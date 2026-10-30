
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

/**
 * Job Hunter database migration runner.
 *
 * Rules:
 * 1. Apply each SQL migration only once.
 * 2. Execute each migration in a transaction.
 * 3. Hold a PostgreSQL advisory lock during migration.
 * 4. Reject modified migrations that were already applied.
 * 5. Treat CRLF and LF line endings as equivalent for checksums.
 * 6. Preserve previously recorded raw-file checksums.
 * 7. Never rewrite migration history automatically.
 *
 * Down migrations remain manual and potentially destructive.
 */

export const MIGRATIONS_DIR = path.resolve("db", "migrations");

const LOCK_KEY = 727_001;
const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export class MigrationChecksumError extends Error {
  constructor(version: string) {
    super(
      `Migration ${version} does not match its recorded checksum. ` +
      "Do not edit an applied migration. Add a new migration instead.",
    );

    this.name = "MigrationChecksumError";
  }
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  version: string;
  sql: string;
  checksum: string;
  legacyChecksum: string;
}

/**
 * Convert Windows CRLF to LF.
 *
 * This makes checksums independent of Git checkout line endings.
 * Existing SQL content is otherwise preserved.
 */
function normalizeLineEndings(sql: string): string {
  return sql.replace(/\r\n/g, "\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Read migrations in deterministic filename order.
 *
 * checksum:
 *   Canonical LF checksum for new migrations.
 *
 * legacyChecksum:
 *   Exact-file checksum for previously applied migrations.
 */
function readMigrations(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort();

  return files.map((file) => {
    const version = file.replace(/\.sql$/, "");
    const sql = readFileSync(path.join(dir, file), "utf8");

    return {
      version,
      sql,
      checksum: sha256(normalizeLineEndings(sql)),
      legacyChecksum: sha256(sql),
    };
  });
}

/**
 * Accept the canonical checksum or a historical exact-file checksum.
 *
 * This supports already-applied CRLF migrations without modifying
 * schema_migrations.
 *
 * Real SQL content changes still cause a mismatch.
 */
function checksumMatches(
  recorded: string,
  migration: MigrationFile,
): boolean {
  return (
    recorded === migration.checksum ||
    recorded === migration.legacyChecksum
  );
}

/**
 * Migrations renamed after they may already have been applied (ADR-0005): new version -> old version.
 * The SQL is unchanged, so the recorded checksum still matches.
 */
export const RENAMED_MIGRATIONS: Readonly<Record<string, string>> = {
  "0012_m4_decision_intelligence": "0006_m4_decision_intelligence",
};

/**
 * Re-key `recorded` in place so each renamed migration is found under its new version.
 * Returns the [oldVersion, newVersion] pairs that were re-keyed, so the caller can update the table.
 */
export function aliasRenamedMigrations(recorded: Map<string, string>): Array<[string, string]> {
  const moved: Array<[string, string]> = [];
  for (const [to, from] of Object.entries(RENAMED_MIGRATIONS)) {
    const checksum = recorded.get(from);
    if (checksum !== undefined && !recorded.has(to)) {
      recorded.delete(from);
      recorded.set(to, checksum);
      moved.push([from, to]);
    }
  }
  return moved;
}

/**
 * Apply pending migrations.
 *
 * Existing migrations are validated before pending ones execute.
 * PostgreSQL stores canonical LF checksums for new migrations.
 */
export async function migrate(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const migrations = readMigrations(dir);
  const client = await pool.connect();

  const result: MigrationResult = {
    applied: [],
    alreadyApplied: [],
  };

  let lockAcquired = false;

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    lockAcquired = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const existing = await client.query<{
      version: string;
      checksum: string;
    }>(
      "SELECT version, checksum FROM schema_migrations",
    );

    const recorded = new Map(
      existing.rows.map((row) => [
        row.version,
        row.checksum,
      ]),
    );

    // A database that recorded a renamed migration under its old name keeps it
    // applied: re-key the row (checksum unchanged) instead of re-running the SQL.
    // The map is re-keyed in memory first, so the checksum validation below sees the renamed file; the table is
    // only updated after that validation passes, and in one transaction.
    const moved = aliasRenamedMigrations(recorded);

    // Validate all previously applied local migrations before
    // executing any pending migration.
    for (const migration of migrations) {
      const prior = recorded.get(migration.version);

      if (
        prior !== undefined &&
        !checksumMatches(prior, migration)
      ) {
        throw new MigrationChecksumError(migration.version);
      }
    }

    if (moved.length) {
      try {
        await client.query("BEGIN");
        for (const [from, to] of moved) {
          await client.query(
            "UPDATE schema_migrations SET version = $1 WHERE version = $2",
            [to, from],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    for (const migration of migrations) {
      const prior = recorded.get(migration.version);

      if (prior !== undefined) {
        result.alreadyApplied.push(migration.version);
        continue;
      }

      try {
        await client.query("BEGIN");

        await client.query(migration.sql);

        await client.query(
          `INSERT INTO schema_migrations
             (version, checksum)
           VALUES ($1, $2)`,
          [migration.version, migration.checksum],
        );

        await client.query("COMMIT");

        result.applied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    return result;
  } finally {
    if (lockAcquired) {
      await client
        .query("SELECT pg_advisory_unlock($1)", [LOCK_KEY])
        .catch(() => undefined);
    }

    client.release();
  }
}

/**
 * Return true only when:
 *
 * - Every local migration has been applied.
 * - Every recorded checksum matches the local migration.
 *
 * Extra migrations recorded by another branch are not modified.
 */
export async function migrationsCurrent(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<boolean> {
  try {
    const migrations = readMigrations(dir);

    const { rows } = await pool.query<{
      version: string;
      checksum: string;
    }>(
      "SELECT version, checksum FROM schema_migrations",
    );

    const recorded = new Map(
      rows.map((row) => [row.version, row.checksum]),
    );
    aliasRenamedMigrations(recorded);

    return migrations.every((migration) => {
      const prior = recorded.get(migration.version);

      return (
        prior !== undefined &&
        checksumMatches(prior, migration)
      );
    });
  } catch {
    return false;
  }
}

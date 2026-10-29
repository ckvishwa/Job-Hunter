
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

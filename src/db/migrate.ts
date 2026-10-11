import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type pg from "pg";

// Plain-SQL forward migrations. Each file runs once, in a transaction, under an advisory lock. A recorded migration whose
// file later changes is an error, never silently re-applied. Down scripts (db/migrations/down) are manual and destructive.

export const MIGRATIONS_DIR = path.resolve("db", "migrations");
const LOCK_KEY = 727_001;

export class MigrationChecksumError extends Error {
  constructor(version: string) {
    super(`Migration ${version} was modified after it was applied. Add a new migration instead of editing an applied one.`);
    this.name = "MigrationChecksumError";
  }
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = readdirSync(dir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const recorded = new Map<string, string>((await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]));
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      const sql = readFileSync(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = recorded.get(version);
      if (prior !== undefined) {
        if (prior !== checksum) throw new MigrationChecksumError(version);
        result.alreadyApplied.push(version);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [version, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      result.applied.push(version);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return result;
}

/** True when every migration file has been applied (used as a startup guard by the API). */
export async function migrationsCurrent(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<boolean> {
  const files = readdirSync(dir).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).map((n) => n.replace(/\.sql$/, ""));
  try {
    const { rows } = await pool.query<{ version: string }>("SELECT version FROM schema_migrations");
    const have = new Set(rows.map((r) => r.version));
    return files.every((f) => have.has(f));
  } catch {
    return false;
  }
}

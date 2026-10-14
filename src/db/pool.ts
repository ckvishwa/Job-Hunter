import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

export type Env = Record<string, string | undefined>;

/** Minimal KEY=VALUE reader for infra/.env. Never overrides variables already set in the process environment. */
export function loadEnvFile(filePath: string, target: Env = process.env): boolean {
  if (!existsSync(filePath)) return false;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (target[key] === undefined) target[key] = value;
  }
  return true;
}

export const DEFAULT_ENV_FILE = path.resolve("infra", ".env");

export interface PgSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function pgSettingsFromEnv(env: Env = process.env, databaseOverride?: string): PgSettings {
  const need = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`${key} is not set (see infra/.env.example).`);
    return value;
  };
  return {
    host: "127.0.0.1", // the compose service publishes on loopback only
    port: Number(env.JH_PG_PORT ?? 55440),
    user: need("JH_PG_USER"),
    password: need("JH_PG_PASSWORD"),
    database: databaseOverride ?? need("JH_PG_DB"),
  };
}

export function createPool(settings: PgSettings, options: { max?: number; connectTimeoutMs?: number; idleTimeoutMs?: number } = {}): pg.Pool {
  const pool = new pg.Pool({ ...settings, max: options.max ?? 8, connectionTimeoutMillis: options.connectTimeoutMs ?? 5000, idleTimeoutMillis: options.idleTimeoutMs ?? 10_000 });
  // pg-pool in this install does not listen on the client. A Windows loopback ECONNRESET is then an
  // unhandled 'error' on the Client and kills the process, leaving a discovery run RUNNING. The query
  // still rejects; this only keeps the process alive so the caller can record the failure.
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      pool.emit("error", error, client);
    });
  });
  pool.on("error", () => undefined);
  return pool;
}

/** Windows loopback sometimes fails the first PostgreSQL connect (docs/KNOWN_FLAKES.md). Retry only that failure. */
export const CONNECT_FAILURE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|Connection terminated/;

export async function retryConnect<T>(run: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ""}` : String(error);
      if (attempt >= attempts - 1 || !CONNECT_FAILURE.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { AiServiceError, type AiClient } from "../../src/ai/client.js";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import { loadApiConfig, type ApiConfig } from "../../src/api/config.js";
import { ExtractionQueue, type ExtractionEvent } from "../../src/api/extraction.js";
import { createFileStore } from "../../src/api/file-store.js";
import { buildServer, type ApiDeps } from "../../src/api/server.js";
import { CandidateRepo } from "../../src/db/candidate-repo.js";
import { migrate } from "../../src/db/migrate.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../../src/db/pool.js";

// Test harness for the S1 workflow. Each call gets its OWN freshly created and migrated PostgreSQL database inside the
// dedicated S1 container (never the working database), and a temporary upload directory. Both are removed afterwards.

loadEnvFile(DEFAULT_ENV_FILE);

/**
 * True when the S1 PostgreSQL is reachable. If infra/.env does not exist the machine is simply not set up for S1 (for example CI)
 * and the DB-backed suites are skipped. If infra/.env EXISTS but the database cannot be reached after retries, this THROWS: a
 * configured machine must never silently skip the persistence tests (a transient connect failure was observed once).
 */
export async function dbAvailable(): Promise<boolean> {
  if (process.env.JH_SKIP_DB_TESTS === "1" || !existsSync(DEFAULT_ENV_FILE)) return false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pool = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1, connectTimeoutMs: 30_000 });
    try {
      await pool.query("SELECT 1");
      return true;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 750));
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  throw new Error(`The S1 PostgreSQL is configured (infra/.env) but unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}. Start it with: docker compose -f infra/docker-compose.yml --env-file infra/.env up -d (or set JH_SKIP_DB_TESTS=1).`);
}

export const ORIGIN = "http://127.0.0.1:4321";
export const HOST = "127.0.0.1:8787";

export interface Harness {
  app: FastifyInstance;
  pool: pg.Pool;
  repo: CandidateRepo;
  queue: ExtractionQueue;
  config: ApiConfig;
  events: ExtractionEvent[];
  dbName: string;
  uploadDir: string;
  /** Close the app and its pool, then bring up a brand-new app and pool on the SAME database (a process restart). */
  restart(): Promise<Harness>;
  close(): Promise<void>;
  dropDatabase(): Promise<void>;
}

export function testEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    JH_API_ACCESS_TOKEN: "a".repeat(40),
    JH_SESSION_SECRET: "b".repeat(40),
    JH_AI_SERVICE_TOKEN: "c".repeat(40),
    JH_API_PORT: "8787",
    JH_DEMO_PROFILE: "1", // synthetic uploads join an active DEMO profile; production defaults to UNVERIFIED
    ...overrides,
  };
}

export async function startHarness(ai: AiClient, options: { env?: Record<string, string>; existing?: { dbName: string; uploadDir: string }; serverDeps?: Partial<ApiDeps> } = {}): Promise<Harness> {
  const admin = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1, connectTimeoutMs: 30_000 });
  // Only the first connection is retried (docs/KNOWN_FLAKES.md, seventh entry: intermittent loopback ETIMEDOUT to 127.0.0.1:55440). Nothing asserted is retried.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query("SELECT 1");
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
    }
  }
  const dbName = options.existing?.dbName ?? `jh_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const uploadDir = options.existing?.uploadDir ?? mkdtempSync(path.join(os.tmpdir(), "jh-s1-"));
  if (!options.existing) {
    // Safety net: a throwaway database whose cleanup failed (for example a transient connect error) is removed after an hour.
    const stale = await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname ~ '^jh_test_[0-9]+_[a-f0-9]+$'");
    for (const row of stale.rows) {
      const created = Number(row.datname.split("_")[2]);
      if (Date.now() - created > 3_600_000) await admin.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.query(`CREATE DATABASE ${dbName}`);
  }
  await admin.end();
  // Generous connect timeout: the full suite runs many headed-Chrome files in parallel and loopback connects can stall under that load.
  // A long idle timeout keeps connections open for the whole file: every new loopback connect is an exposure to the OS-level connect
  // stalls documented in docs/KNOWN_FLAKES.md.
  const pool = createPool(pgSettingsFromEnv(process.env, dbName), { max: 4, connectTimeoutMs: 30_000, idleTimeoutMs: 300_000 });
  if (!options.existing) {
    // The migration only connects and applies SQL in one transaction, so repeating it after a loopback connect failure is safe.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await migrate(pool);
        break;
      } catch (error) {
        if (attempt >= 3 || !/ETIMEDOUT|ECONNRESET|ECONNREFUSED|Connection terminated/.test(String((error as Error).message))) throw error;
        await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
      }
    }
  }
  const config = loadApiConfig(testEnv({ JH_UPLOAD_DIR: uploadDir, ...(options.env ?? {}) }));
  const repo = new CandidateRepo(pool);
  const events: ExtractionEvent[] = [];
  const queue = new ExtractionQueue({ repo, ai, files: createFileStore(uploadDir), onEvent: (e) => events.push(e) });
  const app = await buildServer({ config, repo, files: createFileStore(uploadDir), queue, now: () => new Date("2026-10-09T12:00:00Z"), ...(options.serverDeps ?? {}) });
  const h: Harness = {
    app, pool, repo, queue, config, events, dbName, uploadDir,
    async close() {
      await app.close();
      await queue.idle();
      await pool.end();
    },
    async restart() {
      await h.close();
      // Only the (re)connection is retried, never an assertion: a loopback connect stall (docs/KNOWN_FLAKES.md) here would otherwise
      // leave the closed harness in place and fail every later test in the file.
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await startHarness(ai, { env: options.env, existing: { dbName, uploadDir }, serverDeps: options.serverDeps });
        } catch (error) {
          lastError = error;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      throw lastError;
    },
    async dropDatabase() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const a = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1, connectTimeoutMs: 30_000 });
        try {
          await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
          break;
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise((r) => setTimeout(r, 750));
        } finally {
          await a.end().catch(() => undefined);
        }
      }
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
  return h;
}

// --- HTTP helpers -------------------------------------------------------------------------------------------------------

export interface Session {
  cookie: string;
  csrf: string;
}

export async function login(h: Harness, token = "a".repeat(40)): Promise<Session> {
  const res = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { host: HOST, origin: ORIGIN, "content-type": "application/json" }, payload: { accessToken: token } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode}`);
  const set = res.cookies.find((c) => c.name === "jh_session")!;
  return { cookie: `jh_session=${set.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken };
}

export function authHeaders(s: Session, extra: Record<string, string> = {}): Record<string, string> {
  return { host: HOST, origin: ORIGIN, cookie: s.cookie, "x-csrf-token": s.csrf, ...extra };
}

export function multipartBody(fileName: string, bytes: Buffer, contentType = "application/octet-stream"): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----jh${randomBytes(8).toString("hex")}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, bytes, tail]), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export async function upload(h: Harness, s: Session, bytes: Buffer, fileName = "resume.docx") {
  const { payload, headers } = multipartBody(fileName, bytes);
  return h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: authHeaders(s, headers), payload });
}

export async function getJson<T = any>(h: Harness, s: Session, url: string): Promise<{ status: number; body: T }> {
  const res = await h.app.inject({ method: "GET", url, headers: { host: HOST, cookie: s.cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

export async function postJson<T = any>(h: Harness, s: Session, url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await h.app.inject({ method: "POST", url, headers: authHeaders(s, { "content-type": "application/json" }), payload: payload as never });
  return { status: res.statusCode, body: res.json() as T };
}

export async function putJson<T = any>(h: Harness, s: Session, url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await h.app.inject({ method: "PUT", url, headers: authHeaders(s, { "content-type": "application/json" }), payload: payload as never });
  return { status: res.statusCode, body: res.json() as T };
}

// --- Fake AI client -----------------------------------------------------------------------------------------------------

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n");
export const docxBytes = (marker: string): Buffer => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker)]);

export const SAMPLE_TEXT = "Jordan Rivers\njordan@example.com\nSKILLS\nPython, Splunk\nEXPERIENCE\nNorthwind | SOC Analyst | Jan 2022 – Present";
const at = (quote: string, text = SAMPLE_TEXT) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote });

export function sampleResponse(overrides: Partial<ExtractResponse> = {}): ExtractResponse {
  const text = overrides.text ?? SAMPLE_TEXT;
  return {
    schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text, textSha256: sha256(text), warnings: [],
    facts: [
      { kind: "legal_name", value: "Jordan Rivers", attributes: {}, span: at("Jordan Rivers", text), proposedBy: "rules" },
      { kind: "email", value: "jordan@example.com", attributes: {}, span: at("jordan@example.com", text), proposedBy: "rules" },
      { kind: "skill", value: "Python", attributes: {}, span: at("Python", text), proposedBy: "rules" },
      { kind: "skill", value: "Splunk", attributes: {}, span: at("Splunk", text), proposedBy: "rules" },
      { kind: "employment", value: "Northwind — SOC Analyst", attributes: { employer: "Northwind", title: "SOC Analyst", startDate: "2022-01", current: true }, span: at("Northwind | SOC Analyst | Jan 2022 – Present", text), proposedBy: "rules" },
    ],
    stats: { pageCount: 1, characterCount: text.length, deterministicFacts: 5, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
    ...overrides,
  };
}

export class FakeAi implements AiClient {
  calls = 0;
  constructor(private behavior: (bytes: Uint8Array, fileType: "pdf" | "docx") => ExtractResponse | AiServiceError = () => sampleResponse()) {}
  set(behavior: FakeAi["behavior"]): void {
    this.behavior = behavior;
  }
  async extractResume(bytes: Uint8Array, fileType: "pdf" | "docx"): Promise<ExtractResponse> {
    this.calls += 1;
    const out = this.behavior(bytes, fileType);
    if (out instanceof AiServiceError) throw out;
    return out;
  }
}

// --- Real Python AI service ---------------------------------------------------------------------------------------------------

export const AI_DIR = path.resolve("services", "ai");
export const PYTHON = path.join(AI_DIR, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
export const pythonAvailable = (): boolean => existsSync(PYTHON);

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/** Builds every case in services/ai/tests/fixtures/resume_cases.json as a real PDF/DOCX into `dir`. */
export function buildResumeFixtures(dir: string): void {
  const built = spawnSync(PYTHON, ["-m", "tests.build_fixtures", dir], { cwd: AI_DIR, encoding: "utf8", env: { ...process.env, PYTHONPATH: AI_DIR } });
  if (built.status !== 0) throw new Error(`fixture build failed: ${built.stderr}`);
}

export interface AiService {
  port: number;
  token: string;
  stop(): void;
}

export async function startAiService(token = "c".repeat(40)): Promise<AiService> {
  const port = await freePort();
  const child: ChildProcess = spawn(PYTHON, ["run.py"], {
    cwd: AI_DIR, stdio: "ignore",
    env: { ...process.env, JH_AI_PORT: String(port), JH_AI_HOST: "127.0.0.1", JH_AI_SERVICE_TOKEN: token, JH_AI_QWEN_FALLBACK: "0" },
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/internal/v1/ai/info`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) return { port, token, stop: () => void child.kill() };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error("The Python AI service did not start.");
}

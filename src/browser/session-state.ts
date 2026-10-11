import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Cookie } from "playwright";

// Why a restart used to lose logins (audited 2026-10-11):
//  1. The pipeline and packet entry points opened a NEW profile directory per run / per job (uniqueChromeProfileDir, packet-<jobId>), so no run ever saw another run's cookies.
//  2. The default profile path was CWD-relative ("./.chrome-profile"), so it moved with the working directory.
//  3. Chrome drops SESSION cookies (no Expires/Max-Age) when it exits, even inside a persistent profile; a Playwright persistent context does not restore them.
//     Persistent cookies, localStorage and IndexedDB already survive in the profile directory.
// This module fixes (3): session cookies are snapshotted from the managed context (periodically and on a clean close) into a private file inside the profile
// directory and re-added on the next launch. Only cookies the browser does not already hold are restored, so a fresher login is never overwritten. Nothing here
// is ever logged: cookie names/values stay in the file and in browser memory. The file is created with owner-only permissions where the OS supports it.

export const SESSION_STATE_FILE = "orbital-session-state.json";
/** A snapshot older than this is ignored (sites expire server-side sessions anyway). */
export const SESSION_STATE_TTL_MS = 14 * 24 * 3600 * 1000;
const SNAPSHOT_INTERVAL_MS = 30_000;

interface SessionFile {
  schema: "orbital-session-state/1";
  savedAt: string;
  cookies: Cookie[];
}

export interface ContextHooks {
  beforeClose?: () => Promise<void>;
  afterClose?: () => Promise<void>;
}

const hooks = new WeakMap<BrowserContext, ContextHooks>();
export const registerContextHooks = (context: BrowserContext, h: ContextHooks): void => void hooks.set(context, h);
export const isManagedContext = (context: BrowserContext): boolean => hooks.has(context);
export async function runBeforeClose(context: BrowserContext): Promise<void> {
  await hooks.get(context)?.beforeClose?.().catch(() => undefined);
}
export async function runAfterClose(context: BrowserContext): Promise<void> {
  await hooks.get(context)?.afterClose?.().catch(() => undefined);
  hooks.delete(context);
}

const isSession = (c: Cookie): boolean => c.expires === -1 || c.expires === undefined || c.expires === 0;

/** Writes the context's session cookies (atomic replace). Returns how many were stored; 0 on any failure. */
export async function saveSessionState(context: BrowserContext, profileDir: string, now: () => Date = () => new Date()): Promise<number> {
  try {
    if (typeof context.cookies !== "function" || !existsSync(profileDir)) return 0;
    const cookies = (await context.cookies()).filter(isSession);
    const file = path.join(profileDir, SESSION_STATE_FILE);
    const body: SessionFile = { schema: "orbital-session-state/1", savedAt: now().toISOString(), cookies };
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    renameSync(tmp, file);
    try { chmodSync(file, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
    return cookies.length;
  } catch {
    return 0;
  }
}

/** Re-adds saved session cookies the browser does not already hold. Returns { restored, skipped } counts only. */
export async function restoreSessionState(context: BrowserContext, profileDir: string, now: () => Date = () => new Date()): Promise<{ restored: number; skipped: number; reason: string | null }> {
  const file = path.join(profileDir, SESSION_STATE_FILE);
  try {
    if (typeof context.addCookies !== "function" || !existsSync(file)) return { restored: 0, skipped: 0, reason: "no saved state" };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionFile;
    if (parsed.schema !== "orbital-session-state/1" || !Array.isArray(parsed.cookies)) return { restored: 0, skipped: 0, reason: "unrecognised state file" };
    if (now().getTime() - Date.parse(parsed.savedAt) > SESSION_STATE_TTL_MS || !Number.isFinite(Date.parse(parsed.savedAt))) return { restored: 0, skipped: parsed.cookies.length, reason: "saved state expired" };
    const have = new Set((await context.cookies()).map((c) => `${c.name}|${c.domain}|${c.path}`));
    const fresh = parsed.cookies.filter((c) => !have.has(`${c.name}|${c.domain}|${c.path}`));
    if (fresh.length) await context.addCookies(fresh);
    return { restored: fresh.length, skipped: parsed.cookies.length - fresh.length, reason: null };
  } catch {
    return { restored: 0, skipped: 0, reason: "restore failed" };
  }
}

/** Snapshots on a timer so a crash loses at most one interval. The timer never keeps the process alive. */
export function startPeriodicSnapshot(context: BrowserContext, profileDir: string, intervalMs = SNAPSHOT_INTERVAL_MS): () => void {
  const timer = setInterval(() => void saveSessionState(context, profileDir), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

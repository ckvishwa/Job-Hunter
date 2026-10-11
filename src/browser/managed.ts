import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext } from "playwright";
import { ChromeProfileInUseError, closePersistentChrome, launchPersistentChrome, realChromeProcessDeps, type ChromeProcessDeps, type LaunchPersistentChromeOptions } from "./launcher.js";
import { registerContextHooks, restoreSessionState, saveSessionState, startPeriodicSnapshot } from "./session-state.js";

// The ONE managed automation browser: headed Chrome (channel "chrome") with a persistent profile that is
//   * at a stable location regardless of the working directory (JH_BROWSER_PROFILE_DIR, else <repo>/private-runtime/browser-profiles/orbital-default)
//   * owned by exactly one process at a time (owner lock; a second owner fails with PROFILE_IN_USE, nobody else's Chrome is touched)
//   * never cleared by cleanup (close keeps every file), never the user's everyday Chrome profile
//   * given back its session cookies after a restart (session-state.ts)
// Existing call sites keep working: their close functions run the hooks registered here, so locks are released and state saved wherever they close.

export const DEFAULT_PROFILE_NAME = "orbital-default";
export const OWNER_LOCK_FILE = "orbital-owner.lock";

const repoRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Stable profile location. Never depends on process.cwd(). */
export function resolveBrowserProfileDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.JH_BROWSER_PROFILE_DIR?.trim();
  return path.resolve(override ? override : path.join(repoRoot(), "private-runtime", "browser-profiles", DEFAULT_PROFILE_NAME));
}

export class ProfileInUseError extends Error {
  readonly code = "PROFILE_IN_USE" as const;
  constructor(readonly profileDir: string, readonly ownerPid: number | null) {
    super(`PROFILE_IN_USE: the managed browser profile "${profileDir}" is owned by another process${ownerPid ? ` (pid ${ownerPid})` : ""}. Close that run first; Orbital never kills or shares it.`);
    this.name = "ProfileInUseError";
  }
}

interface LockBody { pid: number; token: string; host: string; startedAt: string }

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export interface OwnerLock { token: string; release(): void }

/** Atomic owner lock inside the profile directory. A lock whose process is gone is stale and is reclaimed; a live owner (even this process) blocks. */
export function acquireOwnerLock(profileDir: string, pidOf: (pid: number) => boolean = pidAlive): OwnerLock {
  mkdirSync(profileDir, { recursive: true });
  const file = path.join(profileDir, OWNER_LOCK_FILE);
  const body: LockBody = { pid: process.pid, token: randomBytes(8).toString("hex"), host: os.hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify(body));
      closeSync(fd);
      return { token: body.token, release: () => { try { if ((JSON.parse(readFileSync(file, "utf8")) as LockBody).token === body.token) rmSync(file, { force: true }); } catch { /* already gone */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: LockBody | null = null;
      try { owner = JSON.parse(readFileSync(file, "utf8")) as LockBody; } catch { /* unreadable: treat as stale below */ }
      if (owner && pidOf(owner.pid)) throw new ProfileInUseError(profileDir, owner.pid);
      rmSync(file, { force: true }); // stale: its owner process no longer exists
    }
  }
  throw new ProfileInUseError(profileDir, null);
}

export function ownerOf(profileDir: string): { pid: number; alive: boolean; startedAt: string } | null {
  try {
    const b = JSON.parse(readFileSync(path.join(profileDir, OWNER_LOCK_FILE), "utf8")) as LockBody;
    return { pid: b.pid, alive: pidAlive(b.pid), startedAt: b.startedAt };
  } catch {
    return null;
  }
}

/** Same signature as launchPersistentChrome, so existing `launchFn` seams accept it. */
export async function launchManagedChrome(
  userDataDir: string = resolveBrowserProfileDir(),
  options: LaunchPersistentChromeOptions = {},
  deps: ChromeProcessDeps = realChromeProcessDeps,
): Promise<BrowserContext> {
  const dir = path.resolve(userDataDir);
  const lock = acquireOwnerLock(dir);
  let context: BrowserContext;
  try {
    context = await launchPersistentChrome(dir, options, deps);
  } catch (error) {
    lock.release();
    throw error;
  }
  await restoreSessionState(context, dir);
  const stop = startPeriodicSnapshot(context, dir);
  registerContextHooks(context, {
    beforeClose: async () => { stop(); await saveSessionState(context, dir); },
    afterClose: async () => { stop(); lock.release(); },
  });
  return context;
}

export async function closeManagedChrome(context: BrowserContext, userDataDir: string = resolveBrowserProfileDir(), deps: ChromeProcessDeps = realChromeProcessDeps): Promise<void> {
  await closePersistentChrome(context, userDataDir, deps);
}

// ---- in-process reuse ------------------------------------------------------------------------------------------------------------------

const open = new Map<string, { context: BrowserContext; refs: number }>();

/** Reuses this process's managed context for the same profile; another process gets PROFILE_IN_USE. */
export async function acquireManagedBrowser(options: LaunchPersistentChromeOptions & { profileDir?: string } = {}): Promise<{ context: BrowserContext; profileDir: string; release: () => Promise<void> }> {
  const { profileDir: given, ...launchOptions } = options;
  const dir = path.resolve(given ?? resolveBrowserProfileDir());
  const existing = open.get(dir);
  if (existing) {
    existing.refs += 1;
  } else {
    open.set(dir, { context: await launchManagedChrome(dir, launchOptions), refs: 1 });
  }
  const entry = open.get(dir)!;
  let released = false;
  return {
    context: entry.context, profileDir: dir,
    release: async () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs <= 0) {
        open.delete(dir);
        await closeManagedChrome(entry.context, dir);
      }
    },
  };
}

export const describeProfile = (dir: string = resolveBrowserProfileDir()): { dir: string; exists: boolean; owner: ReturnType<typeof ownerOf> } => ({ dir, exists: existsSync(dir), owner: ownerOf(dir) });
export { ChromeProfileInUseError };

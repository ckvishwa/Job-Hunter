import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { JobPosting } from "../adapters/types.js";

// Authoritative job store (data/jobs.jsonl): strict reads, guarded atomic replacement and a
// bounded single-writer lock around the whole read-modify-write.
//
// Guarantees (supported environment: Windows 11 / NTFS, local disk, Node 24):
//  - A store file that contains a malformed record is NEVER replaced. Reads and writes fail with
//    a typed JobStoreError; the original bytes stay on disk untouched.
//  - A replacement is written to a unique temp file, fsync'ed, then renamed over the target
//    (MoveFileEx replace on Windows). A crash or error before the rename leaves the previous
//    file intact; a reader sees the old or the new file, never a mix.
//  - updateJobs() holds an exclusive lock file for read + merge + write, so two processes cannot
//    both start from the same stale baseline and lose each other's acknowledged update.
//  Not guaranteed: directory-entry durability after the rename (Node cannot fsync a directory on
//  Windows), locking over network shares (lock files assume one host), or protection from a
//  process that ignores the lock and writes the file directly.

export type JobStoreErrorCode =
  | "CORRUPT_RECORD"
  | "INCOMPLETE_TRAILING_RECORD"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "LOCK_TIMEOUT"
  | "LOCK_LOST";

export interface JobStoreDiagnostics {
  file: string;
  // 1-based line numbers of offending records (at most MAX_REPORTED_LINES). Never record content.
  lines?: number[];
  // Total bad records found, byte length of the offending final fragment, lock owner facts.
  badRecordCount?: number;
  fragmentBytes?: number;
  lockOwnerPid?: number;
  lockAgeMs?: number;
  lockPath?: string;
  cause?: string;
}

const MAX_REPORTED_LINES = 10;

export class JobStoreError extends Error {
  readonly code: JobStoreErrorCode;
  readonly diagnostics: JobStoreDiagnostics;
  constructor(code: JobStoreErrorCode, message: string, diagnostics: JobStoreDiagnostics) {
    super(`[job-store ${code}] ${message}`);
    this.name = "JobStoreError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

// ---------------------------------------------------------------------------
// Strict read
// ---------------------------------------------------------------------------

function isJobRecord(value: unknown): value is JobPosting {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string";
}

/**
 * Parses the store strictly. Blank lines are ignored. A final line without a newline that does
 * not parse is an INCOMPLETE_TRAILING_RECORD (an interrupted append/write); any other
 * unparseable line is a CORRUPT_RECORD. Nothing is dropped silently and nothing is rewritten.
 */
export function loadJobs(filePath: string): JobPosting[] {
  return loadRecords(filePath, isJobRecord);
}

/**
 * Generic strict JSONL read (same corruption rules as loadJobs). `isRecord` decides what counts
 * as a valid record; anything else is CORRUPT_RECORD. Used for other versioned artifacts that
 * need the same protection (e.g. structured JD results).
 */
export function loadRecords<T>(filePath: string, isRecord: (value: unknown) => value is T): T[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new JobStoreError("READ_FAILED", "Could not read the job store.", { file: filePath, cause: (err as NodeJS.ErrnoException).code ?? "unknown" });
  }

  const lines = raw.split("\n");
  const endsWithNewline = raw.endsWith("\n");
  const jobs: T[] = [];
  const bad: number[] = [];
  let badTrailingBytes: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;
    let ok = false;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        jobs.push(parsed);
        ok = true;
      }
    } catch {
      // fall through to classification below
    }
    if (ok) continue;
    const isUnterminatedFinalLine = i === lines.length - 1 && !endsWithNewline;
    if (isUnterminatedFinalLine) {
      badTrailingBytes = Buffer.byteLength(lines[i]!, "utf-8");
    } else {
      bad.push(i + 1);
    }
  }

  if (bad.length > 0) {
    throw new JobStoreError(
      "CORRUPT_RECORD",
      `${bad.length} malformed record(s) in the job store; refusing to read or replace it. Original file left untouched.`,
      { file: filePath, lines: bad.slice(0, MAX_REPORTED_LINES), badRecordCount: bad.length + (badTrailingBytes !== null ? 1 : 0) },
    );
  }
  if (badTrailingBytes !== null) {
    throw new JobStoreError(
      "INCOMPLETE_TRAILING_RECORD",
      "The job store ends with an incomplete record (interrupted write). Original file left untouched; recover it manually.",
      { file: filePath, lines: [lines.length], fragmentBytes: badTrailingBytes, badRecordCount: 1 },
    );
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// Guarded atomic replacement
// ---------------------------------------------------------------------------

export function writeFileDurable(tmpPath: string, content: string): void {
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface JobStoreHooks {
  // Test seams for fault injection; production callers never pass these.
  beforeReplace?: () => void;
}

const RENAME_RETRIES = 5;

function renameWithRetry(from: string, to: string): void {
  // On Windows a rename onto a file another process momentarily holds open (antivirus, indexer,
  // a concurrent reader) fails with EPERM/EBUSY/EACCES; a short bounded retry is the usual fix.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= RENAME_RETRIES) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

function replaceStore<T>(
  filePath: string,
  jobs: T[],
  isRecord: (value: unknown) => value is T,
  hooks?: JobStoreHooks,
): void {
  // Never replace a store we cannot fully read: that is how corrupt records used to vanish.
  loadRecords(filePath, isRecord);

  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + (jobs.length ? "\n" : "");
  try {
    writeFileDurable(tmpPath, content);
    hooks?.beforeReplace?.();
    renameWithRetry(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    if (err instanceof JobStoreError) throw err;
    throw new JobStoreError("WRITE_FAILED", "Writing the job store failed; the previous file is unchanged.", {
      file: filePath,
      cause: (err as NodeJS.ErrnoException).code ?? (err as Error).message.slice(0, 120),
    });
  }
}

/**
 * Replaces the store with `jobs`. Refuses (JobStoreError) if the existing file is corrupt or has
 * an incomplete tail. Not safe against a concurrent writer on its own: read-modify-write callers
 * must use updateJobs().
 */
export function saveJobs(filePath: string, jobs: JobPosting[], hooks?: JobStoreHooks): void {
  replaceStore(filePath, jobs, isJobRecord, hooks);
}

// ---------------------------------------------------------------------------
// Single-writer lock
// ---------------------------------------------------------------------------

export interface LockOptions {
  // Maximum time to wait for another writer. Default 10 s.
  timeoutMs?: number;
  pollMs?: number;
  // A lock file whose body is empty/unparseable (creator died mid-write) is only treated as
  // abandoned once it is this old. Default 10 s.
  unreadableGraceMs?: number;
  // Test seam: pid liveness probe.
  isProcessAlive?: (pid: number) => boolean;
}

interface LockBody {
  pid: number;
  host: string;
  token: string;
  acquiredAt: string;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_UNREADABLE_GRACE_MS = 10_000;

export function lockPathFor(filePath: string): string {
  return `${filePath}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: exists but not ours -> alive.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockBody(lockPath: string): LockBody | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockBody>;
    if (typeof parsed.pid === "number" && typeof parsed.host === "string" && typeof parsed.token === "string") {
      return parsed as LockBody;
    }
  } catch {
    // unreadable
  }
  return null;
}

/**
 * Abandoned-lock policy (conservative; a live or unknown writer's lock is never removed):
 *  - lock body parseable, same host, owner pid NOT alive -> abandoned;
 *  - lock body unparseable (creator died between create and write) and older than the grace -> abandoned;
 *  - anything else (owner alive, other host, young) -> not abandoned; callers wait, then time out.
 * Removal renames the file to a token-named name first and re-checks the token, so a lock that
 * was replaced by a new owner in the meantime is put back instead of destroyed.
 */
function tryRecoverAbandonedLock(lockPath: string, opts: Required<Pick<LockOptions, "unreadableGraceMs" | "isProcessAlive">>): boolean {
  const body = readLockBody(lockPath);
  let observedToken: string | null = null;
  if (body) {
    if (body.host !== hostname() || opts.isProcessAlive(body.pid)) return false;
    observedToken = body.token;
  } else {
    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      return true; // vanished meanwhile: the caller can simply retry creation
    }
    if (ageMs < opts.unreadableGraceMs) return false;
  }

  const graveyard = `${lockPath}.abandoned.${randomBytes(4).toString("hex")}`;
  try {
    renameSync(lockPath, graveyard);
  } catch {
    return false; // someone else recovered or released it first
  }
  const moved = readLockBody(graveyard);
  const movedToken = moved?.token ?? null;
  if (movedToken !== observedToken) {
    // We moved a lock that is not the one we judged abandoned (a new owner won the race).
    try {
      if (!existsSync(lockPath)) renameSync(graveyard, lockPath);
    } catch {
      // best effort; the new owner's operation will fail loudly with LOCK_LOST on release
    }
    return false;
  }
  rmSync(graveyard, { force: true });
  return true;
}

export interface HeldLock {
  readonly token: string;
  release(): void;
}

export async function acquireLock(filePath: string, options: LockOptions = {}): Promise<HeldLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const policy = {
    unreadableGraceMs: options.unreadableGraceMs ?? DEFAULT_UNREADABLE_GRACE_MS,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
  };
  const lockPath = lockPathFor(filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const body: LockBody = { pid: process.pid, host: hostname(), token: randomBytes(8).toString("hex"), acquiredAt: new Date().toISOString() };

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx"); // exclusive create: fails if it exists
      try {
        writeSync(fd, JSON.stringify(body), null, "utf-8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        token: body.token,
        release(): void {
          if (released) return;
          released = true;
          const current = readLockBody(lockPath);
          if (current?.token !== body.token) {
            throw new JobStoreError("LOCK_LOST", "The store lock is no longer owned by this operation; not releasing another writer's lock.", {
              file: filePath,
              lockPath,
            });
          }
          rmSync(lockPath, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new JobStoreError("WRITE_FAILED", "Could not create the store lock file.", {
          file: filePath,
          lockPath,
          cause: (err as NodeJS.ErrnoException).code ?? "unknown",
        });
      }
    }

    if (tryRecoverAbandonedLock(lockPath, policy)) continue;

    if (Date.now() >= deadline) {
      const owner = readLockBody(lockPath);
      let ageMs: number | undefined;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        // gone: next loop would acquire, but the deadline has passed; report without age
      }
      throw new JobStoreError(
        "LOCK_TIMEOUT",
        `Could not acquire the job store lock within ${timeoutMs} ms; another writer holds it. The store was not modified.`,
        { file: filePath, lockPath, lockOwnerPid: owner?.pid, lockAgeMs: ageMs },
      );
    }
    await sleep(pollMs);
  }
}

/**
 * The only supported way to change a store from its existing contents: lock, strict-read the
 * CURRENT file, apply `update`, write atomically, release (also on exceptions). A failed
 * update leaves the store unchanged and the error propagates to the caller.
 */
export async function updateRecords<T>(
  filePath: string,
  isRecord: (value: unknown) => value is T,
  update: (current: T[]) => T[],
  options: LockOptions & JobStoreHooks = {},
): Promise<T[]> {
  const lock = await acquireLock(filePath, options);
  let result: T[];
  try {
    const current = loadRecords(filePath, isRecord);
    result = update(current);
    replaceStore(filePath, result, isRecord, options);
  } catch (err) {
    try {
      lock.release();
    } catch {
      // keep the original error; a lost lock here is secondary
    }
    throw err;
  }
  lock.release();
  return result;
}

export function updateJobs(
  filePath: string,
  update: (current: JobPosting[]) => JobPosting[],
  options: LockOptions & JobStoreHooks = {},
): Promise<JobPosting[]> {
  return updateRecords(filePath, isJobRecord, update, options);
}

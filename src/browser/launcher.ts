import { chromium, type BrowserContext, type LaunchOptions } from "playwright";
import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

export interface LaunchPersistentChromeOptions extends LaunchOptions {
  headless?: boolean;
}

const DEFAULT_USER_DATA_DIR = "./.chrome-profile";
// Bounded wait for the OS Chrome process to exit after context.close() before we force-kill
// it. Playwright's own close() is supposed to tear the process down, but on Windows with a
// real (channel: "chrome") browser this isn't always reliable -- confirmed during Task 17
// live validation, where the process survived both a normal completion and an errored launch.
const SHUTDOWN_WAIT_TIMEOUT_MS = 10_000;
const POST_KILL_WAIT_TIMEOUT_MS = 5_000;
const LOCK_FILE_NAMES = ["lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie"];

export class ChromeProfileInUseError extends Error {
  constructor(userDataDir: string, pids: number[]) {
    super(
      `Chrome profile "${userDataDir}" is already in use by a live Chrome process (pid ${pids.join(", ")}). ` +
        `Close it (or wait for that run to finish) before starting a new one against the same profile.`,
    );
    this.name = "ChromeProfileInUseError";
  }
}

// Injectable so tests never spawn a real process or touch the real filesystem. Real
// implementations are the defaults every production call site gets for free.
export interface ChromeProcessDeps {
  // Finds OS Chrome processes whose command line references the given absolute
  // user-data-dir. Scoped strictly to that exact path string -- must never match or affect
  // any OTHER Chrome process (the user's own browser, a different profile, a different run).
  findOwningProcessIds(absoluteUserDataDir: string): Promise<number[]>;
  killProcessTree(pid: number): Promise<void>;
  lockFileExists(absoluteUserDataDir: string, name: string): boolean;
  removeLockFile(absoluteUserDataDir: string, name: string): void;
  sleep(ms: number): Promise<void>;
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // Any failure (command missing, non-zero exit, no matches) is treated as "found
      // nothing" -- callers only use this to decide whether a live process exists, and a
      // failed lookup must never be mistaken for "confirmed empty."
      resolve(err ? "" : stdout);
    });
  });
}

/**
 * Boundary-anchored check that `commandLine` genuinely launched Chrome against
 * `absoluteUserDataDir` -- not merely a command line whose --user-data-dir value happens to
 * start with that string. Exported and unit-tested directly (not just indirectly through a
 * real subprocess) because a plain substring/wildcard match here is exactly what let
 * uniqueChromeProfileDir's own "<dir>-run-<timestamp>" profiles collide with the shared
 * "<dir>" profile in an earlier version of this file (confirmed by reproducing it against
 * real PowerShell -like semantics during review) -- the isolated-profile feature would have
 * force-killed an unrelated, live Chrome process. The match requires the directory value to
 * be followed by a double-quote, a space, or the end of the command line -- never another
 * path character.
 *
 * Quoting note (also found and fixed during review, against a REAL running chrome.exe's
 * captured command line): when a Windows argv element contains a space, standard command-line
 * quoting wraps the WHOLE element in quotes -- "--user-data-dir=<dir>" -- not just the value
 * after `=`. A profile path containing a space (extremely common: any username with a space,
 * any path under "Program Files") would otherwise produce a false negative here, silently
 * defeating both the in-use guard and the orphan-cleanup force-kill path -- the exact failure
 * this function exists to prevent, just triggered a different way.
 *
 * ponytail: does not attempt to handle a duplicate --user-data-dir flag (indexOf finds the
 * first occurrence, not necessarily the one Chromium's own last-write-wins flag parsing would
 * honor) -- no code path in this repo ever passes launchPersistentChrome extra args that could
 * produce that, so there's no current consumer to build it for. Revisit if that changes.
 */
export function commandLineOwnsProfile(commandLine: string, absoluteUserDataDir: string): boolean {
  // Whole-token quoting: "--user-data-dir=<dir>" (quote wraps the entire flag=value pair).
  if (commandLine.includes(`"--user-data-dir=${absoluteUserDataDir}"`)) return true;
  const marker = `--user-data-dir=${absoluteUserDataDir}`;
  const idx = commandLine.indexOf(marker);
  if (idx === -1) return false;
  const nextChar = commandLine[idx + marker.length];
  return nextChar === undefined || nextChar === " ";
}

async function listChromeProcesses(): Promise<{ pid: number; commandLine: string }[]> {
  if (process.platform === "win32") {
    // No filtering in the script itself -- every chrome.exe pid+commandline is returned
    // as-is, and the boundary-anchored match above (plain string ops, no shell wildcard
    // escaping to get subtly wrong) decides ownership entirely in TypeScript.
    // [char]9 (tab) avoids PowerShell's own backtick-escape syntax entirely -- no backtick
    // has to be embedded inside this JS template literal.
    const script =
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
      `ForEach-Object { "$($_.ProcessId)$([char]9)$($_.CommandLine)" }`;
    const stdout = await execFileText("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return stdout
      .split(/\r?\n/)
      .map((line) => {
        const tabIndex = line.indexOf("\t");
        if (tabIndex === -1) return null;
        const pid = Number(line.slice(0, tabIndex).trim());
        const commandLine = line.slice(tabIndex + 1);
        return Number.isInteger(pid) && pid > 0 ? { pid, commandLine } : null;
      })
      .filter((entry): entry is { pid: number; commandLine: string } => entry !== null);
  }
  // `ps -eo pid=,args=`: leading whitespace-padded pid, then the full command line for the
  // rest of the line -- no shell/regex involved, same plain-string ownership check applies.
  const stdout = await execFileText("ps", ["-eo", "pid=,args="]);
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimStart();
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) return null;
      const pid = Number(trimmed.slice(0, spaceIndex));
      const commandLine = trimmed.slice(spaceIndex + 1);
      return Number.isInteger(pid) && pid > 0 && commandLine.includes("chrome")
        ? { pid, commandLine }
        : null;
    })
    .filter((entry): entry is { pid: number; commandLine: string } => entry !== null);
}

async function findOwningProcessIdsReal(absoluteUserDataDir: string): Promise<number[]> {
  const processes = await listChromeProcesses();
  return processes
    .filter((p) => commandLineOwnsProfile(p.commandLine, absoluteUserDataDir))
    .map((p) => p.pid);
}

async function killProcessTreeReal(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await execFileText("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone -- fine.
  }
}

export const realChromeProcessDeps: ChromeProcessDeps = {
  findOwningProcessIds: findOwningProcessIdsReal,
  killProcessTree: killProcessTreeReal,
  lockFileExists: (dir, name) => existsSync(path.join(dir, name)),
  removeLockFile: (dir, name) => {
    try {
      rmSync(path.join(dir, name), { force: true });
    } catch {
      // Best-effort -- if this fails, launchPersistentContext will surface a clearer error.
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function waitUntilNoOwningProcess(
  absoluteUserDataDir: string,
  timeoutMs: number,
  deps: ChromeProcessDeps,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await deps.findOwningProcessIds(absoluteUserDataDir);
    if (pids.length === 0) return true;
    if (Date.now() >= deadline) return false;
    await deps.sleep(250);
  }
}

/**
 * Generates a fresh, unused profile directory path (never a shared one) so independent runs
 * -- e.g. sequential controlled live-validation checks -- can each get their own Chrome
 * process without contending for the same profile lock. Not the default: normal usage keeps
 * the single persistent, shared profile so cookies/logins survive across runs (manual
 * verification depends on that persistence). Opt in explicitly per run.
 */
export function uniqueChromeProfileDir(baseDir: string = DEFAULT_USER_DATA_DIR): string {
  return `${baseDir}-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Launches a persistent Chrome context so cookies/logins survive across runs. Headless
 * defaults to false — never bypass the visible-browser requirement unless a caller
 * explicitly overrides it.
 *
 * Before launching: checks whether a live OS process already owns this exact user-data-dir.
 * If so, throws ChromeProfileInUseError immediately rather than hanging or silently trying to
 * attach to it (launchPersistentContext's own "Opening in existing browser session" failure
 * mode was observed to leave an orphaned process behind during live validation). If no live
 * process owns it, any lock file left behind is stale from an unclean prior shutdown and is
 * removed — safe, since we've just confirmed nothing is actually using it.
 */
export async function launchPersistentChrome(
  userDataDir: string = DEFAULT_USER_DATA_DIR,
  options: LaunchPersistentChromeOptions = {},
  deps: ChromeProcessDeps = realChromeProcessDeps,
): Promise<BrowserContext> {
  const absoluteUserDataDir = path.resolve(userDataDir);

  const owningPids = await deps.findOwningProcessIds(absoluteUserDataDir);
  if (owningPids.length > 0) {
    throw new ChromeProfileInUseError(absoluteUserDataDir, owningPids);
  }

  for (const lockName of LOCK_FILE_NAMES) {
    if (deps.lockFileExists(absoluteUserDataDir, lockName)) {
      deps.removeLockFile(absoluteUserDataDir, lockName);
    }
  }

  const { headless = false, ...rest } = options;
  return chromium.launchPersistentContext(absoluteUserDataDir, {
    channel: "chrome",
    headless,
    ...rest,
  });
}

/**
 * Closes every page, then the context, then bounded-waits for the underlying OS Chrome
 * process (matched strictly by user-data-dir, never a broader process match) to actually
 * exit — force-killing it if Playwright's own close() didn't fully tear it down within the
 * timeout. Call this from every code path that opened a context: normal completion, a caught
 * error, a timeout, and process signals (see registerShutdownOnSignal). Never touches a
 * process it can't confirm owns this exact profile directory.
 */
export async function closePersistentChrome(
  context: BrowserContext,
  userDataDir: string = DEFAULT_USER_DATA_DIR,
  deps: ChromeProcessDeps = realChromeProcessDeps,
): Promise<void> {
  const absoluteUserDataDir = path.resolve(userDataDir);

  for (const page of context.pages()) {
    await page.close().catch(() => undefined);
  }
  await context.close().catch(() => undefined);

  const exitedCleanly = await waitUntilNoOwningProcess(absoluteUserDataDir, SHUTDOWN_WAIT_TIMEOUT_MS, deps);
  if (exitedCleanly) return;

  const survivors = await deps.findOwningProcessIds(absoluteUserDataDir);
  for (const pid of survivors) {
    await deps.killProcessTree(pid);
  }
  await waitUntilNoOwningProcess(absoluteUserDataDir, POST_KILL_WAIT_TIMEOUT_MS, deps);
}

/**
 * Registers one-shot handlers that close the given context (via closePersistentChrome) before
 * the process exits abnormally, so Ctrl-C, a `kill`/SIGTERM, or a genuinely uncaught error/
 * rejection during a live run doesn't leave an orphaned Chrome process behind. Returns an
 * unregister function -- call it once the context is closed through the normal code path
 * (runDiscover's own try/finally already covers that), so a later signal/crash (after this
 * run is already done) doesn't try to close an already-closed context.
 *
 * Known limitation (confirmed during Task 17 live validation, not something this function can
 * fix): none of this fires on an external, forceful process termination (Windows
 * TerminateProcess -- what a job runner's "stop task" typically does under the hood, or
 * `taskkill /F`) -- that tears the process down at the OS level without running any JS handler
 * at all, signal or otherwise. The orphan it can leave behind still has to be cleaned up
 * externally by PID, same as any other abrupt kill. This only covers crashes/signals the
 * process itself gets a chance to react to.
 */
export function registerShutdownOnSignal(
  context: BrowserContext,
  userDataDir: string = DEFAULT_USER_DATA_DIR,
  deps: ChromeProcessDeps = realChromeProcessDeps,
): () => void {
  let handled = false;
  const shutdown = (exitCode: number, err?: unknown) => {
    if (handled) return;
    handled = true;
    if (err !== undefined) {
      console.error("[launcher] Uncaught error -- closing browser before exit:", err);
    }
    void closePersistentChrome(context, userDataDir, deps).finally(() => {
      process.exit(exitCode);
    });
  };

  const onSigint = () => shutdown(130); // 128 + SIGINT(2), conventional exit code for signal termination
  const onSigterm = () => shutdown(143); // 128 + SIGTERM(15)
  const onUncaught = (err: unknown) => shutdown(1, err);

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("uncaughtException", onUncaught);
  process.once("unhandledRejection", onUncaught);

  return () => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("uncaughtException", onUncaught);
    process.removeListener("unhandledRejection", onUncaught);
  };
}

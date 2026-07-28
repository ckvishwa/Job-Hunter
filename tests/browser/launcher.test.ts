import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { ChromeProcessDeps } from "../../src/browser/launcher.js";

// chromium.launchPersistentContext must never actually run in a test -- mocked so
// launchPersistentChrome's own pre-launch logic can be exercised without a real browser.
const { launchPersistentContextMock } = vi.hoisted(() => ({
  launchPersistentContextMock: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: launchPersistentContextMock },
}));

const {
  launchPersistentChrome,
  closePersistentChrome,
  registerShutdownOnSignal,
  uniqueChromeProfileDir,
  ChromeProfileInUseError,
  commandLineOwnsProfile,
} = await import("../../src/browser/launcher.js");

function makeFakeDeps(overrides: Partial<ChromeProcessDeps> = {}): ChromeProcessDeps {
  return {
    findOwningProcessIds: vi.fn().mockResolvedValue([]),
    killProcessTree: vi.fn().mockResolvedValue(undefined),
    lockFileExists: vi.fn().mockReturnValue(false),
    removeLockFile: vi.fn(),
    sleep: vi.fn().mockResolvedValue(undefined), // instant -- no real setTimeout wait in tests
    ...overrides,
  };
}

function makeFakeContext(pages: Partial<Page>[] = []): BrowserContext {
  return {
    pages: () => pages as Page[],
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserContext;
}

beforeEach(() => {
  launchPersistentContextMock.mockReset();
  launchPersistentContextMock.mockResolvedValue(makeFakeContext());
});

describe("commandLineOwnsProfile", () => {
  const dir = "F:\\work\\.chrome-profile";

  it("matches an unquoted --user-data-dir followed by a space (next arg)", () => {
    expect(commandLineOwnsProfile(`chrome.exe --user-data-dir=${dir} --headless`, dir)).toBe(true);
  });

  it("matches an unquoted --user-data-dir at the very end of the command line", () => {
    expect(commandLineOwnsProfile(`chrome.exe --user-data-dir=${dir}`, dir)).toBe(true);
  });

  // Regression coverage for a second real bug an independent review found: Windows argv
  // quoting wraps the WHOLE flag=value token in quotes when the value contains a space --
  // "--user-data-dir=<dir>" -- not just the value after "=". Confirmed against a real,
  // live chrome.exe process's actual captured CommandLine during review (a crashpad-handler
  // child using the default Chrome profile, whose path contains a space: "...\User Data").
  // A space-containing profile path (e.g. any Windows username with a space, or any path
  // under "Program Files") is common, not an edge case -- getting this wrong means the
  // in-use guard and the orphan-cleanup force-kill both silently no-op against a real, live
  // process, which is the exact failure this whole module exists to prevent.
  it("matches a whole-token-quoted --user-data-dir when the profile path contains a space", () => {
    const spacedDir = "C:\\Users\\ckvis\\AppData\\Local\\Google\\Chrome\\User Data";
    const realCapturedShape =
      `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=crashpad-handler ` +
      `"--user-data-dir=${spacedDir}" /prefetch:4`;
    expect(commandLineOwnsProfile(realCapturedShape, spacedDir)).toBe(true);
  });

  it("does NOT match the OLD (incorrect) assumed quoting shape -- quote only around the value, not the whole token", () => {
    // This is what the first version of this fix incorrectly expected. A command line in
    // this shape doesn't actually occur on Windows for a spaced path, but the function must
    // not accidentally match it either -- it's neither the real quoted form nor the real
    // unquoted form (a stray leading quote sits where "--user-data-dir=" should start).
    const spacedDir = "C:\\Users\\ckvis\\AppData\\Local\\Google\\Chrome\\User Data";
    expect(commandLineOwnsProfile(`chrome.exe --user-data-dir="${spacedDir}" --headless`, spacedDir)).toBe(false);
  });

  // Regression coverage: reproduced against real PowerShell -like semantics during review that
  // a plain substring/wildcard match here would let uniqueChromeProfileDir's own
  // "<dir>-run-<timestamp>" isolated profiles collide with a lookup for the shared "<dir>"
  // profile -- which would force-kill an unrelated, live Chrome process under an isolated
  // profile whenever the shared profile's ownership was being checked.
  it("does NOT match a longer directory that merely starts with the same prefix (isolated-profile collision)", () => {
    const isolatedDir = `${dir}-run-1785212977890-3uj1sz`;
    expect(commandLineOwnsProfile(`chrome.exe --user-data-dir=${isolatedDir} --headless`, dir)).toBe(false);
    expect(commandLineOwnsProfile(`chrome.exe --user-data-dir="${isolatedDir}"`, dir)).toBe(false);
  });

  it("does not match a completely unrelated directory", () => {
    expect(commandLineOwnsProfile(`chrome.exe --user-data-dir=C:\\other\\profile`, dir)).toBe(false);
  });

  it("does not match when --user-data-dir is absent entirely", () => {
    expect(commandLineOwnsProfile(`chrome.exe --headless --no-sandbox`, dir)).toBe(false);
  });
});

describe("launchPersistentChrome", () => {
  it("launches normally when no live process owns the profile and no lock file exists", async () => {
    const deps = makeFakeDeps();

    await launchPersistentChrome("./.fake-profile", {}, deps);

    expect(deps.findOwningProcessIds).toHaveBeenCalledWith(expect.stringContaining(".fake-profile"));
    expect(deps.removeLockFile).not.toHaveBeenCalled();
    expect(launchPersistentContextMock).toHaveBeenCalledTimes(1);
  });

  it("rejects clearly (active-lock rejection) instead of hanging when a live process already owns the profile", async () => {
    const deps = makeFakeDeps({
      findOwningProcessIds: vi.fn().mockResolvedValue([4242]),
    });

    await expect(launchPersistentChrome("./.fake-profile", {}, deps)).rejects.toThrow(ChromeProfileInUseError);
    // Must fail BEFORE ever attempting a real launch -- this is the fast, clear failure that
    // replaces launchPersistentContext's own hang-prone "Opening in existing browser session"
    // behavior observed during live validation.
    expect(launchPersistentContextMock).not.toHaveBeenCalled();
  });

  it("cleans up a stale lock file when no live process owns the profile, then launches normally", async () => {
    const deps = makeFakeDeps({
      findOwningProcessIds: vi.fn().mockResolvedValue([]), // no live owner
      lockFileExists: vi.fn().mockReturnValue(true), // but a lock file is present
    });

    await launchPersistentChrome("./.fake-profile", {}, deps);

    expect(deps.removeLockFile).toHaveBeenCalled();
    expect(launchPersistentContextMock).toHaveBeenCalledTimes(1);
  });

  it("does not remove a lock file when a live process genuinely owns the profile (rejects before reaching lock cleanup)", async () => {
    const deps = makeFakeDeps({
      findOwningProcessIds: vi.fn().mockResolvedValue([4242]),
      lockFileExists: vi.fn().mockReturnValue(true),
    });

    await expect(launchPersistentChrome("./.fake-profile", {}, deps)).rejects.toThrow(ChromeProfileInUseError);
    expect(deps.removeLockFile).not.toHaveBeenCalled();
  });
});

describe("closePersistentChrome", () => {
  it("clean shutdown: closes every page, then the context, and never force-kills when the process exits on its own", async () => {
    const page1 = { close: vi.fn().mockResolvedValue(undefined) };
    const page2 = { close: vi.fn().mockResolvedValue(undefined) };
    const context = makeFakeContext([page1, page2]);
    const deps = makeFakeDeps({
      findOwningProcessIds: vi.fn().mockResolvedValue([]), // already gone by the time we check
    });

    await closePersistentChrome(context, "./.fake-profile", deps);

    expect(page1.close).toHaveBeenCalledTimes(1);
    expect(page2.close).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(deps.killProcessTree).not.toHaveBeenCalled();
  });

  it("shutdown after failure: context.close() rejecting doesn't stop the process-exit check or throw out of closePersistentChrome", async () => {
    const context = makeFakeContext();
    (context.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("close failed"));
    const deps = makeFakeDeps({
      findOwningProcessIds: vi.fn().mockResolvedValue([]),
    });

    await expect(closePersistentChrome(context, "./.fake-profile", deps)).resolves.toBeUndefined();
    expect(deps.findOwningProcessIds).toHaveBeenCalled();
  });

  it("shutdown after timeout: force-kills the owning process when it's still alive past the bounded wait, then re-checks", async () => {
    // closePersistentChrome's internal wait loop checks Date.now() against a real deadline --
    // a naive instant-resolving sleep mock would busy-spin for the real ~10s
    // SHUTDOWN_WAIT_TIMEOUT_MS before ever calling killProcessTree. Fake timers (matching the
    // pattern already established in tests/discovery/rate-limit.test.ts) let the real
    // setTimeout-based sleep below be fast-forwarded instead of actually waited out.
    vi.useFakeTimers();
    try {
      const context = makeFakeContext();
      // Alive on every check until after killProcessTree is called, then gone.
      let killed = false;
      const deps = makeFakeDeps({
        findOwningProcessIds: vi.fn().mockImplementation(async () => (killed ? [] : [4242])),
        killProcessTree: vi.fn().mockImplementation(async () => {
          killed = true;
        }),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      });

      const closePromise = closePersistentChrome(context, "./.fake-profile", deps);
      await vi.advanceTimersByTimeAsync(20_000); // past both the wait timeout and the post-kill re-check window
      await closePromise;

      expect(deps.killProcessTree).toHaveBeenCalledWith(4242);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not interact with any process the deps didn't report as owning this profile", async () => {
    // findOwningProcessIds here never reports empty, so closePersistentChrome's wait loop runs
    // out its real timeout before force-killing -- fake timers again (see the timeout test
    // above) so this doesn't cost real wall-clock time.
    vi.useFakeTimers();
    try {
      const context = makeFakeContext();
      const deps = makeFakeDeps({
        findOwningProcessIds: vi.fn().mockResolvedValue([111, 222]),
        killProcessTree: vi.fn().mockResolvedValue(undefined),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      });

      const closePromise = closePersistentChrome(context, "./.fake-profile", deps);
      await vi.advanceTimersByTimeAsync(20_000);
      await closePromise;

      // Only the specific pids findOwningProcessIds actually returned are ever touched --
      // never a broader "kill all chrome.exe" or anything not sourced from the scoped lookup.
      expect(deps.killProcessTree).toHaveBeenCalledTimes(2);
      expect(deps.killProcessTree).toHaveBeenCalledWith(111);
      expect(deps.killProcessTree).toHaveBeenCalledWith(222);
      expect(deps.killProcessTree).not.toHaveBeenCalledWith(999);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("uniqueChromeProfileDir", () => {
  it("generates a distinct directory path on each call, never the shared default", () => {
    const a = uniqueChromeProfileDir();
    const b = uniqueChromeProfileDir();
    expect(a).not.toBe(b);
    expect(a).not.toBe("./.chrome-profile");
    expect(a).toContain(".chrome-profile-run-");
  });
});

describe("registerShutdownOnSignal", () => {
  it("registers exactly one SIGINT listener, and the returned unregister function removes it", () => {
    const context = makeFakeContext();
    const before = process.listenerCount("SIGINT");

    const unregister = registerShutdownOnSignal(context, "./.fake-profile", makeFakeDeps());
    expect(process.listenerCount("SIGINT")).toBe(before + 1);

    unregister();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  // SIGTERM/uncaughtException/unhandledRejection: same registration-count pattern as SIGINT
  // above, deliberately never actually emitted -- the real handler calls process.exit(), which
  // would kill the test runner itself. Registration/unregistration is what's under test here;
  // the handler's own close-then-exit behavior is exercised indirectly via closePersistentChrome's
  // own dedicated tests above (same function, just invoked directly instead of through a signal).
  it("also registers SIGTERM, uncaughtException, and unhandledRejection listeners, all removed together", () => {
    const context = makeFakeContext();
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      uncaught: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
    };

    const unregister = registerShutdownOnSignal(context, "./.fake-profile", makeFakeDeps());
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
    expect(process.listenerCount("unhandledRejection")).toBe(before.unhandledRejection + 1);

    unregister();
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(before.unhandledRejection);
  });

  it("never touches an unrelated Chrome process -- registration alone launches/closes nothing", () => {
    const deps = makeFakeDeps();
    const context = makeFakeContext();

    const unregister = registerShutdownOnSignal(context, "./.fake-profile", deps);
    unregister();

    expect(deps.findOwningProcessIds).not.toHaveBeenCalled();
    expect(deps.killProcessTree).not.toHaveBeenCalled();
  });
});

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
});

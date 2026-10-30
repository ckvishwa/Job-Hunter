import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCareerOpsScan } from "../../../src/sources/careerops/careerops-runner.js";
import type { CareerOpsPreflightResult } from "../../../src/sources/careerops/careerops-preflight.js";

const HOME = "C:/fake/career-ops";

const PASSING_PREFLIGHT: CareerOpsPreflightResult = {
  ok: true,
  careerOpsHome: HOME,
  scanScriptPath: `${HOME}/scan-ats-full.mjs`,
  currentCommit: "abc123",
  errors: [],
  warnings: [],
};

const FAILING_PREFLIGHT: CareerOpsPreflightResult = {
  ok: false,
  careerOpsHome: HOME,
  errors: [{ code: "HOME_NOT_FOUND", message: "not found" }],
  warnings: [],
};

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function baseOptions(overrides: Partial<Parameters<typeof runCareerOpsScan>[0]> = {}) {
  return { careerOpsHome: HOME, sinceDays: 7, timeoutMs: 5000, ...overrides };
}

// runCareerOpsScan awaits preflightFn (a resolved-but-still-a-real-Promise mock) before ever
// calling spawnFn -- so spawnFn's target child process doesn't exist yet at the exact moment
// runCareerOpsScan() is called. Emitting events on `child` before spawnFn has actually run would
// be emitting into a void (no listeners attached yet, events lost, "error" would throw
// synchronously with no listener). Wait for the real spawn call first, every time.
async function waitForSpawn(spawnFn: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => {
    if (spawnFn.mock.calls.length === 0) throw new Error("spawnFn not called yet");
  });
}

function spawnFnReturning(child: FakeChildProcess) {
  return vi.fn((_command: string, _args: string[], _options: { cwd: string; shell: boolean }) => child);
}

describe("runCareerOpsScan - preflight gating", () => {
  test("does not spawn when preflight fails, and reports preflight-failed", async () => {
    const spawnFn = vi.fn();
    const preflightFn = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);

    const result = await runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.kind).toBe("preflight-failed");
    if (result.kind === "preflight-failed") {
      expect(result.preflight).toBe(FAILING_PREFLIGHT);
    }
  });

  test("does not spawn when options are invalid (sinceDays not a positive integer)", async () => {
    const spawnFn = vi.fn();
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const result = await runCareerOpsScan(baseOptions({ sinceDays: 0 }), { spawnFn, preflightFn });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(preflightFn).not.toHaveBeenCalled();
    expect(result.kind).toBe("invalid-options");
  });

  test("rejects an unsupported ATS source without spawning", async () => {
    const spawnFn = vi.fn();
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const result = await runCareerOpsScan(
      baseOptions({ atsSources: ["greenhouse", "bogus" as never] }),
      { spawnFn, preflightFn },
    );

    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.kind).toBe("invalid-options");
  });
});

describe("runCareerOpsScan - process invocation", () => {
  test("spawns process.execPath with the scan script, cwd, and shell:false", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stdout.emit("data", Buffer.from('{"date":"x"}'));
    child.emit("close", 0);
    await promise;

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [exe, args, opts] = spawnFn.mock.calls[0]!;
    expect(exe).toBe(process.execPath);
    expect(args[0]).toBe(PASSING_PREFLIGHT.scanScriptPath);
    expect(opts).toMatchObject({ cwd: HOME, shell: false });
  });

  test("always includes --json; --since reflects sinceDays", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions({ sinceDays: 14 }), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stdout.emit("data", Buffer.from('{"date":"x"}'));
    child.emit("close", 0);
    await promise;

    const args = spawnFn.mock.calls[0]![1] as string[];
    expect(args).toContain("--json");
    const sinceIdx = args.indexOf("--since");
    expect(sinceIdx).toBeGreaterThan(-1);
    expect(args[sinceIdx + 1]).toBe("14");
  });

  test("--limit reflects atsCompanyLimit (not a Hunt output limit) and is omitted when not supplied", async () => {
    const child1 = new FakeChildProcess();
    const spawnFn1 = spawnFnReturning(child1);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const p1 = runCareerOpsScan(baseOptions({ atsCompanyLimit: 3 }), { spawnFn: spawnFn1, preflightFn });
    await waitForSpawn(spawnFn1);
    child1.stdout.emit("data", Buffer.from('{"date":"x"}'));
    child1.emit("close", 0);
    await p1;
    const args1 = spawnFn1.mock.calls[0]![1] as string[];
    const limitIdx = args1.indexOf("--limit");
    expect(limitIdx).toBeGreaterThan(-1);
    expect(args1[limitIdx + 1]).toBe("3");

    const child2 = new FakeChildProcess();
    const spawnFn2 = spawnFnReturning(child2);
    const p2 = runCareerOpsScan(baseOptions(), { spawnFn: spawnFn2, preflightFn });
    await waitForSpawn(spawnFn2);
    child2.stdout.emit("data", Buffer.from('{"date":"x"}'));
    child2.emit("close", 0);
    await p2;
    const args2 = spawnFn2.mock.calls[0]![1] as string[];
    expect(args2).not.toContain("--limit");
  });

  test("--ats reflects atsSources joined by comma", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions({ atsSources: ["greenhouse", "lever"] }), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stdout.emit("data", Buffer.from('{"date":"x"}'));
    child.emit("close", 0);
    await promise;

    const args = spawnFn.mock.calls[0]![1] as string[];
    const atsIdx = args.indexOf("--ats");
    expect(atsIdx).toBeGreaterThan(-1);
    expect(args[atsIdx + 1]).toBe("greenhouse,lever");
  });
});

describe("runCareerOpsScan - outcome classification", () => {
  const VALID_SCAN_RESULT = {
    date: "2026-07-29",
    sources: ["greenhouse"],
    resumed: false,
    sinceDays: 7,
    companiesAvailable: 1,
    companiesScanned: 1,
    capHit: false,
    datasetStatus: { greenhouse: "ok" },
    postingsKept: 0,
    postingsDroppedNoDate: 0,
    postingsFilteredBlacklist: 0,
    postingsAnnotatedBlacklisted: 0,
    postingsDroppedContent: 0,
    unreachableBoards: 0,
    cappedBoards: 0,
    saved: false,
    offers: [],
  };

  test("clean JSON stdout + exit 0 succeeds, stderr preserved", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stdout.emit("data", Buffer.from(JSON.stringify(VALID_SCAN_RESULT)));
    child.stderr.emit("data", Buffer.from("some progress log\n"));
    child.emit("close", 0);
    const result = await promise;

    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.result.date).toBe("2026-07-29");
      expect(result.stderr).toBe("some progress log\n");
    }
  });

  test("empty stdout on exit 0 fails clearly as empty-stdout", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.emit("close", 0);
    const result = await promise;

    expect(result.kind).toBe("empty-stdout");
  });

  test("invalid JSON stdout fails clearly as invalid-json", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stdout.emit("data", Buffer.from("{not json"));
    child.emit("close", 0);
    const result = await promise;

    expect(result.kind).toBe("invalid-json");
  });

  test("structurally invalid (schema-failing) top-level JSON fails as invalid-scan-result", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stdout.emit("data", Buffer.from(JSON.stringify({ unexpected: true })));
    child.emit("close", 0);
    const result = await promise;

    expect(result.kind).toBe("invalid-scan-result");
  });

  test("non-zero exit returns stderr and exit code", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.stderr.emit("data", Buffer.from("Error: unknown ATS source(s): bogus."));
    child.emit("close", 1);
    const result = await promise;

    expect(result.kind).toBe("non-zero-exit");
    if (result.kind === "non-zero-exit") {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown ATS source");
    }
  });

  test("spawn error (e.g. ENOENT) is handled, not thrown", async () => {
    const child = new FakeChildProcess();
    const spawnFn = spawnFnReturning(child);
    const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

    const promise = runCareerOpsScan(baseOptions(), { spawnFn, preflightFn });
    await waitForSpawn(spawnFn);
    child.emit("error", new Error("spawn ENOENT"));
    const result = await promise;

    expect(result.kind).toBe("spawn-error");
  });

  test("timeout kills the child process and resolves with a timeout outcome", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const spawnFn = spawnFnReturning(child);
      const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

      const promise = runCareerOpsScan(baseOptions({ timeoutMs: 1000 }), { spawnFn, preflightFn });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  test("exit/timeout/error race settles exactly once", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess();
      const spawnFn = spawnFnReturning(child);
      const preflightFn = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);

      const promise = runCareerOpsScan(baseOptions({ timeoutMs: 1000 }), { spawnFn, preflightFn });
      await vi.advanceTimersByTimeAsync(1000); // timeout fires, kill() called
      child.emit("close", null); // the killed process eventually "closes" too -- must be ignored
      child.emit("error", new Error("late error")); // must also be ignored

      const result = await promise;
      expect(result.kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("module import safety", () => {
  test("importing the runner module alone does not spawn anything", async () => {
    // If import-time execution occurred, it would have thrown or produced side effects long
    // before this test file's other tests (which all pass an explicit spawnFn) ran. This test
    // just documents/asserts the module has no top-level call -- re-importing is a cache hit
    // and inherently side-effect-free once already loaded, so the real guarantee is structural
    // (no top-level `runCareerOpsScan(...)` in the source) and is verified by code review.
    const mod = await import("../../../src/sources/careerops/careerops-runner.js");
    expect(typeof mod.runCareerOpsScan).toBe("function");
  });
});

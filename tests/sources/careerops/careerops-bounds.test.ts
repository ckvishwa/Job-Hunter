import { describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runCareerOpsScan } from "../../../src/sources/careerops/careerops-runner.js";
import type { CareerOpsPreflightResult } from "../../../src/sources/careerops/careerops-preflight.js";

const PASSING: CareerOpsPreflightResult = {
  ok: true,
  careerOpsHome: "C:/fake/career-ops",
  scanScriptPath: "C:/fake/career-ops/scan-ats-full.mjs",
  currentCommit: "dff9703a",
  errors: [],
  warnings: [],
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

describe("careerops process bounds", () => {
  test("stops when stdout exceeds the cap", async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child);
    const promise = runCareerOpsScan(
      { careerOpsHome: PASSING.careerOpsHome, sinceDays: 1, timeoutMs: 5000, maxStdoutBytes: 8, atsSources: ["bamboohr"] },
      { spawnFn, preflightFn: async () => PASSING },
    );
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalled());
    child.stdout.emit("data", Buffer.from("0123456789"));
    child.emit("close", null);
    const result = await promise;
    expect(result.kind).toBe("stdout-capped");
    expect(child.kill).toHaveBeenCalled();
  });

  test("accepts the pinned scanner's bamboohr family", async () => {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child);
    const promise = runCareerOpsScan(
      { careerOpsHome: PASSING.careerOpsHome, sinceDays: 1, timeoutMs: 5000, atsSources: ["bamboohr"] },
      { spawnFn, preflightFn: async () => PASSING },
    );
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalled());
    const call = spawnFn.mock.calls[0] as unknown as [string, string[]] | undefined;
    expect(call?.[1].join(" ")).toContain("--ats bamboohr");
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      date: "2026-10-21", sources: ["bamboohr"], resumed: false, sinceDays: 1,
      companiesAvailable: 1, companiesScanned: 0, capHit: false, datasetStatus: {},
      postingsKept: 0, postingsDroppedNoDate: 0, postingsFilteredBlacklist: 0,
      postingsAnnotatedBlacklisted: 0, postingsDroppedContent: 0, unreachableBoards: 0,
      cappedBoards: 0, saved: false, offers: [],
    })));
    child.emit("close", 0);
    expect((await promise).kind).toBe("success");
  });
});

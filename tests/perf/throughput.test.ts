import { describe, expect, it } from "vitest";
import { throughput } from "../../src/perf/throughput.js";

describe("throughput instrumentation", () => {
  it("keeps a synthetic timing run distinct from live coverage", () => {
    const report = throughput({
      condition: "synthetic",
      requests: 4,
      durationsMs: [10, 20, 30, 40],
      uniqueVerifiedRelevant: 2,
      wallMs: 60_000,
      falseDuplicates: 1,
      comparisons: 4,
      notes: "fixture",
    });
    expect(report.condition).toBe("synthetic");
    expect(report.uniqueVerifiedRelevantPerMinute).toBe(2);
    expect(report.falseDuplicateRate).toBe(0.25);
    expect(report.latency.p95Ms).toBe(40);
  });
});

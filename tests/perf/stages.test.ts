import { describe, expect, it } from "vitest";
import { percentile, StageProfiler } from "../../src/perf/stages.js";
import { classifyCandidatePosting } from "../../src/jobs/runner.js";
import type { DiscoveryPlan } from "../../src/jobs/planner.js";

const plan: DiscoveryPlan = {
  selectionRevisionNo: 1,
  catalogVersion: 1,
  roles: [{ roleSlug: "soc-analyst", title: "SOC Analyst", phrases: ["soc analyst"] }],
  locations: [],
  workModes: [],
  seniorityLevels: [],
  searchBand: { minYears: 0, maxYears: 5 },
};

describe("stage profiler", () => {
  it("reports p50 and p95 and leaves unmeasured stages at zero", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    const profiler = new StageProfiler();
    profiler.record("normalization", 10);
    profiler.record("normalization", 30, { failed: true, retries: 1 });
    const report = profiler.report();
    const normalization = report.stages.find((stage) => stage.stage === "normalization");
    expect(normalization).toMatchObject({ count: 2, failures: 1, retries: 1, p50Ms: 10, p95Ms: 30 });
    expect(report.stages.find((stage) => stage.stage === "browser-navigation")?.count).toBe(0);
  });

  it("classifies an unselected role without dropping the ability to record it", () => {
    const filtered = classifyCandidatePosting({ title: "Account Executive", location: "Remote" }, plan, []);
    const selected = classifyCandidatePosting({ title: "SOC Analyst", location: "Remote" }, plan, []);
    expect(filtered).toMatchObject({ disposition: "filtered", filterReason: "not-a-selected-role" });
    expect(selected.disposition).toBe("selected");
  });
});

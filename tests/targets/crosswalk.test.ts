import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateCrosswalkFiles } from "../../src/targets/crosswalk.js";

const docs = path.resolve("docs");

describe("83-target identity crosswalk", () => {
  const report = validateCrosswalkFiles(
    path.join(docs, "job_hunter_target_companies_68.json"),
    path.join(docs, "job_hunter_new_40_mapping.csv"),
    path.join(docs, "job_hunter_target_companies_83.json"),
  );

  it("keeps 68 original ids, 40 mapping rows, 25 overlaps, and 83 merged employers", () => {
    expect(report.discrepancies).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.originalCount).toBe(68);
    expect(report.mappingRows).toBe(40);
    expect(report.overlapCanonicalIds).toBe(25);
    expect(report.addedCanonicalIds).toBe(15);
    expect(report.mergedCount).toBe(83);
  });

  it("keeps brand and parent relationships from collapsing requisition identity", () => {
    expect(report.identityChecks.every((check) => check.ok)).toBe(true);
  });
});

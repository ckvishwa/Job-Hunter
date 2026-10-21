import { describe, expect, it } from "vitest";
import { skillExtractionGate } from "../../src/resume/skill-gate.js";

describe("resume skill evaluation gate", () => {
  const perfect = {
    truePositives: 400,
    falsePositives: 0,
    falseNegatives: 0,
    sourceEvidenceValid: 400,
    sourceEvidenceChecked: 400,
    routineApprovals: 0,
    processingFailures: 0,
    independentReviewer: true,
    frozenBeforeScoring: true,
    tunedOnThisSet: false,
    sampleSize: 400,
  };

  it("accepts a large independent untouched set whose Wilson lower bound clears 99%", () => {
    const result = skillExtractionGate(perfect);
    expect(result.status).toBe("MET");
    expect(result.precisionLower95).toBeGreaterThanOrEqual(0.99);
    expect(result.recallLower95).toBeGreaterThanOrEqual(0.99);
  });

  it("does not treat a perfect score on the author's own small set as 99%", () => {
    const result = skillExtractionGate({ ...perfect, truePositives: 20, sourceEvidenceValid: 20, sourceEvidenceChecked: 20, sampleSize: 20, independentReviewer: false });
    expect(result.status).toBe("NOT_MET");
    expect(result.reasons.join(" ")).toContain("independent");
  });

  it("counts a processing failure as a failure", () => {
    expect(skillExtractionGate({ ...perfect, processingFailures: 1 }).status).toBe("NOT_MET");
  });
});

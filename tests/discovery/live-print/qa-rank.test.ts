import { describe, expect, test } from "vitest";
import { assessQaJob } from "../../../src/discovery/live-print/qa-rank.js";

describe("full-description QA relevance and evidence-gated eligibility", () => {
  test("uses responsibilities and skills in the JD, not only the title", () => {
    const result = assessQaJob({ title: "Quality Engineer I", location: "Remote - US", approvedFacts: [], description: "Build test automation with Python, Selenium, and API testing. Write regression test cases and quality plans." });
    expect(result.relevant).toBe(true);
    expect(result.score).toBeGreaterThan(50);
    expect(result.reasons.join(" ")).toContain("testing/quality responsibilities");
  });

  test("includes a junior tester when the full JD describes software QA work", () => {
    const result = assessQaJob({ title: "Junior Tester", location: "Remote/Onsite if local to Maryland", approvedFacts: [], description: "Execute software test cases, report defects, perform regression testing, and update test scripts." });
    expect(result.relevant).toBe(true);
  });

  test("keeps preferred skills relevant but never turns unknown authorization into a failure", () => {
    const result = assessQaJob({ title: "Junior SDET", location: "Remote in Mexico", approvedFacts: [], description: "Python and Selenium preferred. This role is remote in Mexico. Must have work authorization in Mexico." });
    expect(result.eligibility).toBe("NEEDS_VERIFICATION");
    expect(result.eligibilityEvidence.length).toBeGreaterThan(0);
    expect(result.group).toBe("verification_required");
  });

  test("extracts explicit experience quote from the full JD", () => {
    const result = assessQaJob({ title: "QA Automation Engineer", location: "New York, NY", approvedFacts: [], description: "Responsibilities include automation. Candidates should have at least 2 years of professional experience with test automation." });
    expect(result.requiredExperience.toLowerCase()).toContain("2 years");
  });
});

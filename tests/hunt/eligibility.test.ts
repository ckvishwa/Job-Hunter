import { describe, expect, it } from "vitest";
import { classifyEligibility } from "../../src/hunt/eligibility.js";

describe("classifyEligibility", () => {
  describe("title-based rejection (senior-tier terms)", () => {
    const rejectTitles = [
      ["Senior SDET", "senior"],
      ["Sr. Software Engineer", "senior"],
      ["Staff QA Engineer", "staff"],
      ["Principal Security Engineer", "principal"],
      ["Team Lead, Network Operations", "lead"],
      ["Engineering Manager", "manager"],
      ["Director of Security", "director"],
      ["Solutions Architect", "architect"],
    ] as const;

    for (const [title, expectedTerm] of rejectTitles) {
      it(`rejects "${title}"`, () => {
        const result = classifyEligibility(title, "");
        expect(result.eligible).toBe(false);
        expect(result.reasons.join(" ").toLowerCase()).toContain(expectedTerm);
      });
    }
  });

  describe("title-based acceptance (junior/entry-tier terms)", () => {
    const acceptTitles: [string, string][] = [
      ["SDET Intern", "internship"],
      ["Entry Level SDET", "entry-level"],
      ["Junior QA Engineer", "junior"],
      ["Jr. Network Engineer", "junior"],
      ["Associate Security Analyst", "associate"],
      ["Software Engineer, Level I", "level-1"],
      ["Software Engineer Level 1", "level-1"],
    ];

    for (const [title, expectedTier] of acceptTitles) {
      it(`accepts "${title}" as ${expectedTier}`, () => {
        const result = classifyEligibility(title, "");
        expect(result.eligible).toBe(true);
        expect(result.seniority).toBe(expectedTier);
      });
    }
  });

  it("does not reject a title merely because the JD mentions working with senior engineers", () => {
    const result = classifyEligibility(
      "SDET I",
      "You will work closely with senior engineers and the engineering manager on this team.",
    );
    expect(result.eligible).toBe(true);
    expect(result.seniority).toBe("level-1");
  });

  describe("years-based fallback (title has no seniority signal)", () => {
    it("rejects when the JD explicitly requires more than 4 years (X+ form)", () => {
      const result = classifyEligibility("Software Engineer", "Requires 5+ years of experience.");
      expect(result.eligible).toBe(false);
      expect(result.requiredYearsMin).toBe(5);
      expect(result.reasons.join(" ")).toMatch(/years/);
    });

    it("rejects when the JD explicitly requires a range whose max exceeds 4 years", () => {
      const result = classifyEligibility("Software Engineer", "3-6 years of relevant experience required.");
      expect(result.eligible).toBe(false);
      expect(result.requiredYearsMin).toBe(3);
      expect(result.requiredYearsMax).toBe(6);
    });

    it("accepts a 0-3 years range as entry-level", () => {
      const result = classifyEligibility("Software Engineer", "0-3 years of experience required.");
      expect(result.eligible).toBe(true);
      expect(result.seniority).toBe("entry-level");
      expect(result.requiredYearsMin).toBe(0);
      expect(result.requiredYearsMax).toBe(3);
    });

    it("accepts a single-number years requirement of 2 years", () => {
      const result = classifyEligibility("Software Engineer", "2 years of experience with test automation.");
      expect(result.eligible).toBe(true);
      expect(result.requiredYearsMin).toBe(2);
    });

    it("treats no years signal at all as eligible but unknown seniority", () => {
      const result = classifyEligibility("Software Engineer", "We build great software together.");
      expect(result.eligible).toBe(true);
      expect(result.seniority).toBe("unknown");
      expect(result.requiredYearsMin).toBeNull();
      expect(result.requiredYearsMax).toBeNull();
    });

    it("treats a 4-year requirement as eligible (not explicitly more than 4)", () => {
      const result = classifyEligibility("Software Engineer", "4 years of experience required.");
      expect(result.eligible).toBe(true);
      expect(result.requiredYearsMin).toBe(4);
    });
  });

  it("never scans descriptionText for senior/staff/lead/manager words", () => {
    const result = classifyEligibility(
      "QA Automation Engineer",
      "This role reports to a Senior Manager and partners with our Staff Architect team.",
    );
    expect(result.eligible).toBe(true);
    expect(result.seniority).toBe("unknown");
  });
});

import { describe, expect, it } from "vitest";
import { summarizeExperience, unionRanges, monthLabel } from "../../src/roles/experience.js";
import { emp, makeFact } from "./helpers.js";

// Expected values are worked out by hand from the documented convention (month precision; lower bound = [start, end),
// upper bound = [start, end]; overlaps merged; a current job ends at the asOf month), not produced by the code under test.
// Month indexes below are relative to Jan 2020 = 0 in the comments.

const ASOF = "2026-10-09";
const pro = (s: ReturnType<typeof summarizeExperience>) => s.buckets.professional;

describe("summarizeExperience: professional time", () => {
  it("a single closed job: lower bound excludes the end month, upper bound includes both ends", () => {
    // Jan 2020 .. Dec 2020. Lower [0,11) = 11 months. Upper [0,12) = 12 months.
    const s = summarizeExperience([emp("a", "2020-01", "2020-12", "professional")], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([11, 12]);
    expect(pro(s).gaps).toEqual([]);
    expect(s.status).toBe("OK");
    expect(s.precision).toBe("month");
  });

  it("two overlapping jobs are counted once in the overlap", () => {
    // A Jan2020..Dec2020 = [0,11)/[0,12); B Jun2020..Mar2021 = [5,14)/[5,15). Union lower [0,14)=14, upper [0,15)=15.
    const s = summarizeExperience([emp("a", "2020-01", "2020-12", "professional", { employer: "Alpha" }), emp("b", "2020-06", "2021-03", "professional", { employer: "Beta" })], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([14, 15]);
    // Naive sum would be 11 + 9 = 20 (lower): the overlap must not be double counted.
    expect(pro(s).monthsLower).toBeLessThan(20);
    expect(s.issues.filter((i) => i.code === "OVERLAP_SAME_EMPLOYER")).toEqual([]);
  });

  it("a job fully inside another adds nothing", () => {
    const s = summarizeExperience([emp("a", "2020-01", "2021-01", "professional", { employer: "Alpha" }), emp("b", "2020-04", "2020-08", "professional", { employer: "Beta" })], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([12, 13]);
  });

  it("adjacent jobs merge: end month equal to the next start month", () => {
    // A Jan..Jun 2020, B Jun..Dec 2020. Lower [0,5)+[5,11) = 11. Upper [0,6)u[5,12) = 12. No gap.
    const s = summarizeExperience([emp("a", "2020-01", "2020-06", "professional", { employer: "Alpha" }), emp("b", "2020-06", "2020-12", "professional", { employer: "Beta" })], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([11, 12]);
    expect(pro(s).gaps).toEqual([]);
  });

  it("a job that ends one month and the next that starts the following month is not a gap", () => {
    // A Jan..Jun, B Jul..Dec 2020. Upper [0,6) and [6,12) touch: 12, no gap. Lower 5 + 5 = 10 (each end month uncounted).
    const s = summarizeExperience([emp("a", "2020-01", "2020-06", "professional", { employer: "Alpha" }), emp("b", "2020-07", "2020-12", "professional", { employer: "Beta" })], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([10, 12]);
    expect(pro(s).gaps).toEqual([]);
  });

  it("a real gap remains a gap and is reported", () => {
    // A Jan..Mar 2020 upper [0,3); B Jul..Sep 2020 upper [6,9). Uncovered: Apr, May, Jun = 3 months. Lower 2 + 2 = 4, upper 3 + 3 = 6.
    const s = summarizeExperience([emp("a", "2020-01", "2020-03", "professional", { employer: "Alpha" }), emp("b", "2020-07", "2020-09", "professional", { employer: "Beta" })], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([4, 6]);
    expect(pro(s).gaps).toEqual([{ from: "2020-04", to: "2020-06", months: 3 }]);
  });

  it("a current job ends at the fixed asOf month, so the result depends only on asOf", () => {
    // Start Jan 2024, asOf 2024-03-15 (month index 2): lower [0,2) = 2, upper [0,3) = 3.
    const job = emp("a", "2024-01", null, "professional");
    const early = summarizeExperience([job], "2024-03-15");
    expect([pro(early).monthsLower, pro(early).monthsUpper]).toEqual([2, 3]);
    // asOf 2025-03-15 -> index 14: lower 14, upper 15.
    const later = summarizeExperience([job], "2025-03-15");
    expect([pro(later).monthsLower, pro(later).monthsUpper]).toEqual([14, 15]);
    expect(summarizeExperience([job], "2024-03-15")).toEqual(early); // deterministic
  });

  it("a job that starts and ends in the same month: zero certain months, at most one", () => {
    const s = summarizeExperience([emp("a", "2020-05", "2020-05", "professional")], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([0, 1]);
  });

  it("a reversed range is reported for review and never counted", () => {
    const s = summarizeExperience([emp("a", "2020-06", "2019-12", "professional")], ASOF);
    expect(pro(s).monthsLower).toBe(0);
    expect(pro(s).monthsUpper).toBe(0);
    expect(s.status).toBe("REVIEW");
    expect(s.issues.map((i) => i.code)).toContain("INVALID_DATE_RANGE");
    expect(s.entries.find((e) => e.factId === "a")?.counted).toBe(false);
  });

  it("a missing end date is unknown, not 'until today': reported for review and not counted", () => {
    const noEnd = makeFact({ id: "n", kind: "employment", value: "Employer n", attributes: { employer: "N", startDate: "2020-01", employmentType: "professional" } });
    const s = summarizeExperience([noEnd], ASOF);
    expect(pro(s).monthsUpper).toBe(0);
    expect(s.status).toBe("REVIEW");
    expect(s.issues.map((i) => [i.code, i.severity])).toEqual([["MISSING_END_DATE", "review"]]);
    // The same job marked current (explicit null) is counted to asOf.
    expect(pro(summarizeExperience([emp("c", "2020-01", null, "professional")], ASOF)).monthsUpper).toBeGreaterThan(0);
  });

  it("study without an end date is not counted either (warning only)", () => {
    const study = makeFact({ id: "m", kind: "education", value: "M.S. Cybersecurity", attributes: { startDate: "2022-08" } });
    const s = summarizeExperience([study], ASOF);
    expect(s.academicStudy.monthsUpper).toBe(0);
    expect(s.issues.map((i) => [i.code, i.severity])).toEqual([["MISSING_END_DATE", "warning"]]);
    expect(s.status).toBe("NO_DATA");
  });

  it("a start after asOf is not counted and needs review", () => {
    const s = summarizeExperience([emp("a", "2027-02", null, "professional")], ASOF);
    expect(pro(s).monthsUpper).toBe(0);
    expect(s.issues.map((i) => i.code)).toContain("FUTURE_START");
    expect(s.status).toBe("REVIEW");
  });

  it("an end after asOf is counted only up to asOf and warned about", () => {
    // Start Sep 2026, end Jan 2027, asOf Oct 2026: clamped end = Oct. Lower [0,1) = 1, upper [0,2) = 2.
    const s = summarizeExperience([emp("a", "2026-09", "2027-01", "professional")], ASOF);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([1, 2]);
    expect(s.issues.map((i) => i.code)).toContain("END_AFTER_AS_OF");
    expect(s.status).toBe("OK");
  });
});

describe("summarizeExperience: what must not count", () => {
  it("internship, academic and volunteer employment are separate buckets and add no professional time", () => {
    const s = summarizeExperience(
      [emp("i", "2021-06", "2021-08", "internship"), emp("r", "2021-09", "2022-05", "academic"), emp("v", "2020-01", "2020-12", "volunteer")],
      ASOF,
    );
    expect(pro(s).monthsLower).toBe(0);
    expect(pro(s).monthsUpper).toBe(0);
    expect([s.buckets.internship.monthsLower, s.buckets.internship.monthsUpper]).toEqual([2, 3]); // Jun..Aug 2021
    expect([s.buckets.academic.monthsLower, s.buckets.academic.monthsUpper]).toEqual([8, 9]); // Sep 2021..May 2022
    expect([s.buckets.volunteer.monthsLower, s.buckets.volunteer.monthsUpper]).toEqual([11, 12]);
  });

  it("a master's program is academic study, never professional experience", () => {
    const masters = makeFact({ id: "m", kind: "education", value: "M.S. Cybersecurity", attributes: { startDate: "2022-08", endDate: "2024-05" } });
    const s = summarizeExperience([masters, emp("j", "2024-06", "2025-06", "professional")], ASOF);
    expect([s.academicStudy.monthsLower, s.academicStudy.monthsUpper]).toEqual([21, 22]);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([12, 13]);
    expect(s.counts.education).toBe(1);
  });

  it("projects and skill mentions are counted as counts only, never as months or years", () => {
    const s = summarizeExperience(
      [
        makeFact({ id: "p", kind: "project", value: "Home SIEM lab", attributes: { startDate: "2019-01", endDate: "2024-01" } }),
        makeFact({ id: "s1", kind: "skill", value: "Splunk" }),
        makeFact({ id: "s2", kind: "skill", value: "Python" }),
        makeFact({ id: "c", kind: "certification", value: "Security+" }),
      ],
      ASOF,
    );
    expect(s.counts).toEqual({ projects: 1, skillMentions: 2, certifications: 1, education: 0 });
    for (const b of ["professional", "internship", "academic", "volunteer"] as const) expect(s.buckets[b].monthsUpper).toBe(0);
    expect(s.status).toBe("NO_DATA");
  });

  it("approved but unclassified employment is not counted and forces review", () => {
    const s = summarizeExperience([emp("a", "2020-01", "2022-01", undefined)], ASOF);
    expect(pro(s).monthsUpper).toBe(0);
    expect(s.status).toBe("REVIEW");
    expect(s.issues.find((i) => i.code === "UNCLASSIFIED_EMPLOYMENT")?.factId).toBe("a");
  });

  it("pending employment is not counted (warning); rejected and 'lacks' facts are ignored", () => {
    const s = summarizeExperience(
      [
        emp("p", "2020-01", "2022-01", "professional", {}, "pending"),
        emp("r", "2020-01", "2022-01", "professional", {}, "rejected"),
        makeFact({ id: "l", kind: "employment", value: "Never worked at X", polarity: "lacks", attributes: { employer: "X", startDate: "2020-01", employmentType: "professional" } }),
      ],
      ASOF,
    );
    expect(pro(s).monthsUpper).toBe(0);
    expect(s.issues.map((i) => [i.code, i.factId])).toEqual([["PENDING_EMPLOYMENT", "p"]]);
    expect(s.status).toBe("NO_DATA");
  });

  it("an expired approval does not count", () => {
    const expired = makeFact({
      id: "e", kind: "employment", value: "Employer e", validUntil: "2026-01-01",
      attributes: { employer: "E", startDate: "2020-01", endDate: "2022-01", employmentType: "professional" },
    });
    expect(pro(summarizeExperience([expired], ASOF)).monthsUpper).toBe(0);
  });

  it("flags a possible duplicate at the same employer but still counts the time once", () => {
    const s = summarizeExperience(
      [emp("a", "2020-01", "2021-01", "professional", { employer: "Same Co" }), emp("b", "2020-06", "2021-06", "professional", { employer: "same  co" })],
      ASOF,
    );
    expect(s.issues.map((i) => i.code)).toEqual(["OVERLAP_SAME_EMPLOYER"]);
    expect([pro(s).monthsLower, pro(s).monthsUpper]).toEqual([17, 18]); // Jan 2020..Jun 2021
  });

  it("lists which approved facts produced each bucket (evidence links)", () => {
    const s = summarizeExperience([emp("b", "2021-01", "2021-12", "professional"), emp("a", "2020-01", "2020-12", "professional")], ASOF);
    expect(pro(s).factIds).toEqual(["a", "b"]);
    expect(s.entries.map((e) => e.factId)).toEqual(["a", "b"]);
  });
});

describe("month helpers", () => {
  it("unionRanges merges touching and overlapping ranges and drops empty ones", () => {
    expect(unionRanges([[0, 3], [3, 5], [10, 12], [11, 14], [20, 20]])).toEqual({ total: 5 + 4, merged: [[0, 5], [10, 14]] });
  });
  it("monthLabel round-trips", () => {
    expect(monthLabel(2020 * 12)).toBe("2020-01");
    expect(monthLabel(2020 * 12 + 11)).toBe("2020-12");
  });
});

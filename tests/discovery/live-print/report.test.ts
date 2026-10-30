import { describe, expect, it } from "vitest";
import { isQaTitle } from "../../../src/discovery/live-print/qa-rank.js";
import { partitionShortlist, summarizeCoverage, type BoardOutcome, type EvaluatedJob } from "../../../src/discovery/live-print/report.js";

const job = (o: Partial<EvaluatedJob>): EvaluatedJob => ({ company: "A", title: "QA Engineer", location: "Austin, TX", ats: "greenhouse", requisitionId: "1", url: "https://x/1",
  sourceStatus: "HTTP 200", eligibility: "NEEDS_VERIFICATION", extractionStatus: "COMPLETE", score: 50, relevanceScore: 50, urlVerified: true, ...o });

describe("isQaTitle", () => {
  it("accepts QA/SDET titles and rejects unrelated or hardware ones", () => {
    for (const t of ["Junior QA Engineer", "SDET I", "Software Test Engineer", "QA Automation Engineer", "Associate Software Test Analyst", "Software Quality Engineer", "Automation Tester"]) expect(isQaTitle(t), t).toBe(true);
    for (const t of ["Senior Backend Engineer", "Account Executive", "Battery Test Engineer", "Mechanical Test Engineer"]) expect(isQaTitle(t), t).toBe(false);
  });
});

describe("partitionShortlist", () => {
  it("orders PASS first and never lets a high score outrank a better decision", () => {
    const { actionable } = partitionShortlist([job({ requisitionId: "a", eligibility: "NEEDS_VERIFICATION", score: 99 }), job({ requisitionId: "b", eligibility: "PASS", score: 10 })], 20);
    expect(actionable.map((j) => j.requisitionId)).toEqual(["b", "a"]);
  });
  it("keeps FAIL, extraction failures, non-US and unverified URLs out of the actionable list", () => {
    const { actionable, diagnostic } = partitionShortlist([
      job({ requisitionId: "fail", eligibility: "FAIL", score: 99 }), job({ requisitionId: "ext", extractionStatus: "EXTRACTION_FAILED", score: null }),
      job({ requisitionId: "mx", location: "Remote in Mexico" }), job({ requisitionId: "url", urlVerified: false }), job({ requisitionId: "ok" })], 20);
    expect(actionable.map((j) => j.requisitionId)).toEqual(["ok"]);
    expect(Object.fromEntries(diagnostic.map((d) => [d.job.requisitionId, d.reasons]))).toEqual({
      fail: ["FAIL_ELIGIBILITY"], ext: ["EXTRACTION_FAILED"], mx: ["NON_US_LOCATION"], url: ["URL_NOT_VERIFIED"] });
  });
  it("diverts staff/leadership titles and ranks senior titles after non-senior ones", () => {
    const { actionable, diagnostic } = partitionShortlist([job({ requisitionId: "s", title: "Senior QA Engineer", score: 90 }), job({ requisitionId: "j", title: "Junior QA Engineer", score: 10 }), job({ requisitionId: "st", title: "Staff Quality Engineer", score: 99 })], 20);
    expect(actionable.map((j) => j.requisitionId)).toEqual(["j", "s"]);
    expect(diagnostic.map((d) => [d.job.requisitionId, d.reasons])).toEqual([["st", ["SENIOR_LEADERSHIP_TITLE"]]]);
  });
  it("prints fewer than the limit without padding, zero when none qualify, and keeps same-title requisitions distinct", () => {
    expect(partitionShortlist([], 20).actionable).toEqual([]);
    const two = partitionShortlist([job({ requisitionId: "2" }), job({ requisitionId: "1" })], 20).actionable;
    expect(two.map((j) => j.requisitionId)).toEqual(["1", "2"]);
    expect(partitionShortlist([job({ requisitionId: "2" }), job({ requisitionId: "1" })], 1).actionable).toHaveLength(1);
  });
  it("is stable regardless of input order", () => {
    const rows = [job({ requisitionId: "3", score: 5 }), job({ requisitionId: "1", score: 5 }), job({ requisitionId: "2", score: 9 })];
    expect(partitionShortlist(rows, 20).actionable.map((j) => j.requisitionId)).toEqual(partitionShortlist([...rows].reverse(), 20).actionable.map((j) => j.requisitionId));
  });
});

describe("summarizeCoverage", () => {
  const base: BoardOutcome = { company: "A", ats: "greenhouse", board: "a", ownership: "CONFIRMED", failure: null, listings: 10, qaCandidates: 2, canonicalJobs: 2, fullJds: 2, urlsVerified: 2 };
  it("counts validated, unavailable, zero-opening boards per ATS and isolates failures", () => {
    const c = summarizeCoverage([base, { ...base, board: "b", listings: 0, qaCandidates: 0, canonicalJobs: 0, fullJds: 0, urlsVerified: 0 },
      { ...base, ats: "lever", board: "c", failure: { kind: "RATE_LIMITED", detail: "HTTP 429" } }, { ...base, board: "d", failure: { kind: "UNCONFIRMED_OWNER", detail: "no" } }]);
    expect(c.greenhouse).toMatchObject({ companiesAttempted: 3, boardsValidated: 2, boardsUnavailable: 1, zeroOpenings: 1, listingsReturned: 10, canonicalJobs: 2 });
    expect(c.lever.errors).toEqual([{ company: "A", kind: "RATE_LIMITED", detail: "HTTP 429" }]);
    expect(c.ashby.companiesAttempted).toBe(0);
  });
});

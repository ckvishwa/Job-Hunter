import { describe, expect, it } from "vitest";
import { decideMatch, type MatchDecision } from "../../src/match/intelligence.js";
import type { MatchReport } from "../../src/match/pipeline.js";

const requirement = (status: "SUPPORTED" | "UNSUPPORTED" | "PARTIAL" | "UNKNOWN", level: "required" | "preferred" = "required") => ({
  requirementId: `r-${level}`, value: "Python", type: "skill", level, effectiveLevel: level, applicable: true, mandatory: level === "required", status,
  explicitLack: false, matchedFactIds: status === "SUPPORTED" ? ["fact-1"] : [],
  support: status === "SUPPORTED" ? [{ factId: "fact-1", resumeId: "resume-1", category: "skill", value: "Python", quote: "Python", basis: "exact", strength: "mention" }] : [],
  notCounted: [], retrievalLeads: [], missingEvidence: status === "SUPPORTED" ? [] : ["Approved Python evidence"], explanation: "Evidence status", jd: { quote: "Python required", start: 20, end: 35 }, groupId: null, termRole: "single",
});

function report(required: "SUPPORTED" | "UNSUPPORTED" | "PARTIAL" | "UNKNOWN", options: { preferred?: boolean; blocker?: boolean; sponsorship?: boolean; quote?: string | null } = {}): MatchReport {
  const conditions = options.blocker ? [{ type: "work_authorization", jd: { status: "required", value: "United States", quote: options.quote === undefined ? "Must be authorized to work in the United States" : options.quote, start: 80, end: 127 }, candidateFactIds: ["attestation-1"], result: "BLOCKER", severity: "blocker", explanation: "Explicit attestation conflicts" }] : options.sponsorship ? [{ type: "sponsorship", jd: { status: "not_offered", value: null, quote: "No visa sponsorship", start: 80, end: 99 }, candidateFactIds: [], result: "UNKNOWN", severity: "needs-candidate-answer", explanation: "No candidate answer" }] : [];
  return {
    schema: "orbital-job-match-report/1", status: "COMPLETE", scoring: "NONE: statuses and evidence only; no match score, hiring probability or eligibility percentage exists",
    versions: { policy: "match-policy@1", profile: { profileId: "profile-1", profileRevisionNo: 1 }, jd: { jdSha256: "a".repeat(64) } },
    job: { title: "SDET", company: "Fixture", location: "Remote", url: "https://example.test/job", jdSha256: "a".repeat(64) },
    extraction: { providerRevision: "rules", requirements: 1, groups: 0, warnings: [], analysisWarnings: [] },
    summary: { required: { SUPPORTED: Number(required === "SUPPORTED"), PARTIAL: Number(required === "PARTIAL"), UNSUPPORTED: Number(required === "UNSUPPORTED"), UNKNOWN: Number(required === "UNKNOWN") }, preferred: { SUPPORTED: 0, PARTIAL: 0, UNSUPPORTED: 0, UNKNOWN: 0 }, criticalBlockers: options.blocker ? conditions as never : [], needsCandidateAnswer: options.sponsorship ? conditions as never : [], extractionGaps: [], missingRequiredEvidence: [] },
    conditions: conditions as never, arrangement: { mode: "remote", source: "jd-text", evidence: "This role is remote", selection: "MATCHES_SELECTION" },
    requirements: [requirement(required), ...(options.preferred ? [requirement("UNSUPPORTED", "preferred")] : [])] as never,
    alternativeGroups: [], itemRollups: [], retrieval: { rrfK: 60, encoder: null, semantic: "NOT_CONFIGURED", perRequirement: [] },
    evidence: { approvedProfessionalEmployment: 0, unitsSearched: 1, boundaryExcludedApproved: [], corpusExcluded: [] },
  };
}

describe("M4 evidence-grounded decision intelligence", () => {
  const evaluate = (r: MatchReport, options: Parameters<typeof decideMatch>[1] = {}): MatchDecision => decideMatch(r, options);

  it("shortlists a supported required skill while a missing preferred skill only affects ranking", () => {
    const d = evaluate(report("SUPPORTED", { preferred: true }));
    expect(d.outcome).toBe("SHORTLIST");
    expect(d.matched[0]).toMatchObject({ requirementId: "r-required", candidateFactIds: ["fact-1"], jd: { start: 20, end: 35 } });
    expect(d.missing).toHaveLength(1);
    expect(d.ranking?.score).toBeGreaterThanOrEqual(0);
    expect(d.ranking?.score).toBeLessThanOrEqual(100);
    expect(d.hardReject).toBe(false);
  });

  it("orders a preferred role and location higher without changing the decision", () => {
    const fit = evaluate(report("SUPPORTED"), { rolePreference: "MATCH", locationCompatibility: "MATCH", postingStatus: "RECENT" });
    const distant = evaluate(report("SUPPORTED"), { rolePreference: "MISMATCH", locationCompatibility: "MISMATCH", postingStatus: "RECENT" });
    expect(fit.outcome).toBe("SHORTLIST");
    expect(distant.outcome).toBe("SHORTLIST");
    expect(fit.ranking!.score).toBeGreaterThan(distant.ranking!.score);
    expect(Object.values(fit.ranking!.weights).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("never rejects on missing, partial, or unknown candidate evidence", () => {
    for (const status of ["UNSUPPORTED", "PARTIAL", "UNKNOWN"] as const) {
      const d = evaluate(report(status));
      expect(d.outcome).toBe("REVIEW_REQUIRED");
      expect(d.hardReject).toBe(false);
      expect(d.uncertain).toHaveLength(1);
    }
  });

  it("requires a quoted employer restriction, explicit contradictory attestation and enabled policy for rejection", () => {
    expect(evaluate(report("SUPPORTED", { blocker: true })).outcome).toBe("REJECT");
    expect(evaluate(report("SUPPORTED", { blocker: true, quote: null })).outcome).toBe("REVIEW_REQUIRED");
    expect(evaluate(report("SUPPORTED", { blocker: true }), { rejectOn: [] }).outcome).toBe("REVIEW_REQUIRED");
    const d = evaluate(report("SUPPORTED", { blocker: true }));
    expect(d.blocking[0]).toMatchObject({ rule: "explicit-attestation-conflict", candidateFactIds: ["attestation-1"] });
    expect(d.ranking).toBeNull();
  });

  it("keeps unknown sponsorship in review and never makes it a blanket rejection", () => {
    const d = evaluate(report("SUPPORTED", { sponsorship: true }));
    expect(d.outcome).toBe("REVIEW_REQUIRED");
    expect(d.hardReject).toBe(false);
  });

  it("keeps extraction failure and stale posting out of a shortlist", () => {
    const failed = { schema: "orbital-job-match-report/1", status: "EXTRACTION_FAILED", failure: { code: "BAD_JD", issues: [] }, versions: {}, note: "failed" } as MatchReport;
    expect(evaluate(failed).outcome).toBe("REVIEW_REQUIRED");
    expect(evaluate(report("SUPPORTED"), { postingStatus: "STALE" }).outcome).toBe("REVIEW_REQUIRED");
  });

  it("routes student-only, contradictory, and incompatible work arrangements to review", () => {
    const student = report("SUPPORTED");
    if (student.status !== "COMPLETE") throw new Error("fixture");
    student.extraction.analysisWarnings.push("STUDENT_ONLY_ELIGIBILITY_UNRESOLVED");
    expect(evaluate(student).outcome).toBe("REVIEW_REQUIRED");
    const contrary = report("SUPPORTED");
    if (contrary.status !== "COMPLETE") throw new Error("fixture");
    contrary.extraction.analysisWarnings.push("CONFLICTING_WORK_ARRANGEMENT");
    expect(evaluate(contrary).outcome).toBe("REVIEW_REQUIRED");
    const location = report("SUPPORTED");
    if (location.status !== "COMPLETE") throw new Error("fixture");
    location.arrangement.selection = "NOT_IN_SELECTION";
    expect(evaluate(location).outcome).toBe("REVIEW_REQUIRED");
  });
});

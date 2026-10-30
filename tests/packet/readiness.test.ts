import { describe, expect, it } from "vitest";
import { approvalSchema, evaluateReadiness, READINESS_STATES, type Approval, type ReadinessEvidence } from "../../src/packet/readiness.js";

const h = (c: string) => c.repeat(64);
const JD = h("a"), PROFILE = h("b"), RESUME = h("c"), FORM = h("d"), ANSWERS = h("e");
const approval = (kind: Approval["kind"], bound: Approval["bound"]): Approval => ({ kind, reviewer: "Test Applicant", reviewedAt: "2026-10-09T12:00:00.000Z", bound });
const ALL: Approval[] = [
  approval("eligibility", { jdHash: JD, profileDigest: PROFILE }),
  approval("resume", { jdHash: JD, resumeSha256: RESUME }),
  approval("form", { jdHash: JD, formFingerprint: FORM, answersDigest: ANSWERS, resumeSha256: RESUME }),
  approval("final", { jdHash: JD, profileDigest: PROFILE, resumeSha256: RESUME, formFingerprint: FORM, answersDigest: ANSWERS }),
];
// Everything satisfied: the only state from which READY_TO_SUBMIT is allowed.
const ready = (over: Partial<ReadinessEvidence> = {}): ReadinessEvidence => ({
  job: { discovered: true, postingLive: true, jdHash: JD, jdVerified: true },
  eligibility: { outcome: "ELIGIBLE", decidedForJdHash: JD, profileDigest: PROFILE, currentProfileDigest: PROFILE, coverageAttested: true },
  resume: { prepared: true, sha256: RESUME, preparedForJdHash: JD, unsupportedClaims: 0, previewOnly: false },
  form: { prepared: true, verified: true, formFingerprint: FORM, answersDigest: ANSWERS, requiredUnresolved: 0, mismatches: 0, preparedForJdHash: JD, resumeSha256: RESUME },
  approvals: ALL,
  submission: { independentEvidence: false },
  ...over,
});

describe("readiness state machine", () => {
  it("reaches READY_TO_SUBMIT only when every gate and every human approval is satisfied, and that is not SUBMITTED", () => {
    const r = evaluateReadiness(ready());
    expect(r.state).toBe("READY_TO_SUBMIT");
    expect(r.blockers).toEqual([]);
    expect(r.submitted).toBe(false);
    expect(r.satisfied).toEqual(["DISCOVERED", "JD_VERIFIED", "ELIGIBILITY_REVIEWED", "RESUME_PREPARED", "FORM_PREPARED", "FORM_VERIFIED", "READY_TO_SUBMIT"]);
  });

  it("stays in a review state when only the human approvals are outstanding", () => {
    const r = evaluateReadiness(ready({ approvals: [] }));
    expect(r.state).toBe("FORM_VERIFIED");
    expect(r.state).not.toBe("BLOCKED");
    expect(r.reviewsOutstanding).toEqual(["eligibility", "resume", "form", "final"]);
  });

  it("is never ready while eligibility is REVIEW, even with every approval", () => {
    const r = evaluateReadiness(ready({ eligibility: { outcome: "REVIEW", decidedForJdHash: JD, profileDigest: PROFILE, currentProfileDigest: PROFILE, coverageAttested: false } }));
    expect(r.state).not.toBe("READY_TO_SUBMIT");
    expect(r.blockers.join(" ")).toContain("REVIEW");
  });

  it("requires independent coverage attestation, an application-ready (non-preview) resume and zero unresolved required questions", () => {
    expect(evaluateReadiness(ready({ eligibility: { outcome: "ELIGIBLE", decidedForJdHash: JD, profileDigest: PROFILE, currentProfileDigest: PROFILE, coverageAttested: false } })).state).not.toBe("READY_TO_SUBMIT");
    expect(evaluateReadiness(ready({ resume: { prepared: true, sha256: RESUME, preparedForJdHash: JD, unsupportedClaims: 0, previewOnly: true } })).state).not.toBe("READY_TO_SUBMIT");
    expect(evaluateReadiness(ready({ form: { ...ready().form, requiredUnresolved: 1 } })).state).not.toBe("READY_TO_SUBMIT");
    expect(evaluateReadiness(ready({ resume: { prepared: true, sha256: RESUME, preparedForJdHash: JD, unsupportedClaims: null, previewOnly: false } })).state).not.toBe("READY_TO_SUBMIT");
  });

  it("blocks on hard blockers: REJECT, closed posting, unsupported resume claims, failed form readback", () => {
    expect(evaluateReadiness(ready({ eligibility: { outcome: "REJECT", decidedForJdHash: JD, profileDigest: PROFILE, currentProfileDigest: PROFILE, coverageAttested: true } })).state).toBe("BLOCKED");
    expect(evaluateReadiness(ready({ job: { discovered: true, postingLive: false, jdHash: JD, jdVerified: true } })).state).toBe("BLOCKED");
    expect(evaluateReadiness(ready({ resume: { prepared: true, sha256: RESUME, preparedForJdHash: JD, unsupportedClaims: 2, previewOnly: false } })).state).toBe("BLOCKED");
    expect(evaluateReadiness(ready({ form: { ...ready().form, mismatches: 1 } })).state).toBe("BLOCKED");
  });

  it("invalidates every dependent approval and blocks when the job description changes", () => {
    const NEW_JD = h("f");
    const r = evaluateReadiness(ready({ job: { discovered: true, postingLive: true, jdHash: NEW_JD, jdVerified: true } }));
    expect(r.state).toBe("BLOCKED");
    expect(r.validApprovals).toEqual([]);
    expect(r.invalidatedApprovals).toHaveLength(4);
    expect(r.blockers.join(" ")).toContain("job description changed");
  });

  it("voids only the approvals bound to a changed resume or changed form", () => {
    const newResume = h("1");
    const r = evaluateReadiness(ready({ resume: { prepared: true, sha256: newResume, preparedForJdHash: JD, unsupportedClaims: 0, previewOnly: false } }));
    expect(r.validApprovals).toEqual(["eligibility", "form"]);
    expect(r.invalidatedApprovals.map((x) => x.split(" ")[0])).toEqual(["resume", "final"]);
    expect(r.state).toBe("BLOCKED"); // the form was prepared with the old resume
    const newForm = evaluateReadiness(ready({ form: { ...ready().form, formFingerprint: h("2") } }));
    expect(newForm.validApprovals.sort()).toEqual(["eligibility", "resume"]);
    expect(newForm.state).not.toBe("READY_TO_SUBMIT");
  });

  it("voids approvals when the candidate profile changes after they were given", () => {
    const r = evaluateReadiness(ready({ eligibility: { outcome: "ELIGIBLE", decidedForJdHash: JD, profileDigest: PROFILE, currentProfileDigest: h("9"), coverageAttested: true } }));
    expect(r.validApprovals).toEqual(["resume", "form"]);
    expect(r.state).toBe("BLOCKED");
    expect(r.blockers.join(" ")).toContain("profile changed after the eligibility decision");
  });

  it("rejects, at the schema, an approval that is not bound to everything its kind depends on", () => {
    expect(approvalSchema.safeParse(approval("resume", { jdHash: JD })).success).toBe(false);
    expect(approvalSchema.safeParse(approval("final", { jdHash: JD })).success).toBe(false);
    for (const a of ALL) expect(approvalSchema.safeParse(a).success).toBe(true);
    expect(approvalSchema.safeParse({ ...ALL[0], reviewer: "" }).success).toBe(false);
  });

  it("only independent external evidence yields SUBMITTED; this repository never supplies it", () => {
    expect(evaluateReadiness(ready({ submission: { independentEvidence: true } })).state).toBe("SUBMITTED");
    expect(evaluateReadiness(ready()).state).not.toBe("SUBMITTED");
    expect(READINESS_STATES).toContain("SUBMITTED");
  });

  it("reports BLOCKED when the job was never recorded and stops at the last satisfied gate otherwise", () => {
    expect(evaluateReadiness(ready({ job: { discovered: false, postingLive: null, jdHash: null, jdVerified: false } })).state).toBe("BLOCKED");
    expect(evaluateReadiness(ready({ job: { discovered: true, postingLive: null, jdHash: JD, jdVerified: false } })).state).toBe("DISCOVERED");
    expect(evaluateReadiness(ready({ eligibility: { outcome: null, decidedForJdHash: null, profileDigest: null, currentProfileDigest: PROFILE, coverageAttested: false } })).state).toBe("JD_VERIFIED");
    expect(evaluateReadiness(ready({ resume: { prepared: false, sha256: null, preparedForJdHash: null, unsupportedClaims: null, previewOnly: true } })).state).toBe("ELIGIBILITY_REVIEWED");
    expect(evaluateReadiness(ready({ form: { ...ready().form, prepared: false } })).state).toBe("RESUME_PREPARED");
    expect(evaluateReadiness(ready({ form: { ...ready().form, verified: false } })).state).toBe("FORM_PREPARED");
  });
});

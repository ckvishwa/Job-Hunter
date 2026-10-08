import { z } from "zod";

// Application readiness as a pure function of recorded evidence. Nothing here performs an action; it only decides
// what the evidence supports. `SUBMITTED` is accepted from independent external evidence only, and nothing in
// this repository ever produces such evidence (V1-V3 never submit).

export const READINESS_STATES = ["DISCOVERED", "JD_VERIFIED", "ELIGIBILITY_REVIEWED", "RESUME_PREPARED", "FORM_PREPARED", "FORM_VERIFIED", "READY_TO_SUBMIT", "BLOCKED", "SUBMITTED"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const approvalKindSchema = z.enum(["eligibility", "resume", "form", "final"]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

/** A human decision bound to the exact things that were reviewed. If any bound value later differs, the approval is void. */
export const approvalSchema = z
  .object({
    kind: approvalKindSchema,
    reviewer: z.string().trim().min(2).max(80),
    reviewedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "reviewedAt must be an ISO timestamp"),
    bound: z
      .object({
        jdHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        profileDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        resumeSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        formFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        answersDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      })
      .strict(),
    note: z.string().max(300).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    // An approval must be bound to everything its kind depends on, so a change to any of it can be detected.
    const required: Record<ApprovalKind, Array<keyof typeof a.bound>> = {
      eligibility: ["jdHash", "profileDigest"],
      resume: ["jdHash", "resumeSha256"],
      form: ["jdHash", "formFingerprint", "answersDigest", "resumeSha256"],
      final: ["jdHash", "profileDigest", "resumeSha256", "formFingerprint", "answersDigest"],
    };
    for (const key of required[a.kind]) if (!a.bound[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bound", key], message: `a ${a.kind} approval must be bound to ${key}` });
  });
export type Approval = z.infer<typeof approvalSchema>;

export interface ReadinessEvidence {
  job: { discovered: boolean; postingLive: boolean | null; jdHash: string | null; jdVerified: boolean };
  eligibility: {
    outcome: "ELIGIBLE" | "REJECT" | "REVIEW" | null;
    decidedForJdHash: string | null;
    /** Digest of the candidate profile the decision was computed against. */
    profileDigest: string | null;
    /** Digest of the candidate profile as it is now. A difference means the decision is stale. */
    currentProfileDigest: string | null;
    coverageAttested: boolean;
  };
  resume: { prepared: boolean; sha256: string | null; preparedForJdHash: string | null; unsupportedClaims: number | null; previewOnly: boolean };
  form: { prepared: boolean; verified: boolean; formFingerprint: string | null; answersDigest: string | null; requiredUnresolved: number; mismatches: number; preparedForJdHash: string | null; resumeSha256: string | null };
  approvals: Approval[];
  /** Independent evidence that the employer received an application. This tool never produces it. */
  submission: { independentEvidence: boolean };
}

export interface ReadinessResult {
  state: ReadinessState;
  /** Gates satisfied so far, in order. */
  satisfied: ReadinessState[];
  /** Why the state is not further along. Empty only for READY_TO_SUBMIT or SUBMITTED. */
  blockers: string[];
  /** Human reviews that are still outstanding (the state remains a review state until they exist). */
  reviewsOutstanding: ApprovalKind[];
  /** Approvals present in the record that no longer match the current evidence and therefore do not count. */
  invalidatedApprovals: string[];
  /** Approval kinds whose bound values match the current evidence. */
  validApprovals: ApprovalKind[];
  submitted: boolean;
}

function boundMatches(approval: Approval, current: Partial<Record<keyof Approval["bound"], string | null>>): string[] {
  const stale: string[] = [];
  for (const key of Object.keys(approval.bound) as Array<keyof Approval["bound"]>) {
    if ((approval.bound[key] ?? null) !== (current[key] ?? null)) stale.push(key);
  }
  return stale;
}

export function evaluateReadiness(ev: ReadinessEvidence): ReadinessResult {
  const blockers: string[] = [];
  const satisfied: ReadinessState[] = [];
  const invalidated: string[] = [];
  const hard: string[] = [];
  const hardBlock = (reason: string) => { hard.push(reason); blockers.push(reason); };

  // What each approval must still match, taken from the current evidence (never from the approval itself).
  const currentBinding: Record<ApprovalKind, Partial<Record<keyof Approval["bound"], string | null>>> = {
    eligibility: { jdHash: ev.job.jdHash, profileDigest: ev.eligibility.currentProfileDigest },
    resume: { jdHash: ev.job.jdHash, resumeSha256: ev.resume.sha256 },
    form: { jdHash: ev.job.jdHash, formFingerprint: ev.form.formFingerprint, answersDigest: ev.form.answersDigest, resumeSha256: ev.form.resumeSha256 },
    final: { jdHash: ev.job.jdHash, profileDigest: ev.eligibility.currentProfileDigest, resumeSha256: ev.resume.sha256, formFingerprint: ev.form.formFingerprint, answersDigest: ev.form.answersDigest },
  };
  const valid = new Set<ApprovalKind>();
  for (const approval of ev.approvals) {
    const stale = boundMatches(approval, currentBinding[approval.kind]);
    if (stale.length > 0) invalidated.push(`${approval.kind} approval by ${approval.reviewer} no longer matches the current ${stale.join(", ")}`);
    else valid.add(approval.kind);
  }

  if (ev.submission.independentEvidence) {
    return { state: "SUBMITTED", satisfied: [...READINESS_STATES.filter((s) => s !== "BLOCKED")], blockers: [], reviewsOutstanding: [], invalidatedApprovals: invalidated, validApprovals: [...valid], submitted: true };
  }

  if (!ev.job.discovered) return { state: "BLOCKED", satisfied, blockers: ["The job was never recorded."], reviewsOutstanding: [], invalidatedApprovals: invalidated, validApprovals: [...valid], submitted: false };
  satisfied.push("DISCOVERED");

  // Hard blockers: conditions that no later step can repair without a new decision.
  if (ev.job.postingLive === false) hardBlock("The official posting is no longer live.");
  if (ev.eligibility.outcome === "REJECT") hardBlock("The deterministic eligibility decision is REJECT.");
  if (ev.resume.unsupportedClaims !== null && ev.resume.unsupportedClaims > 0) hardBlock(`The resume contains ${ev.resume.unsupportedClaims} unsupported claim(s).`);
  if (ev.form.mismatches > 0) hardBlock(`Form readback has ${ev.form.mismatches} mismatch(es) against approved values.`);
  if (ev.eligibility.decidedForJdHash && ev.job.jdHash && ev.eligibility.decidedForJdHash !== ev.job.jdHash) hardBlock("The job description changed after the eligibility decision; re-run the decision.");
  if (ev.eligibility.profileDigest && ev.eligibility.currentProfileDigest && ev.eligibility.profileDigest !== ev.eligibility.currentProfileDigest) hardBlock("The candidate profile changed after the eligibility decision; re-run the decision.");
  if (ev.resume.preparedForJdHash && ev.job.jdHash && ev.resume.preparedForJdHash !== ev.job.jdHash) hardBlock("The job description changed after the resume was prepared; prepare it again.");
  if (ev.form.preparedForJdHash && ev.job.jdHash && ev.form.preparedForJdHash !== ev.job.jdHash) hardBlock("The job description changed after the form was prepared; prepare it again.");
  if (ev.form.resumeSha256 && ev.resume.sha256 && ev.form.resumeSha256 !== ev.resume.sha256) hardBlock("The resume changed after the form was prepared with it.");
  const done = (): ReadinessResult => finish(hard.length > 0 ? "BLOCKED" : satisfied[satisfied.length - 1]!);
  const finish = (state: ReadinessState): ReadinessResult => ({ state, satisfied, blockers, reviewsOutstanding: outstanding(), invalidatedApprovals: invalidated, validApprovals: [...valid], submitted: false });
  const outstanding = (): ApprovalKind[] => (["eligibility", "resume", "form", "final"] as const).filter((k) => !valid.has(k) && satisfied.includes(gateFor(k)));
  const gateFor = (k: ApprovalKind): ReadinessState => ({ eligibility: "ELIGIBILITY_REVIEWED", resume: "RESUME_PREPARED", form: "FORM_VERIFIED", final: "FORM_VERIFIED" } as const)[k];

  if (!ev.job.jdVerified || !ev.job.jdHash) { blockers.push("The current job description has not been verified against the official source."); return done(); }
  satisfied.push("JD_VERIFIED");

  if (ev.eligibility.outcome === null) { blockers.push("No eligibility decision exists."); return done(); }
  satisfied.push("ELIGIBILITY_REVIEWED");
  if (ev.eligibility.outcome !== "ELIGIBLE") blockers.push("Eligibility is REVIEW: at least one mandatory requirement or fact is unresolved.");
  else if (!ev.eligibility.coverageAttested) blockers.push("No independent human attestation that the extracted requirements cover the job description.");

  if (!ev.resume.prepared || !ev.resume.sha256) { blockers.push("No tailored resume has been prepared."); return done(); }
  satisfied.push("RESUME_PREPARED");
  if (ev.resume.previewOnly) blockers.push("The resume is a review preview, not an application-ready resume.");
  if (ev.resume.unsupportedClaims === null) blockers.push("Resume claims have not been checked against approved facts.");
  if (!valid.has("resume")) blockers.push("The applicant has not approved this exact resume.");

  if (!ev.form.prepared) { blockers.push("The application form has not been prepared."); return done(); }
  satisfied.push("FORM_PREPARED");
  if (!ev.form.verified) { blockers.push("The form has not been verified by readback."); return done(); }
  if (ev.form.requiredUnresolved > 0) blockers.push(`${ev.form.requiredUnresolved} required form question(s) have no approved answer.`);
  if (ev.form.mismatches === 0) satisfied.push("FORM_VERIFIED");
  if (!valid.has("form")) blockers.push("The applicant has not approved the filled form.");
  if (!valid.has("eligibility") && ev.eligibility.outcome === "ELIGIBLE") blockers.push("The applicant has not reviewed the eligibility decision.");
  if (!valid.has("final")) blockers.push("The applicant has not given final review approval.");

  if (blockers.length > 0) return done();
  satisfied.push("READY_TO_SUBMIT");
  return finish("READY_TO_SUBMIT");
}

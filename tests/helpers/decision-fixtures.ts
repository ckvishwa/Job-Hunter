import { candidateFactSchema, parseCandidateProfile, type CandidateFact, type CandidateProfile } from "../../src/domain/candidate-profile.js";
import type { ExtractionReview } from "../../src/decision/evaluate.js";
import type { StructuredJob } from "../../src/domain/structured-job.js";

// Synthetic fixtures (an invented candidate and invented jobs) for the decision engine.
export const JD_HASH = "a".repeat(64);
export const AS_OF = "2026-10-07";

type FactInput = Partial<Omit<CandidateFact, "attributes" | "verification">> & {
  factId: string;
  kind: CandidateFact["kind"];
  value: string;
  attributes?: CandidateFact["attributes"];
  verification?: Partial<CandidateFact["verification"]>;
  pending?: boolean;
};

/** An APPROVED, verified fact unless `pending` (then unverified). */
export function fact(input: FactInput): CandidateFact {
  const { pending, attributes, verification, ...rest } = input;
  const sensitive = ["clearance", "work_authorization", "sponsorship_need"].includes(input.kind);
  return candidateFactSchema.parse({
    polarity: "has",
    sensitivity: sensitive ? "sensitive" : "normal",
    source: { kind: "user-statement", reference: "synthetic-fixture" },
    approvalStatus: pending ? "pending" : "approved",
    attributes: attributes ?? {},
    verification: pending ? { verifiedBy: null, verifiedAt: null, validUntil: null } : { verifiedBy: "synthetic-reviewer", verifiedAt: "2026-09-01", validUntil: null, ...verification },
    ...rest,
  });
}

export function profile(facts: CandidateFact[], over: Record<string, unknown> = {}): CandidateProfile {
  return parseCandidateProfile({
    schemaVersion: 1,
    candidateId: "synthetic-candidate",
    profileVersion: "test.1",
    updatedAt: "2026-09-01",
    facts,
    preferences: {},
    employmentHistoryComplete: null,
    ...over,
  });
}

export const ATTESTED = { attestedBy: "synthetic-reviewer", attestedAt: "2026-09-01" };

export function job(parts: {
  requirements?: Partial<StructuredJob["requirements"][number]>[];
  constraints?: Partial<StructuredJob["constraints"][number]>[];
  groups?: string[];
  jdHash?: string;
}): StructuredJob {
  const span = { quote: "evidence text", start: 10, end: 23 };
  return {
    schemaVersion: 1,
    id: "job-1::s",
    jobId: "job-1",
    jdHash: parts.jdHash ?? JD_HASH,
    parserVersion: "structured-job-validator@1",
    providerRevision: "fixture:MANUAL_ANNOTATION:test",
    requirements: (parts.requirements ?? []).map((r, i) => ({
      id: `r${i + 1}`,
      type: "skill",
      value: "x",
      level: "required",
      minimumYears: null,
      scope: { kind: "unspecified", value: null },
      groupId: null,
      evidence: [{ ...span, start: 100 + i * 50, end: 113 + i * 50 }],
      ...r,
    })) as StructuredJob["requirements"],
    responsibilities: [],
    constraints: (parts.constraints ?? []).map((c, i) => ({ id: `c${i + 1}`, type: "location", status: "unknown", value: null, evidence: [], ...c })) as StructuredJob["constraints"],
    alternativeGroups: (parts.groups ?? []).map((id) => ({ id, operator: "any_of" as const })),
    warnings: [],
    validationStatus: "VALID",
    validatedAt: "2026-10-07T12:00:00.000Z",
  };
}

export function review(over: Partial<ExtractionReview> = {}): ExtractionReview {
  return { schemaVersion: 1, jdHash: JD_HASH, provenance: "MANUAL_ANNOTATION", coverage: "complete", reviewedBy: "reviewer-a", reviewedAt: "2026-10-07", omissions: [], ...over };
}

export const stated = (quote: string, start: number): { quote: string; start: number; end: number } => ({ quote, start, end: start + quote.length });

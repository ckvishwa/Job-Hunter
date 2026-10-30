import { candidateFactSchema, type CandidateFact } from "../../src/domain/candidate-profile.js";

export interface FactSpec {
  id: string;
  kind: CandidateFact["kind"];
  value: string;
  status?: "approved" | "pending" | "rejected";
  polarity?: "has" | "lacks";
  attributes?: Record<string, unknown>;
  sensitivity?: "normal" | "sensitive";
  validUntil?: string | null;
}

export function makeFact(spec: FactSpec): CandidateFact {
  const status = spec.status ?? "approved";
  return candidateFactSchema.parse({
    factId: spec.id,
    kind: spec.kind,
    value: spec.value,
    polarity: spec.polarity ?? "has",
    attributes: spec.attributes ?? {},
    source: { kind: "resume-import", reference: "synthetic-resume.docx" },
    verification:
      status === "approved"
        ? { verifiedBy: "tester", verifiedAt: "2026-01-01", validUntil: spec.validUntil ?? null }
        : { verifiedBy: null, verifiedAt: null, validUntil: null },
    approvalStatus: status,
    sensitivity: spec.sensitivity ?? "normal",
  });
}

export const emp = (
  id: string,
  start: string,
  end: string | null,
  type: string | undefined,
  extra: Record<string, unknown> = {},
  status: FactSpec["status"] = "approved",
): CandidateFact =>
  makeFact({
    id, kind: "employment", value: `Employer ${id}`, status,
    attributes: { employer: `Employer ${id}`, title: "Analyst", startDate: start, endDate: end, ...(type ? { employmentType: type } : {}), ...extra },
  });

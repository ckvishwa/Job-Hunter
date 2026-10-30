import type { StructuredJob } from "../domain/structured-job.js";

// Label-free comparison of the Qwen challenger with the deterministic baseline on the SAME stored JDs. This measures agreement, integrity and
// operational cost. It is not accuracy: without independent human labels nothing here says which side is right, and a schema-valid proposal is
// not evidence that it is correct. A claim the baseline does not corroborate is listed for a person; it is never promoted.

const SENSITIVE = ["clearance", "sponsorship", "citizenship", "work_authorization"] as const;

export interface ExtractionComparison {
  baseline: { requirements: number; items: number };
  challenger: { status: "VALID" | "REJECTED"; requirements: number; items: number; rejectionCode?: string };
  itemOverlap: { shared: number; baselineOnly: number; challengerOnly: number };
  levelAgreement: { compared: number; agree: number };
  yearsAgreement: { compared: number; agree: number; disagreements: Array<{ itemStart: number; baseline: string; challenger: string }> };
  conditions: Array<{ type: string; baseline: string; challenger: string; agree: boolean; uncorroboratedByBaseline: boolean; challengerQuote: string | null }>;
  /** Requirement values the challenger emitted that do not appear verbatim in their own cited quotation. */
  valueNotInQuote: number;
  note: string;
}

const itemMap = (job: StructuredJob): Map<number, StructuredJob["requirements"]> => {
  const m = new Map<number, StructuredJob["requirements"]>();
  for (const r of job.requirements) m.set(r.evidence[0]!.start, [...(m.get(r.evidence[0]!.start) ?? []), r]);
  return m;
};
const yearsLabel = (rs: StructuredJob["requirements"]): string => {
  const y = rs.find((r) => r.minimumYears !== null);
  return y ? `${y.minimumYears}+ (${y.scope.kind}${y.scope.value ? `: ${y.scope.value}` : ""})` : "none";
};

export function compareExtractions(baseline: StructuredJob, challenger: StructuredJob | null, rejectionCode?: string): ExtractionComparison {
  const b = itemMap(baseline);
  const c = challenger ? itemMap(challenger) : new Map<number, StructuredJob["requirements"]>();
  const shared = [...b.keys()].filter((k) => c.has(k));
  const yearsDisagree = shared.filter((k) => yearsLabel(b.get(k)!) !== yearsLabel(c.get(k)!));
  return {
    baseline: { requirements: baseline.requirements.length, items: b.size },
    challenger: challenger ? { status: "VALID", requirements: challenger.requirements.length, items: c.size } : { status: "REJECTED", requirements: 0, items: 0, rejectionCode },
    itemOverlap: { shared: shared.length, baselineOnly: b.size - shared.length, challengerOnly: c.size - shared.length },
    levelAgreement: { compared: shared.length, agree: shared.filter((k) => b.get(k)![0]!.level === c.get(k)![0]!.level).length },
    yearsAgreement: { compared: shared.length, agree: shared.length - yearsDisagree.length, disagreements: yearsDisagree.map((k) => ({ itemStart: k, baseline: yearsLabel(b.get(k)!), challenger: yearsLabel(c.get(k)!) })) },
    conditions: challenger ? SENSITIVE.map((type) => {
      const bs = baseline.constraints.find((x) => x.type === type)!;
      const cs = challenger.constraints.find((x) => x.type === type)!;
      return { type, baseline: bs.status, challenger: cs.status, agree: bs.status === cs.status, uncorroboratedByBaseline: cs.status !== "unknown" && bs.status === "unknown", challengerQuote: cs.evidence[0]?.quote ?? null };
    }) : [],
    valueNotInQuote: challenger ? challenger.warnings.filter((w) => w.code === "VALUE_NOT_IN_EVIDENCE").length : 0,
    note: "Agreement is not accuracy. No side is graded here; independent human labels are required for that (match:gold).",
  };
}

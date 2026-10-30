import { z } from "zod";

// Precision, recall and F1 are reported ONLY against a reference that a person labelled independently of the parser. Without one the
// result is the literal string NOT_EVALUATED. Review status (approved/rejected counts) is never used as a stand-in for accuracy.

export const REFERENCE_SCHEMA = "orbital-extraction-reference/1";

export const referenceSchema = z
  .object({
    schema: z.literal(REFERENCE_SCHEMA),
    /** Must be true: the labels were written by a person from the document, not copied from any parser's output. */
    independent: z.literal(true),
    labeledBy: z.string().min(1).max(120),
    labeledAt: z.string().min(8).max(40),
    /** Optional sha256 of the extracted text the labels were written against; a mismatch makes the reference inapplicable. */
    textSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    facts: z.array(
      z.object({
        kind: z.string().min(1),
        value: z.string().min(1),
        employer: z.string().optional(),
        title: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().nullable().optional(),
      }).strict(),
    ).max(2000),
  })
  .strict();
export type ReferenceLabels = z.infer<typeof referenceSchema>;

export interface ProposedForScoring {
  kind: string;
  value: string;
  attributes?: { employer?: string | null; title?: string | null; startDate?: string | null; endDate?: string | null };
}

export interface CategoryScore {
  proposed: number;
  reference: number;
  truePositives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface EmploymentExact {
  referenceRecords: number;
  exactEmployer: number;
  exactTitle: number;
  exactStart: number;
  exactEnd: number;
  allFieldsExact: number;
}

export type Evaluation =
  | { status: "NOT_EVALUATED"; reason: string; precision: "NOT_EVALUATED"; recall: "NOT_EVALUATED"; f1: "NOT_EVALUATED" }
  | {
      status: "EVALUATED";
      referenceLabeledBy: string;
      precision: number | null;
      recall: number | null;
      f1: number | null;
      truePositives: number;
      falsePositives: number;
      falseNegatives: number;
      perCategory: Record<string, CategoryScore>;
      employmentExact: EmploymentExact;
    };

export const notEvaluated = (reason: string): Evaluation => ({ status: "NOT_EVALUATED", reason, precision: "NOT_EVALUATED", recall: "NOT_EVALUATED", f1: "NOT_EVALUATED" });

const key = (kind: string, value: string): string => `${kind}|${value.toLowerCase().replace(/[^a-z0-9+#]+/g, "")}`;
const ratio = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 10_000) / 10_000);
const f1Of = (p: number | null, r: number | null): number | null => (p === null || r === null || p + r === 0 ? null : Math.round(((2 * p * r) / (p + r)) * 10_000) / 10_000);
const same = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? null) === (b ?? null);
const sameText = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

export function scoreAgainstReference(proposed: readonly ProposedForScoring[], reference: ReferenceLabels): Evaluation {
  const refKeys = new Map<string, ReferenceLabels["facts"][number]>();
  for (const r of reference.facts) refKeys.set(key(r.kind, r.value), r);
  const propKeys = new Map<string, ProposedForScoring>();
  for (const p of proposed) propKeys.set(key(p.kind, p.value), p);
  const matched = [...propKeys.keys()].filter((k) => refKeys.has(k));
  const kinds = new Set([...reference.facts.map((f) => f.kind), ...proposed.map((p) => p.kind)]);
  const perCategory: Record<string, CategoryScore> = {};
  for (const kind of [...kinds].sort()) {
    const pk = [...propKeys.entries()].filter(([, v]) => v.kind === kind).map(([k]) => k);
    const rk = [...refKeys.entries()].filter(([, v]) => v.kind === kind).map(([k]) => k);
    const tp = pk.filter((k) => refKeys.has(k)).length;
    const precision = ratio(tp, pk.length);
    const recall = ratio(tp, rk.length);
    perCategory[kind] = { proposed: pk.length, reference: rk.length, truePositives: tp, precision, recall, f1: f1Of(precision, recall) };
  }
  const employment = reference.facts.filter((f) => f.kind === "employment");
  const proposedEmployment = proposed.filter((p) => p.kind === "employment");
  const exact: EmploymentExact = { referenceRecords: employment.length, exactEmployer: 0, exactTitle: 0, exactStart: 0, exactEnd: 0, allFieldsExact: 0 };
  for (const ref of employment) {
    // the proposal that shares the reference's start date (or, failing that, its value) is the one being judged
    const cand = proposedEmployment.find((p) => p.attributes?.startDate && p.attributes.startDate === ref.startDate) ?? propKeys.get(key("employment", ref.value));
    if (!cand) continue;
    const a = cand.attributes ?? {};
    const e = sameText(a.employer, ref.employer);
    const t = sameText(a.title, ref.title);
    const s = same(a.startDate, ref.startDate);
    const n = same(a.endDate, ref.endDate);
    exact.exactEmployer += Number(e);
    exact.exactTitle += Number(t);
    exact.exactStart += Number(s);
    exact.exactEnd += Number(n);
    exact.allFieldsExact += Number(e && t && s && n);
  }
  const precision = ratio(matched.length, propKeys.size);
  const recall = ratio(matched.length, refKeys.size);
  return {
    status: "EVALUATED", referenceLabeledBy: reference.labeledBy, precision, recall, f1: f1Of(precision, recall),
    truePositives: matched.length, falsePositives: propKeys.size - matched.length, falseNegatives: refKeys.size - matched.length, perCategory, employmentExact: exact,
  };
}

/** Evaluates only when the reference exists, is independent, and (if it names a text hash) was written for this exact text. */
export function evaluateIfPossible(proposed: readonly ProposedForScoring[], reference: ReferenceLabels | null, textSha256: string | null): Evaluation {
  if (!reference) return notEvaluated("No independently human-labelled reference exists for this résumé.");
  if (reference.textSha256 && textSha256 && reference.textSha256 !== textSha256) return notEvaluated("The reference was labelled against different extracted text (hash mismatch).");
  return scoreAgainstReference(proposed, reference);
}

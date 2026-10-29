import type { CandidateRepo } from "../db/candidate-repo.js";

// Résumé-review history -> a versioned correction dataset for parser evaluation. Read-only. It never approves, edits or rejects a fact.
// Scope: sources the owner AUTHORIZED as personal evidence (fixtures and unverified uploads are excluded). Contact/identity kinds are left out entirely.

export const FACT_FEEDBACK_REVISION = "fact-feedback@1";
const EXCLUDED_KINDS = new Set(["email", "phone", "legal_name", "address", "citizenship", "work_authorization", "sponsorship", "clearance"]);

export interface FactOutcome {
  kind: string;
  parserRevision: string | null;
  resumeId: string;
  decision: "approved" | "rejected" | "pending";
  editedBeforeDecision: boolean;
  editedFields: string[];
  warnings: string[];
}

export interface FactFeedback {
  revision: string;
  parsers: string[];
  totals: { facts: number; approved: number; rejected: number; pending: number; edited: number };
  byKind: Record<string, { proposed: number; approved: number; rejected: number; pending: number; edited: number; acceptanceRate: number | null }>;
  errorClasses: Record<string, number>;
  challenger: { status: "NOT_EVALUATED"; reason: string };
  outcomes: FactOutcome[];
  bulkApprovalCandidates: Array<{ factId: string; resumeId: string; value: string; reason: string }>;
}

export type ReviewHistory = Awaited<ReturnType<CandidateRepo["reviewHistoryForFeedback"]>>;

export async function collectFactFeedback(repo: Pick<CandidateRepo, "reviewHistoryForFeedback">): Promise<FactFeedback> {
  const { facts: rows, revisions: revs } = await repo.reviewHistoryForFeedback();
  const history = new Map<string, typeof revs>();
  for (const r of revs) history.set(r.fact_pk, [...(history.get(r.fact_pk) ?? []), r]);

  const outcomes: FactOutcome[] = [];
  const errorClasses: Record<string, number> = {};
  const bump = (k: string) => { errorClasses[k] = (errorClasses[k] ?? 0) + 1; };
  for (const r of rows) {
    if (EXCLUDED_KINDS.has(r.kind) || r.sensitivity === "sensitive") continue;
    const h = history.get(r.pk) ?? [];
    const edits = h.filter((x) => x.action === "EDIT");
    const editedFields = new Set<string>();
    for (let i = 1; i < h.length; i++) {
      if (h[i]!.action !== "EDIT") continue;
      const a = h[i - 1]!.snapshot?.fact, b = h[i]!.snapshot?.fact;
      if (a?.value !== b?.value) editedFields.add("value");
      for (const key of new Set([...Object.keys(a?.attributes ?? {}), ...Object.keys(b?.attributes ?? {})])) if (JSON.stringify(a?.attributes?.[key]) !== JSON.stringify(b?.attributes?.[key])) editedFields.add(`attributes.${key}`);
      if (JSON.stringify(a?.span) !== JSON.stringify(b?.span)) editedFields.add("evidence");
    }
    const warnings: string[] = [];
    if (typeof r.notes === "string" && /could not be determined/i.test(r.notes)) { warnings.push("EMPLOYER_TITLE_ORDER_UNKNOWN"); bump("employer_title_confusion"); }
    if (editedFields.has("evidence")) bump("evidence_boundary");
    if (editedFields.has("attributes.employer") || editedFields.has("attributes.title")) bump("employer_title_confusion");
    if (editedFields.has("value")) bump("value_boundary_or_wording");
    const decision = r.approval_status === "approved" ? "approved" : r.approval_status === "rejected" ? "rejected" : "pending";
    if (decision === "rejected") bump(`rejected_${r.kind}`);
    outcomes.push({ kind: r.kind, parserRevision: r.parser_revision, resumeId: r.resume_id, decision, editedBeforeDecision: edits.length > 0, editedFields: [...editedFields].sort(), warnings });
  }

  const byKind: FactFeedback["byKind"] = {};
  for (const o of outcomes) {
    const k = (byKind[o.kind] ??= { proposed: 0, approved: 0, rejected: 0, pending: 0, edited: 0, acceptanceRate: null });
    k.proposed++; k[o.decision]++; if (o.editedBeforeDecision) k.edited++;
  }
  for (const k of Object.values(byKind)) k.acceptanceRate = k.approved + k.rejected === 0 ? null : Number((k.approved / (k.approved + k.rejected)).toFixed(3));

  // Opt-in bulk-approval candidates: non-sensitive skills whose exact value is in their own quotation AND already approved from another authorized source.
  const approvedSkills = new Set(rows.filter((r) => r.kind === "skill" && r.approval_status === "approved").map((r) => String(r.value).toLowerCase()));
  const bulkApprovalCandidates = rows.filter((r) => r.kind === "skill" && r.approval_status === "pending" && r.span?.quote && String(r.span.quote).toLowerCase().includes(String(r.value).toLowerCase()) && approvedSkills.has(String(r.value).toLowerCase()))
    .map((r) => ({ factId: r.fact_id, resumeId: r.resume_id, value: r.value, reason: "exact skill, source-valid, already approved from another authorized résumé" }));

  return {
    revision: FACT_FEEDBACK_REVISION,
    parsers: [...new Set(outcomes.map((o) => o.parserRevision ?? "unknown"))].sort(),
    totals: { facts: outcomes.length, approved: outcomes.filter((o) => o.decision === "approved").length, rejected: outcomes.filter((o) => o.decision === "rejected").length, pending: outcomes.filter((o) => o.decision === "pending").length, edited: outcomes.filter((o) => o.editedBeforeDecision).length },
    byKind, errorClasses,
    challenger: { status: "NOT_EVALUATED", reason: "No ML-assisted fact-extraction challenger exists yet, and a parser comparison needs reviewed gold on held-out résumés. Only parser@2's reviewer-acceptance rates are reported." },
    outcomes, bulkApprovalCandidates,
  };
}

import { templateKeyOf } from "./sampler.js";
import type { CurrentLabel } from "./repo.js";

// Read-only audit of saved human labels. Findings are QUESTIONS for the reviewer ("does this still look right?"). Nothing here changes or creates a label.

export interface PairEvidence {
  postingId: string; roleSlug: string; company: string; title: string;
  ruleAdmits: boolean; titleSim: number; simPercentile: number;
  /** Near-duplicate JD family id within the same employer (cosine >= 0.985); equal ids mean the same underlying posting text. */
  familyId: string;
}

export type FindingKind = "RELEVANT_WITH_LOW_SIMILARITY" | "IRRELEVANT_WITH_STRONG_EVIDENCE" | "TEMPLATE_CONFLICT" | "FALSE_POSITIVE_FLAG_MISMATCH";
export interface Finding { kind: FindingKind; labelIds: number[]; postings: string[]; detail: string; suggestion: string }

export function auditLabels(labels: readonly CurrentLabel[], evidence: ReadonlyMap<string, PairEvidence>): Finding[] {
  const key = (l: { postingId: string; roleSlug: string }) => `${l.postingId}|${l.roleSlug}`;
  const rel = labels.filter((l) => l.task === "relevance");
  const fp = new Map(labels.filter((l) => l.task === "false_positive_admission").map((l) => [key(l), l]));
  const out: Finding[] = [];
  const name = (e: PairEvidence) => `${e.company} / ${e.title} -> ${e.roleSlug}`;
  for (const l of rel) {
    const e = evidence.get(key(l));
    if (!e) continue;
    if (l.value === "relevant" && e.simPercentile < 0.6 && e.titleSim < 0.45) {
      out.push({ kind: "RELEVANT_WITH_LOW_SIMILARITY", labelIds: [l.id], postings: [name(e)], detail: `labeled relevant, but title similarity is ${e.titleSim.toFixed(2)} and the overall similarity percentile is ${(e.simPercentile * 100).toFixed(0)}${e.ruleAdmits ? " (the rules admitted it)" : ""}`, suggestion: `look again; if it is a mistake: npm run ml:labels -- correct --id ${l.id} --value <relevant|adjacent|irrelevant|unsure> --reason "..."` });
    }
    if (l.value === "irrelevant" && e.ruleAdmits && e.titleSim >= 0.6) {
      out.push({ kind: "IRRELEVANT_WITH_STRONG_EVIDENCE", labelIds: [l.id], postings: [name(e)], detail: `labeled irrelevant although the rules admit the role and title similarity is ${e.titleSim.toFixed(2)}`, suggestion: "look again (it may be adjacent, or the rule may be wrong, which is useful to know)" });
    }
    const flag = fp.get(key(l));
    if (flag && flag.value === "true" && l.value === "relevant") {
      out.push({ kind: "FALSE_POSITIVE_FLAG_MISMATCH", labelIds: [l.id, flag.id], postings: [name(e)], detail: "flagged as a rule false positive but its relevance label is 'relevant'", suggestion: "one of the two labels is a mistake" });
    }
  }
  // Same employer + role with the same normalized title, or the same near-duplicate JD family, labeled differently.
  const groups = new Map<string, Array<{ l: CurrentLabel; e: PairEvidence }>>();
  for (const l of rel) {
    const e = evidence.get(key(l));
    if (!e) continue;
    for (const g of [`T|${templateKeyOf(e.company, e.title)}|${e.roleSlug}`, `F|${e.familyId}|${e.roleSlug}`]) groups.set(g, [...(groups.get(g) ?? []), { l, e }]);
  }
  const seen = new Set<string>();
  for (const members of groups.values()) {
    const values = new Set(members.map((m) => m.l.value));
    const ids = members.map((m) => m.l.id).sort((a, b) => a - b);
    if (members.length < 2 || values.size < 2 || seen.has(ids.join(","))) continue;
    seen.add(ids.join(","));
    out.push({ kind: "TEMPLATE_CONFLICT", labelIds: ids, postings: members.map((m) => name(m.e)), detail: `the same template/JD family was labeled differently: ${members.map((m) => `#${m.l.id}=${m.l.value}`).join(", ")}`, suggestion: "decide whether the difference is real (e.g. a different job) or one label needs a correction" });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.labelIds[0]! - b.labelIds[0]!);
}

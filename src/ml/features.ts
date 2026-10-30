import type { CatalogRoleView } from "../db/roles-repo.js";
import { senioritySignal } from "../jobs/planner.js";
import { titleMatches } from "../pipeline/discovery/board-discoverer.js";

// Feature construction for one JOB-ROLE PAIR, from job text and the saved role catalog only. No candidate fact, contact detail, citizenship,
// sponsorship or protected attribute is read here, and none is a feature.

export const FEATURE_REVISION = "ml-features@3-full-text";

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

export function meanUnit(vs: readonly (readonly number[])[]): number[] {
  const d = vs[0]!.length;
  const m = new Array<number>(d).fill(0);
  for (const v of vs) for (let i = 0; i < d; i++) m[i]! += v[i]!;
  const n = Math.sqrt(m.reduce((s, x) => s + x * x, 0)) || 1;
  return m.map((x) => x / n);
}

export interface RoleProto {
  roleSlug: string;
  familySlug: string;
  phraseVecs: number[][];
  textVec: number[];
  coreGroups: Array<{ id: string; terms: string[] }>;
}

export function protoTexts(role: CatalogRoleView): { phrases: string[]; text: string; coreGroups: RoleProto["coreGroups"] } {
  const phrases = [...new Set([role.title, ...role.aliases].map((p) => p.trim()).filter(Boolean))];
  const coreGroups = (role.evidence?.requirements ?? []).filter((r) => r.importance === "core").map((r) => ({ id: r.id, terms: r.terms.map((t) => t.toLowerCase()) }));
  const terms = [...new Set(coreGroups.flatMap((g) => g.terms))];
  return { phrases, text: `${role.title}. ${role.description ?? ""} ${terms.slice(0, 40).join(", ")}`.trim(), coreGroups };
}

export interface PostingVectors { titleVec: number[]; passageVecs: number[][]; docVec: number[]; truncated: boolean }

export interface PairSim { titleSim: number; docSimMean: number; docSimMaxPassage: number; score: number }

export function pairSimilarity(v: PostingVectors, role: RoleProto): PairSim {
  const titleSim = Math.max(...role.phraseVecs.map((p) => cosine(v.titleVec, p)));
  const docSimMean = cosine(v.docVec, role.textVec);
  const docSimMaxPassage = Math.max(...v.passageVecs.map((p) => cosine(p, role.textVec)));
  return { titleSim, docSimMean, docSimMaxPassage, score: (titleSim + docSimMean) / 2 };
}

export interface FeatureVector { names: string[]; values: number[] }

export interface PairInput {
  title: string;
  description: string;
  vectors: PostingVectors;
  role: RoleProto;
  allRoles: readonly RoleProto[];
  families: readonly string[];
  rule: { relevant: boolean; basis: "title" | "description" | null; roleSlugs: readonly string[] };
}

export function pairFeatures(i: PairInput): FeatureVector & { sim: PairSim } {
  const sim = pairSimilarity(i.vectors, i.role);
  const otherBestTitle = Math.max(-1, ...i.allRoles.filter((r) => r.roleSlug !== i.role.roleSlug).map((r) => pairSimilarity(i.vectors, r).titleSim));
  const text = `${i.title}\n${i.description}`;
  const groupsHit = i.role.coreGroups.filter((g) => titleMatches(text, g.terms).length > 0).length;
  const termsHit = new Set(i.role.coreGroups.flatMap((g) => titleMatches(text, g.terms))).size;
  const seniority = senioritySignal(i.title);
  const ruleThis = i.rule.roleSlugs.includes(i.role.roleSlug);
  const names: string[] = [];
  const values: number[] = [];
  const push = (n: string, v: number) => { names.push(n); values.push(v); };
  push("title_sim_role", sim.titleSim);
  push("doc_sim_role_mean", sim.docSimMean);
  push("doc_sim_role_max_passage", sim.docSimMaxPassage);
  push("title_sim_margin_vs_other_roles", sim.titleSim - otherBestTitle);
  push("evidence_terms_found", Math.min(termsHit, 12) / 12);
  push("evidence_groups_found", Math.min(groupsHit, 5) / 5);
  push("rule_admits_this_role", ruleThis ? 1 : 0);
  push("rule_basis_title", ruleThis && i.rule.basis === "title" ? 1 : 0);
  push("rule_basis_description", ruleThis && i.rule.basis === "description" ? 1 : 0);
  push("rule_admits_any_role", i.rule.relevant ? 1 : 0);
  push("seniority_senior_title", seniority === "SENIOR" ? 1 : 0);
  push("seniority_entry_title", seniority === "ENTRY" ? 1 : 0);
  push("jd_truncated", i.vectors.truncated ? 1 : 0);
  for (const f of i.families) push(`family:${f}`, i.role.familySlug === f ? 1 : 0);
  return { names, values, sim };
}

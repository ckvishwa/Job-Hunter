import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobPosting } from "../adapters/types.js";
import { inventorySource } from "../semantic/source-coverage.js";
import type { RetrievalResult } from "./retrieval.js";
import { normalizeText } from "./lexicon.js";

// S4A gold-set workflow. A person labels; code only prepares the sheet, freezes the split BEFORE any comparison, and scores. Accuracy metrics exist
// only when an independent human-labelled file validates against the frozen split. Nothing here is graded by a model, and nothing is invented.

export const GOLD_SCHEMA = "orbital-s4a-gold/1";
export const SPLIT_SCHEMA = "orbital-s4a-split/1";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------------------------------------------------
// Pool, sheet and frozen split
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface PoolItem {
  itemKey: string;
  jobId: string;
  jdSha256: string;
  start: number;
  end: number;
  quote: string;
  /** Mechanical hint from the source-inventory heading. It is NOT a label. */
  sectionHint: string;
}

/** Every qualification-like source item of every supplied JD. The postings are whatever the system had already stored; none is picked here. */
export function buildPool(jobs: readonly JobPosting[]): PoolItem[] {
  const out: PoolItem[] = [];
  for (const job of jobs) {
    const jd = job.jdContentHash ?? sha256(job.descriptionText);
    for (const item of inventorySource(job.descriptionText).items) {
      if (!item.annotate) continue;
      out.push({ itemKey: `${jd.slice(0, 8)}:${item.start}`, jobId: job.id, jdSha256: jd, start: item.start, end: item.end, quote: item.text, sectionHint: item.section });
    }
  }
  return out.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
}

export interface SplitManifest {
  schema: typeof SPLIT_SCHEMA;
  frozenAt: string;
  rule: string;
  poolDigest: string;
  development: string[];
  heldOut: string[];
  manifestSha256: string;
}

/** Deterministic and independent of any extractor output: an item goes to held-out when the first byte of sha256(itemKey) is odd. */
export function freezeSplit(pool: readonly PoolItem[], frozenAt: string): SplitManifest {
  const rule = "held-out when the first byte of sha256(itemKey) is odd, otherwise development";
  const development: string[] = [];
  const heldOut: string[] = [];
  for (const p of pool) (parseInt(sha256(p.itemKey).slice(0, 2), 16) % 2 === 1 ? heldOut : development).push(p.itemKey);
  const poolDigest = sha256(JSON.stringify(pool.map((p) => [p.itemKey, sha256(p.quote)])));
  const body = { schema: SPLIT_SCHEMA, frozenAt, rule, poolDigest, development, heldOut } as const;
  return { ...body, manifestSha256: sha256(JSON.stringify(body)) };
}

export const verifySplit = (m: SplitManifest): boolean => {
  const { manifestSha256, ...body } = m;
  return sha256(JSON.stringify(body)) === manifestSha256;
};

// ---------------------------------------------------------------------------------------------------------------------------------------
// Label file (written by a person)
// ---------------------------------------------------------------------------------------------------------------------------------------

const status = z.enum(["required", "not_required", "offered", "not_offered", "unknown"]);
const labelRequirement = z.object({
  value: z.string().min(1),
  level: z.enum(["required", "preferred", "unknown"]),
  type: z.string().min(1).optional(),
  minimumYears: z.number().positive().nullable().optional(),
  yearsScope: z.enum(["professional", "domain", "tool", "role"]).nullable().optional(),
  negated: z.boolean().optional(),
}).strict();

export const goldFileSchema = z.object({
  schema: z.literal(GOLD_SCHEMA),
  /** True only if a person wrote every label from the JD text, not from any extractor's output. */
  independent: z.literal(true),
  labeledBy: z.string().min(2).max(120),
  labeledAt: z.string().min(8),
  splitManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(z.object({
    itemKey: z.string(),
    /** null = not labelled yet; [] = a person says this item states no requirement. */
    requirements: z.array(labelRequirement).nullable(),
  }).strict()),
  conditions: z.array(z.object({
    jdSha256: z.string().regex(/^[0-9a-f]{64}$/),
    citizenship: status.nullable(), clearance: status.nullable(), work_authorization: status.nullable(), sponsorship: status.nullable(),
  }).strict()).default([]),
  /** Which candidate facts a person judges relevant to a requirement (for retrieval metrics). */
  evidence: z.array(z.object({ itemKey: z.string(), requirementValue: z.string(), relevantFactIds: z.array(z.string()) }).strict()).default([]),
}).strict();
export type GoldFile = z.infer<typeof goldFileSchema>;

export interface GoldProblem { code: string; message: string }

const AI_LABELER = /\b(claude|qwen|gpt|llm|model|agent|assistant|bot|ai)\b/i;

/** The label file must be independent, human, complete for the split being scored, and bound to the frozen split. */
export function validateGold(raw: unknown, split: SplitManifest, which: "development" | "heldOut"): { ok: true; gold: GoldFile } | { ok: false; problems: GoldProblem[] } {
  const parsed = goldFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: [{ code: "NOT_A_GOLD_FILE", message: `${parsed.error.issues[0]?.path.join(".") || "(root)"}: ${parsed.error.issues[0]?.message}` }] };
  const gold = parsed.data;
  const problems: GoldProblem[] = [];
  if (!verifySplit(split)) problems.push({ code: "SPLIT_TAMPERED", message: "The split manifest does not match its recorded hash." });
  if (gold.splitManifestSha256 !== split.manifestSha256) problems.push({ code: "SPLIT_MISMATCH", message: "The labels were written against a different split than the frozen one." });
  if (AI_LABELER.test(gold.labeledBy)) problems.push({ code: "NOT_HUMAN_LABELLED", message: `labeledBy "${gold.labeledBy}" looks like a model or agent; only a person's labels count.` });
  const byKey = new Map(gold.items.map((i) => [i.itemKey, i]));
  const unlabeled = split[which].filter((k) => byKey.get(k)?.requirements == null);
  if (unlabeled.length) problems.push({ code: "INCOMPLETE", message: `${unlabeled.length} of ${split[which].length} ${which} items are not labelled yet.` });
  return problems.length ? { ok: false, problems } : { ok: true, gold };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Scoring (pure; runs only on a validated gold file)
// ---------------------------------------------------------------------------------------------------------------------------------------

export interface SystemRequirement { itemKey: string; value: string; level: string; minimumYears: number | null; yearsKind: string; negated: boolean }
export interface SystemRun {
  requirements: SystemRequirement[];
  conditions: Array<{ jdSha256: string; citizenship: string; clearance: string; work_authorization: string; sponsorship: string }>;
  decisions: Array<{ itemKey: string; requirementValue: string; status: string; matchedFactIds: string[] }>;
  retrieval: Array<{ itemKey: string; requirementValue: string; methods: Record<string, string[]> }>;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : Math.round((a / b) * 10_000) / 10_000);
const f1 = (p: number | null, r: number | null): number | null => (p === null || r === null || p + r === 0 ? null : Math.round(((2 * p * r) / (p + r)) * 10_000) / 10_000);
const key = (itemKey: string, value: string): string => `${itemKey}|${normalizeText(value)}`;

export function scoreRun(gold: GoldFile, itemKeys: readonly string[], run: SystemRun) {
  const inSplit = new Set(itemKeys);
  const goldReq = new Map<string, z.infer<typeof labelRequirement>>();
  for (const item of gold.items) if (inSplit.has(item.itemKey)) for (const r of item.requirements ?? []) goldReq.set(key(item.itemKey, r.value), r);
  const sysReq = new Map<string, SystemRequirement>();
  for (const r of run.requirements) if (inSplit.has(r.itemKey)) sysReq.set(key(r.itemKey, r.value), r);

  const tp = [...sysReq.keys()].filter((k) => goldReq.has(k));
  const precision = ratio(tp.length, sysReq.size);
  const recall = ratio(tp.length, goldReq.size);
  const levelRight = tp.filter((k) => goldReq.get(k)!.level === sysReq.get(k)!.level).length;
  const yearsRight = tp.filter((k) => (goldReq.get(k)!.minimumYears ?? null) === sysReq.get(k)!.minimumYears).length;

  // retrieval: Recall@5 and MRR over requirements a person marked with at least one relevant fact
  const relevant = new Map(gold.evidence.filter((e) => inSplit.has(e.itemKey)).map((e) => [key(e.itemKey, e.requirementValue), new Set(e.relevantFactIds)]));
  const methods = new Set(run.retrieval.flatMap((r) => Object.keys(r.methods)));
  const retrieval: Record<string, { requirements: number; recallAt5: number | null; mrr: number | null }> = {};
  for (const m of methods) {
    let n = 0, hit5 = 0, rr = 0;
    for (const r of run.retrieval) {
      const rel = relevant.get(key(r.itemKey, r.requirementValue));
      if (!rel || rel.size === 0) continue;
      n += 1;
      const ranked = r.methods[m] ?? [];
      const first = ranked.findIndex((id) => rel.has(id));
      if (first >= 0 && first < 5) hit5 += 1;
      if (first >= 0) rr += 1 / (first + 1);
    }
    retrieval[m] = { requirements: n, recallAt5: ratio(hit5, n), mrr: n ? Math.round((rr / n) * 10_000) / 10_000 : null };
  }

  // false support: the engine said SUPPORTED but a person says no relevant fact exists (or the engine cited none of the relevant ones)
  const supported = run.decisions.filter((d) => inSplit.has(d.itemKey) && d.status === "SUPPORTED");
  const falseSupport = supported.filter((d) => {
    const rel = relevant.get(key(d.itemKey, d.requirementValue));
    return rel !== undefined && !d.matchedFactIds.some((id) => rel.has(id));
  });
  const judged = supported.filter((d) => relevant.has(key(d.itemKey, d.requirementValue)));
  const unsupportedClaims = supported.filter((d) => d.matchedFactIds.length === 0);

  // eligibility and negation
  let condChecked = 0, condWrong = 0;
  for (const g of gold.conditions) {
    const s = run.conditions.find((c) => c.jdSha256 === g.jdSha256);
    if (!s) continue;
    for (const t of ["citizenship", "clearance", "work_authorization", "sponsorship"] as const) {
      if (g[t] === null) continue;
      condChecked += 1;
      if (s[t] !== g[t]) condWrong += 1;
    }
  }
  const negChecked = tp.length;
  const negWrong = tp.filter((k) => Boolean(goldReq.get(k)!.negated) !== sysReq.get(k)!.negated).length;

  return {
    extraction: { truePositives: tp.length, system: sysReq.size, gold: goldReq.size, precision, recall, f1: f1(precision, recall) },
    levelAccuracy: ratio(levelRight, tp.length), yearsAccuracy: ratio(yearsRight, tp.length),
    retrieval,
    falseSupportRate: ratio(falseSupport.length, judged.length), falseSupportJudged: judged.length,
    unsupportedClaimRate: ratio(unsupportedClaims.length, supported.length),
    eligibilityErrors: { checked: condChecked, wrong: condWrong, rate: ratio(condWrong, condChecked) },
    negationErrors: { checked: negChecked, wrong: negWrong, rate: ratio(negWrong, negChecked) },
  };
}

export const NOT_EVALUATED = (reason: string) => ({ status: "NOT_EVALUATED" as const, reason });

// ---------------------------------------------------------------------------------------------------------------------------------------
// Review workflow (pure). A person labels from the JD text; nothing a model suggests is ever written into a label file by this code.
// ---------------------------------------------------------------------------------------------------------------------------------------

export type SplitName = "development" | "heldOut";
export const parseSplitName = (v: string | undefined): SplitName | null => (v === "dev" || v === "development" ? "development" : v === "heldout" || v === "heldOut" || v === "held-out" ? "heldOut" : null);

export interface SplitStatus {
  total: number;
  labelled: number;
  unlabelled: string[];
  /** Metrics may be printed only when the label file passes validateGold for this split. */
  metrics: "ELIGIBLE" | "NOT_EVALUATED";
  reasons: string[];
}

export function goldStatus(split: SplitManifest, raw: unknown | null): { splitOk: boolean; labelFile: "NONE" | "INVALID" | "PRESENT"; labeledBy: string | null; independent: boolean | null; development: SplitStatus; heldOut: SplitStatus } {
  const parsed = raw == null ? null : goldFileSchema.safeParse(raw);
  const byKey = new Map(parsed?.success ? parsed.data.items.map((i) => [i.itemKey, i]) : []);
  const one = (which: SplitName): SplitStatus => {
    const keys = split[which];
    const unlabelled = keys.filter((k) => byKey.get(k)?.requirements == null);
    const reasons: string[] = [];
    if (raw == null) reasons.push("no label file");
    else if (!parsed!.success) reasons.push(`label file does not parse: ${parsed!.error.issues[0]?.path.join(".") || "(root)"}: ${parsed!.error.issues[0]?.message}`);
    else {
      const v = validateGold(raw, split, which);
      if (!v.ok) reasons.push(...v.problems.map((p) => `${p.code}: ${p.message}`));
    }
    return { total: keys.length, labelled: keys.length - unlabelled.length, unlabelled, metrics: reasons.length ? "NOT_EVALUATED" : "ELIGIBLE", reasons };
  };
  return {
    splitOk: verifySplit(split),
    labelFile: raw == null ? "NONE" : parsed!.success ? "PRESENT" : "INVALID",
    labeledBy: parsed?.success ? parsed.data.labeledBy : null,
    independent: parsed?.success ? parsed.data.independent : null,
    development: one("development"),
    heldOut: one("heldOut"),
  };
}

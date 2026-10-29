import { sha256 } from "./types.js";

// Two separate queues over JOB-ROLE PAIRS. They only decide what a human is shown next; every label still comes from a person.
//
//  ACTIVE stream  (TRAIN-side employers only): finds informative pairs. Deliberately biased towards likely positives, hard cases and ambiguity, so its
//                 labels are never used to evaluate a model.
//  EVAL stream    (HELD-OUT employers only): stratified RANDOM sampling with a recorded inclusion weight, so evaluation estimates are not biased by active
//                 learning. Strata: rule-admitted / high-similarity-but-not-admitted / the rest. Within a stratum the order is a fixed seeded shuffle, so
//                 the first n labeled pairs are a uniform random sample of that stratum.
//
// Rules, MiniLM similarity and model scores appear here only as ordering suggestions.

export interface PoolItem {
  postingId: string;
  roleSlug: string;
  familySlug: string;
  company: string;
  title: string;
  /** employer + normalized title: one template per employer. */
  templateKey: string;
  /** normalized title alone: stops the same wording from many employers filling a batch. */
  titleKey: string;
  ruleRelevant: boolean;
  /** MiniLM title<->role similarity (max over the role's phrases). */
  titleSim: number;
  /** Mean of title and JD similarity. */
  sim: number;
  /** 0..1 rank of `sim` within the pair pool. */
  simPercentile: number;
  modelScore?: number | null;
  /** A human earlier marked a rule admission with this template as a false positive. */
  knownFalsePositiveTemplate?: boolean;
  /** Same text as an earlier pool item. */
  duplicate?: boolean;
  /** This posting's near-duplicate JD family (same employer + role) already has a human label. */
  familyLabeled?: boolean;
}

export type ActiveBucket = "uncertainty_least_confidence" | "rule_model_disagreement" | "likely_positive" | "hard_negative" | "adjacent_candidate" | "diverse_random" | "calibration_random";
export type EvalStratum = "rule_admitted" | "similar_not_admitted" | "rest";
export interface Pick { postingId: string; roleSlug: string; bucket: ActiveBucket | `eval:${EvalStratum}`; reason: string; stratum?: EvalStratum; stratumSize?: number }

const tie = (seed: string, it: { postingId: string; roleSlug: string }): string => sha256(`${seed}|${it.postingId}|${it.roleSlug}`);
const pairKey = (it: { postingId: string; roleSlug: string }) => `${it.postingId}|${it.roleSlug}`;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const NOISE = /\b(senior|sr|junior|jr|lead|staff|principal|associate|intern|i|ii|iii|iv|remote|hybrid|us|usa|uk|emea|apac|amer|latam|canada|ireland|germany|france|japan|india|singapore|tokyo|london|remote-friendly)\b/g;
export function templateKeyOf(company: string, title: string): string {
  return `${company.toLowerCase()}|${titleKeyOf(title)}`;
}
export function titleKeyOf(title: string): string {
  return title.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z ]/g, " ").replace(NOISE, " ").replace(/\s+/g, " ").trim();
}

/** Ordering suggestion for "likely true positive": title evidence first, then overall similarity, then the rules. It is a score for ordering, not a label. */
export const likelyPositiveScore = (i: Pick2): number => 0.45 * clamp01((i.titleSim - 0.3) / 0.5) + 0.35 * i.simPercentile + 0.2 * (i.ruleRelevant ? 1 : 0);
type Pick2 = { titleSim: number; simPercentile: number; ruleRelevant: boolean };

export const isHardNegativeCandidate = (i: PoolItem): boolean =>
  !!i.knownFalsePositiveTemplate || (i.ruleRelevant && i.titleSim < 0.4) || (!i.ruleRelevant && i.simPercentile >= 0.9 && i.titleSim < 0.45);
export const isAdjacentCandidate = (i: PoolItem): boolean => i.simPercentile >= 0.75 && i.simPercentile < 0.97 && i.titleSim >= 0.35 && i.titleSim < 0.7 && !isHardNegativeCandidate(i);

export interface Deficits { relevant: number; irrelevant: number }

export interface ActiveOptions { size: number; seed: string; deficits?: Deficits; maxPerCompany?: number; maxPerTitleKey?: number; maxRoleShare?: number; threshold?: number }

/** Share of the batch given to each bucket. With a model the uncertainty buckets lead; otherwise likely positives, hard cases, adjacent and diverse picks. */
export function quotas(hasModel: boolean, deficits?: Deficits): Record<Exclude<ActiveBucket, "calibration_random">, number> {
  const q = hasModel
    ? { uncertainty_least_confidence: 0.3, rule_model_disagreement: 0.1, likely_positive: 0.2, hard_negative: 0.1, adjacent_candidate: 0.1, diverse_random: 0.2 }
    : { uncertainty_least_confidence: 0, rule_model_disagreement: 0, likely_positive: 0.35, hard_negative: 0.2, adjacent_candidate: 0.2, diverse_random: 0.25 };
  if (deficits) {
    // Move 10% of the batch towards whichever class is further from its minimum.
    const needPositives = deficits.relevant > deficits.irrelevant;
    const from = needPositives ? "hard_negative" : "likely_positive";
    const to = needPositives ? "likely_positive" : "hard_negative";
    const shift = Math.min(0.1, q[from]);
    q[from] -= shift; q[to] += shift;
  }
  return q;
}

export function selectActive(pool: readonly PoolItem[], opts: ActiveOptions): Pick[] {
  const maxPerCompany = opts.maxPerCompany ?? 2;
  const maxPerTitleKey = opts.maxPerTitleKey ?? 2;
  const maxPerRole = Math.max(2, Math.ceil((opts.maxRoleShare ?? 0.35) * opts.size));
  const threshold = opts.threshold ?? 0.5;
  const eligible = pool.filter((p) => !p.duplicate && !p.familyLabeled);
  const hasModel = eligible.some((p) => p.modelScore != null);
  const order = <T extends PoolItem>(xs: T[], key: (x: T) => number): T[] => [...xs].sort((a, b) => key(a) - key(b) || tie(opts.seed, a).localeCompare(tie(opts.seed, b)));

  const lists: Record<Exclude<ActiveBucket, "calibration_random">, Array<{ it: PoolItem; reason: string }>> = {
    uncertainty_least_confidence: [], rule_model_disagreement: [], likely_positive: [], hard_negative: [], adjacent_candidate: [], diverse_random: [],
  };
  if (hasModel) {
    const m = eligible.filter((p) => p.modelScore != null);
    lists.uncertainty_least_confidence = order(m, (p) => Math.abs(p.modelScore! - 0.5)).map((it) => ({ it, reason: `model probability ${it.modelScore!.toFixed(2)} is near 0.5 (least confidence)` }));
    lists.rule_model_disagreement = order(m.filter((p) => (p.modelScore! >= threshold) !== p.ruleRelevant), (p) => Math.abs(p.modelScore! - threshold))
      .map((it) => ({ it, reason: `rules say ${it.ruleRelevant ? "relevant" : "not relevant"}, model says ${it.modelScore! >= threshold ? "relevant" : "not relevant"} (${it.modelScore!.toFixed(2)})` }));
  }
  lists.likely_positive = order(eligible.filter((p) => !isHardNegativeCandidate(p)), (p) => -likelyPositiveScore(p))
    .map((it) => ({ it, reason: `likely true positive (suggestion): title similarity ${it.titleSim.toFixed(2)}, overall percentile ${(it.simPercentile * 100).toFixed(0)}${it.ruleRelevant ? ", rules admit" : ""}` }));
  lists.hard_negative = order(eligible.filter(isHardNegativeCandidate), (p) => -p.simPercentile)
    .map((it) => ({ it, reason: it.knownFalsePositiveTemplate ? "same employer/title template as a rule admission you marked irrelevant" : it.ruleRelevant ? `hard negative: rules admit it but the title is not close (title similarity ${it.titleSim.toFixed(2)})` : `hard negative: looks similar overall (percentile ${(it.simPercentile * 100).toFixed(0)}) but the title is not` }));
  lists.adjacent_candidate = order(eligible.filter(isAdjacentCandidate), (p) => Math.abs(p.simPercentile - 0.86))
    .map((it) => ({ it, reason: `possible adjacent role: related field but not a title match (title similarity ${it.titleSim.toFixed(2)}, percentile ${(it.simPercentile * 100).toFixed(0)})` }));
  lists.diverse_random = order(eligible.filter((p) => p.simPercentile >= 0.35), () => 0)
    .map((it) => ({ it, reason: `diverse random draw (${it.familySlug}); the obvious-negative tail below percentile 35 is skipped` }));

  const q = quotas(hasModel, opts.deficits);
  const calibration = opts.size >= 20 ? 1 : 0;
  const target = opts.size - calibration;
  const picked: Pick[] = [];
  const taken = new Set<string>();
  const perTemplate = new Map<string, number>();
  const perCompany = new Map<string, number>(), perTitle = new Map<string, number>(), perRole = new Map<string, number>(), perFamily = new Map<string, number>();
  const allowed = (it: PoolItem, famLimit: number): boolean =>
    !taken.has(pairKey(it)) && (perTemplate.get(`${it.templateKey}|${it.roleSlug}`) ?? 0) < 1 && (perCompany.get(it.company) ?? 0) < maxPerCompany && (perTitle.get(it.titleKey) ?? 0) < maxPerTitleKey &&
    (perRole.get(it.roleSlug) ?? 0) < maxPerRole && (perFamily.get(it.familySlug) ?? 0) < famLimit;
  const take = (it: PoolItem, bucket: ActiveBucket, reason: string) => {
    taken.add(pairKey(it));
    for (const [m, k] of [[perTemplate, `${it.templateKey}|${it.roleSlug}`], [perCompany, it.company], [perTitle, it.titleKey], [perRole, it.roleSlug], [perFamily, it.familySlug]] as const) m.set(k, (m.get(k) ?? 0) + 1);
    picked.push({ postingId: it.postingId, roleSlug: it.roleSlug, bucket, reason });
  };
  // fill a bucket to its quota, round-robin over role families (limit 1, then 2, ...) so one family cannot dominate it
  // big LLM batches need a higher per-family ceiling than a 25-pair human batch (12 per family)
  const famLimitMax = Math.max(12, Math.ceil(opts.size / 4));
  const fill = (bucket: Exclude<ActiveBucket, "calibration_random">, count: number): number => {
    let got = 0;
    for (let famLimit = 1; famLimit <= famLimitMax && got < count && picked.length < target; famLimit++) {
      for (const c of lists[bucket]) {
        if (got >= count || picked.length >= target) break;
        if (allowed(c.it, famLimit)) { take(c.it, bucket, c.reason); got++; }
      }
    }
    return got;
  };
  let shortfall = 0;
  const bucketOrder = (Object.keys(q) as Array<keyof typeof q>).filter((b) => q[b] > 0);
  for (const b of bucketOrder) {
    const want = Math.round(q[b] * target);
    shortfall += want - fill(b, want);
  }
  // unfilled quota flows to likely positives, then diverse random
  for (const b of ["likely_positive", "diverse_random"] as const) {
    if (shortfall <= 0) break;
    shortfall -= fill(b, shortfall);
  }
  if (picked.length < target) { const extra = fill("diverse_random", target - picked.length); void extra; }
  if (calibration && picked.length < opts.size) {
    const low = order(eligible.filter((p) => p.simPercentile < 0.35 && allowed(p, 99)), () => 0)[0];
    if (low) take(low, "calibration_random", "single calibration draw from the low-similarity tail, so clear negatives are still sampled now and then");
  }
  return picked.slice(0, opts.size);
}

// ------------------------------------------------------------------------------------------------------------------------- evaluation stream

export const EVAL_STREAM = "eval_v1";
export const evalStratumOf = (i: { ruleRelevant: boolean; simPercentile: number }): EvalStratum => (i.ruleRelevant ? "rule_admitted" : i.simPercentile >= 0.97 ? "similar_not_admitted" : "rest");

/** selection_basis written on an eval-stream label: carries the stratum and the pool size N, from which the inclusion weight N/n is computed at evaluation. */
export const evalBasis = (stratum: EvalStratum, stratumSize: number): string => `${EVAL_STREAM}|stratum=${stratum}|N=${stratumSize}`;
export const parseEvalBasis = (basis: string): { stratum: EvalStratum; stratumSize: number } | null => {
  const m = /^eval_v1\|stratum=(rule_admitted|similar_not_admitted|rest)\|N=(\d+)/.exec(basis);
  return m ? { stratum: m[1] as EvalStratum, stratumSize: Number(m[2]) } : null;
};

export const EVAL_SHARES: Record<EvalStratum, number> = { rule_admitted: 0.4, similar_not_admitted: 0.3, rest: 0.3 };

/**
 * Next pairs for the independent evaluation set. `pool` must contain ONLY pairs of held-out employers (the caller enforces it) including already-labeled
 * ones, so the stratum sizes N are stable. Order inside a stratum is a fixed seeded shuffle (independent of labels, models and rules).
 */
export function selectEval(pool: readonly PoolItem[], labeled: ReadonlySet<string>, opts: { size: number; seed: string }): Pick[] {
  const base = pool.filter((p) => !p.duplicate);
  const strata = new Map<EvalStratum, PoolItem[]>();
  for (const p of base) strata.set(evalStratumOf(p), [...(strata.get(evalStratumOf(p)) ?? []), p]);
  const shuffled = new Map<EvalStratum, PoolItem[]>();
  for (const [s, xs] of strata) shuffled.set(s, [...xs].sort((a, b) => tie(`${opts.seed}|${s}`, a).localeCompare(tie(`${opts.seed}|${s}`, b))));
  const picks: Pick[] = [];
  const want = (s: EvalStratum) => Math.round(EVAL_SHARES[s] * opts.size);
  let carry = 0;
  for (const s of ["rule_admitted", "similar_not_admitted", "rest"] as EvalStratum[]) {
    const list = (shuffled.get(s) ?? []).filter((p) => !labeled.has(pairKey(p)) && !p.familyLabeled);
    let n = want(s) + carry;
    carry = 0;
    for (const it of list) {
      if (n <= 0) break;
      picks.push({ postingId: it.postingId, roleSlug: it.roleSlug, bucket: `eval:${s}`, stratum: s, stratumSize: strata.get(s)!.length, reason: `independent random draw from held-out employers, stratum ${s} (N=${strata.get(s)!.length}); no model, rule or similarity ordering` });
      n--;
    }
    carry = Math.max(0, n);
  }
  return picks.slice(0, opts.size);
}

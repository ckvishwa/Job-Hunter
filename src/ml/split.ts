import { parseEvalBasis } from "./sampler.js";
import { GATES, sha256, type Relevance } from "./types.js";

export type Split = "train" | "heldout";

/** One human-labelled job-role pair. */
export interface LabeledPair {
  postingId: string;
  roleSlug: string;
  textSha256: string;
  company: string;
  relevance: Relevance;
  seniority: string | null;
  workMode: string | null;
  labelIds: number[];
  /** selection_basis of the relevance label: tells an independent eval-stream label from an active-learning one. */
  selectionBasis?: string;
}

export interface DatasetItem extends LabeledPair {
  groupKey: string;
  split: Split;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    // The lexicographically smaller name is the representative, so group keys are stable regardless of input order.
    if (ra < rb) this.parent.set(rb, ra); else this.parent.set(ra, rb);
  }
}

export interface BuiltDataset {
  items: DatasetItem[];
  excluded: Array<{ postingId: string; roleSlug: string; reason: "STALE_LABEL" | "DUPLICATE_PAIR_TEXT" | "NEAR_DUPLICATE_ACROSS_SPLIT" | "HELDOUT_NOT_EVAL_SAMPLE" }>;
  splitHash: string;
  counts: Record<Split, Record<Relevance, number>> & { employers: Record<Split, number>; groups: Record<Split, number> };
}

const norm = (s: string): string => s.toLowerCase();

/** Side an employer gets when no registry or earlier version decides it. */
export const hashSide = (company: string, salt: string): Split => (parseInt(sha256(`${salt}|${norm(company)}`).slice(0, 8), 16) / 0x1_0000_0000 < GATES.heldoutFraction ? "heldout" : "train");

/**
 * Employer-grouped split. A group is an employer, merged with every employer linked to it by a near-duplicate JD family (`links`), so one template
 * never sits on both sides. A group's side depends only on its name and the salt; an employer assigned in an earlier version keeps its side
 * (held-out wins if a merged group contains both).
 *
 * Registry mode (`opts.registry`): `priorByCompany` is a frozen employer->side registry and is authoritative. Employers are never merged or moved;
 * instead a TRAIN-side posting that is a near-duplicate of a HELD-OUT-side posting (`opts.postingLinks`) is excluded from the dataset, so the held-out
 * set keeps only the labels it was sampled for and no template straddles the split.
 */
export function buildDataset(
  labeled: Array<LabeledPair & { currentTextSha256: string }>,
  salt: string,
  priorByCompany: ReadonlyMap<string, Split>,
  links: ReadonlyArray<readonly [string, string]> = [],
  opts: { registry?: boolean; postingLinks?: ReadonlyArray<readonly [string, string]>; heldoutEvalOnly?: boolean } = {},
): BuiltDataset {
  const uf = new UnionFind();
  if (!opts.registry) for (const [a, b] of links) uf.union(norm(a), norm(b));
  const sideOf = new Map<string, Split>();
  const members = new Map<string, Set<string>>();
  for (const row of labeled) {
    const key = uf.find(norm(row.company));
    members.set(key, (members.get(key) ?? new Set()).add(norm(row.company)));
  }
  for (const [key, cos] of members) {
    const priors = [...cos].map((c) => priorByCompany.get(c)).filter((x): x is Split => !!x);
    sideOf.set(key, priors.includes("heldout") ? "heldout" : priors.includes("train") ? "train" : hashSide(key, salt));
  }
  const excluded: BuiltDataset["excluded"] = [];
  const seen = new Set<string>();
  const items: DatasetItem[] = [];
  const heldPostings = new Set<string>();
  const trainSidePostings = new Set<string>();
  if (opts.registry) for (const row of labeled) (sideOf.get(uf.find(norm(row.company))) === "heldout" ? heldPostings : trainSidePostings).add(row.postingId);
  const crossLinked = new Set<string>(); // train-side postings that duplicate a held-out posting
  for (const [a, b] of opts.postingLinks ?? []) {
    if (heldPostings.has(a) && trainSidePostings.has(b)) crossLinked.add(b);
    if (heldPostings.has(b) && trainSidePostings.has(a)) crossLinked.add(a);
  }
  for (const row of [...labeled].sort((a, b) => `${a.postingId}:${a.roleSlug}`.localeCompare(`${b.postingId}:${b.roleSlug}`))) {
    if (row.textSha256 !== row.currentTextSha256) { excluded.push({ postingId: row.postingId, roleSlug: row.roleSlug, reason: "STALE_LABEL" }); continue; }
    if (opts.registry && crossLinked.has(row.postingId)) { excluded.push({ postingId: row.postingId, roleSlug: row.roleSlug, reason: "NEAR_DUPLICATE_ACROSS_SPLIT" }); continue; }
    // Held-out labels count only if they came from the independent random evaluation stream (active-learning picks are selection-biased).
    if (opts.heldoutEvalOnly && sideOf.get(uf.find(norm(row.company))) === "heldout" && !parseEvalBasis(row.selectionBasis ?? "")) { excluded.push({ postingId: row.postingId, roleSlug: row.roleSlug, reason: "HELDOUT_NOT_EVAL_SAMPLE" }); continue; }
    const dupKey = `${row.textSha256}:${row.roleSlug}`;
    if (seen.has(dupKey)) { excluded.push({ postingId: row.postingId, roleSlug: row.roleSlug, reason: "DUPLICATE_PAIR_TEXT" }); continue; }
    seen.add(dupKey);
    const groupKey = uf.find(norm(row.company));
    items.push({ ...row, groupKey, split: sideOf.get(groupKey)! });
  }
  const zero = (): Record<Relevance, number> => ({ relevant: 0, irrelevant: 0, adjacent: 0, unsure: 0 });
  const counts = { train: zero(), heldout: zero(), employers: { train: 0, heldout: 0 }, groups: { train: 0, heldout: 0 } } as BuiltDataset["counts"];
  const emp: Record<Split, Set<string>> = { train: new Set(), heldout: new Set() };
  const grp: Record<Split, Set<string>> = { train: new Set(), heldout: new Set() };
  for (const it of items) { counts[it.split][it.relevance] += 1; emp[it.split].add(norm(it.company)); grp[it.split].add(it.groupKey); }
  counts.employers = { train: emp.train.size, heldout: emp.heldout.size };
  counts.groups = { train: grp.train.size, heldout: grp.heldout.size };
  const splitHash = sha256(items.map((i) => `${i.postingId}:${i.roleSlug}:${i.textSha256}:${i.split}`).join("\n"));
  return { items, excluded, splitHash, counts };
}

export type Sufficiency = { ok: true } | { ok: false; reasons: string[] };

/** Binary training uses relevant vs irrelevant only. Adjacent/unsure are kept and reported, never silently relabeled. */
export function sufficiency(counts: BuiltDataset["counts"]): Sufficiency {
  const reasons: string[] = [];
  for (const cls of ["relevant", "irrelevant"] as const) {
    if (counts.train[cls] < GATES.minTrainPerClass) reasons.push(`train ${cls}: ${counts.train[cls]} < ${GATES.minTrainPerClass}`);
    if (counts.heldout[cls] < GATES.minHeldoutPerClass) reasons.push(`held-out ${cls}: ${counts.heldout[cls]} < ${GATES.minHeldoutPerClass}`);
  }
  if (counts.employers.heldout < GATES.minHeldoutEmployers) reasons.push(`held-out employers: ${counts.employers.heldout} < ${GATES.minHeldoutEmployers}`);
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

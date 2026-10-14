import { cosine } from "./features.js";
import { GATES } from "./types.js";
import { titleKeyOf } from "./sampler.js";
import type { DatasetItem, Split } from "./split.js";

// Read-only audit that a dataset version's TRAIN and HELD-OUT sides share nothing that could leak: employers, group keys, exact text, near-duplicate JDs
// and (as a warning) identical normalized titles. It also reports whether the held-out side is a reasonable share of the data. It changes nothing.

export interface AuditPosting { id: string; company: string; title: string; textSha256: string; docVec: readonly number[] }

export interface SplitAudit {
  verdict: "DISJOINT" | "LEAKAGE";
  sharedEmployers: string[];
  sharedGroupKeys: string[];
  sharedExactText: Array<{ a: string; b: string }>;
  /** cosine >= 0.985 between a train posting and a held-out posting (blocking) */
  nearDuplicates: Array<{ train: string; heldout: string; cosine: number }>;
  /** 0.95 <= cosine < 0.985 (warning only) */
  similar: Array<{ train: string; heldout: string; cosine: number }>;
  sharedNormalizedTitles: Array<{ title: string; trainEmployers: string[]; heldoutEmployers: string[] }>;
  balance: {
    employers: Record<Split, number>;
    heldoutEmployerShare: number;
    pairs: Record<Split, number>;
    heldoutPairShare: number;
    relevantByEmployer: Record<string, number>;
    relevantInHeldout: number;
    relevantInTrain: number;
    warnings: string[];
  };
}

export const NEAR_DUPLICATE = 0.985;
export const SIMILAR = 0.95;

export function auditSplit(items: readonly DatasetItem[], postings: ReadonlyMap<string, AuditPosting>): SplitAudit {
  const side = (s: Split) => items.filter((i) => i.split === s);
  const train = side("train"), held = side("heldout");
  const emp = (xs: readonly DatasetItem[]) => new Set(xs.map((i) => i.company.toLowerCase()));
  const sharedEmployers = [...emp(train)].filter((c) => emp(held).has(c)).sort();
  const grp = (xs: readonly DatasetItem[]) => new Set(xs.map((i) => i.groupKey));
  const sharedGroupKeys = [...grp(train)].filter((g) => grp(held).has(g)).sort();
  const textOf = (xs: readonly DatasetItem[]) => new Map(xs.map((i) => [i.textSha256, i.postingId]));
  const trainText = textOf(train);
  const sharedExactText = held.filter((i) => trainText.has(i.textSha256)).map((i) => ({ a: trainText.get(i.textSha256)!, b: i.postingId }));

  const label = (id: string) => { const p = postings.get(id); return p ? `${p.company} / ${p.title}` : id; };
  const nearDuplicates: SplitAudit["nearDuplicates"] = [], similar: SplitAudit["similar"] = [];
  const trainPostings = [...new Set(train.map((i) => i.postingId))], heldPostings = [...new Set(held.map((i) => i.postingId))];
  for (const a of trainPostings) for (const b of heldPostings) {
    const pa = postings.get(a), pb = postings.get(b);
    if (!pa || !pb) continue;
    const c = cosine(pa.docVec, pb.docVec);
    if (c >= NEAR_DUPLICATE) nearDuplicates.push({ train: label(a), heldout: label(b), cosine: Number(c.toFixed(4)) });
    else if (c >= SIMILAR) similar.push({ train: label(a), heldout: label(b), cosine: Number(c.toFixed(4)) });
  }
  const titlesBySide = (xs: readonly DatasetItem[]) => {
    const m = new Map<string, Set<string>>();
    for (const i of xs) { const p = postings.get(i.postingId); if (!p) continue; const k = titleKeyOf(p.title); if (k) m.set(k, (m.get(k) ?? new Set()).add(p.company)); }
    return m;
  };
  const tt = titlesBySide(train), ht = titlesBySide(held);
  const sharedNormalizedTitles = [...tt.keys()].filter((k) => ht.has(k)).sort().map((title) => ({ title, trainEmployers: [...tt.get(title)!].sort(), heldoutEmployers: [...ht.get(title)!].sort() }));

  const relevantByEmployer: Record<string, number> = {};
  for (const i of items) if (i.relevance === "relevant") relevantByEmployer[i.company] = (relevantByEmployer[i.company] ?? 0) + 1;
  const employers = { train: emp(train).size, heldout: emp(held).size };
  const pairs = { train: train.length, heldout: held.length };
  const relevantInHeldout = held.filter((i) => i.relevance === "relevant").length;
  const relevantInTrain = train.filter((i) => i.relevance === "relevant").length;
  const heldoutEmployerShare = employers.train + employers.heldout ? Number((employers.heldout / (employers.train + employers.heldout)).toFixed(3)) : 0;
  const heldoutPairShare = pairs.train + pairs.heldout ? Number((pairs.heldout / (pairs.train + pairs.heldout)).toFixed(3)) : 0;
  const warnings: string[] = [];
  if (heldoutEmployerShare > GATES.heldoutFraction + 0.15) warnings.push(`held-out has ${(heldoutEmployerShare * 100).toFixed(0)}% of the labeled employers (target about ${(GATES.heldoutFraction * 100).toFixed(0)}%)`);
  const totalRel = relevantInHeldout + relevantInTrain;
  if (totalRel >= 4 && relevantInHeldout / totalRel > 0.6) warnings.push(`${relevantInHeldout} of ${totalRel} relevant labels sit in the held-out side, leaving little to train on`);
  if (totalRel >= 4 && relevantInTrain / totalRel > 0.9) warnings.push("almost all relevant labels are on the train side, so the held-out side may have too few positives to evaluate");
  const leakage = sharedEmployers.length > 0 || sharedGroupKeys.length > 0 || sharedExactText.length > 0 || nearDuplicates.length > 0;
  return { verdict: leakage ? "LEAKAGE" : "DISJOINT", sharedEmployers, sharedGroupKeys, sharedExactText, nearDuplicates, similar, sharedNormalizedTitles, balance: { employers, heldoutEmployerShare, pairs, heldoutPairShare, relevantByEmployer, relevantInHeldout, relevantInTrain, warnings } };
}

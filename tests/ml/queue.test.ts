import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditLabels, type PairEvidence } from "../../src/ml/label-audit.js";
import { deficitReport, RELEVANCE_DEFINITIONS, SEPARATION_NOTE } from "../../src/ml/guidance.js";
import { weightedMetrics } from "../../src/ml/metrics.js";
import type { CurrentLabel } from "../../src/ml/repo.js";
import { evalBasis, evalStratumOf, isAdjacentCandidate, isHardNegativeCandidate, likelyPositiveScore, parseEvalBasis, quotas, selectActive, selectEval, templateKeyOf, titleKeyOf, type PoolItem } from "../../src/ml/sampler.js";
import { freezeSides, loadSides, proposeSides, SidesError, sideSummary, type EmployerStat } from "../../src/ml/sides.js";
import { auditSplit } from "../../src/ml/split-audit.js";
import { buildDataset, type DatasetItem, type LabeledPair } from "../../src/ml/split.js";

// All data below is SYNTHETIC (invented employers, titles, scores). Expected values are worked out by hand from the construction of each pool.

const FAMILIES = ["soc-blue-team", "qa-sdet", "cloud", "identity-access", "network-noc", "grc-compliance"];
function pool(n: number, make: (i: number) => Partial<PoolItem> = () => ({})): PoolItem[] {
  return Array.from({ length: n }, (_, i) => {
    const company = `Emp${i % 30}`;
    const letters = (n: number) => { let out = ""; do { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); } while (n > 0); return out; };
    const title = `Role ${letters(i)} ${letters(i * 7 + 3)}`; // letters only, so every title has its own normalized key
    return {
      postingId: `p${i}`, roleSlug: ["soc-analyst", "sdet", "cloud-security-analyst", "iam-analyst", "noc-technician", "grc-analyst-junior"][i % 6]!, familySlug: FAMILIES[i % 6]!,
      company, title, templateKey: templateKeyOf(company, title), titleKey: titleKeyOf(title), ruleRelevant: i % 9 === 0, titleSim: (i % 20) / 20, sim: (i % 20) / 20, simPercentile: (i % 50) / 50, ...make(i),
    } as PoolItem;
  });
}
const idOf = (p: { postingId: string; roleSlug: string }) => `${p.postingId}|${p.roleSlug}`;

describe("active queue composition", () => {
  const items = pool(600);
  const picks = selectActive(items, { size: 40, seed: "s" });
  const by = (b: string) => picks.filter((p) => p.bucket === b);

  it("is deterministic and never offers a pair twice", () => {
    expect(selectActive(items, { size: 40, seed: "s" })).toEqual(picks);
    expect(new Set(picks.map(idOf)).size).toBe(picks.length);
    expect(picks).toHaveLength(40);
  });
  it("mixes likely positives, hard negatives, adjacent candidates and diverse random draws, plus one calibration draw", () => {
    expect(by("likely_positive").length).toBeGreaterThanOrEqual(10);
    expect(by("hard_negative").length).toBeGreaterThanOrEqual(5);
    expect(by("adjacent_candidate").length).toBeGreaterThanOrEqual(5);
    expect(by("diverse_random").length).toBeGreaterThanOrEqual(6);
    expect(by("calibration_random")).toHaveLength(1);
    expect(by("uncertainty_least_confidence")).toHaveLength(0); // no model -> no model buckets
  });
  it("likely positives come from the top of the title/similarity/rule suggestion score, and suggestions carry reasons, not labels", () => {
    const score = new Map(items.map((i) => [idOf(i), likelyPositiveScore(i)]));
    const chosen = by("likely_positive").map((p) => score.get(idOf(p))!);
    const eligible = items.filter((i) => !isHardNegativeCandidate(i)).map((i) => likelyPositiveScore(i)).sort((a, b) => b - a);
    expect(Math.min(...chosen)).toBeGreaterThanOrEqual(eligible[Math.floor(eligible.length * 0.35)]!); // taken from the best third (family/employer caps skip some)
    expect(picks.every((p) => p.reason.length > 10)).toBe(true);
    expect(JSON.stringify(picks)).not.toMatch(/"label"|"value"/);
  });
  it("hard negatives are real conflicts (rules admit but title far; or looks similar but title is not), adjacent ones sit in the mid-high band", () => {
    const byId = new Map(items.map((i) => [idOf(i), i]));
    for (const p of by("hard_negative")) expect(isHardNegativeCandidate(byId.get(idOf(p))!)).toBe(true);
    for (const p of by("adjacent_candidate")) { const i = byId.get(idOf(p))!; expect(isAdjacentCandidate(i)).toBe(true); expect(i.simPercentile).toBeGreaterThanOrEqual(0.75); expect(i.simPercentile).toBeLessThan(0.97); }
  });
  it("does not fill the batch with obvious negatives: only the single calibration draw may come from the low-similarity tail", () => {
    const byId = new Map(items.map((i) => [idOf(i), i]));
    const obvious = picks.filter((p) => { const i = byId.get(idOf(p))!; return !i.ruleRelevant && i.simPercentile < 0.2; });
    expect(obvious.length).toBeLessThanOrEqual(1);
    expect(obvious.every((p) => p.bucket === "calibration_random")).toBe(true);
  });
  it("caps repetition by employer, normalized title and role, and spreads picks over role families", () => {
    const byId = new Map(items.map((i) => [idOf(i), i]));
    const count = (f: (i: PoolItem) => string) => { const m = new Map<string, number>(); for (const p of picks) m.set(f(byId.get(idOf(p))!), (m.get(f(byId.get(idOf(p))!)) ?? 0) + 1); return Math.max(...m.values()); };
    expect(count((i) => i.company)).toBeLessThanOrEqual(2);
    expect(count((i) => i.titleKey)).toBeLessThanOrEqual(2);
    expect(count((i) => i.roleSlug)).toBeLessThanOrEqual(Math.ceil(0.35 * 40));
    expect(new Set(picks.map((p) => byId.get(idOf(p))!.familySlug)).size).toBeGreaterThanOrEqual(5);
  });
  it("never offers two postings of the same employer template for the same role in one batch", () => {
    const twins = pool(80, (i) => ({ company: `Emp${i % 40}`, title: "Incident Responder", titleKey: titleKeyOf("Incident Responder"), templateKey: templateKeyOf(`Emp${i % 40}`, "Incident Responder"), roleSlug: "incident-response-analyst" }));
    const out = selectActive(twins, { size: 30, seed: "s", maxPerCompany: 99, maxPerTitleKey: 99, maxRoleShare: 1 });
    const keys = out.map((p) => twins.find((t) => idOf(t) === idOf(p))!.templateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("skips duplicates and pairs whose near-duplicate family already has a human label", () => {
    const small = pool(30);
    const skipped = new Set([small[3]!, small[4]!].map(idOf));
    const out = selectActive(small.map((i, k) => (k === 3 ? { ...i, duplicate: true } : k === 4 ? { ...i, familyLabeled: true } : i)), { size: 25, seed: "s", maxPerCompany: 99, maxPerTitleKey: 99 });
    expect(out.every((p) => !skipped.has(idOf(p)))).toBe(true);
  });
  it("shifts 10% of the batch towards whichever class is further from its minimum", () => {
    expect(quotas(false, { relevant: 24, irrelevant: 2 }).likely_positive).toBeCloseTo(0.45);
    expect(quotas(false, { relevant: 24, irrelevant: 2 }).hard_negative).toBeCloseTo(0.1);
    expect(quotas(false, { relevant: 0, irrelevant: 20 }).hard_negative).toBeCloseTo(0.3);
    expect(quotas(false).likely_positive).toBeCloseTo(0.35);
  });
  it("with a model, uncertainty (least confidence, |p-0.5| ascending) leads and rule/model disagreement is a named bucket", () => {
    const withModel = pool(300, (i) => ({ modelScore: [0.99, 0.51, 0.02, 0.47, 0.8, 0.6, 0.5][i % 7]!, ruleRelevant: i % 3 === 0 }));
    const out = selectActive(withModel, { size: 30, seed: "s", maxPerCompany: 99, maxPerTitleKey: 99 });
    const unc = out.filter((p) => p.bucket === "uncertainty_least_confidence");
    expect(unc.length).toBeGreaterThan(5);
    const byId = new Map(withModel.map((i) => [idOf(i), i]));
    expect(Math.max(...unc.map((p) => Math.abs(byId.get(idOf(p))!.modelScore! - 0.5)))).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(out.some((p) => p.bucket === "rule_model_disagreement")).toBe(true);
  });
});

describe("independent evaluation stream", () => {
  const held = pool(900, (i) => ({ ruleRelevant: i % 10 === 0, simPercentile: ((i * 37) % 100) / 100 }));
  const picks = selectEval(held, new Set(), { size: 50, seed: "orbital-eval-v1" });

  it("draws stratified random pairs with the recorded stratum size, in the fixed shares 40/30/30", () => {
    expect(picks).toHaveLength(50);
    const n = (s: string) => picks.filter((p) => p.stratum === s).length;
    expect([n("rule_admitted"), n("similar_not_admitted"), n("rest")]).toEqual([20, 15, 15]);
    const size = (s: string) => held.filter((h) => evalStratumOf(h) === s).length;
    for (const p of picks) expect(p.stratumSize).toBe(size(p.stratum!));
  });
  it("is independent of rules, model scores and similarity ordering: changing them changes nothing about WHICH pairs are drawn within a stratum", () => {
    const perturbed = held.map((h) => ({ ...h, modelScore: Math.random(), titleSim: Math.random(), sim: Math.random(), knownFalsePositiveTemplate: Math.random() > 0.5 }));
    expect(selectEval(perturbed, new Set(), { size: 50, seed: "orbital-eval-v1" }).map(idOf)).toEqual(picks.map(idOf));
  });
  it("nested uniform sample: a larger draw contains the smaller one, and labeled pairs are skipped without disturbing the order", () => {
    const bigger = selectEval(held, new Set(), { size: 100, seed: "orbital-eval-v1" }).map(idOf);
    for (const id of picks.map(idOf)) expect(bigger).toContain(id);
    const labeled = new Set(picks.slice(0, 10).map(idOf));
    const next = selectEval(held, labeled, { size: 50, seed: "orbital-eval-v1" }).map(idOf);
    expect(next.some((id) => labeled.has(id))).toBe(false);
  });
  it("basis strings round-trip, and weights are N/n per stratum (weighted recall on a hand-built sample)", () => {
    expect(parseEvalBasis(evalBasis("similar_not_admitted", 412))).toEqual({ stratum: "similar_not_admitted", stratumSize: 412 });
    expect(parseEvalBasis("likely_positive: title similarity 0.8")).toBeNull();
    // stratum A: pool 100, 2 sampled (1 positive caught, 1 negative); stratum B: pool 10, 2 sampled (1 positive missed, 1 negative)
    const rows = [
      { score: 0.9, label: true, weight: 50 }, { score: 0.1, label: false, weight: 50 },
      { score: 0.2, label: true, weight: 5 }, { score: 0.1, label: false, weight: 5 },
    ];
    const w = weightedMetrics(rows, 0.5);
    expect(w.recall).toBeCloseTo(50 / 55); // tp 50, fn 5
    expect(w.precision).toBe(1);
    expect(w.falsePositiveRate).toBe(0);
    expect(w.effectiveN).toBe(110);
  });
});

describe("frozen employer registry", () => {
  const stats: EmployerStat[] = Array.from({ length: 24 }, (_, i) => ({ company: `Org${String(i).padStart(2, "0")}`, postings: 50 + i, ruleShare: i / 24 }));
  it("proposes a deterministic stratified split with about 30% held out in every tercile", () => {
    const a = proposeSides(stats, "salt");
    expect(proposeSides([...stats].reverse(), "salt")).toEqual(a);
    const sum = sideSummary(a);
    expect(sum.employers.heldout).toBe(6); // 3 terciles of 8 employers, round(8 * 0.3) = 2 each
  });
  it("hand check: 24 employers -> terciles of 8 -> round(8*0.3)=2 held out each -> 6 total, 2 per tercile", () => {
    const a = proposeSides(stats, "salt");
    for (const stratum of ["high", "mid", "low"] as const) expect(a.filter((e) => e.stratum === stratum && e.side === "heldout")).toHaveLength(2);
    expect(a.filter((e) => e.side === "heldout")).toHaveLength(6);
    expect(a).toHaveLength(24);
  });
  it("freezes once, is verified on load, detects tampering and never overwrites", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "sides-")), "sides.json");
    expect(loadSides(file)).toBeNull();
    const entries = proposeSides(stats, "salt");
    const frozen = freezeSides(entries, "salt", "tester", file);
    expect(frozen.employers).toHaveLength(24);
    expect(loadSides(file)!.map.get("org00")).toBe(entries.find((e) => e.company === "Org00")!.side);
    expect(() => freezeSides(entries, "salt", "tester", file)).toThrowError(expect.objectContaining({ code: "EXISTS" }));
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.employers[0].side = doc.employers[0].side === "train" ? "heldout" : "train";
    writeFileSync(file, JSON.stringify(doc));
    expect(() => loadSides(file)).toThrowError(SidesError);
    writeFileSync(file, "{not json");
    expect(() => loadSides(file)).toThrowError(expect.objectContaining({ code: "INVALID" }));
  });
});

describe("dataset builder in registry mode", () => {
  const labeled = (company: string, n: number, basis: string, rel: LabeledPair["relevance"] = "relevant"): LabeledPair & { currentTextSha256: string } => {
    const sha = `${company}${n}`.padEnd(64, "b").replace(/[^a-f0-9]/g, "b").slice(0, 64);
    return { postingId: `id-${company}-${n}`, roleSlug: "soc-analyst", textSha256: sha, currentTextSha256: sha, company, relevance: rel, seniority: null, workMode: null, labelIds: [n], selectionBasis: basis };
  };
  const registry = new Map<string, "train" | "heldout">([["trainco", "train"], ["heldco", "heldout"]]);
  it("registry sides are authoritative; held-out labels count only from the eval stream", () => {
    const rows = [labeled("TrainCo", 1, "likely_positive: x"), labeled("HeldCo", 2, "likely_positive: x"), labeled("HeldCo", 3, evalBasis("rest", 200))];
    const built = buildDataset(rows, "salt", registry, [["TrainCo", "HeldCo"]], { registry: true, heldoutEvalOnly: true });
    expect(built.items.map((i) => `${i.company}:${i.split}`).sort()).toEqual(["HeldCo:heldout", "TrainCo:train"]); // employers were NOT merged by the link
    expect(built.excluded).toEqual([{ postingId: "id-HeldCo-2", roleSlug: "soc-analyst", reason: "HELDOUT_NOT_EVAL_SAMPLE" }]);
  });
  it("a train-side posting that duplicates a held-out posting is excluded, the held-out one is kept", () => {
    const rows = [labeled("TrainCo", 1, "likely_positive: x"), labeled("TrainCo", 4, "likely_positive: x"), labeled("HeldCo", 3, evalBasis("rest", 200))];
    const built = buildDataset(rows, "salt", registry, [], { registry: true, heldoutEvalOnly: true, postingLinks: [["id-TrainCo-1", "id-HeldCo-3"]] });
    expect(built.excluded.map((e) => `${e.postingId}:${e.reason}`)).toEqual(["id-TrainCo-1:NEAR_DUPLICATE_ACROSS_SPLIT"]);
    expect(built.items.map((i) => i.postingId).sort()).toEqual(["id-HeldCo-3", "id-TrainCo-4"]);
  });
  it("without a registry the legacy behaviour is unchanged (employers merged by the link)", () => {
    const rows = [labeled("A", 1, "x"), labeled("B", 2, "x")];
    const built = buildDataset(rows, "salt", new Map(), [["A", "B"]]);
    expect(new Set(built.items.map((i) => i.split)).size).toBe(1);
  });
});

describe("train/held-out disjointness audit", () => {
  const vec = (k: number) => Array.from({ length: 8 }, (_, i) => (i === k ? 1 : 0));
  const item = (id: string, company: string, split: "train" | "heldout", sha: string, rel: DatasetItem["relevance"] = "relevant"): DatasetItem => ({ postingId: id, roleSlug: "soc-analyst", textSha256: sha, company, groupKey: company.toLowerCase(), split, relevance: rel, seniority: null, workMode: null, labelIds: [1] });
  const post = (id: string, company: string, title: string, sha: string, v: number[]) => [id, { id, company, title, textSha256: sha, docVec: v }] as const;

  it("reports DISJOINT when nothing is shared, and warns about skew", () => {
    const items = [item("a", "A", "train", "1".repeat(64), "irrelevant"), item("b", "B", "train", "2".repeat(64), "irrelevant"), item("c", "C", "heldout", "3".repeat(64)), item("d", "D", "heldout", "4".repeat(64)), item("e", "E", "heldout", "5".repeat(64)), item("f", "F", "heldout", "6".repeat(64))];
    const posts = new Map([post("a", "A", "Cook", "1".repeat(64), vec(0)), post("b", "B", "Pilot", "2".repeat(64), vec(1)), post("c", "C", "SOC Analyst", "3".repeat(64), vec(2)), post("d", "D", "Threat Hunter", "4".repeat(64), vec(3)), post("e", "E", "DFIR Analyst", "5".repeat(64), vec(4)), post("f", "F", "SOC Analyst II", "6".repeat(64), vec(5))]);
    const audit = auditSplit(items, posts);
    expect(audit.verdict).toBe("DISJOINT");
    expect(audit.balance.warnings.join(" ")).toMatch(/relevant labels sit in the held-out side/);
    expect(audit.balance.warnings.join(" ")).toMatch(/labeled employers/);
  });
  it("detects a shared employer, a shared exact text and a near-duplicate JD across the split", () => {
    const items = [item("a", "Same", "train", "1".repeat(64)), item("b", "Same", "heldout", "2".repeat(64)), item("c", "X", "train", "9".repeat(64)), item("d", "Y", "heldout", "9".repeat(64)), item("e", "P", "train", "7".repeat(64)), item("f", "Q", "heldout", "8".repeat(64))];
    const posts = new Map([post("a", "Same", "T1", "1".repeat(64), vec(0)), post("b", "Same", "T2", "2".repeat(64), vec(1)), post("c", "X", "Security Analyst", "9".repeat(64), vec(2)), post("d", "Y", "Security Analyst", "9".repeat(64), vec(3)), post("e", "P", "Alpha", "7".repeat(64), vec(5)), post("f", "Q", "Beta", "8".repeat(64), vec(5))]);
    const audit = auditSplit(items, posts);
    expect(audit.verdict).toBe("LEAKAGE");
    expect(audit.sharedEmployers).toEqual(["same"]);
    expect(audit.sharedExactText).toHaveLength(1);
    expect(audit.nearDuplicates).toEqual([{ train: "P / Alpha", heldout: "Q / Beta", cosine: 1 }]);
    expect(audit.sharedNormalizedTitles.map((t) => t.title)).toContain("security analyst");
  });
});

describe("saved-label audit (questions only)", () => {
  const lab = (id: number, value: string, task = "relevance", roleSlug = "noc-technician", postingId = `p${id}`): CurrentLabel => ({ id, postingId, textSha256: "a".repeat(64), task, roleSlug, value, reviewer: "x", reviewedAt: new Date(0), selectionBasis: "b" });
  const ev = (postingId: string, over: Partial<PairEvidence> = {}): [string, PairEvidence] => [`${postingId}|${over.roleSlug ?? "noc-technician"}`, { postingId, roleSlug: "noc-technician", company: "Stripe", title: `Title ${postingId}`, ruleAdmits: true, titleSim: 0.13, simPercentile: 0, familyId: `fam-${postingId}`, ...over }];
  it("flags the Stripe-style case: labeled relevant with very low title and overall similarity", () => {
    const f = auditLabels([lab(1, "relevant")], new Map([ev("p1", { title: "Sales Strategy and Operations, Mergers and Acquisitions" })]));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "RELEVANT_WITH_LOW_SIMILARITY", labelIds: [1] });
    expect(f[0]!.suggestion).toContain("ml:labels -- correct --id 1");
  });
  it("flags an irrelevant label against strong evidence, a flag/value mismatch and same-template conflicts; stays quiet on consistent labels", () => {
    const labels = [lab(2, "irrelevant"), lab(3, "relevant", "relevance", "soc-analyst", "p3"), lab(4, "true", "false_positive_admission", "soc-analyst", "p3"), lab(5, "relevant", "relevance", "soc-analyst", "p5"), lab(6, "adjacent", "relevance", "soc-analyst", "p6")];
    const evidence = new Map([
      ev("p2", { titleSim: 0.8, simPercentile: 0.99 }), ev("p3", { roleSlug: "soc-analyst", titleSim: 0.9, simPercentile: 0.99 }),
      ev("p5", { roleSlug: "soc-analyst", company: "Huntress", title: "Security Operations Analyst", titleSim: 0.8, simPercentile: 0.98, familyId: "H1" }),
      ev("p6", { roleSlug: "soc-analyst", company: "Huntress", title: "Security Operations Analyst- UK", titleSim: 0.8, simPercentile: 0.98, familyId: "H1" }),
    ]);
    const kinds = auditLabels(labels, evidence).map((f) => f.kind).sort();
    expect(kinds).toEqual(["FALSE_POSITIVE_FLAG_MISMATCH", "IRRELEVANT_WITH_STRONG_EVIDENCE", "TEMPLATE_CONFLICT"]);
    expect(auditLabels([lab(7, "irrelevant")], new Map([ev("p7", { ruleAdmits: false })]))).toEqual([]);
  });
});

describe("reviewer guidance", () => {
  it("lists the four answers with meanings and keeps role relevance separate from seniority, location and eligibility", () => {
    expect(RELEVANCE_DEFINITIONS.map((d) => d.value)).toEqual(["relevant", "adjacent", "irrelevant", "unsure"]);
    for (const w of ["seniority", "location", "visa", "clearance", "qualifications"]) expect(SEPARATION_NOTE.toLowerCase()).toContain(w);
    expect(SEPARATION_NOTE).toContain("Senior SOC Analyst");
  });
  it("computes dataset deficits against the fixed gates", () => {
    const zero = { relevant: 0, irrelevant: 0, adjacent: 0, unsure: 0 };
    const r = deficitReport({ train: { ...zero, relevant: 1, irrelevant: 13, adjacent: 6, unsure: 1 }, heldout: { ...zero, relevant: 4, irrelevant: 8, adjacent: 10 }, employers: { train: 11, heldout: 11 }, groups: { train: 11, heldout: 11 } });
    expect(r.needs).toEqual({ trainRelevant: 24, trainIrrelevant: 12, heldoutRelevant: 6, heldoutIrrelevant: 2, heldoutEmployers: 0 });
    expect(r.ready).toBe(false);
    expect(r.lines[0]).toContain("need 24 more");
  });
});

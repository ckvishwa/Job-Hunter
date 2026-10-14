import { admissionIssues } from "./admission.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { candidateRoles, FEATURE_REVISION, featurize, pairFor, type EngineContext, type Featurized, type PairView } from "./engine.js";
import { cosine } from "./features.js";
import { binaryMetrics, bestF1Threshold, byFamily, calibration, precisionAtK, recallAtK, weightedMetrics, type BinaryMetrics, type Scored, type WeightedMetrics } from "./metrics.js";
import { CANDIDATES, defaultPython, scoreRows, sha256File, trainArtifact, MlRuntimeError, type PairRow, type PythonRunner } from "./artifact.js";
import type { CorpusRow, MlRepo, ModelRecord } from "./repo.js";
import { evalBasis, isHardNegativeCandidate, likelyPositiveScore, parseEvalBasis, selectActive, selectEval, templateKeyOf, titleKeyOf, type Deficits, type Pick, type PoolItem } from "./sampler.js";
import { ruleDecision } from "./rules.js";
import { loadSides } from "./sides.js";
import { auditSplit, type AuditPosting } from "./split-audit.js";
import type { PairEvidence } from "./label-audit.js";
import { deficitReport, type DeficitReport } from "./guidance.js";
import { buildDataset, hashSide, sufficiency, type DatasetItem, type LabeledPair } from "./split.js";
import { GATES, sha256, type Relevance } from "./types.js";

export const ML_DIR = path.resolve("private-runtime", "ml");
export const SPLIT_SALT = "orbital-ml-split-v2";
export const NEAR_DUPLICATE_COSINE = 0.985;
export const TRAIN_SEED = 20261014;

export type MlMode = "off" | "shadow";
/** Feature flag. "off" (default) = deterministic behaviour only. "shadow" = predictions are computed and stored, never used to filter or rank. */
export function mlMode(env: Record<string, string | undefined> = process.env): MlMode {
  return env.JH_ML_MODE === "shadow" ? "shadow" : "off";
}

// ---------------------------------------------------------------------------------------------------------------- pair rows

export function pairRow(f: Featurized, view: PairView, withEmb: boolean, y?: 0 | 1): PairRow {
  return { title: f.posting.title, text: `${f.posting.title}\n${f.posting.description}`, role: view.roleSlug, dense: view.values, emb: withEmb ? f.vectors.docVec : null, group: f.posting.company, ...(y === undefined ? {} : { y }) };
}

// ---------------------------------------------------------------------------------------------------------------- dataset

export async function labeledPairs(repo: MlRepo, corpus: readonly CorpusRow[]): Promise<Array<LabeledPair & { currentTextSha256: string }>> {
  const labels = await repo.currentLabels();
  const byPosting = new Map<string, typeof labels>();
  for (const l of labels) byPosting.set(l.postingId, [...(byPosting.get(l.postingId) ?? []), l]);
  const out: Array<LabeledPair & { currentTextSha256: string }> = [];
  for (const p of corpus) {
    const ls = byPosting.get(p.id) ?? [];
    const seniority = ls.find((l) => l.task === "seniority")?.value ?? null;
    const workMode = ls.find((l) => l.task === "work_mode")?.value ?? null;
    for (const rel of ls.filter((l) => l.task === "relevance" && l.roleSlug !== "")) {
      out.push({ postingId: p.id, roleSlug: rel.roleSlug, textSha256: rel.textSha256, currentTextSha256: p.textSha256, company: p.company, relevance: rel.value as Relevance, seniority, workMode, labelIds: [rel.id], selectionBasis: rel.selectionBasis });
    }
  }
  return out;
}

/** Employer pairs whose labeled postings share a near-duplicate JD family (identical text hash or passage-mean cosine >= NEAR_DUPLICATE_COSINE). */
export async function nearDuplicateLinks(ctx: EngineContext, corpus: readonly CorpusRow[], postingIds: ReadonlySet<string>): Promise<{ companyLinks: Array<[string, string]>; postingLinks: Array<[string, string]> }> {
  const feats: Featurized[] = [];
  for (const p of corpus) if (postingIds.has(p.id)) feats.push(await featurize(ctx, p));
  const companyLinks: Array<[string, string]> = [];
  const postingLinks: Array<[string, string]> = [];
  for (let i = 0; i < feats.length; i++) for (let j = i + 1; j < feats.length; j++) {
    const a = feats[i]!, b = feats[j]!;
    if (a.posting.textSha256 !== b.posting.textSha256 && cosine(a.vectors.docVec, b.vectors.docVec) < NEAR_DUPLICATE_COSINE) continue;
    postingLinks.push([a.posting.id, b.posting.id]);
    if (a.posting.company !== b.posting.company) companyLinks.push([a.posting.company, b.posting.company]);
  }
  return { companyLinks, postingLinks };
}

/** Side of an employer for sampling and for datasets: frozen registry if one exists, otherwise an earlier dataset version, otherwise the hash rule. */
export async function sideResolver(repo: MlRepo): Promise<{ registry: boolean; version: number | null; sideOf: (company: string) => "train" | "heldout"; priors: Map<string, "train" | "heldout"> }> {
  const reg = loadSides();
  const priors = reg ? reg.map : await repo.priorSplits();
  return { registry: !!reg, version: reg?.file.version ?? null, priors, sideOf: (c) => priors.get(c.toLowerCase()) ?? hashSide(c, SPLIT_SALT) };
}

export async function createDatasetVersion(repo: MlRepo, ctx: EngineContext, createdBy: string): Promise<{ status: "NO_LABELS" | "CREATED"; version?: string; manifest?: Record<string, unknown> }> {
  const corpus = await repo.corpus();
  const labeled = await labeledPairs(repo, corpus);
  if (labeled.length === 0) return { status: "NO_LABELS" };
  const { companyLinks, postingLinks } = await nearDuplicateLinks(ctx, corpus, new Set(labeled.map((l) => l.postingId)));
  const sides = await sideResolver(repo);
  // With a frozen registry the employer sides are authoritative; held-out labels count only if they came from the independent random evaluation stream.
  const built = buildDataset(labeled, SPLIT_SALT, sides.priors, companyLinks, { registry: sides.registry, postingLinks, heldoutEvalOnly: sides.registry });
  if (built.items.length === 0) return { status: "NO_LABELS" };
  const version = await repo.nextDatasetVersion();
  const suff = sufficiency(built.counts);
  const manifest = {
    version, createdAt: new Date().toISOString(), unit: "job-role pair", splitSalt: SPLIT_SALT, splitGroup: sides.registry ? `frozen employer registry v${sides.version}` : "employer merged by near-duplicate JD family (no registry frozen)",
    heldoutEvalOnly: sides.registry, nearDuplicateCosine: NEAR_DUPLICATE_COSINE,
    heldoutFraction: GATES.heldoutFraction, gates: GATES, counts: built.counts, excluded: built.excluded, splitHash: built.splitHash, trainable: suff.ok, insufficiency: suff.ok ? [] : suff.reasons,
    labelSource: "human reviewer labels in ml_labels (label_source is constrained to 'human'); no rule or model output is used as a label",
    reviewers: [...new Set((await repo.currentLabels()).map((l) => l.reviewer))].sort(), corpusPostings: corpus.length, featureRevision: FEATURE_REVISION,
  };
  await repo.createDataset(version, createdBy, built.splitHash, manifest, built.items);
  return { status: "CREATED", version, manifest };
}

// ---------------------------------------------------------------------------------------------------------------- training

export async function rowsFor(ctx: EngineContext, repo: MlRepo, items: readonly DatasetItem[], withEmb: boolean): Promise<Array<{ item: DatasetItem; f: Featurized; view: PairView; row: PairRow }>> {
  const out: Array<{ item: DatasetItem; f: Featurized; view: PairView; row: PairRow }> = [];
  for (const item of items) {
    const p = await repo.posting(item.postingId);
    if (!p || p.textSha256 !== item.textSha256) continue; // posting changed since labeling: the pair is dropped, never silently re-labeled
    const f = await featurize(ctx, p);
    const view = pairFor(ctx, f, item.roleSlug);
    out.push({ item, f, view, row: pairRow(f, view, withEmb, item.relevance === "relevant" ? 1 : 0) });
  }
  return out;
}

export type TrainOutcome =
  | { status: "REFUSED"; reasons: string[] }
  | { status: "FAILED"; detail: string }
  | { status: "OK"; models: Array<{ candidate: string; revision: string; file: string; cvF1: number; threshold: number }> };

export async function trainModels(repo: MlRepo, ctx: EngineContext, version: string, python: PythonRunner = defaultPython, outDir = ML_DIR, purpose: "production" | "synthetic" = "production"): Promise<TrainOutcome> {
  const meta = await repo.datasetManifest(version);
  if (!meta) return { status: "FAILED", detail: `Unknown dataset version ${version}.` };
  const suff = sufficiency((meta.manifest as { counts: Parameters<typeof sufficiency>[0] }).counts);
  if (!suff.ok) return { status: "REFUSED", reasons: suff.reasons };
  // The trainer receives the TRAIN split only. Held-out rows are never written to its input file.
  const admission = await admissionIssues(repo, await repo.datasetItems(version));
  if (admission.length) return { status: "REFUSED", reasons: admission };
  const train = (await repo.datasetItems(version)).filter((i) => i.split === "train" && (i.relevance === "relevant" || i.relevance === "irrelevant"));
  const rows = await rowsFor(ctx, repo, train, true);
  if (rows.length === 0) return { status: "FAILED", detail: "No usable training rows." };
  const denseNames = rows[0]!.view.names;
  const out: Extract<TrainOutcome, { status: "OK" }>["models"] = [];
  for (const candidate of CANDIDATES) {
    try {
      const art = trainArtifact({ purpose, candidate, seed: TRAIN_SEED, denseNames, featureRevision: FEATURE_REVISION, datasetVersion: version, splitHash: meta.splitHash, rows: rows.map((r) => ({ ...r.row, group: r.item.groupKey, emb: ["hybrid_emb", "minilm"].includes(candidate) ? r.row.emb : null })) }, outDir, python);
      await repo.registerModel({ revision: art.revision, candidate, datasetVersion: version, splitHash: meta.splitHash, artifactPath: art.file, artifactSha256: art.sha256, featureRevision: FEATURE_REVISION, libraryVersions: art.meta.libraries, seed: TRAIN_SEED });
      await repo.setModelStatus(art.revision, "candidate", { training: art.meta });
      out.push({ candidate, revision: art.revision, file: art.file, cvF1: art.meta.cvF1, threshold: art.meta.threshold });
    } catch (e) {
      return { status: "FAILED", detail: e instanceof MlRuntimeError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : "training failed" };
    }
  }
  return { status: "OK", models: out };
}

// ---------------------------------------------------------------------------------------------------------------- evaluation

export interface SystemReport {
  name: string;
  revision?: string;
  threshold: number | null;
  metrics: BinaryMetrics | null;
  precisionAt10: number | null;
  recallAt50: number | null;
  recallOnRuleMisses: number | null;
  calibration?: { brier: number | null; ece: number | null };
  abstained?: number;
  /** Inverse-probability weighted metrics on the independent stratified-random held-out sample (absent if the held-out set was not sampled that way). */
  weighted?: WeightedMetrics;
  byFamily?: Record<string, BinaryMetrics>;
  byEmployer?: Record<string, BinaryMetrics>;
  latencyMs?: { p50: number; p95: number; batch: number };
  peakRssMb?: number | null;
  error?: string;
  qualifies?: { ok: boolean; reasons: string[] };
}

export interface EvalOutcome {
  status: "NOT_EVALUATED" | "EVALUATED";
  datasetVersion: string;
  splitHash?: string;
  reasons?: string[];
  counts?: unknown;
  heldoutSampling?: { independent: boolean; strata: Record<string, { labeled: number; poolSize: number }> };
  heldout?: { pairs: number; positives: number; negatives: number; adjacentOrUnsure: number; employers: number };
  systems?: SystemReport[];
  promotion?: { qualifies: boolean; note: string };
}

const pct = (xs: number[], q: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0; };

export async function evaluateDataset(repo: MlRepo, ctx: EngineContext, version: string, python: PythonRunner = defaultPython, outDir = ML_DIR, purpose: "production" | "synthetic" = "production"): Promise<EvalOutcome> {
  const meta = await repo.datasetManifest(version);
  if (!meta) return { status: "NOT_EVALUATED", datasetVersion: version, reasons: ["unknown dataset version"] };
  const counts = (meta.manifest as { counts: Parameters<typeof sufficiency>[0] }).counts;
  const suff = sufficiency(counts);
  if (!suff.ok) return { status: "NOT_EVALUATED", datasetVersion: version, splitHash: meta.splitHash, reasons: suff.reasons, counts };
  const items = await repo.datasetItems(version);
  const admission = await admissionIssues(repo, items);
  if (admission.length) return { status: "NOT_EVALUATED", datasetVersion: version, reasons: admission };
  const candidates = (await repo.models(version)).filter((m) => m.status !== "retired").sort((a, b) => {
    const cv = (m: ModelRecord) => Number((m.metrics as { training?: { cvF1?: number } } | null)?.training?.cvF1 ?? -1);
    return cv(b) - cv(a) || a.candidate.localeCompare(b.candidate);
  });
  const selected = candidates[0];
  if (!selected) return { status: "NOT_EVALUATED", datasetVersion: version, reasons: ["Train and freeze a candidate using training-group validation first."] };
  if (!await repo.claimFinalEvaluation(meta.splitHash, version, selected.revision, purpose === "synthetic" ? "synthetic" : "real")) return { status: "NOT_EVALUATED", datasetVersion: version, reasons: ["This frozen held-out split was already reserved/evaluated. Do not optimize against it or rerun automatically."] };
  const bin = (xs: DatasetItem[]) => xs.filter((i) => i.relevance === "relevant" || i.relevance === "irrelevant");
  const train = await rowsFor(ctx, repo, bin(items.filter((i) => i.split === "train")), true);
  const held = await rowsFor(ctx, repo, bin(items.filter((i) => i.split === "heldout")), true);
  const truth = (r: { item: DatasetItem }) => r.item.relevance === "relevant";
  // Held-out rows from the independent random stream carry their stratum and pool size; weight = N / n per stratum.
  const bases = await repo.labelBasisByIds(held.flatMap((r) => r.item.labelIds));
  const strata = held.map((r) => parseEvalBasis(bases.get(r.item.labelIds[0]!) ?? ""));
  const independent = held.length > 0 && strata.every((x) => x !== null);
  const labeledPer = new Map<string, { labeled: number; poolSize: number }>();
  for (const x of strata) if (x) labeledPer.set(x.stratum, { labeled: (labeledPer.get(x.stratum)?.labeled ?? 0) + 1, poolSize: x.stratumSize });
  const heldWeights: number[] | null = independent ? strata.map((x) => x!.stratumSize / labeledPer.get(x!.stratum)!.labeled) : null;
  const scored = (rs: typeof held, f: (r: (typeof held)[number]) => number): Scored[] => rs.map((r) => ({ score: f(r), label: truth(r), family: r.view.familySlug }));
  const misses = (rs: typeof held, sc: Scored[], t: number): number | null => {
    const idx = rs.map((r, i) => (!r.f.rule.roleSlugs.includes(r.item.roleSlug) && truth(r) ? i : -1)).filter((i) => i >= 0);
    return idx.length === 0 ? null : idx.filter((i) => sc[i]!.score >= t).length / idx.length;
  };
  const report = (name: string, rs: typeof held, sc0: Scored[], t: number, prob: boolean): SystemReport => {
    const sc = rs === held && heldWeights ? sc0.map((x, i) => ({ ...x, weight: heldWeights[i]! })) : sc0;
    const byEmp: Record<string, BinaryMetrics> = {};
    for (const c of new Set(rs.map((r) => r.item.company))) byEmp[c] = binaryMetrics(sc.filter((_, i) => rs[i]!.item.company === c), t);
    return { name, threshold: t, metrics: binaryMetrics(sc, t), precisionAt10: precisionAtK(sc, 10), recallAt50: recallAtK(sc, 50), recallOnRuleMisses: misses(rs, sc, t), ...(prob ? { calibration: calibration(sc) } : {}), ...(rs === held && heldWeights ? { weighted: weightedMetrics(sc, t) } : {}), byFamily: byFamily(sc, t), byEmployer: byEmp };
  };

  const systems: SystemReport[] = [];
  systems.push(report("A rules (s3-screen-all-roles@1)", held, scored(held, (r) => (r.f.rule.roleSlugs.includes(r.item.roleSlug) ? 1 : 0)), 0.5, false));
  const simT = bestF1Threshold(scored(train, (r) => r.view.sim.score));
  systems.push(report("B minilm-similarity (threshold fit on train)", held, scored(held, (r) => r.view.sim.score), simT, false));
  const denseNames = held[0]?.view.names ?? [];
  for (const m of await repo.models(version)) {
    const label = `${m.candidate}-logreg@${m.revision}`;
    if (m.splitHash !== meta.splitHash) { systems.push({ name: label, revision: m.revision, threshold: null, metrics: null, precisionAt10: null, recallAt50: null, recallOnRuleMisses: null, error: "trained on a different split", qualifies: { ok: false, reasons: ["trained on a different split"] } }); continue; }
    try {
      const withEmb = ["hybrid_emb", "minilm"].includes(m.candidate);
      const rows = held.map((r) => ({ ...r.row, emb: withEmb ? r.row.emb : null }));
      const out = scoreRows(m, denseNames, rows, outDir, python);
      // latency: score in small batches to get a per-batch distribution (each call is one subprocess, so this includes process start-up)
      const lat: number[] = [];
      for (let i = 0; i < Math.min(rows.length, 60); i += 20) { const t0 = performance.now(); scoreRows(m, denseNames, rows.slice(i, i + 20), outDir, python); lat.push(performance.now() - t0); }
      const rep = report(label, held, out.scores.map((s, i) => ({ score: s, label: truth(held[i]!), family: held[i]!.view.familySlug })), out.threshold, true);
      rep.revision = m.revision;
      rep.abstained = out.scores.filter((s) => s > out.abstainBand[0] && s < out.abstainBand[1]).length;
      rep.latencyMs = { p50: Number(pct(lat, 0.5).toFixed(0)), p95: Number(pct(lat, 0.95).toFixed(0)), batch: 20 };
      rep.peakRssMb = out.peakRssMb;
      systems.push(rep);
    } catch (e) {
      systems.push({ name: label, revision: m.revision, threshold: null, metrics: null, precisionAt10: null, recallAt50: null, recallOnRuleMisses: null, error: e instanceof Error ? e.message : "scoring failed", qualifies: { ok: false, reasons: ["scoring failed"] } });
    }
  }
  const rules = systems[0]!;
  for (const s of systems.slice(2)) {
    if (!s.metrics) continue;
    const reasons: string[] = [];
    if (s.revision !== selected.revision) reasons.push("Not the candidate frozen by training-group validation before test access.");
    if ((s.metrics.f1 ?? 0) < (rules.metrics?.f1 ?? 0) + GATES.minF1Gain) reasons.push(`F1 ${(s.metrics.f1 ?? 0).toFixed(3)} is not at least ${GATES.minF1Gain} above the rules' ${(rules.metrics?.f1 ?? 0).toFixed(3)}`);
    if ((s.metrics.falsePositiveRate ?? 1) > (rules.metrics?.falsePositiveRate ?? 0) + GATES.maxFprIncrease) reasons.push("false-positive rate exceeds the rules' by more than the tolerance");
    if ((s.precisionAt10 ?? 0) < (rules.precisionAt10 ?? 0)) reasons.push("precision@10 is below the rules'");
    s.qualifies = { ok: reasons.length === 0, reasons };
  }
  const winners = systems.filter((s) => s.qualifies?.ok);
  await repo.completeFinalEvaluation(meta.splitHash, purpose === "synthetic" ? "synthetic" : "real");
  for (const m of await repo.models(version)) {
    const s = systems.find((x) => x.revision === m.revision);
    if (s) await repo.setModelStatus(m.revision, m.status === "promoted" ? "promoted" : "candidate", { ...(m.metrics as Record<string, unknown> ?? {}), heldout: s.metrics, qualifies: s.qualifies ?? null });
  }
  return {
    status: "EVALUATED", datasetVersion: version, splitHash: meta.splitHash, counts, heldoutSampling: { independent, strata: Object.fromEntries(labeledPer) },
    heldout: { pairs: held.length, positives: held.filter(truth).length, negatives: held.filter((r) => !truth(r)).length, adjacentOrUnsure: items.filter((i) => i.split === "heldout" && (i.relevance === "adjacent" || i.relevance === "unsure")).length, employers: new Set(held.map((r) => r.item.company)).size },
    systems,
    promotion: { qualifies: winners.length > 0, note: winners.length ? `Meets the pre-set gates: ${winners.map((w) => w.name).join(", ")}. Promotion still needs an explicit human decision; production stays in shadow mode.` : "No model meets the pre-set gates. Production stays deterministic." },
  };
}

// ---------------------------------------------------------------------------------------------------------------- shadow

export interface ShadowRow { posting: CorpusRow; roleSlug: string; ruleRelevant: boolean; sim: number; modelScore: number | null; decision: "relevant" | "irrelevant" | "abstain" | null }

export async function shadowRun(
  repo: MlRepo, ctx: EngineContext, corpus: readonly CorpusRow[], model: ModelRecord | null, python: PythonRunner = defaultPython, outDir = ML_DIR,
  opts: { topRoles?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ runId: string; rows: ShadowRow[]; modelRevision: string | null; status: "OK" | "FAILED"; detail?: string; inferenceMs: number | null }> {
  const pairs: Array<{ f: Featurized; view: PairView }> = [];
  for (const [i, p] of corpus.entries()) {
    const f = await featurize(ctx, p);
    for (const role of candidateRoles(ctx, f, opts.topRoles ?? 3)) pairs.push({ f, view: pairFor(ctx, f, role) });
    if (opts.onProgress && (i + 1) % 250 === 0) opts.onProgress(i + 1, corpus.length);
  }
  let scores: number[] | null = null;
  let band: [number, number] | null = null;
  let loadError: string | undefined;
  let inferenceMs: number | null = null;
  if (model && pairs.length > 0) {
    try {
      const out = scoreRows(model, pairs[0]!.view.names, pairs.map((x) => pairRow(x.f, x.view, ["hybrid_emb", "minilm"].includes(model.candidate))), outDir, python);
      scores = out.scores; band = out.abstainBand; inferenceMs = out.inferenceMs;
    } catch (e) { loadError = e instanceof Error ? e.message : "model scoring failed"; }
  }
  const rows: ShadowRow[] = pairs.map((x, i) => {
    const s = scores ? scores[i]! : null;
    return { posting: x.f.posting, roleSlug: x.view.roleSlug, ruleRelevant: x.f.rule.roleSlugs.includes(x.view.roleSlug), sim: x.view.sim.score, modelScore: s, decision: s == null || !band ? null : s >= band[1] ? "relevant" : s <= band[0] ? "irrelevant" : "abstain" };
  });
  const runId = await repo.recordRun("shadow", loadError ? "FAILED" : "OK", { modelRevision: model?.revision, detail: { pairs: rows.length, modelLoadError: loadError ?? null, mode: "shadow: predictions stored, production ranking untouched" } });
  await repo.saveShadow(runId, rows.map((r) => ({ postingId: r.posting.id, roleSlug: r.roleSlug, textSha256: r.posting.textSha256, ruleRelevant: r.ruleRelevant, sim: r.sim, modelRevision: loadError ? null : (model?.revision ?? null), modelScore: r.modelScore, decision: r.decision, inferenceMs: null })));
  return { runId, rows, modelRevision: model?.revision ?? null, status: loadError ? "FAILED" : "OK", detail: loadError, inferenceMs };
}

// ---------------------------------------------------------------------------------------------------------------- clustering

export interface ClusterReport {
  k: number; silhouette: number | null;
  clusters: Array<{ id: number; size: number; ruleAdmittedFraction: number; topRoles: string[]; sampleTitles: string[]; candidateTitlesMissedByRules: string[] }>;
  nearDuplicates: Array<{ a: string; b: string; cosine: number; sameCompany: boolean }>;
  digest: string;
}

export async function clusterCorpus(ctx: EngineContext, corpus: readonly CorpusRow[], python: PythonRunner = defaultPython, outDir = ML_DIR): Promise<ClusterReport> {
  mkdirSync(path.join(outDir, "tmp"), { recursive: true });
  const feats: Featurized[] = [];
  for (const p of corpus) feats.push(await featurize(ctx, p));
  const src = path.join(outDir, "tmp", "cluster-in.json");
  const dst = path.join(outDir, "tmp", "cluster-out.json");
  writeFileSync(src, JSON.stringify({ ids: feats.map((f) => f.posting.id), vectors: feats.map((f) => f.vectors.docVec), kRange: [6, 30] }));
  const r = python("cluster.py", [src, dst]);
  if (r.status !== 0) throw new MlRuntimeError("PYTHON_FAILED", `cluster.py exited ${r.status}: ${(r.stdout || r.stderr).slice(0, 300)}`);
  const out = JSON.parse(readFileSync(dst, "utf8")) as { k: number; silhouette: number | null; labels: number[]; nearDuplicates: Array<[number, number, number]> };
  const clusters: ClusterReport["clusters"] = [];
  for (let id = 0; id < out.k; id++) {
    const members = feats.filter((_, i) => out.labels[i] === id);
    if (members.length === 0) continue;
    const roles = new Map<string, number>();
    for (const m of members) { const best = [...ctx.protos].map((p) => ({ s: p.roleSlug, v: cosine(m.vectors.docVec, p.textVec) })).sort((a, b) => b.v - a.v)[0]!; roles.set(best.s, (roles.get(best.s) ?? 0) + 1); }
    const frac = members.filter((m) => m.rule.relevant).length / members.length;
    clusters.push({
      id, size: members.length, ruleAdmittedFraction: Number(frac.toFixed(3)),
      topRoles: [...roles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, n]) => `${f}:${n}`),
      sampleTitles: [...new Set(members.slice(0, 40).map((m) => m.posting.title))].slice(0, 6),
      // Titles the rules did not admit inside a cluster the rules mostly admit: candidates for alias REVIEW, never auto-added.
      candidateTitlesMissedByRules: frac >= 0.4 ? [...new Set(members.filter((m) => !m.rule.relevant).map((m) => m.posting.title))].slice(0, 8) : [],
    });
  }
  const nearDuplicates = out.nearDuplicates.slice(0, 500).map(([i, j, c]) => ({ a: feats[i]!.posting.sourceKey, b: feats[j]!.posting.sourceKey, cosine: c, sameCompany: feats[i]!.posting.company === feats[j]!.posting.company }));
  return { k: out.k, silhouette: out.silhouette, clusters, nearDuplicates, digest: sha256(JSON.stringify(out.labels)) };
}

// ---------------------------------------------------------------------------------------------------------------- review queue

export type Stream = "active" | "eval";
/** Per-batch caps for large LLM batches (a human batch of 25 keeps the sampler defaults). */
export interface Pick2Caps { maxPerCompany?: number; maxPerTitleKey?: number; maxRoleShare?: number }
export interface QueueEntry extends Pick {
  posting: CorpusRow; ruleRelevant: boolean; ruleRoles: string[]; sim: number; titleSim: number; modelScore: number | null; roleTitle: string; stream: Stream;
  /** Text stored as selection_basis of the label(s) saved for this entry. */
  basis: string;
}

/** Deficits against the minimum gates for the dataset the CURRENT labels would produce (near-duplicate exclusions are applied later, by ml:dataset). */
export async function projectDeficits(repo: MlRepo, corpus: readonly CorpusRow[]): Promise<DeficitReport & { registry: boolean }> {
  const sides = await sideResolver(repo);
  const built = buildDataset(await labeledPairs(repo, corpus), SPLIT_SALT, sides.priors, [], { registry: sides.registry, heldoutEvalOnly: sides.registry });
  return { ...deficitReport(built.counts), registry: sides.registry };
}

export async function reviewQueue(
  repo: MlRepo, ctx: EngineContext, corpus: readonly CorpusRow[], size: number,
  opts: { stream?: Stream; model?: ModelRecord | null; python?: PythonRunner; outDir?: string; roleTitleOf?: (slug: string) => string; /** pairs ("postingId|roleSlug") not to offer again, e.g. already sent to the LLM labeler */ skip?: ReadonlySet<string>; caps?: Pick2Caps } = {},
): Promise<QueueEntry[]> {
  const stream = opts.stream ?? "active";
  const roleTitleOf = opts.roleTitleOf ?? ((s: string) => s);
  const sides = await sideResolver(repo);
  const feats: Featurized[] = [];
  for (const p of corpus) feats.push(await featurize(ctx, p));
  const labels = await repo.currentLabels();
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const doneKeys = new Set(labels.filter((l) => l.task === "relevance").map((l) => `${l.postingId}|${l.roleSlug}|${l.textSha256}`));
  // pairs (posting, role) -> every candidate role for every posting
  const all: Array<{ f: Featurized; view: PairView }> = [];
  for (const f of feats) for (const role of candidateRoles(ctx, f, 3)) all.push({ f, view: pairFor(ctx, f, role) });
  const sorted = [...all].sort((a, b) => a.view.sim.score - b.view.sim.score);
  const rank = new Map(sorted.map((c, i) => [`${c.f.posting.id}|${c.view.roleSlug}`, i / Math.max(1, sorted.length - 1)]));

  // Near-duplicate families that already have a human label for this role (same employer, same template or cosine >= 0.985): not offered again.
  const labeledFamilies = all.filter((c) => doneKeys.has(`${c.f.posting.id}|${c.view.roleSlug}|${c.f.posting.textSha256}`));
  const familyLabeled = (c: { f: Featurized; view: PairView }): boolean =>
    labeledFamilies.some((l) => l.f.posting.id !== c.f.posting.id && l.view.roleSlug === c.view.roleSlug && l.f.posting.company === c.f.posting.company &&
      (templateKeyOf(l.f.posting.company, l.f.posting.title) === templateKeyOf(c.f.posting.company, c.f.posting.title) || cosine(l.f.vectors.docVec, c.f.vectors.docVec) >= NEAR_DUPLICATE_COSINE));

  const irrelevantTemplates = new Set<string>();
  for (const l of labels) if (l.task === "relevance" && l.value === "irrelevant") { const p = byId.get(l.postingId); if (p) irrelevantTemplates.add(`${templateKeyOf(p.company, p.title)}|${l.roleSlug}`); }

  const wantSide = stream === "active" ? "train" : "heldout";
  const seenText = new Set<string>();
  const cands = all.filter((c) => sides.sideOf(c.f.posting.company) === wantSide);
  let scores: (number | null)[] = cands.map(() => null);
  if (stream === "active" && opts.model && cands.length) {
    try { scores = scoreRows(opts.model, cands[0]!.view.names, cands.map((c) => pairRow(c.f, c.view, ["hybrid_emb", "minilm"].includes(opts.model!.candidate))), opts.outDir ?? ML_DIR, opts.python).scores; } catch { scores = cands.map(() => null); }
  }
  const items: PoolItem[] = cands.map((c, i) => {
    const key = `${c.f.posting.id}|${c.view.roleSlug}`;
    const dup = seenText.has(`${c.f.posting.textSha256}|${c.view.roleSlug}`); seenText.add(`${c.f.posting.textSha256}|${c.view.roleSlug}`);
    const labeledNow = doneKeys.has(`${key}|${c.f.posting.textSha256}`);
    const ruleAdmits = c.f.rule.roleSlugs.includes(c.view.roleSlug);
    return {
      postingId: c.f.posting.id, roleSlug: c.view.roleSlug, familySlug: c.view.familySlug, company: c.f.posting.company, title: c.f.posting.title,
      templateKey: templateKeyOf(c.f.posting.company, c.f.posting.title), titleKey: titleKeyOf(c.f.posting.title), ruleRelevant: ruleAdmits,
      titleSim: c.view.sim.titleSim, sim: c.view.sim.score, simPercentile: rank.get(key) ?? 0, modelScore: scores[i],
      knownFalsePositiveTemplate: ruleAdmits && irrelevantTemplates.has(`${templateKeyOf(c.f.posting.company, c.f.posting.title)}|${c.view.roleSlug}`),
      duplicate: dup && !labeledNow, familyLabeled: stream === "active" ? familyLabeled(c) || (opts.skip?.has(key) ?? false) : false,
      // labeled pairs stay in the pool so the evaluation strata sizes stay stable
      ...(labeledNow ? { labeled: true } : {}),
    } as PoolItem & { labeled?: boolean };
  });
  const lookup = new Map(cands.map((c, i) => [`${c.f.posting.id}|${c.view.roleSlug}`, { c, s: scores[i] }]));
  const mk = (p: Pick, basis: string): QueueEntry => {
    const { c, s } = lookup.get(`${p.postingId}|${p.roleSlug}`)!;
    return { ...p, posting: c.f.posting, ruleRelevant: c.f.rule.roleSlugs.includes(p.roleSlug), ruleRoles: c.f.rule.roleSlugs, sim: c.view.sim.score, titleSim: c.view.sim.titleSim, modelScore: s ?? null, roleTitle: roleTitleOf(p.roleSlug), stream, basis: basis.slice(0, 200) };
  };
  if (stream === "eval") {
    const labeledKeys = new Set([...items.filter((i) => (i as PoolItem & { labeled?: boolean }).labeled).map((i) => `${i.postingId}|${i.roleSlug}`), ...(opts.skip ?? [])]);
    return selectEval(items, labeledKeys, { size, seed: "orbital-eval-v1" }).map((p) => mk(p, evalBasis(p.stratum!, p.stratumSize!)));
  }
  const open = items.filter((i) => !(i as PoolItem & { labeled?: boolean }).labeled);
  const deficits = await projectDeficits(repo, corpus);
  const d: Deficits = { relevant: deficits.needs.trainRelevant, irrelevant: deficits.needs.trainIrrelevant };
  return selectActive(open, { size, seed: `active-${doneKeys.size}`, deficits: d, threshold: opts.model?.candidate ? 0.5 : undefined, ...(opts.caps ?? {}) }).map((p) => mk(p, `${p.bucket}: ${p.reason}`));
}

export { isHardNegativeCandidate, likelyPositiveScore, hashSide, sha256File };

// ---------------------------------------------------------------------------------------------------------------- evidence for audits

/** Per-employer facts from the UNLABELED corpus, used only to propose stratified employer sides. */
export function employerStats(corpus: readonly CorpusRow[], ctx: { plan: EngineContext["plan"]; familyOf: EngineContext["familyOf"] }): Array<{ company: string; postings: number; ruleShare: number }> {
  const by = new Map<string, { n: number; admitted: number }>();
  for (const p of corpus) {
    const d = ruleDecision({ title: p.title, description: p.description }, ctx.plan, ctx.familyOf);
    const s = by.get(p.company) ?? { n: 0, admitted: 0 };
    s.n++; if (d.relevant) s.admitted++;
    by.set(p.company, s);
  }
  return [...by.entries()].map(([company, s]) => ({ company, postings: s.n, ruleShare: s.n ? s.admitted / s.n : 0 }));
}

/** Evidence for each CURRENT relevance label (rule decision, title similarity, similarity percentile among all candidate pairs, near-duplicate family). */
export async function labelEvidence(repo: MlRepo, ctx: EngineContext, corpus: readonly CorpusRow[]): Promise<Map<string, PairEvidence>> {
  const feats: Featurized[] = [];
  for (const p of corpus) feats.push(await featurize(ctx, p));
  const byId = new Map(feats.map((f) => [f.posting.id, f]));
  const all: Array<{ f: Featurized; view: PairView }> = [];
  for (const f of feats) for (const role of candidateRoles(ctx, f, 3)) all.push({ f, view: pairFor(ctx, f, role) });
  const sorted = [...all].sort((a, b) => a.view.sim.score - b.view.sim.score);
  const rank = new Map(sorted.map((c, i) => [`${c.f.posting.id}|${c.view.roleSlug}`, i / Math.max(1, sorted.length - 1)]));
  const labels = (await repo.currentLabels()).filter((l) => l.task === "relevance");
  const out = new Map<string, PairEvidence>();
  const families: Array<{ id: string; f: Featurized }> = [];
  for (const l of labels) {
    const f = byId.get(l.postingId);
    if (!f) continue;
    const view = pairFor(ctx, f, l.roleSlug);
    const fam = families.find((x) => x.f.posting.company === f.posting.company && (x.f.posting.textSha256 === f.posting.textSha256 || cosine(x.f.vectors.docVec, f.vectors.docVec) >= NEAR_DUPLICATE_COSINE));
    const familyId = fam?.id ?? `${f.posting.company}#${f.posting.id}`;
    if (!fam) families.push({ id: familyId, f });
    out.set(`${l.postingId}|${l.roleSlug}`, { postingId: l.postingId, roleSlug: l.roleSlug, company: f.posting.company, title: f.posting.title, ruleAdmits: f.rule.roleSlugs.includes(l.roleSlug), titleSim: view.sim.titleSim, simPercentile: rank.get(`${l.postingId}|${l.roleSlug}`) ?? 0, familyId });
  }
  return out;
}

export async function auditDataset(repo: MlRepo, ctx: EngineContext, version: string) {
  const items = await repo.datasetItems(version);
  const postings = new Map<string, AuditPosting>();
  for (const id of new Set(items.map((i) => i.postingId))) {
    const p = await repo.posting(id);
    if (!p) continue;
    const f = await featurize(ctx, p);
    postings.set(id, { id, company: p.company, title: p.title, textSha256: p.textSha256, docVec: f.vectors.docVec });
  }
  return auditSplit(items, postings);
}

import { INDEPENDENT_REVIEW } from "./admission.js";
import { randomUUID } from "node:crypto";
import type { CatalogView } from "../db/roles-repo.js";
import { candidateRoles, featurize, type EngineContext } from "./engine.js";
import { buildDataset } from "./split.js";
import { protoTexts } from "./features.js";
import { consensus, labelOnce, needsSecondPass, PROMPT_VERSION, type Consensus, type LlmProvider, type PassView, type RoleBrief } from "./llm-label.js";
import type { LlmLabelRow, LlmRepo } from "./llm-repo.js";
import type { CorpusRow, MlRepo } from "./repo.js";
import path from "node:path";
import { CANDIDATES, defaultPython, MlRuntimeError, scoreRows, trainArtifact, type PythonRunner } from "./artifact.js";
import { binaryMetrics, type Scored } from "./metrics.js";
import { FEATURE_REVISION } from "./features.js";
import type { DatasetItem } from "./split.js";
import { deficitReport } from "./guidance.js";
import { GATES, sha256 } from "./types.js";
import { labeledPairs, ML_DIR, nearDuplicateLinks, projectDeficits, reviewQueue, rowsFor, sideResolver, SPLIT_SALT, TRAIN_SEED, type QueueEntry } from "./workflows.js";

// Orchestration for LLM-assisted PROVISIONAL labeling and the human review queue built from it.
// Hard rules enforced here and in tests:
//  * nothing in this file writes a model/LLM value into ml_labels; the only ml_labels writer is humanDecision(), which a person invokes with an explicit decision;
//  * dataset building (labeledPairs/buildDataset), training and evaluation never read ml_llm_*; provisional rows reach training only via experimentRows() (separate, reported separately);
//  * pairs are keyed by (text hash, role) so equivalent descriptions at many locations are labeled once.

export const pairKey = (postingId: string, roleSlug: string, textSha256: string): string => `${postingId}|${roleSlug}|${textSha256}`;

export function roleBriefs(catalog: CatalogView): Map<string, RoleBrief> {
  const out = new Map<string, RoleBrief>();
  for (const r of catalog.roles.filter((x) => x.active)) {
    const t = protoTexts(r);
    out.set(r.roleSlug, { slug: r.roleSlug, title: r.title, description: r.description ?? "", aliases: r.aliases ?? [], coreSkills: [...new Set(t.coreGroups.flatMap((g) => g.terms))] });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------ batch selection

export interface BatchPair { posting: CorpusRow; roleSlug: string; source: "calibration" | "active" | "eval"; why: string }

export interface BatchPlan { pairs: BatchPair[]; counts: Record<BatchPair["source"], number>; skippedAlreadyLabeled: number }

/** A saved pass A is resumable whenever the policy still requires B and B was not persisted. */
export function pairNeedsResume(a: Pick<PassView, "relevance" | "confidence"> | undefined, b: Pick<PassView, "relevance" | "confidence"> | undefined, key: string): boolean {
  return !a || (!b && needsSecondPass(a, key).need);
}

export function completedCurrentPairs(done: ReadonlyMap<string, { A?: Pick<PassView, "relevance" | "confidence">; B?: Pick<PassView, "relevance" | "confidence"> }>, corpus: readonly Pick<CorpusRow, "id" | "textSha256">[]): Set<string> {
  const rolesByText = new Map<string, Set<string>>();
  for (const [key, v] of done) {
    if (pairNeedsResume(v.A, v.B, key)) continue;
    const [, role, hash] = key.split("|") as [string, string, string];
    rolesByText.set(hash, (rolesByText.get(hash) ?? new Set()).add(role));
  }
  return new Set(corpus.flatMap((p) => [...(rolesByText.get(p.textSha256) ?? [])].map((role) => `${p.id}|${role}`)));
}

/**
 * Which pairs to send to the model. Reuses the human sampler so priorities match what a person would see first:
 *  - active: train-side employers, likely true positives first, with hard negatives, adjacent and diverse random pairs (never the obvious-negative tail);
 *  - eval: the next pairs of the independent random stream (held-out employers) so model/human agreement can be measured on them;
 *  - calibration: pairs a person already labeled, to measure the model against human truth (never shown to the model as a label).
 * Equivalent texts (same description hash and role) are sent once.
 */
export async function planBatch(repo: MlRepo, llm: LlmRepo, ctx: EngineContext, corpus: readonly CorpusRow[], opts: { active: number; evalN: number; calibration: boolean; model: string; promptVersion?: string; roleTitleOf?: (s: string) => string }): Promise<BatchPlan> {
  const done = await llm.byPair(opts.model, opts.promptVersion ?? PROMPT_VERSION);
  const complete = completedCurrentPairs(done, corpus);
  // An incomplete description is a property of the posting text, not of one role: it is not offered for any role until the text changes.
  const incomplete = new Set((await llm.rejects()).filter((r) => r.reason === "INCOMPLETE_JD").map((r) => `${r.postingId}|${r.textSha256}`));
  const skip = new Set(complete);
  for (const p of corpus) if (incomplete.has(`${p.id}|${p.textSha256}`)) for (const r of ctx.protos) skip.add(`${p.id}|${r.roleSlug}`);
  const pairs: BatchPair[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const add = (posting: CorpusRow, roleSlug: string, source: BatchPair["source"], why: string) => {
    const k = `${posting.id}|${roleSlug}`;
    if (skip.has(k) || incomplete.has(`${posting.id}|${posting.textSha256}`)) { skipped++; return; }
    const textKey = `${posting.textSha256}|${roleSlug}`;
    if (seen.has(textKey)) return;
    seen.add(textKey);
    pairs.push({ posting, roleSlug, source, why });
  };
  const byId = new Map(corpus.map((c) => [c.id, c]));
  if (opts.calibration) {
    for (const l of await labeledPairs(repo, [...corpus])) {
      const p = byId.get(l.postingId);
      if (p && l.textSha256 === p.textSha256) add(p, l.roleSlug, "calibration", "a person already labeled this pair: measures model against human judgment");
    }
  }
  if (opts.evalN > 0) {
    for (const e of await reviewQueue(repo, ctx, [...corpus], opts.evalN, { stream: "eval", skip, roleTitleOf: opts.roleTitleOf })) add(e.posting, e.roleSlug, "eval", e.reason);
  }
  if (opts.active > 0) {
    const employers = new Set(corpus.map((c) => c.company)).size;
    const caps = { maxPerCompany: Math.max(2, Math.ceil((opts.active / Math.max(1, employers)) * 2.5)), maxPerTitleKey: 4, maxRoleShare: 0.4 };
    for (const e of await reviewQueue(repo, ctx, [...corpus], opts.active, { stream: "active", skip, caps, roleTitleOf: opts.roleTitleOf })) add(e.posting, e.roleSlug, "active", e.reason);
  }
  const counts = { calibration: 0, active: 0, eval: 0 };
  for (const p of pairs) counts[p.source]++;
  return { pairs, counts, skippedAlreadyLabeled: skipped };
}

// ------------------------------------------------------------------------------------------------------------------------ the worker

export interface RunStats {
  runId: string; model: string; promptVersion: string; attempted: number; passA: number; passB: number; rejected: Record<string, number>; secondPassReasons: Record<string, number>;
  stoppedEarly: boolean; elapsedMs: number; avgLatencyMs: number | null;
  status: "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED"; failure?: string;
}

export async function runBatch(
  llmRepo: LlmRepo, provider: LlmProvider, pairs: readonly BatchPair[], briefs: ReadonlyMap<string, RoleBrief>,
  opts: { runId?: string; maxMinutes?: number; onProgress?: (done: number, total: number, line: string) => void; onCheckpoint?: (stats: RunStats) => void } = {},
): Promise<RunStats> {
  const runId = opts.runId ?? `llm-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`;
  const id = await provider.identity();
  const t0 = Date.now();
  const existing = await llmRepo.byPair(id.model, PROMPT_VERSION);
  const stats: RunStats = { runId, model: id.model, promptVersion: PROMPT_VERSION, attempted: 0, passA: 0, passB: 0, rejected: {}, secondPassReasons: {}, stoppedEarly: false, elapsedMs: 0, avgLatencyMs: null, status: "RUNNING" };
  const lat: number[] = [];
  const checkpoint = () => {
    stats.elapsedMs = Date.now() - t0;
    stats.avgLatencyMs = lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) : null;
    opts.onCheckpoint?.(stats);
  };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

  const pass = async (pass: "A" | "B", p: BatchPair): Promise<LlmLabelRow | { rejected: true } | null> => {
    const brief = briefs.get(p.roleSlug);
    if (!brief) { await llmRepo.reject({ postingId: p.posting.id, textSha256: p.posting.textSha256, roleSlug: p.roleSlug, pass, model: id.model, promptVersion: PROMPT_VERSION, reason: "INVALID_OUTPUT", detail: "role is not in the active catalog", runId }); bump(stats.rejected, "UNKNOWN_ROLE"); return { rejected: true }; }
    const res = await labelOnce(provider, pass, brief, { title: p.posting.title, company: p.posting.company, description: p.posting.description });
    if (!res.ok) {
      await llmRepo.reject({ postingId: p.posting.id, textSha256: p.posting.textSha256, roleSlug: p.roleSlug, pass, model: id.model, promptVersion: PROMPT_VERSION, reason: res.reason, detail: res.detail, runId });
      bump(stats.rejected, res.reason);
      checkpoint();
      return { rejected: true };
    }
    lat.push(res.latencyMs);
    const row = { postingId: p.posting.id, sourceKey: p.posting.sourceKey, textSha256: p.posting.textSha256, roleSlug: p.roleSlug, pass, provider: id.provider, model: id.model, modelDigest: id.digest, promptVersion: PROMPT_VERSION,
      relevance: res.output.relevance, seniority: res.output.seniority, workMode: res.output.work_mode, confidence: res.output.confidence, evidence: res.quotes, evidenceLocations: res.evidenceLocations, reasoning: res.output.reasoning, jdCharsSent: res.jdCharsSent, jdTruncated: res.jdTruncated, latencyMs: res.latencyMs, runId };
    const saved = await llmRepo.save(row);
    return { ...row, id: saved.id, createdAt: new Date() };
  };

  let n = 0;
  try {
  checkpoint();
  for (const p of pairs) {
    if (opts.maxMinutes && Date.now() - t0 > opts.maxMinutes * 60_000) { stats.stoppedEarly = true; break; }
    n++;
    stats.attempted++;
    const k = pairKey(p.posting.id, p.roleSlug, p.posting.textSha256);
    let a = existing.get(k)?.A ?? null;
    if (!a) {
      const r = await pass("A", p);
      if (!r || "rejected" in r) { opts.onProgress?.(n, pairs.length, `${p.posting.company} / ${p.posting.title.slice(0, 40)} -> rejected`); continue; }
      a = r; stats.passA++;
      checkpoint();
    }
    let line = `A=${a.relevance}(${a.confidence.toFixed(2)})`;
    if (!existing.get(k)?.B) {
      const why = needsSecondPass(a, k);
      if (why.need) {
        bump(stats.secondPassReasons, why.why);
        if (opts.maxMinutes && Date.now() - t0 > opts.maxMinutes * 60_000) { stats.stoppedEarly = true; break; }
        const r = await pass("B", p);
        if (r && !("rejected" in r)) { stats.passB++; line += ` B=${r.relevance}(${r.confidence.toFixed(2)})`; }
        checkpoint();
      }
    }
    opts.onProgress?.(n, pairs.length, `${p.posting.company} / ${p.posting.title.slice(0, 40)} -> ${p.roleSlug}: ${line}`);
  }
  stats.status = stats.stoppedEarly ? "STOPPED" : "COMPLETED";
  return stats;
  } catch (error) {
    stats.status = "FAILED";
    stats.failure = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    throw error;
  } finally { checkpoint(); }
}

// ------------------------------------------------------------------------------------------------------------------------ states

const view = (r: LlmLabelRow | undefined): PassView | null => (r ? { relevance: r.relevance, seniority: r.seniority, confidence: r.confidence, id: r.id } : null);

export interface PairState { key: string; postingId: string; roleSlug: string; textSha256: string; A?: LlmLabelRow; B?: LlmLabelRow; consensus: Consensus }

export async function pairStates(llm: LlmRepo, model: string): Promise<PairState[]> {
  const out: PairState[] = [];
  for (const [key, v] of await llm.byPair(model, PROMPT_VERSION)) {
    const [postingId, roleSlug, textSha256] = key.split("|") as [string, string, string];
    out.push({ key, postingId, roleSlug, textSha256, ...v, consensus: consensus(view(v.A), view(v.B)) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------ human review queue

export type ReviewReason = "disagreement" | "low_confidence" | "eval_required" | "qc_audit";
export interface ReviewItem {
  posting: CorpusRow; roleSlug: string; reason: ReviewReason; why: string;
  /** Eval-required items hide the model's proposal so the human judgment stays independent. */
  blind: boolean; basis: string; state: PairState | null; stream: "active" | "eval";
}

const seededUnit = (seed: string, key: string): number => parseInt(sha256(`${seed}|${key}`).slice(0, 8), 16) / 0x1_0000_0000;

/**
 * ONE queue: LLM disagreements, low-confidence labels, the next independent evaluation samples, and a seeded random audit of confident agreed labels.
 * Anything a person already labeled (any provenance) is not offered again. Held-out employers contribute only their eval-stream samples: any other label
 * of theirs could not count toward the gates.
 */
export async function buildReviewQueue(
  repo: MlRepo, llm: LlmRepo, ctx: EngineContext, corpus: readonly CorpusRow[],
  opts: { model: string; size: number; evalSize?: number; qcRate?: number; qcMin?: number; only?: ReviewReason[]; roleTitleOf?: (s: string) => string; seed?: string },
): Promise<{ items: ReviewItem[]; available: Record<ReviewReason, number> }> {
  const sides = await sideResolver(repo);
  const humanDone = new Set((await repo.currentLabels()).filter((l) => l.task === "relevance").map((l) => `${l.postingId}|${l.roleSlug}`));
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const states = await pairStates(llm, opts.model);
  const wanted = (r: ReviewReason) => !opts.only || opts.only.includes(r);
  const items: ReviewItem[] = [];
  const available: Record<ReviewReason, number> = { disagreement: 0, low_confidence: 0, eval_required: 0, qc_audit: 0 };
  const seenText = new Set<string>();
  const push = (it: ReviewItem) => { const t = `${it.posting.textSha256}|${it.roleSlug}`; if (seenText.has(t)) return; seenText.add(t); items.push(it); };
  const seed = opts.seed ?? `qc-${humanDone.size}`;

  const trainStates = states.filter((s) => {
    const p = byId.get(s.postingId);
    return p && p.textSha256 === s.textSha256 && sides.sideOf(p.company) === "train" && !humanDone.has(`${s.postingId}|${s.roleSlug}`);
  });
  const dis = trainStates.filter((s) => s.consensus.status === "DISAGREE").sort((a, b) => a.key.localeCompare(b.key));
  const low = trainStates.filter((s) => (s.consensus.status === "AGREED" || s.consensus.status === "SINGLE_PASS") && s.consensus.lowConfidence).sort((a, b) => a.key.localeCompare(b.key));
  const conf = trainStates.filter((s) => s.consensus.status === "AGREED" && !s.consensus.lowConfidence);
  const qcN = Math.max(opts.qcMin ?? 3, Math.round(conf.length * (opts.qcRate ?? 0.1)));
  const qc = [...conf].sort((a, b) => seededUnit(seed, a.key) - seededUnit(seed, b.key)).slice(0, qcN);
  available.disagreement = dis.length; available.low_confidence = low.length; available.qc_audit = qc.length;

  const stateOf = new Map(states.map((s) => [`${s.postingId}|${s.roleSlug}`, s]));
  const evalEntries: QueueEntry[] = wanted("eval_required") ? await reviewQueue(repo, ctx, [...corpus], opts.evalSize ?? 10, { stream: "eval", roleTitleOf: opts.roleTitleOf }) : [];
  available.eval_required = evalEntries.length;

  for (const s of dis) if (wanted("disagreement")) { const c = s.consensus as Extract<Consensus, { status: "DISAGREE" }>; push({ posting: byId.get(s.postingId)!, roleSlug: s.roleSlug, reason: "disagreement", why: `the two model passes disagree: A=${c.a}, B=${c.b}`, blind: false, basis: "llm_review:disagreement", state: s, stream: "active" }); }
  for (const e of evalEntries) push({ posting: e.posting, roleSlug: e.roleSlug, reason: "eval_required", why: "independent evaluation sample (held-out employer, random draw): the model's proposal is hidden on purpose", blind: true, basis: e.basis, state: stateOf.get(`${e.postingId}|${e.roleSlug}`) ?? null, stream: "eval" });
  for (const s of low) if (wanted("low_confidence")) { const c = s.consensus as Extract<Consensus, { status: "AGREED" | "SINGLE_PASS" }>; push({ posting: byId.get(s.postingId)!, roleSlug: s.roleSlug, reason: "low_confidence", why: `low confidence (${c.confidence.toFixed(2)}) or unsure`, blind: false, basis: "llm_review:low_confidence", state: s, stream: "active" }); }
  for (const s of qc) if (wanted("qc_audit")) push({ posting: byId.get(s.postingId)!, roleSlug: s.roleSlug, reason: "qc_audit", why: "random quality-control audit of a confident, agreed label", blind: false, basis: "llm_review:qc_audit", state: s, stream: "active" });
  return { items: items.slice(0, opts.size), available };
}

// ------------------------------------------------------------------------------------------------------------------------ the only ml_labels writer here

export type HumanChoice = { kind: "approve" } | { kind: "set"; value: "relevant" | "irrelevant" | "adjacent" | "unsure" };

/**
 * A person's decision on one queue item. `approve` accepts the model's consensus value (only possible when both passes agree); `set` states the person's own value.
 * The row is a HUMAN label: origin is human_corrected when it differs from what the model proposed, otherwise human_verified. Blind items carry no proposal link.
 */
export async function humanDecision(repo: MlRepo, item: ReviewItem, choice: HumanChoice, reviewer: string, sessionId: string, independentlyReviewed = false): Promise<{ id: number; duplicate: boolean; origin: "human_verified" | "human_corrected" }> {
  const proposal = !item.blind && item.state && item.state.consensus.status === "AGREED" ? item.state.consensus.relevance : null;
  if (choice.kind === "approve" && !proposal) throw new Error("There is no single agreed proposal to approve; choose a value.");
  const value = choice.kind === "approve" ? proposal! : choice.value;
  const shown = item.blind ? [] : [item.state?.A?.id, item.state?.B?.id].filter((x): x is number => !!x);
  const origin = shown.length > 0 && value !== proposal && !(item.state?.consensus.status === "DISAGREE" && (value === item.state.consensus.a || value === item.state.consensus.b)) ? "human_corrected" : "human_verified";
  const saved = await repo.saveLabel({
    postingId: item.posting.id, textSha256: item.posting.textSha256, task: "relevance", roleSlug: item.roleSlug, value, reviewer, sessionId, selectionBasis: item.basis.slice(0, 200),
    origin, ...(shown.length ? { llmLabelIds: shown } : {}), note: shown.length ? `reviewed against model proposal (${item.reason})` : item.blind && independentlyReviewed ? INDEPENDENT_REVIEW : undefined,
  });
  return { ...saved, origin };
}

// ------------------------------------------------------------------------------------------------------------------------ reporting

const CLASSES = ["relevant", "irrelevant", "adjacent", "unsure"] as const;
const zero = (): Record<(typeof CLASSES)[number], number> => ({ relevant: 0, irrelevant: 0, adjacent: 0, unsure: 0 });

export interface LlmReport {
  model: string; promptVersion: string;
  universe: { postings: number; distinctTexts: number; candidatePairs: number; distinctTextRolePairs: number };
  provisional: { pairsWithAnyPass: number; twoPass: number; byClass: Record<(typeof CLASSES)[number], number>; byClassAndSide: { train: Record<string, number>; heldout: Record<string, number> }; byStatus: { agreed: number; agreedConfident: number; disagree: number; lowConfidence: number; singlePass: number }; rejects: Record<string, number> };
  agreement: { passAvsB: { n: number; rate: number | null } };
  againstHumans: { blind: Vs; reviewedWithProposal: { n: number; verified: number; corrected: number; correctionRate: number | null }; qcAudit: { n: number; corrected: number; correctionRate: number | null } };
  humanVerified: { train: Record<string, number>; heldout: Record<string, number>; byOrigin: Record<string, number>; gates: ReturnType<typeof deficitReport> & { registry: boolean } };
  remainingHumanWork: { disagreement: number; low_confidence: number; qc_audit: number; eval_required: number };
}
interface Vs { n: number; passA: { n: number; accuracy: number | null }; passB: { n: number; accuracy: number | null }; agreed: { n: number; accuracy: number | null }; agreedConfident: { n: number; accuracy: number | null }; confusion: Record<string, Record<string, number>> }

const rate = (a: number, n: number): number | null => (n ? Number((a / n).toFixed(3)) : null);

export async function llmReport(repo: MlRepo, llm: LlmRepo, ctx: EngineContext, corpus: readonly CorpusRow[], model: string): Promise<LlmReport> {
  const sides = await sideResolver(repo);
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const states = (await pairStates(llm, model)).filter((s) => byId.get(s.postingId)?.textSha256 === s.textSha256);
  const humanRows = await repo.currentLabels();
  const humanRel = new Map(humanRows.filter((l) => l.task === "relevance").map((l) => [`${l.postingId}|${l.roleSlug}`, l]));
  const originOf = await repo.humanOrigins();

  // universe
  let candidatePairs = 0; const textRole = new Set<string>(); const texts = new Set<string>();
  for (const p of corpus) { const f = await featurize(ctx, p); texts.add(p.textSha256); for (const r of candidateRoles(ctx, f, 3)) { candidatePairs++; textRole.add(`${p.textSha256}|${r}`); } }

  const sideOf = (id: string) => sides.sideOf(byId.get(id)!.company);
  const byClass = zero(); const bySide = { train: zero() as Record<string, number>, heldout: zero() as Record<string, number> };
  const st = { agreed: 0, agreedConfident: 0, disagree: 0, lowConfidence: 0, singlePass: 0 };
  let ab = 0, abAgree = 0;
  for (const s of states) {
    const c = s.consensus;
    if (s.A && s.B) { ab++; if (s.A.relevance === s.B.relevance) abAgree++; }
    if (c.status === "AGREED") { st.agreed++; if (!c.lowConfidence) st.agreedConfident++; else st.lowConfidence++; byClass[c.relevance]!++; bySide[sideOf(s.postingId)]![c.relevance]!++; }
    else if (c.status === "SINGLE_PASS") { st.singlePass++; if (c.lowConfidence) st.lowConfidence++; byClass[c.relevance]!++; bySide[sideOf(s.postingId)]![c.relevance]!++; }
    else if (c.status === "DISAGREE") st.disagree++;
  }
  const rejects: Record<string, number> = {};
  for (const r of await llm.rejects()) rejects[r.reason] = (rejects[r.reason] ?? 0) + 1;

  // model vs from-scratch human labels (labels made without seeing a proposal)
  const vs: Vs = { n: 0, passA: { n: 0, accuracy: null }, passB: { n: 0, accuracy: null }, agreed: { n: 0, accuracy: null }, agreedConfident: { n: 0, accuracy: null }, confusion: {} };
  const hit = { A: 0, B: 0, g: 0, gc: 0 };
  let proposalReviewed = 0, verified = 0, corrected = 0, qcN = 0, qcCorrected = 0;
  for (const s of states) {
    const h = humanRel.get(`${s.postingId}|${s.roleSlug}`);
    if (!h || h.textSha256 !== s.textSha256) continue;
    const meta = originOf.get(h.id);
    if (meta?.llm) {
      proposalReviewed++;
      if (meta.origin === "human_corrected") corrected++; else verified++;
      if (h.selectionBasis === "llm_review:qc_audit") { qcN++; if (meta.origin === "human_corrected") qcCorrected++; }
      continue;
    }
    vs.n++;
    if (s.A) { vs.passA.n++; if (s.A.relevance === h.value) hit.A++; }
    if (s.B) { vs.passB.n++; if (s.B.relevance === h.value) hit.B++; }
    const c = s.consensus;
    if (c.status === "AGREED") {
      vs.agreed.n++; if (c.relevance === h.value) hit.g++;
      if (!c.lowConfidence) { vs.agreedConfident.n++; if (c.relevance === h.value) hit.gc++; }
      (vs.confusion[h.value] ??= {})[c.relevance] = ((vs.confusion[h.value] ??= {})[c.relevance] ?? 0) + 1;
    }
  }
  vs.passA.accuracy = rate(hit.A, vs.passA.n); vs.passB.accuracy = rate(hit.B, vs.passB.n); vs.agreed.accuracy = rate(hit.g, vs.agreed.n); vs.agreedConfident.accuracy = rate(hit.gc, vs.agreedConfident.n);

  // human gates (from ml_labels only)
  const deficits = await projectDeficits(repo, [...corpus]);
  const origin: Record<string, number> = {};
  for (const m of originOf.values()) origin[m.origin + (m.llm ? "+seen_proposal" : "")] = (origin[m.origin + (m.llm ? "+seen_proposal" : "")] ?? 0) + 1;
  const q = await buildReviewQueue(repo, llm, ctx, corpus, { model, size: 100000, evalSize: 100000 });
  const remaining = { ...q.available };

  return {
    model, promptVersion: PROMPT_VERSION,
    universe: { postings: corpus.length, distinctTexts: texts.size, candidatePairs, distinctTextRolePairs: textRole.size },
    provisional: { pairsWithAnyPass: states.length, twoPass: ab, byClass, byClassAndSide: bySide, byStatus: st, rejects },
    agreement: { passAvsB: { n: ab, rate: rate(abAgree, ab) } },
    againstHumans: { blind: vs, reviewedWithProposal: { n: proposalReviewed, verified, corrected, correctionRate: rate(corrected, proposalReviewed) }, qcAudit: { n: qcN, corrected: qcCorrected, correctionRate: rate(qcCorrected, qcN) } },
    humanVerified: { train: deficits.counts.train as Record<string, number>, heldout: deficits.counts.heldout as Record<string, number>, byOrigin: origin, gates: deficits },
    remainingHumanWork: remaining,
  };
}

// ------------------------------------------------------------------------------------------------------------------------ leakage checks and the separate experiment

export interface ProvisionalLeakage {
  provisionalPairs: number; trainSide: number; heldoutSide: number;
  exactTextAcrossSides: number; nearDuplicateAcrossSides: number; sharedEmployers: number; excludedFromExperiment: number; verdict: "CLEAN" | "ISSUES";
}

/** Do provisional labels respect the same train/held-out boundary as human labels? Reuses the frozen employer sides and the near-duplicate links. */
export async function provisionalLeakage(repo: MlRepo, llm: LlmRepo, ctx: EngineContext, corpus: readonly CorpusRow[], model: string): Promise<ProvisionalLeakage & { crossLinkedPostings: Set<string> }> {
  const sides = await sideResolver(repo);
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const states = (await pairStates(llm, model)).filter((s) => byId.get(s.postingId)?.textSha256 === s.textSha256);
  const humanPostings = (await repo.currentLabels()).filter((l) => l.task === "relevance").map((l) => l.postingId);
  const ids = new Set([...states.map((s) => s.postingId), ...humanPostings]);
  const sideOfPosting = (id: string) => sides.sideOf(byId.get(id)!.company);
  const train = [...ids].filter((i) => sideOfPosting(i) === "train"), held = [...ids].filter((i) => sideOfPosting(i) === "heldout");
  const trainTexts = new Set(train.map((i) => byId.get(i)!.textSha256));
  const exact = held.filter((i) => trainTexts.has(byId.get(i)!.textSha256)).length;
  const { postingLinks } = await nearDuplicateLinks(ctx, [...corpus], ids);
  const cross = new Set<string>();
  for (const [a, b] of postingLinks) {
    if (sideOfPosting(a) !== sideOfPosting(b)) cross.add(sideOfPosting(a) === "train" ? a : b);
  }
  const sharedEmployers = new Set(train.map((i) => byId.get(i)!.company)).size + new Set(held.map((i) => byId.get(i)!.company)).size - new Set([...train, ...held].map((i) => byId.get(i)!.company)).size;
  const out = {
    provisionalPairs: states.length, trainSide: states.filter((s) => sideOfPosting(s.postingId) === "train").length, heldoutSide: states.filter((s) => sideOfPosting(s.postingId) === "heldout").length,
    exactTextAcrossSides: exact, nearDuplicateAcrossSides: cross.size, sharedEmployers, excludedFromExperiment: cross.size, crossLinkedPostings: cross,
  };
  return { ...out, verdict: exact === 0 && sharedEmployers === 0 ? "CLEAN" : "ISSUES" };
}

export interface ExperimentRow { postingId: string; roleSlug: string; textSha256: string; company: string; relevance: "relevant" | "irrelevant"; origin: "human" | "llm_provisional"; confidence?: number }

/**
 * Rows for the SEPARATE provisional-label experiment: human train-side relevant/irrelevant labels plus provisional labels that the two passes agree on with
 * high confidence, only on TRAIN-side employers, without a human label of their own and not a near-duplicate of any held-out posting. Held-out rows are never
 * returned. The caller must report results as an experiment, never as a gate.
 */
export async function experimentRows(repo: MlRepo, llm: LlmRepo, ctx: EngineContext, corpus: readonly CorpusRow[], model: string): Promise<{ rows: ExperimentRow[]; excluded: Record<string, number> }> {
  const sides = await sideResolver(repo);
  const byId = new Map(corpus.map((c) => [c.id, c]));
  const leak = await provisionalLeakage(repo, llm, ctx, corpus, model);
  const excluded: Record<string, number> = {};
  const bump = (k: string) => { excluded[k] = (excluded[k] ?? 0) + 1; };
  const humanBuilt = buildDataset(await labeledPairs(repo, [...corpus]), SPLIT_SALT, sides.priors, [], { registry: sides.registry, heldoutEvalOnly: sides.registry });
  const rows: ExperimentRow[] = humanBuilt.items.filter((i) => i.split === "train" && (i.relevance === "relevant" || i.relevance === "irrelevant")).map((i) => ({ postingId: i.postingId, roleSlug: i.roleSlug, textSha256: i.textSha256, company: i.company, relevance: i.relevance as "relevant" | "irrelevant", origin: "human" }));
  const have = new Set(humanBuilt.items.map((i) => `${i.postingId}|${i.roleSlug}`));
  const humanTextRole = new Set(rows.map((r) => `${r.textSha256}|${r.roleSlug}`));
  const humanAny = new Set((await repo.currentLabels()).filter((l) => l.task === "relevance").map((l) => `${l.postingId}|${l.roleSlug}`));
  const seen = new Set<string>();
  for (const s of (await pairStates(llm, model)).sort((a, b) => a.key.localeCompare(b.key))) {
    const p = byId.get(s.postingId);
    const c = s.consensus;
    if (!p || p.textSha256 !== s.textSha256) { bump("STALE_TEXT"); continue; }
    if (sides.sideOf(p.company) !== "train") { bump("HELDOUT_SIDE"); continue; }
    if (c.status !== "AGREED" || c.lowConfidence) { bump("NOT_AGREED_CONFIDENT"); continue; }
    if (c.relevance !== "relevant" && c.relevance !== "irrelevant") { bump("ADJACENT_OR_UNSURE"); continue; }
    if (have.has(`${s.postingId}|${s.roleSlug}`) || humanAny.has(`${s.postingId}|${s.roleSlug}`)) { bump("HAS_HUMAN_LABEL"); continue; }
    if (leak.crossLinkedPostings.has(s.postingId)) { bump("NEAR_DUPLICATE_OF_HELDOUT"); continue; }
    const tk = `${p.textSha256}|${s.roleSlug}`;
    if (seen.has(tk) || humanTextRole.has(tk)) { bump("DUPLICATE_TEXT_ROLE"); continue; }
    seen.add(tk);
    rows.push({ postingId: s.postingId, roleSlug: s.roleSlug, textSha256: s.textSha256, company: p.company, relevance: c.relevance, origin: "llm_provisional", confidence: c.confidence });
  }
  return { rows, excluded };
}


// ------------------------------------------------------------------------------------------------------------------------ separately reported training experiment

export interface ExperimentArm { arm: "human_only" | "human_plus_provisional"; train: { relevant: number; irrelevant: number }; candidates: Array<{ candidate: string; status: "OK" | "REFUSED" | "FAILED"; cvF1?: number; detail?: string; heldout?: { n: number; f1: number | null; precision: number | null; recall: number | null; falsePositiveRate: number | null; threshold: number } }> }
export interface ExperimentReport {
  kind: "EXPERIMENT_NOT_A_GATE"; model: string; arms: ExperimentArm[]; heldout: { evaluated: boolean; reason: string; relevant: number; irrelevant: number }; excluded: Record<string, number>;
  caveats: string[];
}

/**
 * Trains the same three candidates twice on TRAIN-side data only: (a) human labels only, (b) human + provisional LLM labels. Artifacts go to
 * private-runtime/ml/experiments and are NOT registered in ml_models, so ml:shadow can never pick them up. The reported number is cross-validated F1 on the
 * training split plus, only if the human held-out gates are already met, one scoring pass on the independent human held-out rows (never used to choose
 * anything). It is an experiment report, not a gate result, and promotes nothing.
 */
export async function experimentTrain(repo: MlRepo, llm: LlmRepo, ctx: EngineContext, corpus: readonly CorpusRow[], model: string, python: PythonRunner = defaultPython, outDir = path.join(ML_DIR, "experiments")): Promise<ExperimentReport> {
  const { rows, excluded } = await experimentRows(repo, llm, ctx, corpus, model);
  const sides = await sideResolver(repo);
  const built = buildDataset(await labeledPairs(repo, [...corpus]), SPLIT_SALT, sides.priors, [], { registry: sides.registry, heldoutEvalOnly: sides.registry });
  const heldItems = built.items.filter((i) => i.split === "heldout" && (i.relevance === "relevant" || i.relevance === "irrelevant"));
  const heldOk = built.counts.heldout.relevant >= GATES.minHeldoutPerClass && built.counts.heldout.irrelevant >= GATES.minHeldoutPerClass && built.counts.employers.heldout >= GATES.minHeldoutEmployers;
  const toItem = (r: ExperimentRow): DatasetItem => ({ postingId: r.postingId, roleSlug: r.roleSlug, textSha256: r.textSha256, company: r.company, relevance: r.relevance, seniority: null, workMode: null, labelIds: [], groupKey: r.company.toLowerCase(), split: "train" });
  const heldRows = heldOk ? await rowsFor(ctx, repo, heldItems, true) : [];
  const arms: ExperimentArm[] = [];
  for (const arm of ["human_only", "human_plus_provisional"] as const) {
    const use = rows.filter((r) => arm === "human_plus_provisional" || r.origin === "human");
    const trainRows = await rowsFor(ctx, repo, use.map(toItem), true);
    const res: ExperimentArm = { arm, train: { relevant: use.filter((r) => r.relevance === "relevant").length, irrelevant: use.filter((r) => r.relevance === "irrelevant").length }, candidates: [] };
    arms.push(res);
    if (trainRows.length === 0) { res.candidates.push({ candidate: "all", status: "REFUSED", detail: "no usable training rows" }); continue; }
    const denseNames = trainRows[0]!.view.names;
    for (const candidate of CANDIDATES) {
      try {
        const art = trainArtifact({ purpose: "research", candidate, seed: TRAIN_SEED, denseNames, featureRevision: FEATURE_REVISION, datasetVersion: `exp-${arm}`, splitHash: "experiment", rows: trainRows.map((r) => ({ ...r.row, group: r.item.groupKey, emb: ["hybrid_emb", "minilm"].includes(candidate) ? r.row.emb : null })) }, outDir, python);
        const entry: ExperimentArm["candidates"][number] = { candidate, status: "OK", cvF1: art.meta.cvF1 };
        if (heldOk) {
          const sc = scoreRows({ artifactPath: art.file, artifactSha256: art.sha256, featureRevision: FEATURE_REVISION }, denseNames, heldRows.map((r) => ({ ...r.row, emb: ["hybrid_emb", "minilm"].includes(candidate) ? r.row.emb : null })), outDir, python);
          const scored: Scored[] = heldRows.map((r, i) => ({ score: sc.scores[i]!, label: r.item.relevance === "relevant", family: r.view.familySlug }));
          const m = binaryMetrics(scored, sc.threshold);
          entry.heldout = { n: m.n, f1: m.f1, precision: m.precision, recall: m.recall, falsePositiveRate: m.falsePositiveRate, threshold: sc.threshold };
        }
        res.candidates.push(entry);
      } catch (e) {
        res.candidates.push({ candidate, status: e instanceof MlRuntimeError ? "FAILED" : "REFUSED", detail: e instanceof Error ? e.message.slice(0, 200) : "training failed" });
      }
    }
  }
  return {
    kind: "EXPERIMENT_NOT_A_GATE", model, arms,
    heldout: { evaluated: heldOk, reason: heldOk ? "scored once on the independent human held-out rows; nothing was tuned on them" : "NOT_EVALUATED: the human held-out gates (>=10 relevant, >=10 irrelevant, >=3 employers, eval-stream labels only) are not met", relevant: built.counts.heldout.relevant, irrelevant: built.counts.heldout.irrelevant },
    excluded,
    caveats: ["Provisional labels come from a small local model and are not ground truth.", "Artifacts are not registered in ml_models and cannot be shadowed or promoted.", "Cross-validated F1 on the training split is not an independent estimate; only a held-out score from human eval-stream labels would be."],
  };
}

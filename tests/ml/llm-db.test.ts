import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { buildContext, makeEmbedService, type EngineContext } from "../../src/ml/engine.js";
import { jdCompleteness, type LlmProvider } from "../../src/ml/llm-label.js";
import { LlmRepo } from "../../src/ml/llm-repo.js";
import { buildReviewQueue, experimentRows, humanDecision, llmReport, pairStates, planBatch, provisionalLeakage, roleBriefs, runBatch, type BatchPair } from "../../src/ml/llm-workflows.js";
import { MlRepo, type CorpusInput } from "../../src/ml/repo.js";
import { freezeSides, proposeSides } from "../../src/ml/sides.js";
import { createDatasetVersion, employerStats, SPLIT_SALT, sideResolver } from "../../src/ml/workflows.js";
import { dbAvailable } from "../helpers/s1-harness.js";
import { fakeEncoder, SYNTHETIC_ROLE, syntheticCorpus, throwawayDb } from "../helpers/ml-fixtures.js";

// Integration on a throwaway PostgreSQL database with a scripted model. Every employer, posting and "model answer" is SYNTHETIC.
// The scripted model is a simple stand-in: SOC-flavoured text -> relevant for SOC Analyst, everything else irrelevant. Per-employer switches make it disagree or hedge.

// Tests must never read the person's real frozen registry (config/ml-employer-sides.json): point at a file that does not exist unless a test freezes its own.
process.env.JH_ML_SIDES_FILE = path.join(os.tmpdir(), `jh-no-sides-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

const PAD = " Our team collaborates closely across functions. Every member owns outcomes, writes clear documentation, and takes part in regular retrospectives. We are committed to inclusive hiring and provide mentoring, flexible schedules and a generous learning budget for every employee throughout the year. New colleagues receive a structured onboarding plan, a named buddy, and regular feedback during their first ninety days.";
const longCorpus = (): CorpusInput[] =>
  syntheticCorpus(20).map(({ synthetic: _s, ...p }) => {
    void _s;
    const description = `${p.description}${PAD}`;
    return { ...p, description, textSha256: createHash("sha256").update(`${p.title}\n${description}`).digest("hex") };
  });

interface Behaviour { disagreeB: Set<string>; hedge: Set<string>; calls: number }
function scriptedModel(b: Behaviour): LlmProvider {
  return {
    identity: async () => ({ provider: "scripted", model: "scripted-1", digest: "d".repeat(64) }),
    complete: async ({ user, pass }) => {
      b.calls++;
      const soc = /security operations center/.test(user) && /Target role: SOC Analyst/.test(user);
      const company = /Synthco\d\d/.exec(user)?.[0] ?? "";
      let relevance = soc ? "relevant" : "irrelevant";
      if (pass === "B" && b.disagreeB.has(company)) relevance = soc ? "adjacent" : "relevant";
      const quote = /security operations center/.test(user) ? "monitor SIEM alerts in Splunk, perform alert triage" : "grow our brand, manage campaigns, plan events";
      return { latencyMs: 2, content: JSON.stringify({ relevance, seniority: "mid", work_mode: "remote", confidence: b.hedge.has(company) ? 0.5 : 0.92, evidence: [quote], reasoning: soc ? "Alert triage in a SOC." : "Marketing work." }) };
    },
  };
}

suite("LLM-assisted provisional labeling (PostgreSQL)", { timeout: 600_000 }, () => {
  let env: Awaited<ReturnType<typeof throwawayDb>>;
  let repo: MlRepo, llm: LlmRepo;
  let ctx: EngineContext;
  let briefs: ReturnType<typeof roleBriefs>;
  const corpus = longCorpus();
  const b: Behaviour = { disagreeB: new Set(), hedge: new Set(), calls: 0 };
  const count = async (sql: string) => Number(((await env.pool.query(sql)).rows[0] as { n: string }).n);
  let sidesFile = "";
  let sideOf: (c: string) => "train" | "heldout";

  beforeAll(async () => {
    env = await throwawayDb();
    repo = new MlRepo(env.pool);
    llm = new LlmRepo(env.pool);
    await repo.upsertCorpus(corpus, "snap");
    const catalog = await new RolesRepo(env.pool).getCatalog();
    briefs = roleBriefs(catalog);
    ctx = await buildContext(catalog, makeEmbedService(repo, fakeEncoder));
    sidesFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jh-llm-sides-")), "sides.json");
    const entries = proposeSides(employerStats(await repo.corpus(), ctx), SPLIT_SALT);
    freezeSides(entries, SPLIT_SALT, "tester", sidesFile);
    process.env.JH_ML_SIDES_FILE = sidesFile;
    sideOf = (await sideResolver(repo)).sideOf;
  });
  afterAll(async () => { delete process.env.JH_ML_SIDES_FILE; await env?.drop(); });

  it("0008 rolls back without touching human labels and re-applies", async () => {
    const db2 = await throwawayDb();
    try {
      const r2 = new MlRepo(db2.pool);
      await r2.upsertCorpus(corpus.slice(0, 3), "snap");
      const p = (await r2.corpus())[0]!;
      await r2.saveLabel({ postingId: p.id, textSha256: p.textSha256, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: "relevant", reviewer: "tester", sessionId: "s", selectionBasis: "unit" });
      await db2.pool.query(readFileSync(path.resolve("db", "migrations", "down", "0011_ml_final_eval_claims.down.sql"), "utf8"));
      await db2.pool.query(readFileSync(path.resolve("db", "migrations", "down", "0010_ml_evidence_integrity.down.sql"), "utf8"));
      await db2.pool.query(readFileSync(path.resolve("db", "migrations", "down", "0009_llm_reject_ledger.down.sql"), "utf8"));
      await db2.pool.query(readFileSync(path.resolve("db", "migrations", "down", "0008_llm_labels.down.sql"), "utf8"));
      const tables = (await db2.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name as string);
      expect(tables).not.toContain("ml_llm_labels");
      expect(tables).toContain("ml_labels");
      expect(Number(((await db2.pool.query("SELECT count(*) n FROM ml_labels")).rows[0] as { n: string }).n)).toBe(1);
      const { migrate } = await import("../../src/db/migrate.js");
      expect((await migrate(db2.pool)).applied).toEqual(["0008_llm_labels", "0009_llm_reject_ledger", "0010_ml_evidence_integrity", "0011_ml_final_eval_claims"]);
      expect((await db2.pool.query("SELECT origin FROM ml_labels")).rows[0]).toMatchObject({ origin: "human_verified" }); // pre-existing rows are from-scratch human labels
    } finally { await db2.drop(); }
  });

  it("fixtures are complete enough to be labeled", () => {
    for (const p of corpus) expect(jdCompleteness(p.description).ok).toBe(true);
  });

  it("schema: provisional rows are append-only, can only be llm_provisional, and old human rows are human_verified", async () => {
    const p = (await repo.corpus())[0]!;
    await llm.save({ postingId: p.id, sourceKey: p.sourceKey, textSha256: p.textSha256, roleSlug: SYNTHETIC_ROLE, pass: "A", provider: "x", model: "schema-test", modelDigest: null, promptVersion: "v0", relevance: "relevant", seniority: "mid", workMode: "unclear", confidence: 0.9, evidence: ["quote text here"], reasoning: "r", jdCharsSent: 10, jdTruncated: false, latencyMs: 1, runId: "t" });
    await expect(env.pool.query("UPDATE ml_llm_labels SET relevance='irrelevant'")).rejects.toThrow(/append-only/);
    await expect(env.pool.query("DELETE FROM ml_llm_labels")).rejects.toThrow(/append-only/);
    await expect(env.pool.query("UPDATE ml_llm_labels SET label_source='human'")).rejects.toThrow();
    await expect(env.pool.query(`INSERT INTO ml_labels (posting_id, text_sha256, task, role_slug, value, label_source, reviewer, session_id, selection_basis) VALUES ('${p.id}','${p.textSha256}','relevance','${SYNTHETIC_ROLE}','relevant','llm_provisional','m','s','b')`)).rejects.toThrow();
  });

  it("rejection outcomes are append-only and idempotent within a run", async () => {
    const p = (await repo.corpus())[1]!;
    const reject = { postingId: p.id, textSha256: p.textSha256, roleSlug: SYNTHETIC_ROLE, pass: "A" as const, model: "reject-idempotency", promptVersion: "llm-label@1", reason: "INVALID_OUTPUT" as const, detail: "bad JSON", runId: "same-run" };
    await llm.reject(reject);
    await llm.reject(reject);
    expect(await count("SELECT count(*) n FROM ml_llm_rejects WHERE run_id='same-run' AND model='reject-idempotency'")).toBe(1);
    await expect(env.pool.query("UPDATE ml_llm_rejects SET detail='edited' WHERE run_id='same-run'")).rejects.toThrow(/append-only/);
    await expect(env.pool.query("DELETE FROM ml_llm_rejects WHERE run_id='same-run'")).rejects.toThrow(/append-only/);
  });

  it("a batch writes only provisional rows, never touches ml_labels, and resumes without re-asking the model", async () => {
    const humanBefore = await count("SELECT count(*) n FROM ml_labels");
    const plan = await planBatch(repo, llm, ctx, await repo.corpus(), { active: 40, evalN: 10, calibration: false, model: "scripted-1" });
    expect(plan.counts.active).toBeGreaterThan(10);
    expect(plan.counts.eval).toBeGreaterThan(0);
    // active pairs only on train-side employers; eval pairs only on held-out employers
    for (const p of plan.pairs) expect(sideOf(p.posting.company)).toBe(p.source === "eval" ? "heldout" : "train");
    // no two pairs share the same description and role
    expect(new Set(plan.pairs.map((p) => `${p.posting.textSha256}|${p.roleSlug}`)).size).toBe(plan.pairs.length);

    b.calls = 0;
    const stats = await runBatch(llm, scriptedModel(b), plan.pairs, briefs, { runId: "run-1" });
    expect(stats.attempted).toBe(plan.pairs.length);
    expect(stats.passA).toBe(plan.pairs.length);
    expect(stats.passB).toBeGreaterThan(0);
    expect(stats.passB).toBeLessThan(stats.passA + 1);
    expect(await count("SELECT count(*) n FROM ml_labels")).toBe(humanBefore);
    expect(await count("SELECT count(*) n FROM ml_llm_labels WHERE label_source='llm_provisional'")).toBeGreaterThanOrEqual(stats.passA + stats.passB);
    const row = (await llm.all("scripted-1"))[0]!;
    expect(row).toMatchObject({ provider: "scripted", model: "scripted-1", modelDigest: "d".repeat(64), promptVersion: "llm-label@3-full-jd-spans" });
    expect(row.sourceKey).toMatch(/^greenhouse:synthco/);
    expect(row.evidence.length).toBeGreaterThan(0);

    const callsAfterFirst = b.calls;
    const again = await runBatch(llm, scriptedModel(b), plan.pairs, briefs, { runId: "run-2" });
    expect(again.passA).toBe(0);
    expect(again.passB).toBe(0);
    expect(b.calls).toBe(callsAfterFirst); // fully resumed from storage
    const replan = await planBatch(repo, llm, ctx, await repo.corpus(), { active: 40, evalN: 10, calibration: false, model: "scripted-1" });
    const replanned = new Set(replan.pairs.map((p) => `${p.posting.id}|${p.roleSlug}`));
    for (const p of plan.pairs) expect(replanned.has(`${p.posting.id}|${p.roleSlug}`)).toBe(false); // labeled pairs are not offered again
  });

  it("equivalent descriptions at several locations are labeled once", async () => {
    const original = (await repo.corpus()).find((c) => c.title === "SOC Analyst" && c.company === "Synthco01")!;
    const clones: CorpusInput[] = ["Berlin", "Austin"].map((city, i) => ({ ...original, sourceKey: `${original.sourceKey}-loc${i}`, requisitionId: `${original.requisitionId}${i}`, location: city, sourceUrl: `${original.sourceUrl}-${i}` }));
    await repo.upsertCorpus(clones, "snap-dup");
    const all = await repo.corpus();
    const sameText = all.filter((c) => c.textSha256 === original.textSha256);
    expect(sameText.length).toBe(3);
    const plan = await planBatch(repo, llm, ctx, all, { active: 400, evalN: 0, calibration: false, model: "scripted-dup" });
    expect(plan.pairs.filter((p) => p.posting.textSha256 === original.textSha256 && p.roleSlug === SYNTHETIC_ROLE).length).toBeLessThanOrEqual(1);
  });

  const fresh = async (company: string, tag: string, short = false): Promise<BatchPair> => {
    const tmpl = corpus.find((c) => c.company === company && c.title === "SOC Analyst")!;
    const description = short ? "Apply here." : `${tmpl.description}

Fresh variant ${tag} with its own wording about handling escalations and weekly reporting.`;
    const row: CorpusInput = { ...tmpl, sourceKey: `${tmpl.sourceKey}-${tag}`, requisitionId: `${tmpl.requisitionId}${tag}`, title: `Detection Analyst ${tag}`, description, sourceUrl: `${tmpl.sourceUrl}-${tag}`, textSha256: createHash("sha256").update(`${tag}
${description}`).digest("hex") };
    await repo.upsertCorpus([row], `snap-${tag}`);
    return { posting: (await repo.corpus()).find((c) => c.sourceKey === row.sourceKey)!, roleSlug: SYNTHETIC_ROLE, source: "active", why: "test" };
  };

  it("an incomplete description is rejected and recorded, and the model is never called for it", async () => {
    const pair = await fresh("Synthco02", "short", true);
    b.calls = 0;
    const s = await runBatch(llm, scriptedModel(b), [pair], briefs, { runId: "run-short" });
    expect(s.rejected.INCOMPLETE_JD).toBe(1);
    expect(b.calls).toBe(0);
    expect((await llm.rejects()).some((r) => r.reason === "INCOMPLETE_JD" && r.postingId === pair.posting.id)).toBe(true);
    expect((await llm.all()).some((l) => l.postingId === pair.posting.id)).toBe(false);
    // and it is not planned again
    const replan = await planBatch(repo, llm, ctx, await repo.corpus(), { active: 400, evalN: 0, calibration: false, model: "scripted-1" });
    expect(replan.pairs.some((p) => p.posting.id === pair.posting.id)).toBe(false);
  });

  it("disagreement and low confidence go to the human queue; held-out employers contribute only blind evaluation samples", async () => {
    const trainCos = [...new Set(corpus.map((c) => c.company))].filter((c) => sideOf(c) === "train");
    const dis = trainCos[0]!, low = trainCos[1]!;
    b.disagreeB = new Set([dis]); b.hedge = new Set([low]);
    const pairs = [await fresh(dis, "d1"), await fresh(dis, "d2"), await fresh(low, "l1"), await fresh(low, "l2")];
    await runBatch(llm, scriptedModel(b), pairs, briefs, { runId: "run-3" });
    const q = await buildReviewQueue(repo, llm, ctx, await repo.corpus(), { model: "scripted-1", size: 500, evalSize: 8 });
    expect(q.available.disagreement).toBeGreaterThan(0);
    expect(q.available.low_confidence).toBeGreaterThan(0);
    expect(q.available.eval_required).toBeGreaterThan(0);
    for (const it of q.items) {
      if (it.reason === "eval_required") { expect(sideOf(it.posting.company)).toBe("heldout"); expect(it.blind).toBe(true); expect(it.basis).toMatch(/^eval_v1\|/); }
      else { expect(sideOf(it.posting.company)).toBe("train"); expect(it.blind).toBe(false); }
    }
    expect(q.items.filter((i) => i.reason === "disagreement").every((i) => i.posting.company === dis)).toBe(true);
    expect(q.items.filter((i) => i.reason === "low_confidence").every((i) => i.posting.company === low)).toBe(true);
    // confident agreed labels are only sampled for audit, never wholesale
    const qc = q.items.filter((i) => i.reason === "qc_audit").length;
    expect(qc).toBeGreaterThanOrEqual(3);
    expect(qc).toBeLessThan(q.available.qc_audit + 1);
    b.disagreeB = new Set(); b.hedge = new Set();
  });

  it("human decisions carry provenance: approve = human_verified, a different value = human_corrected, blind samples have no proposal link; the label is always source human", async () => {
    const q = await buildReviewQueue(repo, llm, ctx, await repo.corpus(), { model: "scripted-1", size: 500, evalSize: 8 });
    const agreed = q.items.find((i) => i.reason === "qc_audit" && i.state?.consensus.status === "AGREED")!;
    expect(agreed).toBeTruthy();
    const proposal = (agreed.state!.consensus as { relevance: string }).relevance;
    const a = await humanDecision(repo, agreed, { kind: "approve" }, "tester", "s1");
    expect(a.origin).toBe("human_verified");
    const row = (await env.pool.query("SELECT label_source, origin, llm_label_ids, reviewer, value FROM ml_labels WHERE id=$1", [a.id])).rows[0] as Record<string, unknown>;
    expect(row).toMatchObject({ label_source: "human", origin: "human_verified", reviewer: "tester", value: proposal });
    expect((row.llm_label_ids as string[]).length).toBeGreaterThan(0);

    const other = q.items.find((i) => i.reason === "qc_audit" && i.state?.consensus.status === "AGREED" && i !== agreed)!;
    const otherProposal = (other.state!.consensus as { relevance: string }).relevance;
    const flipped = otherProposal === "relevant" ? "irrelevant" : "relevant";
    const c = await humanDecision(repo, other, { kind: "set", value: flipped }, "tester", "s1");
    expect(c.origin).toBe("human_corrected");
    expect((await env.pool.query("SELECT origin, value FROM ml_labels WHERE id=$1", [c.id])).rows[0]).toMatchObject({ origin: "human_corrected", value: flipped });

    const blind = q.items.find((i) => i.reason === "eval_required")!;
    const blindProposalHidden = await humanDecision(repo, blind, { kind: "set", value: "irrelevant" }, "tester", "s2");
    expect(blindProposalHidden.origin).toBe("human_verified");
    expect((await env.pool.query("SELECT llm_label_ids, selection_basis FROM ml_labels WHERE id=$1", [blindProposalHidden.id])).rows[0]).toMatchObject({ llm_label_ids: null, selection_basis: blind.basis });
    await expect(humanDecision(repo, blind, { kind: "approve" }, "tester", "s2")).rejects.toThrow(/no single agreed proposal/);
    expect(await count("SELECT count(*) n FROM ml_labels WHERE label_source <> 'human'")).toBe(0);
    // labeled pairs leave the queue
    const after = await buildReviewQueue(repo, llm, ctx, await repo.corpus(), { model: "scripted-1", size: 500, evalSize: 8 });
    expect(after.items.some((i) => i.posting.id === agreed.posting.id && i.roleSlug === agreed.roleSlug)).toBe(false);
  });

  it("evaluation isolation: provisional labels never reach the human dataset, gates or held-out set; held-out labels count only from the eval stream", async () => {
    const humanOnly = await createDatasetVersion(repo, ctx, "tester");
    const manifest = humanOnly.manifest as { counts: { heldout: Record<string, number>; train: Record<string, number> }; labelSource: string };
    expect(manifest.labelSource).toMatch(/human reviewer labels/);
    // dataset items correspond exactly to HUMAN label ids
    const humanIds = new Set((await env.pool.query("SELECT id FROM ml_labels")).rows.map((r) => Number((r as { id: string }).id)));
    for (const it of await repo.datasetItems(humanOnly.version!)) for (const id of it.labelIds) expect(humanIds.has(id)).toBe(true);
    const provisionalPairs = (await pairStates(llm, "scripted-1")).length;
    expect(provisionalPairs).toBeGreaterThan(20);
    const totalItems = (await repo.datasetItems(humanOnly.version!)).length;
    expect(totalItems).toBeLessThan(provisionalPairs); // the provisional bulk is not in the human dataset
    // the report separates provenance and states gates from human labels only
    const rep = await llmReport(repo, llm, ctx, await repo.corpus(), "scripted-1");
    expect(rep.humanVerified.gates.ready).toBe(false);
    expect(rep.provisional.pairsWithAnyPass).toBe(provisionalPairs);
    expect(rep.againstHumans.reviewedWithProposal.n).toBeGreaterThanOrEqual(2);
    expect(rep.againstHumans.reviewedWithProposal.corrected).toBeGreaterThanOrEqual(1);
    expect(rep.agreement.passAvsB.n).toBeGreaterThan(0);
    // leakage verdict: the frozen employer sides keep employers disjoint and no exact text crosses
    const leak = await provisionalLeakage(repo, llm, ctx, await repo.corpus(), "scripted-1");
    expect(leak.sharedEmployers).toBe(0);
    expect(leak.exactTextAcrossSides).toBe(0);
  });

  it("the provisional-label experiment uses train-side agreed confident pairs only, never held-out rows, human-labeled pairs or low-confidence labels", async () => {
    const { rows, excluded } = await experimentRows(repo, llm, ctx, await repo.corpus(), "scripted-1");
    const prov = rows.filter((r) => r.origin === "llm_provisional");
    // Random database UUIDs affect the seeded second-pass/QC selections. Assert
    // non-vacuous isolation, not an unsupported minimum sample size.
    expect(prov.length).toBeGreaterThan(0);
    for (const r of rows) expect(sideOf(r.company)).toBe("train");
    const humanKeys = new Set((await repo.currentLabels()).filter((l) => l.task === "relevance").map((l) => `${l.postingId}|${l.roleSlug}`));
    for (const r of prov) { expect(humanKeys.has(`${r.postingId}|${r.roleSlug}`)).toBe(false); expect(r.confidence!).toBeGreaterThanOrEqual(0.75); expect(["relevant", "irrelevant"]).toContain(r.relevance); }
    expect(new Set(prov.map((r) => `${r.textSha256}|${r.roleSlug}`)).size).toBe(prov.length);
    expect(excluded.NOT_AGREED_CONFIDENT).toBeGreaterThan(0); // the disagreeing / hedged employers were kept out
    expect(Object.keys(excluded)).toContain("HAS_HUMAN_LABEL");
  });

  it("only the LLM workflow modules may import the provisional-label store", () => {
    const dir = path.resolve("src", "ml");
    const importers = readdirSync(dir).filter((f) => f.endsWith(".ts") && /llm-repo\.js/.test(readFileSync(path.join(dir, f), "utf8"))).sort();
    expect(importers).toEqual(["llm-cli.ts", "llm-review-cli.ts", "llm-workflows.ts"]);
    for (const f of ["split.ts", "features.ts", "metrics.ts", "artifact.ts", "labels.ts", "sides.ts"]) expect(readFileSync(path.join(dir, f), "utf8")).not.toMatch(/ml_llm_|llm-repo/);
    // workflows.ts (dataset/training/evaluation) must not read the provisional tables
    expect(readFileSync(path.join(dir, "workflows.ts"), "utf8")).not.toMatch(/ml_llm_|llm-repo/);
  });
});

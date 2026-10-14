import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync as read } from "node:fs";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { MlRuntimeError, scoreRows, trainArtifact, type PairRow, type PythonRunner } from "../../src/ml/artifact.js";
import { buildContext, featurize, makeEmbedService, pairFor, type EngineContext } from "../../src/ml/engine.js";
import { MlLabelError, MlRepo, type CorpusInput } from "../../src/ml/repo.js";
import { clusterCorpus, createDatasetVersion, evaluateDataset, shadowRun, trainModels } from "../../src/ml/workflows.js";
import { FEATURE_REVISION } from "../../src/ml/features.js";
import { dbAvailable } from "../helpers/s1-harness.js";
import { fakeEncoder, SYNTHETIC_ROLE, syntheticCorpus, throwawayDb, purgeHumanLabelsForTest } from "../helpers/ml-fixtures.js";

// Integration: real PostgreSQL (throwaway DB, all migrations), real scikit-learn subprocess, deterministic fake encoder. Everything is SYNTHETIC.

// Tests must never read the person's real frozen registry (config/ml-employer-sides.json): point at a file that does not exist unless a test freezes its own.
process.env.JH_ML_SIDES_FILE = path.join(os.tmpdir(), `jh-no-sides-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const tmpOut = () => mkdtempSync(path.join(os.tmpdir(), "jh-ml-"));

suite("ML engine on PostgreSQL", { timeout: 300_000 }, () => {
  let env: Awaited<ReturnType<typeof throwawayDb>>;
  let repo: MlRepo;
  let ctx: EngineContext;
  let svc: ReturnType<typeof makeEmbedService>;
  const corpus = syntheticCorpus(20);
  const count = async (sql: string) => Number(((await env.pool.query(sql)).rows[0] as { n: string }).n);

  beforeAll(async () => {
    env = await throwawayDb();
    repo = new MlRepo(env.pool);
    await repo.upsertCorpus(corpus, "snap-test");
    svc = makeEmbedService(repo, fakeEncoder);
    ctx = await buildContext(await new RolesRepo(env.pool).getCatalog(), svc);
  });
  afterAll(async () => { await env?.drop(); });

  const rows = () => repo.corpus();
  const byKey = async (key: string) => (await rows()).find((r) => r.sourceKey === key)!;

  it("applies 0006+0007, and 0007 rolls back and re-applies without touching the corpus", async () => {
    const versions = (await env.pool.query("SELECT version FROM schema_migrations ORDER BY 1")).rows.map((r) => r.version as string);
    expect(versions).toEqual(expect.arrayContaining(["0006_ml_engine", "0007_ml_pairs_registry"]));
    const db2 = await throwawayDb();
    try {
      const r2 = new MlRepo(db2.pool);
      await r2.upsertCorpus(corpus.slice(0, 5), "snap");
      await db2.pool.query(read(path.resolve("db", "migrations", "down", "0007_ml_pairs_registry.down.sql"), "utf8"));
      const tables = (await db2.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map((r) => r.table_name as string);
      expect(tables).not.toContain("ml_job_embeddings");
      expect(tables).toContain("ml_embeddings");
      expect(await r2.corpus()).toHaveLength(5);
      const { migrate } = await import("../../src/db/migrate.js");
      expect((await migrate(db2.pool)).applied).toEqual(["0007_ml_pairs_registry"]);
      expect(await r2.corpus()).toHaveLength(5);
    } finally { await db2.drop(); }
  });

  it("stores versioned chunk embeddings with provenance and reuses them; a changed JD gets new vectors, old ones stay as history", async () => {
    const p = await byKey(corpus[0]!.sourceKey);
    const before = svc.stats.misses;
    await featurize(ctx, p);
    expect(svc.stats.misses).toBeGreaterThan(before);
    const r = (await env.pool.query("SELECT * FROM ml_job_embeddings WHERE subject_key=$1 ORDER BY kind, chunk_index", [p.sourceKey])).rows;
    expect(r.length).toBeGreaterThanOrEqual(2);
    expect(r.every((x) => x.dims === 384 && x.vector.length === 384 && x.model_id && x.model_revision && x.preprocess && x.jd_sha256.trim() === p.textSha256)).toBe(true);
    const misses = svc.stats.misses;
    await featurize(ctx, p);
    expect(svc.stats.misses).toBe(misses); // reuse
    const changed: CorpusInput = { ...corpus[0]!, description: `${corpus[0]!.description}\n\nAmended requirements: Kubernetes.`, textSha256: "f".repeat(64) };
    await repo.upsertCorpus([changed], "snap-2");
    const p2 = await byKey(corpus[0]!.sourceKey);
    await featurize(ctx, p2);
    expect(svc.stats.misses).toBeGreaterThan(misses);
    expect(await count(`SELECT count(*) n FROM ml_job_embeddings WHERE subject_key='${p.sourceKey}' AND kind='title'`)).toBe(1); // title text unchanged -> same vector row
    expect(await count(`SELECT count(DISTINCT jd_sha256) n FROM ml_job_embeddings WHERE subject_key='${p.sourceKey}'`)).toBe(2); // old and new JD hashes both kept
    await repo.upsertCorpus([corpus[0]!], "snap-3"); // restore for the later tests
  });

  it("rejects invalid embeddings (wrong dimension, zero vector) and stores nothing for them", async () => {
    const bad = makeEmbedService(repo, { embed: async () => ({ vector: [1, 2, 3] }) });
    await expect(bad.vec({ subjectKey: "t:x:1", kind: "title", chunk: 0, text: "dimension probe" })).rejects.toThrow(/dimensions/);
    const zero = makeEmbedService(repo, { embed: async () => ({ vector: new Array(384).fill(0) }) });
    await expect(zero.vec({ subjectKey: "t:x:1", kind: "title", chunk: 0, text: "zero probe" })).rejects.toThrow(/zero|invalid/);
    expect(await count("SELECT count(*) n FROM ml_job_embeddings WHERE subject_key='t:x:1'")).toBe(0);
  });

  it("label persistence: role mandatory, stale text refused, duplicates skipped, history kept, model-sourced rows impossible", async () => {
    const p = await byKey(corpus[1]!.sourceKey);
    const base = { postingId: p.id, textSha256: p.textSha256, reviewer: "tester", sessionId: "s", selectionBasis: "unit test" };
    await expect(repo.saveLabel({ ...base, task: "relevance", roleSlug: "", value: "relevant" })).rejects.toBeInstanceOf(MlLabelError);
    await expect(repo.saveLabel({ ...base, textSha256: "e".repeat(64), task: "relevance", roleSlug: SYNTHETIC_ROLE, value: "relevant" })).rejects.toMatchObject({ code: "STALE_TEXT" });
    const first = await repo.saveLabel({ ...base, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: "unsure" });
    const again = await repo.saveLabel({ ...base, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: "unsure" });
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ id: first.id, duplicate: true });
    await repo.saveLabel({ ...base, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: "relevant" }); // correction appends
    expect(await count(`SELECT count(*) n FROM ml_labels WHERE posting_id='${p.id}'`)).toBe(2);
    expect((await repo.currentLabels()).find((l) => l.postingId === p.id)!.value).toBe("relevant");
    await expect(env.pool.query("INSERT INTO ml_labels (posting_id, text_sha256, task, role_slug, value, label_source, reviewer, session_id, selection_basis) VALUES ($1,$2,'relevance','soc-analyst','relevant','model','x','s','b')", [p.id, p.textSha256])).rejects.toThrow(/label_source|check/);
    await expect(env.pool.query("INSERT INTO ml_labels (posting_id, text_sha256, task, role_slug, value, reviewer, session_id, selection_basis) VALUES ($1,$2,'relevance','','relevant','x','s','b')", [p.id, p.textSha256])).rejects.toThrow(/check/);
    await purgeHumanLabelsForTest(env.pool);
  });

  it("with no labels: dataset NO_LABELS; with a handful: dataset exists but training is REFUSED and evaluation is NOT_EVALUATED", async () => {
    expect(await createDatasetVersion(repo, ctx, "tester")).toEqual({ status: "NO_LABELS" });
    for (const c of corpus.slice(0, 6)) {
      const p = await byKey(c.sourceKey);
      await repo.saveLabel({ postingId: p.id, textSha256: p.textSha256, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: c.synthetic.relevantToSoc ? "relevant" : "irrelevant", reviewer: "synthetic-oracle", sessionId: "s0", selectionBasis: "SYNTHETIC test oracle" });
    }
    const ds = await createDatasetVersion(repo, ctx, "tester");
    expect(ds.status).toBe("CREATED");
    expect((ds.manifest as { trainable: boolean }).trainable).toBe(false);
    const out = tmpOut();
    const t = await trainModels(repo, ctx, ds.version!, undefined, out);
    expect(t.status).toBe("REFUSED");
    expect(readdirSync(out)).toEqual([]); // the trainer was never started
    const e = await evaluateDataset(repo, ctx, ds.version!, undefined, out);
    expect(e.status).toBe("NOT_EVALUATED");
    expect(e.reasons!.length).toBeGreaterThan(0);
    expect(await count("SELECT count(*) n FROM ml_models")).toBe(0);
  });

  it("full loop on a synthetic corpus: label -> dataset -> train (train split only) -> evaluate on frozen held-out -> shadow, without touching production tables", async () => {
    for (const c of corpus) {
      const p = await byKey(c.sourceKey);
      await repo.saveLabel({ postingId: p.id, textSha256: p.textSha256, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: c.synthetic.relevantToSoc ? "relevant" : "irrelevant", reviewer: "synthetic-oracle", sessionId: "s1", selectionBasis: "SYNTHETIC test oracle", note: "independent-full-jd@1" });
    }
    const ds = await createDatasetVersion(repo, ctx, "tester");
    expect(ds.status).toBe("CREATED");
    const manifest = ds.manifest as { trainable: boolean; counts: any; splitHash: string; insufficiency: string[]; excluded: unknown[] };
    expect(manifest.trainable, JSON.stringify({ why: manifest.insufficiency, counts: manifest.counts, excluded: manifest.excluded.length })).toBe(true);
    const items = await repo.datasetItems(ds.version!);
    const heldCompanies = new Set(items.filter((i) => i.split === "heldout").map((i) => i.company));
    const trainCompanies = new Set(items.filter((i) => i.split === "train").map((i) => i.company));
    for (const c of heldCompanies) expect(trainCompanies.has(c)).toBe(false); // employer-grouped: no leakage
    // hand-computed from the fixture: 4 relevant + 3 irrelevant pairs per employer
    expect(manifest.counts.heldout.relevant).toBe(4 * heldCompanies.size);
    expect(manifest.counts.heldout.irrelevant).toBe(3 * heldCompanies.size);
    expect(await count(`SELECT count(*) n FROM ml_dataset_items WHERE version='${ds.version}'`)).toBe(corpus.length);

    const spy: string[] = [];
    const python: PythonRunner = (script, args, t) => { if (script === "ml_train.py") spy.push(readFileSync(args[0]!, "utf8")); return (require_default())(script, args, t); };
    const out = tmpOut();
    const t = await trainModels(repo, ctx, ds.version!, python, out, "synthetic");
    expect(t.status).toBe("OK");
    if (t.status !== "OK") return;
    expect(t.models.map((m) => m.candidate)).toEqual(["title_tfidf", "hybrid", "hybrid_emb", "tfidf", "minilm"]);
    expect(spy).toHaveLength(5);
    for (const payload of spy) {
      const parsed = JSON.parse(payload) as { rows: Array<{ group: string; y: number }>; datasetVersion: string };
      expect(parsed.rows.length).toBe(items.filter((i) => i.split === "train").length);
      for (const r of parsed.rows) expect(heldCompanies.has(r.group)).toBe(false); // the trainer never saw a held-out employer
    }
    expect(await count("SELECT count(*) n FROM ml_models")).toBe(5);

    const ev = await evaluateDataset(repo, ctx, ds.version!, undefined, out, "synthetic");
    expect(ev.status).toBe("EVALUATED");
    expect(ev.heldout).toMatchObject({ pairs: 7 * heldCompanies.size, positives: 4 * heldCompanies.size, negatives: 3 * heldCompanies.size });
    expect(ev.splitHash).toBe(manifest.splitHash);
    // the frozen split is now consumed: a second final evaluation is refused, and the reservation is COMPLETED
    const again = await evaluateDataset(repo, ctx, ds.version!, undefined, out, "synthetic");
    expect(again.status).toBe("NOT_EVALUATED");
    expect(again.reasons![0]).toMatch(/already reserved/);
    expect((await env.pool.query("SELECT state, scope FROM ml_final_eval_claims")).rows).toEqual([{ state: "COMPLETED", scope: "synthetic" }]);
    expect(ev.systems!.map((s) => s.name.slice(0, 1))).toEqual(["A", "B", "t", "h", "h", "t", "m"]);
    for (const s of ev.systems!) {
      expect(s.error).toBeUndefined();
      expect(s.metrics!.n).toBe(7 * heldCompanies.size);
      expect(s.metrics!.tp + s.metrics!.fp + s.metrics!.fn + s.metrics!.tn).toBe(s.metrics!.n);
    }
    for (const s of ev.systems!.slice(2)) { expect(s.latencyMs!.p50).toBeGreaterThan(0); expect(s.calibration!.brier).not.toBeNull(); }

    const jobsBefore = await count("SELECT count(*) n FROM jobs");
    const reportsBefore = await count("SELECT count(*) n FROM job_match_reports");
    const selBefore = await count("SELECT count(*) n FROM search_preferences");
    const model = (await repo.models(ds.version!)).find((m) => m.candidate === "hybrid")!;
    const sh = await shadowRun(repo, ctx, await repo.corpus(), model, undefined, out);
    expect(sh.status).toBe("OK");
    expect(sh.rows.length).toBeGreaterThanOrEqual(corpus.length);
    expect(sh.rows.every((r) => r.modelScore != null && r.modelScore >= 0 && r.modelScore <= 1)).toBe(true);
    expect(await count(`SELECT count(*) n FROM ml_shadow_predictions WHERE run_id='${sh.runId}'`)).toBe(sh.rows.length);
    expect([await count("SELECT count(*) n FROM jobs"), await count("SELECT count(*) n FROM job_match_reports"), await count("SELECT count(*) n FROM search_preferences")]).toEqual([jobsBefore, reportsBefore, selBefore]);
    expect(await count("SELECT count(*) n FROM candidate_facts WHERE approval_status='approved' AND updated_at > now() - interval '1 minute'")).toBe(0);
  });

  it("falls back cleanly when the model is missing or tampered: rule data still produced, no model scores, typed error", async () => {
    const model = (await repo.models()).find((m) => m.candidate === "title_tfidf")!;
    const missing = await shadowRun(repo, ctx, (await repo.corpus()).slice(0, 8), { ...model, artifactPath: path.join(os.tmpdir(), "does-not-exist.joblib") });
    expect(missing.status).toBe("FAILED");
    expect(missing.detail).toMatch(/missing/i);
    expect(missing.rows.length).toBeGreaterThan(0);
    expect(missing.rows.every((r) => r.modelScore === null && r.decision === null)).toBe(true);
    expect(await count(`SELECT count(*) n FROM ml_shadow_predictions WHERE run_id='${missing.runId}' AND model_score IS NOT NULL`)).toBe(0);
    const tampered = path.join(tmpOut(), "tampered.joblib");
    writeFileSync(tampered, readFileSync(model.artifactPath));
    writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from("x")]));
    const p = (await repo.corpus())[0]!;
    const f = await featurize(ctx, p);
    const v = pairFor(ctx, f, SYNTHETIC_ROLE);
    const row: PairRow = { title: p.title, role: SYNTHETIC_ROLE, dense: v.values, emb: null };
    expect(() => scoreRows({ ...model, artifactPath: tampered }, v.names, [row], tmpOut())).toThrowError(expect.objectContaining({ code: "ARTIFACT_HASH_MISMATCH" }));
    expect(() => scoreRows(model, v.names.slice().reverse(), [{ ...row }], tmpOut())).toThrowError(expect.objectContaining({ code: "FEATURE_MISMATCH" }));
    expect(() => scoreRows(model, v.names, [{ ...row, dense: v.values.slice(1) }], tmpOut())).toThrow();
  });

  it("clustering is descriptive: reports clusters and near-duplicates and writes nothing to roles or selections", async () => {
    const before = await count("SELECT count(*) n FROM search_preferences");
    const rolesBefore = await count("SELECT count(*) n FROM role_catalog_revisions");
    const rep = await clusterCorpus(ctx, await repo.corpus(), undefined, tmpOut());
    expect(rep.k).toBeGreaterThanOrEqual(2);
    expect(rep.clusters.reduce((s, c) => s + c.size, 0)).toBe(corpus.length);
    // each employer's 4 SOC postings share one JD text -> hand-known near-duplicate families exist
    expect(rep.nearDuplicates.length).toBeGreaterThan(0);
    expect(await count("SELECT count(*) n FROM search_preferences")).toBe(before);
    expect(await count("SELECT count(*) n FROM role_catalog_revisions")).toBe(rolesBefore);
  });
});

suite("scikit-learn kernel (no database)", { timeout: 180_000 }, () => {
  const synthetic = (n: number): PairRow[] => Array.from({ length: n }, (_, i) => {
    const pos = i % 2 === 0;
    return { title: pos ? `SOC Analyst ${i}` : `Marketing Manager ${i}`, role: "soc-analyst", dense: [pos ? 0.8 + (i % 5) / 100 : 0.1 + (i % 7) / 100, pos ? 1 : 0, i % 3], emb: null, group: `G${i % 10}`, y: pos ? 1 : 0 } as PairRow;
  });
  const input = (rows: PairRow[]) => ({ purpose: "synthetic" as const, candidate: "hybrid" as const, seed: 7, denseNames: ["sim", "rule", "noise"], featureRevision: FEATURE_REVISION, datasetVersion: "ds-test", splitHash: "0".repeat(64), rows });

  it("training is reproducible: same data and seed give byte-identical artifacts and identical scores", () => {
    const a = trainArtifact(input(synthetic(60)), tmpOut());
    const b = trainArtifact(input(synthetic(60)), tmpOut());
    expect(a.sha256).toBe(b.sha256);
    const reg = { artifactPath: a.file, artifactSha256: a.sha256, featureRevision: FEATURE_REVISION };
    const s1 = scoreRows(reg, ["sim", "rule", "noise"], synthetic(8), tmpOut());
    const s2 = scoreRows({ ...reg, artifactPath: b.file }, ["sim", "rule", "noise"], synthetic(8), tmpOut());
    expect(s2.scores).toEqual(s1.scores);
    expect(s1.scores.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(a.meta.libraries["scikit-learn"]).toBeTruthy();
    expect(a.meta.trainCounts).toEqual({ positive: 30, negative: 30, groups: 10 });
  });

  it("refuses to train with too few examples in a class and rejects non-finite or ragged features", () => {
    const rows = synthetic(40).map((r, i) => ({ ...r, y: (i < 2 ? 1 : 0) as 0 | 1 }));
    expect(() => trainArtifact(input(rows), tmpOut())).toThrowError(expect.objectContaining({ code: "PYTHON_FAILED" }));
    const ragged = synthetic(40); ragged[3]!.dense = [1, 2];
    expect(() => trainArtifact(input(ragged), tmpOut())).toThrowError(MlRuntimeError);
    const nan = synthetic(40); nan[3]!.dense = [Number.NaN, 0, 0];
    expect(() => trainArtifact(input(nan), tmpOut())).toThrowError(MlRuntimeError); // JSON turns NaN into null; the kernel refuses it
  });

  it("maps subprocess failures to typed errors: timeout, crash, garbage output", () => {
    const art = trainArtifact(input(synthetic(40)), tmpOut());
    const reg = { artifactPath: art.file, artifactSha256: art.sha256, featureRevision: FEATURE_REVISION };
    const names = ["sim", "rule", "noise"];
    expect(() => scoreRows(reg, names, synthetic(2), tmpOut(), () => ({ status: null, stdout: "", stderr: "", timedOut: true }))).toThrowError(expect.objectContaining({ code: "TIMEOUT" }));
    expect(() => scoreRows(reg, names, synthetic(2), tmpOut(), () => ({ status: 1, stdout: "", stderr: "boom" }))).toThrowError(expect.objectContaining({ code: "PYTHON_FAILED" }));
    const garbage: PythonRunner = (_s, args) => { writeFileSync(args[3]!, "not json"); return { status: 0, stdout: "{}", stderr: "" }; };
    expect(() => scoreRows(reg, names, synthetic(2), tmpOut(), garbage)).toThrowError(expect.objectContaining({ code: "BAD_OUTPUT" }));
    const outOfRange: PythonRunner = (_s, args) => { writeFileSync(args[3]!, JSON.stringify({ scores: [2, 0.5], threshold: 0.5, abstainBand: [0.4, 0.6], inferenceMs: 1 })); return { status: 0, stdout: "{}", stderr: "" }; };
    expect(() => scoreRows(reg, names, synthetic(2), tmpOut(), outOfRange)).toThrowError(expect.objectContaining({ code: "BAD_OUTPUT" }));
    expect(() => scoreRows({ ...reg, artifactPath: path.join(os.tmpdir(), "nope.joblib") }, names, synthetic(2), tmpOut())).toThrowError(expect.objectContaining({ code: "ARTIFACT_MISSING" }));
  });
});

import { defaultPython } from "../../src/ml/artifact.js";
function require_default(): PythonRunner { return defaultPython; }

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RolesRepo } from "../../src/db/roles-repo.js";
import type { PythonRunner } from "../../src/ml/artifact.js";
import { buildContext, makeEmbedService, type EngineContext } from "../../src/ml/engine.js";
import type { LlmProvider, RoleBrief } from "../../src/ml/llm-label.js";
import { roleBriefs } from "../../src/ml/llm-workflows.js";
import { MlRepo, type CorpusRow, type ModelRecord } from "../../src/ml/repo.js";
import { routeShadow } from "../../src/ml/route-shadow.js";
import { dbAvailable } from "../helpers/s1-harness.js";
import { fakeEncoder, syntheticCorpus, throwawayDb } from "../helpers/ml-fixtures.js";

process.env.JH_ML_SIDES_FILE = path.join(os.tmpdir(), `jh-no-sides-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
const available = await dbAvailable();
const suite = available ? describe : describe.skip;

// SYNTHETIC postings, scripted Qwen and scripted scorer: proves routing wiring and safety, not model accuracy.
suite("shadow three-way routing", { timeout: 120_000 }, () => {
  let env: Awaited<ReturnType<typeof throwawayDb>>;
  let ctx: EngineContext;
  let briefs: Map<string, RoleBrief>;
  let postings: CorpusRow[];
  const dir = mkdtempSync(path.join(os.tmpdir(), "jh-route-"));
  const artifact = path.join(dir, "m.joblib");
  writeFileSync(artifact, "x");
  let qwenCalls = 0;
  const qwen = (answer: "good" | "throw"): LlmProvider => ({
    identity: async () => ({ model: "scripted", provider: "test", digest: null }),
    complete: async (_req: unknown) => {
      qwenCalls++;
      if (answer === "throw") throw new Error("offline");
      throw new Error("scripted quote is checked against the JD; not used in these cases");
    },
  } as unknown as LlmProvider);
  const model = (status: ModelRecord["status"]): ModelRecord => ({ revision: "r1", candidate: "hybrid", datasetVersion: "ds", splitHash: "a".repeat(64), artifactPath: artifact, artifactSha256: "b".repeat(64), featureRevision: "f", libraryVersions: {}, seed: 1, status, metrics: null });
  const scorer = (score: number | "fail"): PythonRunner => (_s, args) => {
    if (score === "fail") return { status: 1, stdout: "artifact hash does not match", stderr: "" };
    const input = JSON.parse(require("node:fs").readFileSync(args[2]!, "utf8")) as { rows: unknown[] };
    writeFileSync(args[3]!, JSON.stringify({ scores: input.rows.map(() => score), threshold: 0.5, abstainBand: [0.1, 0.9], inferenceMs: 1, rows: input.rows.length }));
    return { status: 0, stdout: "", stderr: "" };
  };

  beforeAll(async () => {
    env = await throwawayDb();
    const repo = new MlRepo(env.pool);
    const PAD = " Our team collaborates closely across functions. Every member owns outcomes, writes clear documentation, and takes part in regular retrospectives. We are committed to inclusive hiring and provide mentoring, flexible schedules and a generous learning budget for every colleague. ".repeat(3);
    await repo.upsertCorpus(syntheticCorpus(3).map(({ synthetic: _s, ...p }) => { void _s; const description = `${p.description}${PAD}`; return { ...p, description, textSha256: createHash("sha256").update(`${p.title}
${description}`).digest("hex") }; }), "snap");
    postings = await repo.corpus();
    const catalog = await new RolesRepo(env.pool).getCatalog();
    ctx = await buildContext(catalog, makeEmbedService(repo, fakeEncoder));
    briefs = roleBriefs(catalog);
  });
  afterAll(async () => { await env?.drop(); });

  it("a promoted model's confident score is ML-accepted without calling Qwen", async () => {
    qwenCalls = 0;
    const r = await routeShadow(ctx, postings, model("promoted"), qwen("throw"), briefs, { limit: 3, python: scorer(0.97), outDir: dir });
    expect(r.rows).toHaveLength(3);
    expect(r.mlAcceptanceEnabled).toBe(true);
    for (const row of r.rows) expect(row.routed, JSON.stringify(row.routed)).toMatchObject({ path: "ML", decision: "relevant" });
    expect(qwenCalls).toBe(0);
  });

  it("an unpromoted (even trained and qualifying) model is never used for acceptance; Qwen failure lands in REVIEW", async () => {
    qwenCalls = 0;
    for (const status of ["candidate", "trained"] as ModelRecord["status"][]) {
      const r = await routeShadow(ctx, postings, model(status), qwen("throw"), briefs, { limit: 2, python: scorer(0.99), outDir: dir });
      expect(r.mlAcceptanceEnabled).toBe(false);
      for (const row of r.rows) { expect(row.mlScore).toBeNull(); expect(row.routed.path).toBe("REVIEW"); }
    }
    expect(qwenCalls).toBeGreaterThan(0);
  });

  it("a score inside the abstain band falls back to Qwen; a tampered artifact degrades safely", async () => {
    const mid = await routeShadow(ctx, postings, model("promoted"), qwen("throw"), briefs, { limit: 2, python: scorer(0.5), outDir: dir });
    for (const row of mid.rows) expect(row.routed.path).toBe("REVIEW");
    const bad = await routeShadow(ctx, postings, model("promoted"), qwen("throw"), briefs, { limit: 2, python: scorer("fail"), outDir: dir });
    expect(bad.mlError).toMatch(/hash/);
    expect(bad.mlAcceptanceEnabled).toBe(false);
    for (const row of bad.rows) expect(row.routed.path).not.toBe("ML");
  });

  it("writes nothing to the database", async () => {
    const before = (await env.pool.query("SELECT (SELECT count(*) FROM ml_labels)::int + (SELECT count(*) FROM ml_llm_labels)::int + (SELECT count(*) FROM ml_shadow_predictions)::int n")).rows[0].n;
    await routeShadow(ctx, postings, null, qwen("throw"), briefs, { limit: 2 });
    expect((await env.pool.query("SELECT (SELECT count(*) FROM ml_labels)::int + (SELECT count(*) FROM ml_llm_labels)::int + (SELECT count(*) FROM ml_shadow_predictions)::int n")).rows[0].n).toBe(before);
  });
});

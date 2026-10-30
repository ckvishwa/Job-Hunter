import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { buildContext, makeEmbedService, type EngineContext } from "../../src/ml/engine.js";
import { CorrectionError, correctLabel, correctionOf } from "../../src/ml/labels.js";
import { MlRepo } from "../../src/ml/repo.js";
import { parseEvalBasis } from "../../src/ml/sampler.js";
import { freezeSides, proposeSides } from "../../src/ml/sides.js";
import { createDatasetVersion, employerStats, projectDeficits, reviewQueue, SPLIT_SALT } from "../../src/ml/workflows.js";
import { dbAvailable } from "../helpers/s1-harness.js";
import { fakeEncoder, SYNTHETIC_ROLE, syntheticCorpus, throwawayDb, purgeHumanLabelsForTest } from "../helpers/ml-fixtures.js";

// Integration on a throwaway PostgreSQL database with a deterministic fake encoder. All employers, postings and labels are SYNTHETIC.

// Tests must never read the person's real frozen registry (config/ml-employer-sides.json): point at a file that does not exist unless a test freezes its own.
process.env.JH_ML_SIDES_FILE = path.join(os.tmpdir(), `jh-no-sides-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

suite("review queue, corrections and frozen registry (PostgreSQL)", { timeout: 300_000 }, () => {
  let env: Awaited<ReturnType<typeof throwawayDb>>;
  let repo: MlRepo;
  let ctx: EngineContext;
  const corpus = syntheticCorpus(20);
  const count = async (sql: string) => Number(((await env.pool.query(sql)).rows[0] as { n: string }).n);
  const posting = async (i: number) => (await repo.corpus()).find((r) => r.sourceKey === corpus[i]!.sourceKey)!;
  const label = async (i: number, value: string, basis = "unit test") => {
    const p = await posting(i);
    return repo.saveLabel({ postingId: p.id, textSha256: p.textSha256, task: "relevance", roleSlug: SYNTHETIC_ROLE, value, reviewer: "tester", sessionId: "s", selectionBasis: basis });
  };
  let sidesFile = "";

  beforeAll(async () => {
    env = await throwawayDb();
    repo = new MlRepo(env.pool);
    await repo.upsertCorpus(corpus, "snap");
    ctx = await buildContext(await new RolesRepo(env.pool).getCatalog(), makeEmbedService(repo, fakeEncoder));
    sidesFile = path.join(mkdtempSync(path.join(os.tmpdir(), "jh-sides-")), "sides.json");
  });
  afterAll(async () => { delete process.env.JH_ML_SIDES_FILE; await env?.drop(); });

  it("a correction appends an attributed row, keeps the original, and only the current label can be corrected", async () => {
    const first = await label(0, "relevant");
    const ds = await createDatasetVersion(repo, ctx, "tester");
    expect(ds.status).toBe("CREATED");
    const before = await repo.datasetItems(ds.version!);

    const r = await correctLabel(repo, { labelId: first.id, value: "irrelevant", reviewer: "tester", reason: "Sales strategy role, not this job family" });
    expect(r.corrected).toBe(first.id);
    const p = await posting(0);
    const history = await repo.labelHistory(p.id, "relevance", SYNTHETIC_ROLE);
    expect(history.map((h) => h.value)).toEqual(["relevant", "irrelevant"]); // original row untouched
    expect(history[0]!.id).toBe(first.id);
    expect(history[1]!.note).toMatch(/^CORRECTS #\d+ \(relevant -> irrelevant\): /);
    expect(correctionOf(history[1]!)).toMatchObject({ corrects: first.id, from: "relevant", to: "irrelevant" });
    expect((await repo.currentLabels()).find((l) => l.postingId === p.id && l.task === "relevance")!.value).toBe("irrelevant");
    expect(await repo.datasetItems(ds.version!)).toEqual(before); // frozen dataset versions never change

    await expect(correctLabel(repo, { labelId: first.id, value: "adjacent", reviewer: "tester", reason: "second thoughts here" })).rejects.toMatchObject({ code: "NOT_CURRENT" });
    await expect(correctLabel(repo, { labelId: r.newLabelId, value: "irrelevant", reviewer: "tester", reason: "same value again" })).rejects.toMatchObject({ code: "NO_CHANGE" });
    await expect(correctLabel(repo, { labelId: r.newLabelId, value: "adjacent", reviewer: "tester", reason: "short" })).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(correctLabel(repo, { labelId: 999999, value: "adjacent", reviewer: "tester", reason: "does not exist" })).rejects.toBeInstanceOf(CorrectionError);
    await expect(correctLabel(repo, { labelId: r.newLabelId, value: "maybe", reviewer: "tester", reason: "not a valid value" })).rejects.toThrow();
    expect(await count("SELECT count(*) n FROM ml_labels")).toBe(2);

    const next = await createDatasetVersion(repo, ctx, "tester"); // a NEW version picks up the correction
    expect((await repo.datasetItems(next.version!))[0]!.relevance).toBe("irrelevant");
  });

  it("refuses to correct a label whose posting text changed (stale) and leaves history alone", async () => {
    const l = await label(1, "relevant");
    await repo.upsertCorpus([{ ...corpus[1]!, description: `${corpus[1]!.description}\n\nChanged text.`, textSha256: "d".repeat(64) }], "snap-2");
    await expect(correctLabel(repo, { labelId: l.id, value: "irrelevant", reviewer: "tester", reason: "text changed meanwhile" })).rejects.toMatchObject({ code: "STALE_TEXT" });
    await repo.upsertCorpus([corpus[1]!], "snap-3");
    await purgeHumanLabelsForTest(env.pool);
  });

  it("only the person-run ops command can correct labels: no sampling, training or reviewer code calls correctLabel", () => {
    const dir = path.resolve("src", "ml");
    const callers = readdirSync(dir).filter((f) => f.endsWith(".ts") && /correctLabel\(/.test(readFileSync(path.join(dir, f), "utf8"))).sort();
    expect(callers).toEqual(["labels.ts", "ops-cli.ts"]);
  });

  it("with a frozen registry the active stream offers only train-side employers and the eval stream only held-out employers; neither writes", async () => {
    const entries = proposeSides(employerStats(await repo.corpus(), ctx), SPLIT_SALT);
    freezeSides(entries, SPLIT_SALT, "tester", sidesFile);
    process.env.JH_ML_SIDES_FILE = sidesFile;
    const side = new Map(entries.map((e) => [e.company, e.side]));
    expect(entries.filter((e) => e.side === "heldout").length).toBeGreaterThanOrEqual(3);
    const labelsBefore = await count("SELECT count(*) n FROM ml_labels");

    const active = await reviewQueue(repo, ctx, await repo.corpus(), 25, { stream: "active" });
    expect(active.length).toBeGreaterThan(10);
    expect(active.every((e) => side.get(e.posting.company) === "train" && e.stream === "active")).toBe(true);
    expect(active.every((e) => parseEvalBasis(e.basis) === null)).toBe(true);
    expect(active.every((e) => e.basis.length <= 200 && e.reason.length > 0)).toBe(true);

    const evalQ = await reviewQueue(repo, ctx, await repo.corpus(), 20, { stream: "eval" });
    expect(evalQ.length).toBe(20);
    expect(evalQ.every((e) => side.get(e.posting.company) === "heldout" && e.stream === "eval")).toBe(true);
    expect(evalQ.every((e) => parseEvalBasis(e.basis) !== null)).toBe(true);
    expect(await count("SELECT count(*) n FROM ml_labels")).toBe(labelsBefore);

    // after labeling one eval pair it is not offered again, and the draw order of the rest is unchanged
    const e0 = evalQ[0]!;
    await repo.saveLabel({ postingId: e0.posting.id, textSha256: e0.posting.textSha256, task: "relevance", roleSlug: e0.roleSlug, value: "irrelevant", reviewer: "tester", sessionId: "s", selectionBasis: e0.basis });
    const again = await reviewQueue(repo, ctx, await repo.corpus(), 20, { stream: "eval" });
    expect(again.map((e) => `${e.postingId}|${e.roleSlug}`)).not.toContain(`${e0.postingId}|${e0.roleSlug}`);
    expect(again.slice(0, 5).map((e) => e.postingId)).toEqual(evalQ.slice(1, 6).map((e) => e.postingId));
  });

  it("deficits count held-out labels only from the eval stream; an active-stream label on a held-out employer is excluded from the dataset", async () => {
    const entries = proposeSides(employerStats(await repo.corpus(), ctx), SPLIT_SALT);
    const heldCo = entries.find((e) => e.side === "heldout")!.company;
    const heldIdx = corpus.findIndex((c) => c.company === heldCo && c.synthetic.relevantToSoc);
    await label(heldIdx, "relevant", "likely_positive: should not count for evaluation");
    const d = await projectDeficits(repo, await repo.corpus());
    expect(d.registry).toBe(true);
    expect(d.counts.heldout.relevant).toBe(0);
    expect(d.needs.heldoutRelevant).toBe(10);
    const ds = await createDatasetVersion(repo, ctx, "tester");
    const manifest = ds.manifest as { excluded: Array<{ reason: string }>; heldoutEvalOnly: boolean; splitGroup: string };
    expect(manifest.heldoutEvalOnly).toBe(true);
    expect(manifest.splitGroup).toMatch(/frozen employer registry/);
    expect(manifest.excluded.map((e) => e.reason)).toContain("HELDOUT_NOT_EVAL_SAMPLE");
    // the same pair cannot be "promoted" by repeating the answer (no duplicate row, provenance unchanged); a DIFFERENT held-out pair labeled through the eval stream counts
    const again = await label(heldIdx, "relevant", "eval_v1|stratum=rule_admitted|N=100");
    expect(again.duplicate).toBe(true);
    expect((await projectDeficits(repo, await repo.corpus())).counts.heldout.relevant).toBe(0);
    const otherIdx = corpus.findIndex((c, i) => c.company === heldCo && c.synthetic.relevantToSoc && i !== heldIdx);
    const p = await posting(otherIdx);
    await repo.saveLabel({ postingId: p.id, textSha256: p.textSha256, task: "relevance", roleSlug: SYNTHETIC_ROLE, value: "relevant", reviewer: "tester", sessionId: "s2", selectionBasis: "eval_v1|stratum=rule_admitted|N=100" });
    expect((await projectDeficits(repo, await repo.corpus())).counts.heldout.relevant).toBe(1);
  });
});

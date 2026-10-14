import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { loadBoardsConfig } from "../jobs/runner.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { snapshotBoards } from "./corpus.js";
import { buildContext, makeEmbedService } from "./engine.js";
import { jdCompleteness } from "./llm-label.js";
import { OllamaLabeler } from "./llm-ollama.js";
import { MlRepo } from "./repo.js";
import { routeShadow } from "./route-shadow.js";
import { roleBriefs } from "./llm-workflows.js";
import { clusterCorpus, createDatasetVersion, evaluateDataset, labeledPairs, ML_DIR, mlMode, reviewQueue, shadowRun, trainModels } from "./workflows.js";

// npm run ml:status | ml:corpus | ml:dataset | ml:cluster | ml:sample | ml:train | ml:evaluate | ml:shadow      (docs/ML-ENGINE.md)
// Everything is local and private (private-runtime/ml). Nothing here writes a label, changes a role selection, a shortlist, a fact or an application.

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { user: { type: "string" }, size: { type: "string" }, delay: { type: "string" }, version: { type: "string" }, model: { type: "string" }, stream: { type: "string" }, "max-boards": { type: "string" }, limit: { type: "string" }, json: { type: "boolean", default: false } },
});
const fail = (m: string, code = 2): never => { console.error(m); process.exit(code); };
loadEnvFile(DEFAULT_ENV_FILE);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const report = (name: string, body: unknown) => {
  mkdirSync(path.join(ML_DIR, "reports"), { recursive: true });
  const file = path.join(ML_DIR, "reports", `${name}-${stamp()}.json`);
  writeFileSync(file, JSON.stringify(body, null, 1));
  return file;
};

async function main(): Promise<number> {
  if (!["status", "corpus", "dataset", "cluster", "sample", "train", "evaluate", "shadow", "route"].includes(command ?? "")) return fail("usage: ml <status|corpus|dataset|cluster|sample|train|evaluate|shadow|route>");
  const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
  try {
    const repo = new MlRepo(pool);
    const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
    const embedCtx = async () => {
      const svc = makeEmbedService(repo, new LocalTransformerEncoder());
      const catalog = await new RolesRepo(pool).getCatalog();
      return { svc, ctx: await buildContext(catalog, svc), catalog };
    };

    if (command === "status") {
      const corpus = await repo.corpus();
      const labels = await repo.currentLabels();
      const pairs = await labeledPairs(repo, corpus);
      const latest = await repo.latestDatasetVersion();
      const manifest = latest ? await repo.datasetManifest(latest) : null;
      const trainable = (manifest?.manifest as { trainable?: boolean } | undefined)?.trainable ?? false;
      console.log(JSON.stringify({
        mode: mlMode(), corpusPostings: corpus.length, employers: new Set(corpus.map((c) => c.company)).size,
        humanLabelRows: await repo.labelHistoryCount(), currentLabels: labels.length, relevanceLabeledPairs: pairs.length,
        relevance: Object.fromEntries(["relevant", "irrelevant", "adjacent", "unsure"].map((k) => [k, pairs.filter((l) => l.relevance === k).length])),
        latestDataset: latest, trainable, models: (await repo.models()).map((m) => ({ revision: m.revision, candidate: m.candidate, status: m.status })),
        evaluation: trainable ? "run ml:evaluate" : "NOT_EVALUATED (no independent labeled held-out set)",
        promotion: "none: production discovery and ranking are deterministic; ML runs in shadow only",
      }, null, 2));
      return 0;
    }

    if (command === "corpus") {
      const config = loadBoardsConfig();
      if (!config) return fail("No board list (JH_BOARDS_FILE).");
      const max = Number(values["max-boards"] ?? config.companies.length);
      const snapshotId = `snap-${stamp()}`;
      const { rows, boards } = await snapshotBoards(config.companies.slice(0, max), { delayMs: Number(values.delay ?? 500), onBoard: (b) => console.error(`[corpus] ${b.boardKey} ${b.status} fetched=${b.fetched} kept=${b.kept}${b.detail ? ` ${b.detail}` : ""}`) });
      const saved = await repo.upsertCorpus(rows, snapshotId);
      console.log(JSON.stringify({ snapshotId, boards: boards.length, boardsFailed: boards.filter((b) => b.status === "FAILED").length, postingsKept: rows.length, ...saved }, null, 2));
      return 0;
    }

    const { svc, ctx } = await embedCtx();
    if (command === "dataset") {
      const out = await createDatasetVersion(repo, ctx, handle);
      console.log(JSON.stringify(out.status === "NO_LABELS" ? { status: "NO_LABELS", note: "No human job-role labels yet. Run: npm run ml:review" } : { status: out.status, version: out.version, manifest: out.manifest }, null, 2));
      return 0;
    }
    const corpus = await repo.corpus();
    if (corpus.length === 0) return fail("The ML corpus is empty. Run: npm run ml:corpus", 1);

    if (command === "cluster") {
      const rep = await clusterCorpus(ctx, corpus);
      const file = report("clusters", rep);
      await repo.recordRun("cluster", "OK", { detail: { k: rep.k, silhouette: rep.silhouette, digest: rep.digest }, artifactPath: file });
      console.log(JSON.stringify({ file, k: rep.k, silhouette: rep.silhouette, nearDuplicatePairs: rep.nearDuplicates.length, clustersWithAliasCandidates: rep.clusters.filter((c) => c.candidateTitlesMissedByRules.length).length, embedCache: svc.stats, note: "descriptive only: no cluster is admitted into discovery and no role selection is changed" }, null, 2));
      return 0;
    }

    if (command === "sample") {
      const model = (await repo.models()).filter((m) => m.status !== "retired").at(-1) ?? null;
      const stream = values.stream === "eval" ? "eval" : "active";
      const q = await reviewQueue(repo, ctx, corpus, Number(values.size ?? 40), { stream, model: stream === "active" ? model : null });
      const lines = q.map((e) => [`${String(e.bucket).padEnd(34)} ${e.posting.company} / ${e.posting.title}  ->  ${e.roleSlug}`, `    ${e.reason}`].join(String.fromCharCode(10)));
      console.log(values.json ? JSON.stringify(q.map(({ posting, ...e }) => ({ ...e, company: posting.company, title: posting.title })), null, 1) : lines.join(String.fromCharCode(10)));
      return 0;
    }

    if (command === "train") {
      const version = values.version ?? (await repo.latestDatasetVersion());
      if (!version) return fail("No dataset version. Label pairs (ml:review), then run ml:dataset.", 1);
      const outcome = await trainModels(repo, ctx, version);
      await repo.recordRun("train", outcome.status === "OK" ? "OK" : outcome.status === "REFUSED" ? "REFUSED" : "FAILED", { datasetVersion: version, detail: outcome });
      console.log(JSON.stringify({ datasetVersion: version, ...outcome }, null, 2));
      return outcome.status === "OK" ? 0 : outcome.status === "REFUSED" ? 1 : 2;
    }

    if (command === "evaluate") {
      const version = values.version ?? (await repo.latestDatasetVersion());
      if (!version) return fail("No dataset version.", 1);
      const res = await evaluateDataset(repo, ctx, version);
      const file = report("evaluation", res);
      await repo.recordRun("evaluate", res.status === "EVALUATED" ? "OK" : "NOT_EVALUATED", { datasetVersion: version, detail: res, artifactPath: file });
      console.log(JSON.stringify({ file, ...res }, null, 2));
      return 0;
    }

    if (command === "route") {
      // Shadow three-way routing on a few postings with the LOCAL Qwen. Writes only a report: no labels, no ranking, no ML_ACCEPT unless a model is human-promoted.
      if (mlMode() !== "shadow") return fail("Set JH_ML_MODE=shadow to run routing (default is off).", 1);
      const limitRaw = values.limit ?? "5";
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 50) return fail("--limit must be an integer 1..50.", 1);
      const { ctx, catalog } = await embedCtx();
      const model = (await repo.models()).filter((m) => m.status === "promoted").at(-1) ?? null;
      const complete = (await repo.corpus()).filter((p) => jdCompleteness(p.description).ok);
      const res = await routeShadow(ctx, complete, model, new OllamaLabeler(), roleBriefs(catalog), { limit: Number(limitRaw) });
      const file = report("route", res);
      console.log(JSON.stringify({ mode: "shadow", pairs: res.rows.length, byPath: res.byPath, modelRevision: res.modelRevision, mlAcceptanceEnabled: res.mlAcceptanceEnabled, report: file, note: "shadow only: nothing written to the database; provisional output is not a human label." }, null, 2));
      return 0;
    }

    if (command === "shadow") {
      const models = (await repo.models()).filter((m) => m.status !== "retired");
      const model = values.model ? (await repo.model(values.model)) : (models.at(-1) ?? null);
      if (values.model && !model) return fail(`Unknown model revision ${values.model}.`, 1);
      const out = await shadowRun(repo, ctx, corpus, model, undefined, undefined, { onProgress: (d, t) => console.error(`[shadow] ${d}/${t}`) });
      const ruleAdmitted = out.rows.filter((r) => r.ruleRelevant);
      const disagreements = out.rows.filter((r) => r.decision && r.decision !== "abstain" && (r.decision === "relevant") !== r.ruleRelevant);
      const file = report("shadow", {
        runId: out.runId, modelRevision: out.modelRevision, pairs: out.rows.length, ruleAdmittedPairs: ruleAdmitted.length, disagreements: disagreements.length,
        topBySimilarityNotAdmittedByRules: out.rows.filter((r) => !r.ruleRelevant).sort((a, b) => b.sim - a.sim).slice(0, 30).map((r) => ({ company: r.posting.company, title: r.posting.title, role: r.roleSlug, sim: Number(r.sim.toFixed(3)), modelScore: r.modelScore })),
        ruleAdmittedLowestSimilarity: [...ruleAdmitted].sort((a, b) => a.sim - b.sim).slice(0, 30).map((r) => ({ company: r.posting.company, title: r.posting.title, role: r.roleSlug, sim: Number(r.sim.toFixed(3)), modelScore: r.modelScore })),
      });
      console.log(JSON.stringify({ runId: out.runId, status: out.status, detail: out.detail, mode: mlMode(), pairs: out.rows.length, ruleAdmittedPairs: ruleAdmitted.length, modelRevision: out.modelRevision, modelDisagreements: disagreements.length, embedCache: svc.stats, report: file, note: "shadow only: production discovery, shortlist and ranking are unchanged. Accuracy is NOT_EVALUATED without independent labels." }, null, 2));
      return out.status === "OK" ? 0 : 1;
    }
    return 2;
  } finally {
    await pool.end();
  }
}

process.exitCode = await main().catch((e) => { console.error(`ml ${command} failed: ${e instanceof Error ? e.message : String(e)}`); return 1; });

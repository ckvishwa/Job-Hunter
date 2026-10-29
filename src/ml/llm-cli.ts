import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { parseArgs } from "node:util";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { buildContext, makeEmbedService } from "./engine.js";
import { PROMPT_VERSION } from "./llm-label.js";
import { OllamaLabeler } from "./llm-ollama.js";
import { LlmRepo } from "./llm-repo.js";
import { experimentRows, experimentTrain, llmReport, planBatch, provisionalLeakage, roleBriefs, runBatch } from "./llm-workflows.js";
import { MlRepo } from "./repo.js";
import { ML_DIR } from "./workflows.js";

// npm run ml:llm -- plan   [--active 300] [--eval 40] [--no-calibration]     read-only: which pairs would be sent to the model
// npm run ml:llm -- run    [--active 300] [--eval 40] [--no-calibration] [--max-minutes 45]   label with the LOCAL model (loopback Ollama); provisional only
// npm run ml:llm -- report                                                    counts, agreement, correction rate, leakage checks, gate status
// npm run ml:llm -- experiment                                                SEPARATE experiment: train with provisional labels, reported apart from the gates
//
// Everything written here is llm_provisional (ml_llm_labels). Nothing is written to ml_labels, nothing is trained or promoted by `plan`, `run` or `report`.

const [sub, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { active: { type: "string", default: "300" }, eval: { type: "string", default: "40" }, "no-calibration": { type: "boolean", default: false }, "max-minutes": { type: "string" }, model: { type: "string" }, train: { type: "boolean", default: false } } });
loadEnvFile(DEFAULT_ENV_FILE);
const save = (name: string, body: unknown) => {
  mkdirSync(path.join(ML_DIR, "reports"), { recursive: true });
  const file = path.join(ML_DIR, "reports", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(body, null, 1));
  return file;
};
const pct = (x: number | null) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

async function main(): Promise<void> {
  if (!["plan", "run", "report", "experiment"].includes(sub ?? "")) throw new Error("usage: ml:llm -- plan | run | report | experiment");
  for (const key of ["active", "eval", "max-minutes"] as const) {
    const raw = values[key];
    if (raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > (key === "max-minutes" ? 120 : 5000) || (key === "max-minutes" && Number(raw) === 0))) throw new Error(`Invalid --${key}: use a bounded nonnegative integer (max-minutes 1..120).`);
  }
const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
let owner: PoolClient | undefined;
try {
  if (sub === "run") {
    owner = await pool.connect();
    const locked = await owner.query("SELECT pg_try_advisory_lock(749211, 1) AS acquired");
    if (!locked.rows[0]?.acquired) throw new Error("Another labeling worker owns the database lock.");
    owner.on("error", () => { console.error("Labeling ownership connection lost; stopping. Saved passes remain resumable."); process.exit(1); });
  }
  const repo = new MlRepo(pool);
  const llmRepo = new LlmRepo(pool);
  const catalog = await new RolesRepo(pool).getCatalog();
  const titles = new Map(catalog.roles.map((r) => [r.roleSlug, r.title]));
  const provider = new OllamaLabeler({ model: values.model });
  const ctx = await buildContext(catalog, makeEmbedService(repo, new LocalTransformerEncoder()));
  const corpus = await repo.corpus();
  if (corpus.length === 0) { throw new Error("The ML corpus is empty. Run: npm run ml:corpus"); }
  const model = provider.model;

  if (sub === "plan" || sub === "run") {
    const plan = await planBatch(repo, llmRepo, ctx, corpus, { active: Number(values.active), evalN: Number(values.eval), calibration: !values["no-calibration"], model, roleTitleOf: (s) => titles.get(s) ?? s });
    console.log(`Plan: ${plan.pairs.length} pairs (calibration ${plan.counts.calibration}, eval-stream ${plan.counts.eval}, active ${plan.counts.active}); ${plan.skippedAlreadyLabeled} already labeled by ${model}/${PROMPT_VERSION} and skipped.`);
    if (sub === "plan") {
      for (const p of plan.pairs.slice(0, 40)) console.log(`  [${p.source}] ${p.posting.company} / ${p.posting.title.slice(0, 55)} -> ${p.roleSlug}`);
      if (plan.pairs.length > 40) console.log(`  ... ${plan.pairs.length - 40} more`);
      console.log("No Qwen inference or labels written; embedding caches may be populated by planning.");
      return;
    }
    const id = await provider.identity();
    console.log(`Model ${id.model} (digest ${id.digest?.slice(0, 12)}…) via loopback Ollama; prompt ${PROMPT_VERSION}. Provisional labels only. Ctrl+C is safe: every answer is stored as it arrives and a rerun resumes.`);
    const stats = await runBatch(llmRepo, provider, plan.pairs, roleBriefs(catalog), {
      maxMinutes: values["max-minutes"] ? Number(values["max-minutes"]) : 45,
      onCheckpoint: (stats) => {
        const directory = path.join(ML_DIR, "reports");
        mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${stats.runId}.checkpoint.json`);
        writeFileSync(`${file}.tmp`, JSON.stringify({ stats, plan: plan.counts, updatedAt: new Date().toISOString() }, null, 2));
        renameSync(`${file}.tmp`, file);
      },
      onProgress: (n, total, line) => { if (n % 10 === 0 || n === total) console.log(`  ${n}/${total}  ${line}`); },
    });
    const file = save("llm-run", { stats, plan: plan.counts });
    console.log(`\nRun ${stats.runId}: attempted ${stats.attempted}, pass A ${stats.passA}, pass B ${stats.passB}, rejected ${JSON.stringify(stats.rejected)}, second-pass reasons ${JSON.stringify(stats.secondPassReasons)}; avg ${stats.avgLatencyMs}ms/call${stats.stoppedEarly ? " (stopped at the time limit; rerun to continue)" : ""}\nreport: ${file}\nNext: npm run ml:llm -- report ; npm run ml:llm-review`);
    return;
  }

  if (sub === "report") {
    const r = await llmReport(repo, llmRepo, ctx, corpus, model);
    const leak = await provisionalLeakage(repo, llmRepo, ctx, corpus, model);
    const { crossLinkedPostings: _drop, ...leakage } = leak; void _drop;
    const file = save("llm-report", { ...r, leakage });
    const u = r.universe, p = r.provisional, h = r.againstHumans;
    console.log(`== LLM-assisted labeling report  (${r.model}, ${r.promptVersion}) ==`);
    console.log(`Existing job-role pairs: ${u.postings} postings x roles; candidate pairs (rule-admitted + 3 most similar roles per posting) ${u.candidatePairs}; after removing equivalent descriptions ${u.distinctTextRolePairs} distinct (text, role) pairs.`);
    console.log(`\nProvisional (llm_provisional, NOT human): ${p.pairsWithAnyPass} pairs labeled, ${p.twoPass} with two independent passes`);
    console.log(`  by class   ${JSON.stringify(p.byClass)}   (agreed/single-pass value; disagreements excluded)`);
    console.log(`  train side ${JSON.stringify(p.byClassAndSide.train)}   held-out side ${JSON.stringify(p.byClassAndSide.heldout)}`);
    console.log(`  status     agreed ${p.byStatus.agreed} (confident ${p.byStatus.agreedConfident}), disagree ${p.byStatus.disagree}, low-confidence ${p.byStatus.lowConfidence}, single pass ${p.byStatus.singlePass}; rejected ${JSON.stringify(p.rejects)}`);
    console.log(`  pass A vs pass B agreement: ${pct(r.agreement.passAvsB.rate)} of ${r.agreement.passAvsB.n}`);
    console.log(`\nModel vs labels without recorded proposal links (independence unverified): n=${h.blind.n}`);
    console.log(`  pass A ${pct(h.blind.passA.accuracy)} (n=${h.blind.passA.n}), pass B ${pct(h.blind.passB.accuracy)} (n=${h.blind.passB.n}), both agree ${pct(h.blind.agreed.accuracy)} (n=${h.blind.agreed.n}), agree+confident ${pct(h.blind.agreedConfident.accuracy)} (n=${h.blind.agreedConfident.n})`);
    console.log(`  confusion (human -> model, agreed pairs) ${JSON.stringify(h.blind.confusion)}`);
    console.log(`Reviewed WITH a proposal: ${h.reviewedWithProposal.n} (approved ${h.reviewedWithProposal.verified}, corrected ${h.reviewedWithProposal.corrected}, correction rate ${pct(h.reviewedWithProposal.correctionRate)}); random QC audits: ${h.qcAudit.n}, corrected ${h.qcAudit.corrected} (${pct(h.qcAudit.correctionRate)})`);
    console.log(`\nHuman-verified labels by partition (these alone count toward the gates): ${r.humanVerified.gates.registry ? "frozen employer registry" : "NO frozen registry"}`);
    for (const l of r.humanVerified.gates.lines) console.log(`  ${l}`);
    console.log(`  provenance of human labels ${JSON.stringify(r.humanVerified.byOrigin)}`);
    console.log(`  training gates satisfied: ${r.humanVerified.gates.ready ? "YES" : "NO"}`);
    console.log(`\nLeakage / dedup: ${leak.verdict}; provisional pairs train ${leak.trainSide} / held-out ${leak.heldoutSide}; exact texts across sides ${leak.exactTextAcrossSides}; near-duplicates (>=0.985) of a held-out posting on the train side ${leak.nearDuplicateAcrossSides} (excluded from the experiment); employers on both sides ${leak.sharedEmployers}`);
    console.log(`\nRemaining human work: disagreements ${r.remainingHumanWork.disagreement}, low confidence ${r.remainingHumanWork.low_confidence}, QC audit sample ${r.remainingHumanWork.qc_audit}, independent evaluation samples ${r.remainingHumanWork.eval_required} (next draw)`);
    console.log(`\nreport: ${file}`);
    return;
  }

  if (sub === "experiment") {
    const { rows, excluded } = await experimentRows(repo, llmRepo, ctx, corpus, model);
    const c = (o: string, v: string) => rows.filter((r) => r.origin === o && r.relevance === v).length;
    console.log(`Experiment rows (TRAIN-side employers only): human ${c("human", "relevant")} relevant / ${c("human", "irrelevant")} irrelevant; provisional (two passes agree, confident) ${c("llm_provisional", "relevant")} relevant / ${c("llm_provisional", "irrelevant")} irrelevant; excluded ${JSON.stringify(excluded)}`);
    const file = save("llm-experiment-rows", { note: "EXPERIMENT ONLY. Provisional labels are not ground truth; no held-out row is included; nothing here is registered, promoted or counted toward any gate.", counts: { human: { relevant: c("human", "relevant"), irrelevant: c("human", "irrelevant") }, provisional: { relevant: c("llm_provisional", "relevant"), irrelevant: c("llm_provisional", "irrelevant") } }, excluded, rows });
    console.log(`rows written: ${file}`);
    if (!values.train) { console.log("Add --train to run the separately reported experiment (human-only vs human+provisional, same candidates; nothing is registered or promoted)."); return; }
    const rep = await experimentTrain(repo, llmRepo, ctx, corpus, model);
    const f = save("llm-experiment", rep);
    console.log("\n== EXPERIMENT (not a gate, nothing registered or promoted) ==");
    for (const a of rep.arms) {
      console.log(`arm ${a.arm}: train ${JSON.stringify(a.train)}`);
      for (const k of a.candidates) console.log(`   ${k.candidate.padEnd(12)} ${k.status}${k.cvF1 != null ? `  cv-F1 ${k.cvF1.toFixed(3)}` : ""}${k.heldout ? `  held-out F1 ${k.heldout.f1?.toFixed(3)} (n=${k.heldout.n})` : ""}${k.detail ? `  ${k.detail}` : ""}`);
    }
    console.log(`held-out: ${rep.heldout.reason}\nreport: ${f}`);
    return;
  }

  console.error("usage: ml:llm -- plan | run | report | experiment");
  process.exitCode = 2; return;
} finally {
  if (owner) {
    await owner.query("SELECT pg_advisory_unlock(749211, 1)").catch(() => undefined);
    owner.release();
  }
  await pool.end();
}
}
await main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { renderReviewBatch, validateDecisions } from "./review-batch.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { buildContext, makeEmbedService } from "./engine.js";
import { RELEVANCE_DEFINITIONS, SEPARATION_NOTE } from "./guidance.js";
import { OllamaLabeler } from "./llm-ollama.js";
import { LlmRepo } from "./llm-repo.js";
import { buildReviewQueue, humanDecision, type ReviewItem, type ReviewReason } from "./llm-workflows.js";
import { MlRepo } from "./repo.js";
import { projectDeficits } from "./workflows.js";

// npm run ml:llm-review -- [--size 30] [--eval 10] [--only disagreement,low_confidence,eval_required,qc_audit] [--reviewer name]
//
// ONE queue of the pairs where independent human judgment is needed: the two model passes disagree, the model is unsure, the next independent evaluation
// samples (model proposal HIDDEN), and a random audit of confident labels. Your answer is a HUMAN label saved the moment you press the key:
//   Enter / y  approve the model's proposal (only when both passes agree)      r i a u  your own value (a different value = human_corrected)
//   s          approve the proposed seniority too (saved separately)           n skip   ? definitions   d deficits   q quit
// A model value is never saved by itself: no key, no label.

const { values } = parseArgs({ options: { size: { type: "string", default: "30" }, eval: { type: "string", default: "10" }, only: { type: "string" }, reviewer: { type: "string" }, model: { type: "string" }, "export-batch": { type: "string" }, "import-decisions": { type: "string" }, batch: { type: "string" } } });
for (const key of ["size", "eval"] as const) if (!/^\d+$/.test(values[key]!) || Number(values[key]) > 200) throw new Error(`--${key} must be an integer from 0 to 200`);
loadEnvFile(DEFAULT_ENV_FILE);
const reviewer = values.reviewer ?? process.env.JH_USER_HANDLE ?? "local";
const only = values.only ? (values.only.split(",").map((s) => s.trim()) as ReviewReason[]) : undefined;
if (only && !only.every((o) => ["disagreement", "low_confidence", "eval_required", "qc_audit"].includes(o))) { console.error("--only takes: disagreement,low_confidence,eval_required,qc_audit"); process.exit(2); }

const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
try {
  const repo = new MlRepo(pool);
  if (values["import-decisions"]) {
    if (!values.batch || !values.reviewer) throw new Error("Import requires --batch <manifest.json> and --reviewer <name>.");
    const batch = JSON.parse(readFileSync(values.batch, "utf8")) as { version: number; batchId: string; items: ReviewItem[] };
    if (batch.version !== 1 || !Array.isArray(batch.items)) throw new Error("Unsupported review manifest.");
    const decisions = validateDecisions(JSON.parse(readFileSync(values["import-decisions"], "utf8")), batch.batchId, batch.items);
    // Validate all text hashes before the first write. Retrying a partially saved
    // import is idempotent; original annotations are never overwritten.
    for (const d of decisions) {
      const item = batch.items[d.index]!;
      if ((await repo.posting(item.posting.id))?.textSha256 !== item.posting.textSha256) throw new Error("Review batch contains stale posting text; regenerate it.");
    }
    for (const d of decisions) await humanDecision(repo, batch.items[d.index]!, { kind: "set", value: d.value }, reviewer, batch.batchId, d.independent);
    console.log(`Saved ${decisions.length} explicitly reviewed decisions. No model-generated human labels.`);
    process.exit(0);
  }
  const llm = new LlmRepo(pool);
  const catalog = await new RolesRepo(pool).getCatalog();
  const titles = new Map(catalog.roles.map((r) => [r.roleSlug, r.title]));
  const model = new OllamaLabeler({ model: values.model }).model;
  const ctx = await buildContext(catalog, makeEmbedService(repo, new LocalTransformerEncoder()));
  const corpus = await repo.corpus();
  const showDeficits = async () => {
    const d = await projectDeficits(repo, corpus);
    console.log(`\nHuman-label deficits (only labels YOU confirm count)${d.registry ? "" : "  [no frozen employer registry yet]"}`);
    for (const l of d.lines) console.log(`  ${l}`);
  };
  const { items, available } = await buildReviewQueue(repo, llm, ctx, corpus, { model, size: Number(values.size), evalSize: Number(values.eval), only, roleTitleOf: (s) => titles.get(s) ?? s });
  if (values["export-batch"]) {
    const prefix = path.resolve(values["export-batch"]);
    mkdirSync(path.dirname(prefix), { recursive: true });
    const batchId = `review-${randomUUID()}`;
    writeFileSync(`${prefix}.json`, JSON.stringify({ version: 1, batchId, createdAt: new Date().toISOString(), items }, null, 2), { flag: "wx" });
    writeFileSync(`${prefix}.html`, renderReviewBatch(batchId, items), { flag: "wx" });
    console.log(`Review page: ${prefix}.html\nFrozen manifest: ${prefix}.json\nNo human labels written. Download decisions from the page, then use --import-decisions <file> --batch ${prefix}.json --reviewer <name>.`);
    process.exit(0);
  }
  console.log(`Queue available: disagreements ${available.disagreement}, low confidence ${available.low_confidence}, evaluation samples ${available.eval_required}, QC audit sample ${available.qc_audit}. Showing ${items.length}.`);
  console.log("\nWhat each answer means (for the role under review):");
  for (const d of RELEVANCE_DEFINITIONS) console.log(`  [${d.key}] ${d.value.padEnd(10)} ${d.meaning}`);
  console.log(`\n  ${SEPARATION_NOTE}`);
  await showDeficits();
  if (items.length === 0) { console.log("\nNothing needs a human right now. Run more labeling: npm run ml:llm -- run"); process.exit(0); }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const sessionId = randomUUID().slice(0, 8);
  let n = 0;
  const show = (it: ReviewItem) => {
    console.log(`\n=== ${n}/${items.length}  [${it.reason}]  ${it.posting.company} — ${it.posting.title}\nRole under review: ${titles.get(it.roleSlug) ?? it.roleSlug} (${it.roleSlug})\nWhy shown: ${it.why}\nLocation: ${it.posting.location ?? "?"}   Source: ${it.posting.sourceUrl}`);
    console.log(`\n${it.posting.description.replace(/\s+/g, " ").slice(0, 900)}…\n`);
    if (it.blind) console.log("Choosing a label confirms you independently reviewed the complete description without AI-suggested answers; otherwise skip.");
    if (it.blind || !it.state) { console.log("(proposal hidden: this pair is part of the independent evaluation set)"); return; }
    for (const p of [it.state.A, it.state.B]) if (p) console.log(`  model pass ${p.pass}: ${p.relevance.toUpperCase()} (confidence ${p.confidence.toFixed(2)}), seniority ${p.seniority}, work mode ${p.workMode}\n    reasoning: ${p.reasoning}\n${p.evidence.map((q) => `    quote: "${q}"`).join("\n")}`);
    const c = it.state.consensus;
    console.log(c.status === "AGREED" ? `  proposal: ${c.relevance} (both passes agree, confidence ${c.confidence.toFixed(2)})` : c.status === "DISAGREE" ? `  the passes DISAGREE (${c.a} vs ${c.b}): choose yourself` : "  proposal: single pass only");
  };
  for (const it of items) {
    n++;
    show(it);
    const canApprove = !it.blind && it.state?.consensus.status === "AGREED";
    for (;;) {
      const key = (await rl.question(`${canApprove ? "[Enter] approve  " : ""}[r]elevant [i]rrelevant [a]djacent [u]nsure  [s]eniority ok  [?] [d] [n]skip [q]uit > `)).trim().toLowerCase();
      if (key === "q") { rl.close(); console.log(`Saved. Session ${sessionId}.`); await showDeficits(); process.exit(0); }
      if (key === "n") break;
      if (key === "?") { for (const d of RELEVANCE_DEFINITIONS) console.log(`  [${d.key}] ${d.value}: ${d.meaning}`); continue; }
      if (key === "d") { await showDeficits(); continue; }
      if (key === "s") {
        const s = it.blind ? null : it.state?.A?.seniority;
        if (!s || s === "unclear") { console.log("  no proposed seniority to approve (type r/i/a/u, or use ml:review for manual seniority)"); continue; }
        try { const r = await repo.saveLabel({ postingId: it.posting.id, textSha256: it.posting.textSha256, task: "seniority", roleSlug: "", value: s, reviewer, sessionId, selectionBasis: it.basis.slice(0, 200), origin: "human_verified", llmLabelIds: [it.state!.A!.id] }); console.log(`  saved #${r.id} seniority: ${s} (separate from relevance)`); } catch (e) { console.log(`  ${(e as Error).message}`); }
        continue;
      }
      const value = ({ r: "relevant", i: "irrelevant", a: "adjacent", u: "unsure" } as Record<string, "relevant" | "irrelevant" | "adjacent" | "unsure">)[key];
      try {
        if ((key === "" || key === "y") && canApprove) {
          const r = await humanDecision(repo, it, { kind: "approve" }, reviewer, sessionId);
          console.log(`  saved #${r.id}: approved (${r.origin})`);
          break;
        }
        if (value) {
          const r = await humanDecision(repo, it, { kind: "set", value }, reviewer, sessionId, it.blind);
          console.log(`  saved #${r.id}: ${value} (${r.origin})${r.duplicate ? " (same as before, nothing new stored)" : ""}`);
          break;
        }
      } catch (e) { console.log(`  ${(e as Error).message}`); continue; }
      console.log("  unknown key");
    }
  }
  rl.close();
  await showDeficits();
  console.log(`\nQueue done. Session ${sessionId}. More: npm run ml:llm -- run ; when deficits are zero: npm run ml:dataset`);
} finally {
  await pool.end();
}

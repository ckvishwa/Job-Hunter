import { INDEPENDENT_REVIEW } from "./admission.js";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { buildContext, makeEmbedService } from "./engine.js";
import { RELEVANCE_DEFINITIONS, SEPARATION_NOTE } from "./guidance.js";
import { MlRepo } from "./repo.js";
import { projectDeficits, reviewQueue, type QueueEntry, type Stream } from "./workflows.js";

// npm run ml:review -- [--stream active|eval] [--size 25] [--blind] [--reviewer <name>]
//
//   --stream active  (default) postings of TRAIN-side employers, chosen to teach the model: likely true positives, hard negatives, adjacent candidates and
//                    diverse random draws. These labels are never used to evaluate a model.
//   --stream eval    postings of HELD-OUT employers drawn at RANDOM (stratified, no model or rule ordering, hints hidden). These make the independent test set.
//
// One JOB-ROLE PAIR at a time. You judge the ROLE only (seniority, location, eligibility are separate). Every answer is saved the moment you press the key
// (append-only; to change an earlier answer use `npm run ml:labels -- correct`), so quitting loses nothing and a re-run offers only unlabeled pairs.
//   r relevant  i irrelevant  a adjacent  u unsure | s seniority  w work mode | ? definitions  d deficits | n skip  q quit

const { values } = parseArgs({ options: { size: { type: "string", default: "25" }, blind: { type: "boolean", default: false }, reviewer: { type: "string" }, stream: { type: "string", default: "active" } } });
loadEnvFile(DEFAULT_ENV_FILE);
const reviewer = values.reviewer ?? process.env.JH_USER_HANDLE ?? "local";
if (values.stream !== "active" && values.stream !== "eval") { console.error('--stream must be "active" or "eval"'); process.exit(2); }
const stream = values.stream as Stream;

const printDefinitions = () => {
  console.log("\nWhat each answer means (for the role under review):");
  for (const d of RELEVANCE_DEFINITIONS) console.log(`  [${d.key}] ${d.value.padEnd(10)} ${d.meaning}\n       e.g. ${d.example}`);
  console.log(`\n  ${SEPARATION_NOTE}\n`);
};

const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
try {
  const repo = new MlRepo(pool);
  const svc = makeEmbedService(repo, new LocalTransformerEncoder());
  const catalog = await new RolesRepo(pool).getCatalog();
  const titles = new Map(catalog.roles.map((r) => [r.roleSlug, r.title]));
  const ctx = await buildContext(catalog, svc);
  const corpus = await repo.corpus();
  if (corpus.length === 0) { console.error("The ML corpus is empty. Run: npm run ml:corpus"); process.exit(1); }
  const showDeficits = async () => {
    const d = await projectDeficits(repo, corpus);
    console.log(`\nDataset deficits (minimum gates before any training)${d.registry ? "" : "  [no frozen employer registry yet: run npm run ml:splits -- propose]"}`);
    for (const l of d.lines) console.log(`  ${l}`);
    return d;
  };
  printDefinitions();
  const deficits = await showDeficits();
  if (stream === "eval") console.log("\nEVAL stream: independent random sample of held-out employers. Model/rule hints are hidden on purpose; sampling is not guided by anything you label.");
  const model = values.blind || stream === "eval" ? null : ((await repo.models()).filter((m) => m.status !== "retired").at(-1) ?? null);
  const queue = await reviewQueue(repo, ctx, corpus, Number(values.size), { stream, model, roleTitleOf: (s) => titles.get(s) ?? s });
  if (queue.length === 0) { console.log(stream === "eval" ? "\nNothing left to draw for the eval stream (held-out employers have no unlabeled pairs, or no registry is frozen)." : "\nNothing left to review."); process.exit(0); }
  const sessionId = randomUUID().slice(0, 8);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let n = 0;
  const save = (e: QueueEntry, task: "relevance" | "seniority" | "work_mode" | "false_positive_admission", value: string, roleSlug: string) =>
    repo.saveLabel({ postingId: e.posting.id, textSha256: e.posting.textSha256, task, roleSlug, value, reviewer, sessionId, selectionBasis: e.basis, ...(stream === "eval" ? { note: INDEPENDENT_REVIEW } : {}) });
  void deficits;
  for (const e of queue) {
    n++;
    console.log(`\n=== ${n}/${queue.length}  [${e.stream}]  ${e.posting.company} — ${e.posting.title}\nRole under review: ${e.roleTitle} (${e.roleSlug})\nLocation: ${e.posting.location ?? "?"}   Official source: ${e.posting.sourceUrl}`);
    console.log(`Why shown: ${e.reason}`);
    if (!values.blind && stream === "active") console.log(`Suggestions only (not labels): rules ${e.ruleRelevant ? `admit this role` : "do not admit this role"}; title similarity ${e.titleSim.toFixed(2)}; overall ${e.sim.toFixed(2)}${e.modelScore != null ? `; model ${e.modelScore.toFixed(2)}` : ""}`);
    console.log(`\n${e.posting.description}\n`);
    if (stream === "eval") console.log("Choosing a label confirms you reviewed the COMPLETE description independently, without AI-suggested answers. Otherwise skip.");
    console.log(`Judge the ROLE "${e.roleTitle}" only. Seniority / work mode are separate (s / w). ? = definitions`);
    for (;;) {
      const key = (await rl.question("[r]elevant [i]rrelevant [a]djacent [u]nsure  [s]eniority [w]ork mode  [?] [d] [n]skip [q]uit > ")).trim().toLowerCase();
      if (key === "q") { rl.close(); console.log(`Saved. Session ${sessionId}.`); process.exit(0); }
      if (key === "n") break;
      if (key === "?") { printDefinitions(); continue; }
      if (key === "d") { await showDeficits(); continue; }
      const rel = ({ r: "relevant", i: "irrelevant", a: "adjacent", u: "unsure" } as Record<string, string>)[key];
      if (rel) {
        const r = await save(e, "relevance", rel, e.roleSlug);
        // Disagreeing with a rule admission is recorded as its own label so hard negatives can be found later (active stream only).
        if (stream === "active" && e.ruleRelevant && rel === "irrelevant") await save(e, "false_positive_admission", "true", e.roleSlug);
        console.log(`  saved #${r.id}: ${rel}${r.duplicate ? " (same as before, nothing new stored)" : ""}`);
        break;
      }
      if (key === "s" || key === "w") {
        const task = key === "s" ? "seniority" : "work_mode";
        const v = (await rl.question(key === "s" ? "  seniority of this POSTING (entry | junior | mid | senior | unclear): " : "  work mode of this POSTING (remote | hybrid | onsite | unclear): ")).trim().toLowerCase();
        try { const r = await save(e, task, v, ""); console.log(`  saved #${r.id} ${task}: ${v} (separate from relevance)`); } catch (err) { console.log(`  ${err instanceof Error ? err.message : "invalid"}`); }
        continue;
      }
      console.log("  unknown key (? shows definitions)");
    }
  }
  rl.close();
  await showDeficits();
  console.log(`\nBatch finished. Session ${sessionId}. Next: npm run ml:review${stream === "active" ? " (or --stream eval)" : ""}; when the deficits are zero: npm run ml:dataset`);
} finally {
  await pool.end();
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { parseCanonicalJob } from "../semantic/parse-job.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { analyzeJd } from "./analyze.js";
import { decideRequirements } from "./decide.js";
import { buildEvidenceCorpus } from "./evidence.js";
import { NOT_EVALUATED, SPLIT_SCHEMA, buildPool, freezeSplit, goldStatus, parseSplitName, validateGold, scoreRun, type SplitManifest, type SystemRun } from "./gold.js";
import { loadStoredJobs } from "./jd-source.js";
import { EvidenceIndex, queryFor } from "./retrieval.js";
import { RulesJobSemanticProvider } from "./rules-provider.js";

// npm run match:gold -- init  --jobs-file <jsonl> [--dir private-runtime/s4a-gold]      prepare the labelling sheet and FREEZE the split
// npm run match:gold -- score --jobs-file <jsonl> --labels <file> --which development|heldOut [--encoder minilm|none]
// Accuracy metrics are printed only when an independent, human, complete label file validates against the frozen split. Otherwise: NOT_EVALUATED.

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { "jobs-file": { type: "string" }, dir: { type: "string", default: path.join("private-runtime", "s4a-gold") }, labels: { type: "string" }, which: { type: "string", default: "heldOut" }, split: { type: "string" }, record: { type: "boolean", default: false }, encoder: { type: "string", default: "minilm" }, user: { type: "string" } },
});
const fail = (m: string, code = 2): never => {
  console.error(m);
  process.exit(code);
};
loadEnvFile(DEFAULT_ENV_FILE);
const dir = path.resolve(values.dir!);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
const asOf = new Date().toISOString().slice(0, 10);

async function main(): Promise<number> {
  if (!["init", "score", "status", "review"].includes(command ?? "")) return fail("usage: match:gold init|score|status|review ...");
  if (command === "status" || command === "review") return reviewCommand();
  if (!values["jobs-file"]) return fail("--jobs-file is required");
  const jobs = loadStoredJobs(values["jobs-file"]);
  if (!jobs.length) return fail("No resolved, hash-verified stored JDs in that file.");
  const pool = buildPool(jobs);

  if (command === "init") {
    const splitFile = path.join(dir, "split-manifest.json");
    if (existsSync(splitFile)) return fail(`${splitFile} already exists: the split is frozen and is never regenerated.`, 1);
    mkdirSync(dir, { recursive: true });
    const split = freezeSplit(pool, new Date().toISOString());
    writeFileSync(splitFile, JSON.stringify(split, null, 2) + "\n");
    writeFileSync(path.join(dir, "pool.json"), JSON.stringify(pool, null, 2) + "\n");
    const template = {
      schema: "orbital-s4a-gold/1", independent: false, labeledBy: "", labeledAt: "", splitManifestSha256: split.manifestSha256,
      items: pool.map((p) => ({ itemKey: p.itemKey, requirements: null })), conditions: [], evidence: [],
    };
    writeFileSync(path.join(dir, "gold-template.json"), JSON.stringify(template, null, 2) + "\n");

    const dbPool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
    let facts: string[] = [];
    try {
      const candidates = new CandidateRepo(dbPool);
      const user = await candidates.findUser(handle);
      if (user) facts = (await buildEvidenceCorpus({ pool: dbPool, candidates, userId: user.id, asOf })).units.map((u) => `- \`${u.factId}\` (${u.category}) ${u.value}`);
    } finally {
      await dbPool.end().catch(() => undefined);
    }
    const sheet = [
      "# S4A gold-set labelling sheet", "",
      "You are the labeller. Write labels from the JD text yourself; do not copy an extractor's output and do not ask a model to label. Copy `gold-template.json` to `gold.labels.json`, then:", "",
      '1. For each item, set `requirements` to a list of `{ "value", "level": "required|preferred|unknown", "minimumYears"?, "yearsScope"?: "professional|domain|tool|role", "negated"? }`, or `[]` if the item states no requirement. Do not leave `null`.',
      "2. Add one `conditions` entry per JD (`jdSha256`) with `citizenship`, `clearance`, `work_authorization`, `sponsorship` each `required|not_required|offered|not_offered|unknown` (a separate answer for each; silence is `unknown`).",
      "3. Optionally add `evidence` entries `{ itemKey, requirementValue, relevantFactIds }` naming which candidate facts below you judge relevant (empty list = none).",
      '4. Set `"independent": true`, `labeledBy` (your name) and `labeledAt`. The split is frozen (sha256 below); do not edit it.', "",
      `Split ${split.manifestSha256} frozen ${split.frozenAt}: ${split.development.length} development items, ${split.heldOut.length} held-out items. Rule: ${split.rule}.`, "",
      "## Candidate facts available for evidence labels (approved, authorized)", "", ...(facts.length ? facts : ["(none)"]), "", "## Items", "",
      ...pool.map((p) => `- **${p.itemKey}** [${split.heldOut.includes(p.itemKey) ? "held-out" : "development"}] hint:${p.sectionHint}\n  > ${p.quote.replace(/\s+/g, " ").slice(0, 400)}`),
    ];
    writeFileSync(path.join(dir, "labeling-sheet.md"), sheet.join("\n") + "\n");
    console.log(`Wrote ${dir}: pool (${pool.length} items from ${jobs.length} JDs), frozen split (${split.development.length} dev / ${split.heldOut.length} held-out), gold-template.json, labeling-sheet.md`);
    return 0;
  }

  // score
  const splitFile = path.join(dir, "split-manifest.json");
  if (!existsSync(splitFile)) return fail("No frozen split: run init first.");
  const split = JSON.parse(readFileSync(splitFile, "utf8")) as SplitManifest;
  if (split.schema !== SPLIT_SCHEMA) return fail("Not a split manifest.");
  const which = parseSplitName(values.split) ?? (values.which === "development" ? "development" : "heldOut");
  if (!values.labels || !existsSync(values.labels)) {
    console.log(JSON.stringify({ requirementExtraction: NOT_EVALUATED("no label file"), levelAccuracy: NOT_EVALUATED("no label file"), retrieval: NOT_EVALUATED("no label file"), falseSupport: NOT_EVALUATED("no label file"), eligibility: NOT_EVALUATED("no label file") }, null, 2));
    return 3;
  }
  const validated = validateGold(JSON.parse(readFileSync(values.labels, "utf8")), split, which);
  if (!validated.ok) {
    console.log(JSON.stringify({ status: "NOT_EVALUATED", which, problems: validated.problems }, null, 2));
    return 3;
  }
  const gold = validated.gold;
  const dbPool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
  try {
    const candidates = new CandidateRepo(dbPool);
    const user = await candidates.findUser(handle);
    if (!user) return fail(`No user "${handle}".`);
    const corpus = await buildEvidenceCorpus({ pool: dbPool, candidates, userId: user.id, asOf });
    const index = new EvidenceIndex(corpus.units, values.encoder === "minilm" ? new LocalTransformerEncoder() : null);
    await index.prepare();
    const run: SystemRun = { requirements: [], conditions: [], decisions: [], retrieval: [] };
    for (const job of jobs) {
      const parsed = await parseCanonicalJob(job, new RulesJobSemanticProvider());
      if (!parsed.ok) continue;
      const jd8 = (job.jdContentHash ?? "").slice(0, 8);
      const analysis = analyzeJd(job, parsed.structured);
      for (const r of analysis.requirements) run.requirements.push({ itemKey: `${jd8}:${r.quote.start}`, value: r.value, level: r.level, minimumYears: r.minimumYears, yearsKind: r.yearsKind, negated: r.negated });
      run.conditions.push({ jdSha256: job.jdContentHash!, citizenship: analysis.conditions.citizenship.status, clearance: analysis.conditions.clearance.status, work_authorization: analysis.conditions.work_authorization.status, sponsorship: analysis.conditions.sponsorship.status });
      const retr = new Map<string, Awaited<ReturnType<EvidenceIndex["retrieve"]>>>();
      for (const r of analysis.requirements) retr.set(r.id, await index.retrieve(queryFor({ id: r.id, value: r.value, type: r.type })));
      for (const d of decideRequirements({ analysis, corpus, retrieval: retr, asOf }).decisions) run.decisions.push({ itemKey: `${jd8}:${d.jd.start}`, requirementValue: d.value, status: d.status, matchedFactIds: d.matchedFactIds });
      for (const e of gold.evidence) {
        if (!e.itemKey.startsWith(`${jd8}:`)) continue;
        const res = await index.retrieve(queryFor({ id: "gold", value: e.requirementValue, type: "skill" }));
        const factsOf = (list: Array<{ unitId: string }> | null): string[] => [...new Set((list ?? []).map((x) => corpus.units.find((u) => u.unitId === x.unitId)!.factId))];
        run.retrieval.push({ itemKey: e.itemKey, requirementValue: e.requirementValue, methods: { lexical: factsOf(res.lexical), bm25: factsOf(res.bm25), semantic: factsOf(res.semantic), hybrid: factsOf(res.hybrid) } });
      }
    }
    console.log(JSON.stringify({ status: "EVALUATED", which, labeledBy: gold.labeledBy, splitManifestSha256: split.manifestSha256, baseline: "rules-jd-extractor@1", metrics: scoreRun(gold, split[which], run) }, null, 2));
    return 0;
  } finally {
    await dbPool.end().catch(() => undefined);
  }
}

async function reviewCommand(): Promise<number> {
  const splitFile = path.join(dir, "split-manifest.json");
  if (!existsSync(splitFile)) return fail("No frozen split: run init first.");
  const split = JSON.parse(readFileSync(splitFile, "utf8")) as SplitManifest;
  const raw = values.labels && existsSync(values.labels) ? (JSON.parse(readFileSync(values.labels, "utf8")) as unknown) : null;
  const st = goldStatus(split, raw);
  if (command === "status") {
    console.log(JSON.stringify({
      split: { sha256: split.manifestSha256, intact: st.splitOk, development: split.development.length, heldOut: split.heldOut.length }, labelFile: st.labelFile, labeledBy: st.labeledBy, independent: st.independent,
      development: { labelled: `${st.development.labelled}/${st.development.total}`, metrics: st.development.metrics, reasons: st.development.reasons },
      heldOut: { labelled: `${st.heldOut.labelled}/${st.heldOut.total}`, metrics: st.heldOut.metrics, reasons: st.heldOut.reasons },
      note: "Metrics are NOT_EVALUATED until a person has labelled every item of the split from the JD text. Nothing here labels anything.",
    }, null, 2));
    return 0;
  }
  const which = parseSplitName(values.split);
  if (!which) return fail("--split dev|heldout is required");
  const one = st[which];
  if (values.record) {
    if (one.metrics !== "ELIGIBLE") {
      console.log(JSON.stringify({ recorded: false, split: which, reasons: one.reasons }, null, 2));
      return 3;
    }
    const entry = { recordedAt: new Date().toISOString(), split: which, labeledBy: st.labeledBy, labelFileSha256: createHash("sha256").update(readFileSync(values.labels!)).digest("hex"), splitManifestSha256: split.manifestSha256, itemsLabelled: one.labelled };
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "reviewer-log.jsonl"), JSON.stringify(entry) + "\n");
    console.log(JSON.stringify({ recorded: true, ...entry }, null, 2));
    return 0;
  }
  const poolFile = path.join(dir, "pool.json");
  if (!existsSync(poolFile)) return fail("pool.json missing: run init first.");
  const items = JSON.parse(readFileSync(poolFile, "utf8")) as Array<{ itemKey: string; quote: string; sectionHint: string }>;
  const open = new Set(one.unlabelled);
  const lines = [`# Review sheet: ${which} (${one.labelled}/${one.total} labelled)`, "", "Write each label yourself from the JD text. Do not copy a suggestion. A label file with `independent: true` asserts that you did.", ""];
  for (const it of items.filter((i) => open.has(i.itemKey))) {
    lines.push(`- **${it.itemKey}** hint:${it.sectionHint}`, `  > ${it.quote.replace(/\s+/g, " ").slice(0, 400)}`);
    if (which === "heldOut") lines.push("  (held-out: no extractor suggestion is shown, to avoid anchoring)");
  }
  const out = path.join(dir, `review-${which}.md`);
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`Wrote ${out}: ${open.size} item(s) still to label in the ${which} split.`);
  return 0;
}

process.exit(await main().catch((error) => fail(`match:gold ${command} failed: ${error instanceof Error ? error.message : String(error)}`, 1)));

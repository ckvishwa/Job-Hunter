import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { buildContext, makeEmbedService } from "./engine.js";
import { auditLabels } from "./label-audit.js";
import { CorrectionError, correctLabel, correctionOf } from "./labels.js";
import { MlRepo } from "./repo.js";
import { freezeSides, loadSides, proposeSides, sideSummary, SIDES_FILE, SidesError } from "./sides.js";
import { auditDataset, employerStats, labelEvidence, ML_DIR, sideResolver, SPLIT_SALT } from "./workflows.js";

// npm run ml:audit  [-- --version ds-0002]        read-only: saved labels that deserve a second look + whether train and held-out are disjoint/balanced
// npm run ml:labels -- list | history --id N | correct --id N --value V --reason "..." [--false-positive]
// npm run ml:splits -- propose | freeze            stratified employer sides: propose is read-only; freeze writes config/ml-employer-sides.json once
//
// Nothing here creates a label by itself. `correct` is the only writer: it appends one explicit, attributed correction after you type CORRECT.

const [command, sub, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: command === "audit" ? [sub ?? "", ...rest].filter(Boolean) : rest,
  options: { id: { type: "string" }, value: { type: "string" }, reason: { type: "string" }, version: { type: "string" }, "false-positive": { type: "boolean", default: false }, confirm: { type: "string" }, user: { type: "string" }, task: { type: "string" }, limit: { type: "string" } },
  allowPositionals: true,
});
const fail = (m: string, code = 2): never => { console.error(m); process.exit(code); };
loadEnvFile(DEFAULT_ENV_FILE);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
const save = (name: string, body: unknown) => {
  mkdirSync(path.join(ML_DIR, "reports"), { recursive: true });
  const file = path.join(ML_DIR, "reports", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(body, null, 1));
  return file;
};
const ask = async (q: string): Promise<string> => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return (await rl.question(q)).trim(); } finally { rl.close(); } };

const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
try {
  const repo = new MlRepo(pool);
  const catalog = await new RolesRepo(pool).getCatalog();
  const mkCtx = () => buildContext(catalog, makeEmbedService(repo, new LocalTransformerEncoder()));

  if (command === "audit") {
    const ctx = await mkCtx();
    const corpus = await repo.corpus();
    const findings = auditLabels(await repo.currentLabels(), await labelEvidence(repo, ctx, corpus));
    const version = values.version ?? (await repo.latestDatasetVersion());
    const split = version ? await auditDataset(repo, ctx, version) : null;
    const sides = await sideResolver(repo);
    const file = save("audit", { version, findings, split, registry: sides.registry ? `frozen v${sides.version}` : "none" });
    console.log("== Saved labels worth a second look (questions, not corrections) ==");
    if (!findings.length) console.log("  none");
    for (const f of findings) console.log(`  ${f.kind}  labels ${f.labelIds.map((i) => `#${i}`).join(", ")}\n    ${f.postings.join("\n    ")}\n    ${f.detail}\n    -> ${f.suggestion}`);
    console.log(`\n== Train / held-out audit of ${version ?? "(no dataset yet)"}  [employer registry: ${sides.registry ? `frozen v${sides.version}` : "NOT frozen (hash rule)"}] ==`);
    if (split) {
      console.log(`  verdict: ${split.verdict}`);
      console.log(`  shared employers: ${split.sharedEmployers.length}, shared group keys: ${split.sharedGroupKeys.length}, shared exact texts: ${split.sharedExactText.length}, near-duplicate (>=0.985) cross-split pairs: ${split.nearDuplicates.length}, similar (0.95-0.985): ${split.similar.length}`);
      console.log(`  shared normalized titles across the split (warning only): ${split.sharedNormalizedTitles.map((t) => t.title).join("; ") || "none"}`);
      console.log(`  employers train/held-out: ${split.balance.employers.train}/${split.balance.employers.heldout} (held-out ${(split.balance.heldoutEmployerShare * 100).toFixed(0)}%); pairs ${split.balance.pairs.train}/${split.balance.pairs.heldout}; relevant labels train/held-out ${split.balance.relevantInTrain}/${split.balance.relevantInHeldout}`);
      for (const w of split.balance.warnings) console.log(`  WARNING: ${w}`);
    }
    console.log(`\nreport: ${file}`);
    process.exit(0);
  }

  if (command === "labels") {
    if (sub === "list") {
      const corpus = new Map((await repo.corpus()).map((c) => [c.id, c]));
      const rows = (await repo.allLabelRows());
      const current = new Set((await repo.currentLabels()).map((l) => l.id));
      const limit = Number(values.limit ?? 200);
      for (const l of rows.filter((r) => !values.task || r.task === values.task).slice(-limit)) {
        const p = corpus.get(l.postingId);
        const c = correctionOf(l);
        console.log(`#${String(l.id).padStart(4)} ${current.has(l.id) ? "current " : "history "} ${l.task.padEnd(24)} ${l.value.padEnd(10)} ${l.roleSlug.padEnd(26)} ${p?.company ?? "?"} / ${p?.title.slice(0, 50) ?? "?"}${c ? `   [corrects #${c.corrects}]` : ""}`);
      }
      process.exit(0);
    }
    if (sub === "history") {
      const l = await repo.labelById(Number(values.id));
      if (!l) fail("No such label id.", 1);
      const posting = await repo.posting(l!.postingId);
      console.log(`${posting?.company} / ${posting?.title}  [${l!.task}${l!.roleSlug ? ` -> ${l!.roleSlug}` : ""}]`);
      for (const h of await repo.labelHistory(l!.postingId, l!.task, l!.roleSlug)) console.log(`  #${h.id}  ${h.reviewedAt.toISOString()}  ${h.reviewer}  ${h.value}${h.note ? `   (${h.note})` : ""}`);
      process.exit(0);
    }
    if (sub === "correct") {
      if (!values.id || !values.value || !values.reason) fail('usage: ml:labels -- correct --id <label id> --value <new value> --reason "<why>" [--false-positive]');
      const old = await repo.labelById(Number(values.id));
      if (!old) fail("No such label id.", 1);
      const posting = await repo.posting(old!.postingId);
      console.log(`Label #${old!.id}: ${posting?.company} / ${posting?.title}\n  ${old!.task}${old!.roleSlug ? ` -> ${old!.roleSlug}` : ""}: "${old!.value}"  (saved ${old!.reviewedAt.toISOString()} by ${old!.reviewer})\n  becomes "${values.value}"\n  reason: ${values.reason}\nThe original row stays in the history; this appends one new, attributed row. Datasets already created (ds-*) are not changed; run ml:dataset afterwards.`);
      const typed = values.confirm ?? (await ask("Type CORRECT to apply, anything else cancels: "));
      if (typed !== "CORRECT") { console.log("Cancelled. Nothing changed."); process.exit(0); }
      try {
        const r = await correctLabel(repo, { labelId: old!.id, value: values.value!, reviewer: handle, reason: values.reason! });
        console.log(`Saved correction #${r.newLabelId} (was #${r.corrected}: ${r.from} -> ${r.to}).`);
        if (values["false-positive"] && values.value === "irrelevant" && old!.task === "relevance") {
          const fp = await repo.saveLabel({ postingId: old!.postingId, textSha256: old!.textSha256, task: "false_positive_admission", roleSlug: old!.roleSlug, value: "true", reviewer: handle, sessionId: `corr-fp`, selectionBasis: `correction of #${old!.id}`, note: `explicit --false-positive on correction of #${old!.id}` });
          console.log(`Also saved false_positive_admission=true as #${fp.id} (you asked for it).`);
        }
      } catch (e) {
        if (e instanceof CorrectionError) fail(`${e.code}: ${e.message}`, 1);
        throw e;
      }
      process.exit(0);
    }
    fail("usage: ml:labels -- list | history --id N | correct --id N --value V --reason \"...\"");
  }

  if (command === "splits") {
    const ctx = await mkCtx();
    const corpus = await repo.corpus();
    const proposal = proposeSides(employerStats(corpus, ctx), SPLIT_SALT);
    const summary = sideSummary(proposal);
    if (sub === "propose") {
      const frozen = loadSides();
      const current = await sideResolver(repo);
      console.log(`Stratified employer sides (terciles of rule-admitted share; unlabeled corpus facts only).  Registry: ${frozen ? `FROZEN v${frozen.file.version}` : "not frozen"}`);
      for (const e of proposal) {
        const now = current.sideOf(e.company);
        console.log(`  ${e.company.padEnd(20)} ${e.side.padEnd(8)} ${e.stratum.padEnd(5)} ruleShare ${e.ruleShare.toFixed(2)}  postings ${String(e.postings).padStart(4)}${now !== e.side ? `   (today: ${now})` : ""}`);
      }
      console.log(`\nheld-out: ${summary.employers.heldout}/${summary.employers.train + summary.employers.heldout} employers, ${(summary.heldoutPostingShare * 100).toFixed(0)}% of postings; per stratum ${JSON.stringify(summary.byStratum)}`);
      console.log("Nothing was written. If you accept it: npm run ml:splits -- freeze");
      process.exit(0);
    }
    if (sub === "freeze") {
      console.log(`About to freeze ${proposal.length} employers: ${summary.employers.heldout} held out (${(summary.heldoutPostingShare * 100).toFixed(0)}% of postings), ${summary.employers.train} train. The file ${SIDES_FILE} is never overwritten.\nEarlier datasets (ds-0001, ds-0002) are NOT changed, were never trained or evaluated, and should not be used once this exists. Held-out labels will count only if they come from --stream eval.`);
      const typed = values.confirm ?? (await ask("Type FREEZE to write the registry: "));
      if (typed !== "FREEZE") { console.log("Cancelled. Nothing written."); process.exit(0); }
      try { const f = freezeSides(proposal, SPLIT_SALT, handle); console.log(`Frozen v${f.version} (${f.sha256.slice(0, 12)}…) -> ${SIDES_FILE}`); } catch (e) { if (e instanceof SidesError) fail(e.message, 1); throw e; }
      process.exit(0);
    }
    fail("usage: ml:splits -- propose | freeze");
  }
  fail("usage: ml:audit | ml:labels | ml:splits");
} finally {
  await pool.end();
}

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { RolesRepo } from "../db/roles-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { collectEmploymentConflicts } from "./fact-context.js";
import { assertConfirmed, planCorrection, toEditInput, type ConfirmedField } from "./fact-correct.js";
import { applyPlan, planApply, type Plan } from "./fact-review-apply.js";
import { buildReviewFile, defaultReviewPath, readReviewFile, writeReviewFile } from "./fact-review-file.js";
import { runReviewSession, type ReviewFilter } from "./fact-review-session.js";

// npm run facts:list | facts:export | facts:review | facts:apply   (see docs/FACT-REVIEW.md)
// Local only: talks to the same PostgreSQL as the web app and uses the same guarded review path. Only approve/reject exist.

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    resume: { type: "string" },
    file: { type: "string" },
    user: { type: "string" },
    reviewer: { type: "string" },
    out: { type: "string" },
    force: { type: "boolean", default: false },
    reveal: { type: "boolean", default: false },
    filter: { type: "string", default: "pending" },
    redo: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    "confirm-sensitive": { type: "boolean", default: false },
    "skip-conflicts": { type: "boolean", default: false },
    fact: { type: "string" },
    value: { type: "string" },
    employer: { type: "string" },
    title: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    category: { type: "string" },
    reason: { type: "string" },
    quote: { type: "string" },
    "confirm-fields": { type: "string" },
    "allow-approved-edit": { type: "boolean", default: false },
    "prior-profile": { type: "string" },
    "no-prior-profile": { type: "boolean", default: false },
    "accept-employment-conflicts": { type: "boolean", default: false },
  },
});

const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};

loadEnvFile(DEFAULT_ENV_FILE);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
const today = new Date().toISOString().slice(0, 10);

function printPlan(plan: Plan): void {
  console.log(`\nBatch ${plan.batchId}`);
  for (const p of plan.fileProblems) console.log(`  FILE PROBLEM: ${p}`);
  const will = plan.items.filter((i) => i.status === "WILL_APPLY");
  const already = plan.items.filter((i) => i.status === "ALREADY_APPLIED");
  const conflicts = plan.items.filter((i) => i.status === "CONFLICT");
  for (const i of will) console.log(`  APPLY     ${i.decision.toUpperCase().padEnd(7)} ${i.kind.padEnd(13)} ${i.from} -> ${i.to}   ${i.label}${i.reason ? `   (reason: ${i.reason})` : ""}`);
  for (const i of already) console.log(`  NO CHANGE ${i.decision.toUpperCase().padEnd(7)} ${i.kind.padEnd(13)} already ${i.to}   ${i.label}`);
  for (const i of conflicts) console.log(`  CONFLICT  ${i.decision.toUpperCase().padEnd(7)} ${i.kind.padEnd(13)} ${i.code}: ${i.message}   ${i.label}`);
  console.log(`\n  to apply: ${will.length}   already in that state: ${already.length}   conflicts: ${conflicts.length}   left unchanged (no decision): ${plan.skipped}`);
}

async function main(): Promise<number> {
  if (!["list", "export", "review", "apply", "correct"].includes(command ?? "")) {
    fail("usage: facts:list | facts:export --resume <id> | facts:review --resume <id> | facts:apply --file <review.json> [--dry-run] | facts:correct --resume <id> --fact <factId> [--employer ..] [--title ..] [--start YYYY-MM] [--end YYYY-MM|current] [--category professional|internship|academic|volunteer|none] [--value ..] --reason ..");
  }
  const pool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
  try {
    const repo = new CandidateRepo(pool);
    const user = await repo.findUser(handle);
    if (!user) return fail(`No user "${handle}" in the database.`);

    if (command === "list") {
      const rows = await repo.listResumes(user.id);
      if (!rows.length) console.log("No résumés yet.");
      for (const r of rows) console.log(`${r.resumeId}  ${r.fileType}  ${r.state.padEnd(9)}  pending ${r.counts.pending}  approved ${r.counts.approved}  rejected ${r.counts.rejected}  ${r.createdAt.toISOString().slice(0, 10)}`);
      return 0;
    }

    const priorArg = values["no-prior-profile"] ? null : values["prior-profile"];
    const roles = new RolesRepo(pool);

    if (command === "correct") {
      if (!values.resume || !values.fact) return fail("--resume <resume-id> and --fact <factId> are required (see: npm run resumes:diagnose -- --resume <id>)");
      if (!values.reason || values.reason.trim().length < 5) return fail("--reason is required: say what document or statement supports this correction.");
      const fact = (await repo.listFacts(user.id, values.resume)).find((f) => f.factId === values.fact);
      if (!fact) return fail("No such fact on that résumé for this user.");
      const source = await repo.getResumeSource(user.id, values.resume);
      const plan = planCorrection(fact, {
        value: values.value, employer: values.employer, title: values.title, startDate: values.start, endDate: values.end, employmentType: values.category,
        quote: values.quote === undefined ? undefined : values.quote.replace(/\\n/g, "\n"),
      }, source?.versionId === fact.resumeVersionId ? source.text : (await repo.getResumeDetail(user.id, values.resume))?.text ?? null);
      console.log(`\nCorrection of ${plan.factId} (${plan.kind}, currently ${fact.approvalStatus.toUpperCase()}, revision ${fact.headRevision})`);
      for (const c of plan.changes) console.log(`  ${c.field.padEnd(15)} ${c.from}  ->  ${c.to}`);
      for (const c of plan.consequences) console.log(`  note: ${c}`);
      console.log(`  reason on record: ${values.reason}`);
      if (values["dry-run"]) {
        console.log("\nDry run: nothing was changed.");
        return 0;
      }
      const confirmed: string[] = (values["confirm-fields"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!confirmed.length && plan.needsConfirmation.length) {
        if (!process.stdin.isTTY || values.yes) return fail(`Refusing to change ${plan.needsConfirmation.join(", ")} without explicit confirmation. Re-run in a terminal, or pass --confirm-fields ${plan.needsConfirmation.join(",")} after reading the dry run.`);
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          for (const field of plan.needsConfirmation) {
            const c = plan.changes.find((x) => x.field === field)!;
            const answer = (await rl.question(`Confirm ${field} "${c.from}" -> "${c.to}"? Type ${field} to confirm: `)).trim();
            if (answer === field) confirmed.push(field);
          }
        } finally {
          rl.close();
        }
      }
      assertConfirmed(plan, confirmed as ConfirmedField[], values["allow-approved-edit"]);
      const batchId = `correct-${Date.now().toString(36)}`;
      const out = await repo.applyReview(user.id, user.handle, plan.factId, {
        action: "edit", actor: values.reviewer ?? user.handle, today, expectedDigest: fact.contentDigest, expectedHeadRevision: fact.headRevision,
        edit: toEditInput(plan), span: plan.evidence?.after, provenance: { channel: "cli-correct", reason: values.reason.trim(), batchId, changes: { fields: plan.changes, confirmed, wasApproved: plan.wasApproved } },
      });
      const refreshed = await roles.refresh(user.id, today);
      console.log(`\n${out.changed ? "Corrected" : "No change"}: ${plan.factId} is now ${out.fact.approvalStatus.toUpperCase()} at revision ${out.fact.headRevision}.`);
      console.log(`S2 recommendations recomputed: ${refreshed.superseded} superseded, ${refreshed.inserted} new.`);
      console.log("Nothing was approved. Review the corrected fact (A/R) when you are satisfied.");
      return 0;
    }

    if (command === "export") {
      if (!values.resume) return fail("--resume <resume-id> is required (see: npm run facts:list)");
      const source = await repo.getResumeSource(user.id, values.resume);
      if (!source) return fail("No completed extraction for that résumé and user.");
      const facts = (await repo.listFacts(user.id, values.resume)).filter((f) => f.resumeVersionId === source.versionId);
      const ctx = await collectEmploymentConflicts(repo, user.id, priorArg);
      if (ctx.priorProfileProblem) console.log(`  note: ${ctx.priorProfileProblem}`);
      const file = buildReviewFile({ userHandle: user.handle, resumeId: values.resume, resumeVersionId: source.versionId, sourceTextSha256: source.textSha256, text: source.text, facts, reveal: values.reveal, now: new Date(), conflicts: ctx.conflicts });
      const target = values.out ?? defaultReviewPath(values.resume);
      writeReviewFile(target, file, { overwrite: values.force });
      const warned = file.facts.filter((f) => f.warnings.length).length;
      console.log(`Wrote ${file.facts.length} facts to ${path.resolve(target)}`);
      console.log(`  with quality warnings: ${warned}   lines with no extracted fact: ${file.coverage.uncoveredLongLines}${values.reveal ? "   (VALUES REVEALED in the file)" : "   (sensitive values masked)"}`);
      if (!path.resolve(target).startsWith(path.resolve("private-runtime"))) console.log("  note: this path is outside private-runtime/; keep it out of Git.");
      return 0;
    }

    const filePath = values.file ?? (values.resume ? defaultReviewPath(values.resume) : undefined);
    if (!filePath) return fail("--resume <id> or --file <review.json> is required");

    if (command === "review") {
      const filter = values.filter as ReviewFilter;
      if (!["pending", "undecided", "warnings", "all"].includes(filter)) return fail("--filter must be pending, undecided, warnings or all");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const s = await runReviewSession(filePath, { filter, redo: values.redo }, { ask: (q) => rl.question(q), out: (t) => console.log(t) });
        console.log(`\nThis session: ${s.reviewedThisSession} decision(s) recorded${s.quit ? " (quit early; progress saved)" : ""}.`);
      } finally {
        rl.close();
      }
      return 0;
    }

    // apply
    const file = readReviewFile(filePath);
    const actor = values.reviewer ?? user.handle;
    const conflictCtx = await collectEmploymentConflicts(repo, user.id, priorArg);
    const options = {
      actor, today, confirmSensitive: values["confirm-sensitive"], acceptEmploymentConflicts: values["accept-employment-conflicts"],
      employmentConflictFactIds: new Set(conflictCtx.conflicts.flatMap((c) => c.records.map((r) => r.ref))),
    };
    const plan = await planApply(repo, user.id, file, options);
    printPlan(plan);
    if (values["dry-run"]) {
      console.log("\nDry run: nothing was changed.");
      return plan.fileProblems.length || plan.items.some((i) => i.status === "CONFLICT") ? 1 : 0;
    }
    const will = plan.items.filter((i) => i.status === "WILL_APPLY").length;
    if (will > 0 && !plan.fileProblems.length && (!plan.items.some((i) => i.status === "CONFLICT") || values["skip-conflicts"])) {
      if (!values.yes) {
        if (!process.stdin.isTTY) return fail("Refusing to change anything without confirmation. Re-run in a terminal, or pass --yes after reading the dry run.");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await rl.question(`\nType APPLY to apply ${will} decision(s): `)).trim();
        rl.close();
        if (answer !== "APPLY") {
          console.log("Cancelled; nothing was changed.");
          return 1;
        }
      }
    }
    const result = await applyPlan(repo, user.id, user.handle, file, plan, { ...options, skipConflicts: values["skip-conflicts"] });
    if (result.applied.length) {
      const refreshed = await roles.refresh(user.id, today); // approved evidence may have changed: recompute S2 now and supersede stale recommendations
      console.log(`S2 recommendations recomputed: ${refreshed.superseded} superseded, ${refreshed.inserted} new.`);
    }
    const logDir = path.resolve("private-runtime", "fact-review");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, `${file.resumeId}.apply-log.jsonl`), JSON.stringify({ at: new Date().toISOString(), actor, ...result, fileProblems: result.fileProblems }) + "\n");
    console.log(`\nApplied: ${result.applied.length}   already in state: ${result.alreadyApplied.length}   conflicts: ${result.conflicts.length}   failed: ${result.failed.length}   left unchanged: ${result.skippedUndecided}`);
    for (const f of result.failed) console.log(`  FAILED ${f.factId}: ${f.code} ${f.message}`);
    if (result.aborted) console.log("ABORTED: nothing was changed. Resolve the problems above (or pass --skip-conflicts to apply only the clean decisions).");
    else if (!result.complete) console.log("INCOMPLETE: some decisions were NOT applied. Re-running is safe; applied decisions are not repeated.");
    else console.log("All decisions in the file are now in their requested state.");
    return result.complete ? 0 : 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exit(await main().catch((error) => fail(`facts:${command} failed: ${error instanceof Error ? error.message : String(error)}`, 1)));

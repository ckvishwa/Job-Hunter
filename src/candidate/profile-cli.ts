import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { ProfileRepo, ProfileRuleError } from "../db/profile-repo.js";
import { RolesRepo, evidenceScopeView } from "../db/roles-repo.js";
import { loadScopedEvidence } from "../db/profile-repo.js";
import { evidenceReadiness } from "./evidence-status.js";
import { suggestProvenance, type FixtureDoc } from "./provenance.js";

// npm run profile -- status | init | suggest [--apply] | classify | confirm-employment      (see docs/CANDIDATE-PROFILE-BOUNDARY.md)
// Decides which uploaded résumés are evidence for the ACTIVE candidate profile. Writes classifications and confirmed-employment references only;
// it never edits, approves, rejects or deletes a fact, and S2 is recomputed afterwards so stale recommendations are superseded.

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    user: { type: "string" }, kind: { type: "string" }, label: { type: "string" }, resume: { type: "string" }, as: { type: "string" },
    authorize: { type: "boolean", default: false }, basis: { type: "string" }, "owner-email": { type: "string" }, apply: { type: "boolean", default: false },
    employer: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, category: { type: "string" },
    statement: { type: "string" }, detail: { type: "string" }, json: { type: "boolean", default: false },
  },
});
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};
loadEnvFile(DEFAULT_ENV_FILE);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
const today = new Date().toISOString().slice(0, 10);

function fixtureDocs(): FixtureDoc[] {
  const out: FixtureDoc[] = [];
  for (const [file, pick] of [["services/ai/tests/fixtures/resume_cases.json", (j: any) => j], ["services/ai/eval/heldout_cases.json", (j: any) => j.cases]] as const) {
    try {
      for (const c of pick(JSON.parse(readFileSync(path.resolve(file), "utf8"))) as Array<{ id: string; lines: string[] }>) out.push({ id: c.id, file, lines: c.lines });
    } catch {
      /* a missing fixture file just means fewer comparisons */
    }
  }
  return out;
}

async function main(): Promise<number> {
  if (!["status", "evidence-status", "init", "suggest", "classify", "confirm-employment"].includes(command ?? "")) {
    return fail("usage: profile status | init --kind personal|demo --label <text> | suggest [--owner-email <e>] [--apply] | classify --resume <id> --as personal|fixture|unverified [--authorize] --basis <text> | confirm-employment --employer .. --title .. --start YYYY-MM --end YYYY-MM|current --category professional|internship|academic|volunteer --statement <text>");
  }
  const pool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
  try {
    const repo = new CandidateRepo(pool);
    const profiles = new ProfileRepo(pool);
    const roles = new RolesRepo(pool);
    const user = await repo.findUser(handle);
    if (!user) return fail(`No user "${handle}" in the database.`);
    const recompute = async (): Promise<void> => {
      const r = await roles.refresh(user.id, today);
      console.log(`S2 recomputed from the profile's authorized evidence: ${r.superseded} superseded, ${r.inserted} new.`);
    };

    if (command === "init") {
      if (values.kind !== "personal" && values.kind !== "demo") return fail("--kind personal|demo is required");
      const out = await profiles.ensureActive(user.id, values.kind, values.label ?? values.kind);
      console.log(out.created ? `Created active ${out.profile.kind} profile ${out.profile.id}.` : `An active ${out.profile.kind} profile already exists (${out.profile.id}); nothing changed.`);
      return 0;
    }

    if (command === "classify") {
      if (!values.resume || !values.as || !values.basis) return fail("--resume, --as and --basis are required");
      if (!["personal", "fixture", "unverified"].includes(values.as)) return fail("--as must be personal, fixture or unverified");
      const s = await profiles.classify(user.id, { resumeId: values.resume, provenance: values.as as never, authorized: values.authorize, basis: values.basis, actor: handle });
      console.log(`${s.resumeId}: ${s.provenance}, ${s.authorized ? "AUTHORIZED as evidence" : "not authorized (excluded from career scoring)"}.`);
      await recompute();
      return 0;
    }

    if (command === "confirm-employment") {
      const { employer, title, start, end, category, statement } = values;
      if (!employer || !title || !start || !end || !category || !statement) return fail("--employer --title --start --end --category --statement are all required");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start) || !(end === "current" || /^\d{4}-(0[1-9]|1[0-2])$/.test(end))) return fail("--start/--end must be YYYY-MM (end may be 'current')");
      if (!["professional", "internship", "academic", "volunteer"].includes(category)) return fail("--category must be professional, internship, academic or volunteer");
      const out = await profiles.confirmEmployment(user.id, { employer, title, startDate: start, endDate: end === "current" ? null : end, employmentType: category as never, detail: values.detail, statement, actor: handle });
      console.log(out.created ? "Recorded as a confirmed-employment REFERENCE." : "Already recorded; nothing changed.");
      console.log("It is not a fact and has no source quotation; it does not count as experience. Résumé employment that contradicts it is excluded until the source résumé is corrected and reviewed.");
      await recompute();
      return 0;
    }

    // status / suggest read the same scoped view S2 uses
    const resumes = await repo.listResumes(user.id);
    const scope = await loadScopedEvidence(pool, user.id);
    const bySource = new Map(scope.sources.map((s) => [s.resumeId, s]));

    if (command === "suggest") {
      if (!scope.profile) return fail("No active profile. Run: npm run profile -- init --kind personal --label <text>");
      const fixtures = fixtureDocs();
      const rows = [];
      for (const r of resumes) {
        const text = (await repo.getResumeSource(user.id, r.resumeId))?.text ?? null;
        const sug = suggestProvenance({ text, fixtures, ownerEmail: values["owner-email"] });
        rows.push({ resumeId: r.resumeId, current: bySource.get(r.resumeId)?.provenance ?? "unverified (unclassified)", suggestion: sug });
        console.log(`${r.resumeId}  ${r.fileType}  currently ${rows.at(-1)!.current}\n   suggested ${sug.provenance}${sug.needsExplicitAuthorization ? " (needs explicit authorization)" : ""}: ${sug.basis}`);
        // --apply records only the NON-authorizing suggestions (fixture / unverified). A personal source is never authorized automatically.
        if (values.apply && sug.provenance !== "personal" && !bySource.has(r.resumeId)) {
          await profiles.classify(user.id, { resumeId: r.resumeId, provenance: sug.provenance, authorized: false, basis: sug.basis, actor: handle });
          console.log("   recorded (not authorized).");
        }
      }
      if (values.apply) await recompute();
      else console.log("\nDry run. --apply records fixture/unverified suggestions only; personal needs: profile classify --as personal --authorize --basis ...");
      return 0;
    }

    if (command === "evidence-status") {
      const rd = evidenceReadiness(scope, scope.confirmed);
      if (values.json) {
        console.log(JSON.stringify(rd, null, 2));
        return 0;
      }
      console.log(scope.profile ? `Active profile: ${scope.profile.kind} "${scope.profile.label}"` : "NO ACTIVE PROFILE: nothing counts as evidence.");
      for (const [k, n] of Object.entries(rd.counts)) console.log(`  ${k.padEnd(22)} ${n}`);
      for (const f of rd.facts.filter((x) => x.status !== "APPROVED_VALID" && x.status !== "PENDING")) console.log(`  ${f.status}: ${f.factId} (${f.kind}) ${f.value}${f.detail ? ` -- ${f.detail}` : ""}`);
      for (const a of rd.awaitingResume) console.log(`  CONFIRMED_AWAITING_RESUME: ${a.employer} / ${a.title} ${a.startDate}..${a.endDate ?? "current"} -- ${a.note}`);
      console.log("Only APPROVED_VALID facts count as evidence. Upload the corrected résumé, then: npm run candidate:review (approve what is accurate).");
      return 0;
    }

    // status
    const view = { ...evidenceScopeView(scope), resumes: resumes.map((r) => ({ resumeId: r.resumeId, fileType: r.fileType, classification: bySource.get(r.resumeId)?.provenance ?? "unverified", authorized: bySource.get(r.resumeId)?.authorized ?? false })) };
    if (values.json) {
      console.log(JSON.stringify(view, null, 2));
      return 0;
    }
    console.log(scope.profile ? `Active profile: ${scope.profile.kind} "${scope.profile.label}" (${scope.profile.id})` : "NO ACTIVE PROFILE: every résumé is excluded from career scoring.");
    for (const r of view.resumes) console.log(`  ${r.resumeId}  ${r.fileType}  ${r.classification.padEnd(10)}  ${r.authorized ? "AUTHORIZED" : "excluded"}`);
    console.log(`facts used as evidence: ${view.factsUsed}; confirmed-employment references: ${view.confirmedEmploymentReferences}`);
    for (const e of view.excludedApproved) console.log(`  kept out: ${e.factId} (${e.kind}, résumé ${e.resumeId?.slice(0, 8) ?? "-"}) ${e.code}: ${e.detail}`);
    for (const d of view.duplicatesCountedOnce) console.log(`  counted once: ${d.dropped} duplicates ${d.kept}`);
    return 0;
  } catch (error) {
    if (error instanceof ProfileRuleError) return fail(`${error.code}: ${error.message}`, 1);
    throw error;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exit(await main().catch((error) => fail(`profile ${command} failed: ${error instanceof Error ? error.message : String(error)}`, 1)));

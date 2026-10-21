import path from "node:path";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { JobsRepo } from "../db/jobs-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { loadStoredJobs } from "../match/jd-source.js";
import { createLiveImportRun, importSavedPostings, type ImportContext } from "./import.js";
import { DiscoveryRunner, boardKeyOf, loadBoardsConfig } from "./runner.js";

// npm run jobs:import -- --saved <jobs.jsonl> [--saved <more.jsonl>] --boards-file <company-boards.json> --roles soc-analyst,incident-response-analyst
//   Offline. Re-checks postings that an earlier verified run saved and stores them in the authoritative S3 PostgreSQL tables (same dedup/revision rules).
// npm run jobs:import -- --live --boards-file <company-boards.json> --board greenhouse:expel,greenhouse:huntress --roles ... [--delay-ms 750]
//   OPT-IN network use: read-only GETs to the public ATS board APIs (the S3 runner), bounded by the run limits. Nothing is submitted or applied.
// The roles are explicit arguments for this run only; they are not stored as your search preference.

const { values } = parseArgs({
  options: {
    saved: { type: "string", multiple: true }, "boards-file": { type: "string" }, roles: { type: "string" }, user: { type: "string" }, live: { type: "boolean", default: false },
    board: { type: "string" }, "delay-ms": { type: "string", default: "750" }, json: { type: "boolean", default: false },
  },
});
const fail = (m: string, code = 2): never => {
  console.error(m);
  process.exit(code);
};
loadEnvFile(DEFAULT_ENV_FILE);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";

async function main(): Promise<number> {
  if (!values["boards-file"]) return fail("--boards-file <company-boards.json> is required (it names the employers' boards and corporate domains used for verification)");
  if (!values.roles) return fail("--roles <slug,slug> is required (see the S2 role catalog); it is used for this run only");
  if (!values.live && !values.saved?.length) return fail("give --saved <jsonl> (offline) or --live (explicit opt-in network read)");
  const config = loadBoardsConfig(path.resolve(values["boards-file"]));
  if (!config) return fail("The board list could not be read.");
  const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
  try {
    const candidates = new CandidateRepo(pool);
    const user = await candidates.findUser(handle);
    if (!user) return fail(`No user "${handle}".`);
    const roles = new RolesRepo(pool);
    const catalog = await roles.getCatalog();
    const slugs = values.roles.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = slugs.filter((s) => !catalog.roles.some((r) => r.roleSlug === s && r.active));
    if (unknown.length) return fail(`Unknown or inactive role slug(s): ${unknown.join(", ")}`);
    const jobs = new JobsRepo(pool);
    const before = Number((await pool.query("SELECT count(*) AS n FROM jobs")).rows[0].n);
    const ctx: ImportContext = { repo: jobs, userId: user.id, catalogRoles: catalog.roles, catalogVersion: catalog.catalogVersion, roleSlugs: slugs, boards: config.companies };

    let report: unknown;
    if (values.live) {
      const keys = (values.board ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!keys.length) return fail(`--board <ats:board,...> is required with --live. Available: ${config.companies.map(boardKeyOf).join(", ")}`);
      console.error(`LIVE read-only refresh of ${keys.length} board(s) from the public ATS API. Nothing is submitted.`);
      const { runId } = await createLiveImportRun(ctx, keys);
      const runner = new DiscoveryRunner({ repo: jobs, boards: () => config, delayMs: Number(values["delay-ms"]), provenancePath: path.resolve("data/listing-provenance.jsonl") });
      runner.enqueue(runId);
      await runner.idle();
      report = { mode: "live", runId, run: await jobs.getRun(user.id, runId) };
    } else {
      const postings = (values.saved ?? []).flatMap((f) => loadStoredJobs(path.resolve(f)));
      const out = await importSavedPostings(ctx, postings);
      report = { mode: "saved", runId: out.runId, outcomes: out.outcomes };
    }
    const after = Number((await pool.query("SELECT count(*) AS n FROM jobs")).rows[0].n);
    const revisions = Number((await pool.query("SELECT count(*) AS n FROM job_revisions")).rows[0].n);
    console.log(JSON.stringify({ jobsBefore: before, jobsAfter: after, jobRevisions: revisions, ...(report as object) }, null, 2));
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch((e) => fail(`jobs:import failed: ${e instanceof Error ? e.message : String(e)}`, 1));

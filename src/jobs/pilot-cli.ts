import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { CandidateRepo } from "../db/candidate-repo.js";
import { JobsRepo } from "../db/jobs-repo.js";
import { migrate } from "../db/migrate.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { buildPlan } from "./planner.js";
import { DiscoveryRunner, boardKeyOf, loadBoardsConfig } from "./runner.js";

// npm run s3:pilot -- --boards <file> [--roles soc-analyst,...] [--max-boards 8] [--max-candidates 50] [--delay-ms 750] [--keep-db]
//
// A bounded, read-only pilot of S3 against REAL official Greenhouse/Lever board APIs. It runs in a THROWAWAY database with a SYNTHETIC role
// selection (never your real candidate data), makes plain GET requests only, waits between boards, stops at the candidate limit, and prints
// exactly what happened: attempted / read / unique / verified / blocked / failed / duplicate. It never opens an application, never submits
// anything and does not evaluate eligibility. It is NOT the owner's real-résumé acceptance (OWNER_REAL_RESUME_VALIDATION_PENDING).

const { values } = parseArgs({
  options: {
    boards: { type: "string" },
    roles: { type: "string", default: "soc-analyst,incident-response-analyst,vulnerability-analyst" },
    "max-boards": { type: "string", default: "8" },
    "max-candidates": { type: "string", default: "50" },
    "max-per-board": { type: "string", default: "25" },
    "delay-ms": { type: "string", default: "750" },
    "keep-db": { type: "boolean", default: false },
    // No place filter and every seniority level: exercises official verification on whatever the boards list, instead of the US/entry filters.
    "open-filters": { type: "boolean", default: false },
  },
});

if (!values.boards) {
  console.error("usage: npm run s3:pilot -- --boards <company-boards.json> [--roles a,b] [--max-boards 8] [--max-candidates 50] [--delay-ms 750] [--keep-db]");
  process.exit(2);
}

loadEnvFile(DEFAULT_ENV_FILE);
const config = loadBoardsConfig(values.boards);
if (!config) {
  console.error(`No board list at ${values.boards}.`);
  process.exit(2);
}
const maxBoards = Math.min(Math.max(Number(values["max-boards"]), 1), 30);
const maxCandidates = Math.min(Math.max(Number(values["max-candidates"]), 1), 50);
const limits = { maxBoards, maxCandidates, maxMatchedPerBoard: Math.min(Math.max(Number(values["max-per-board"]), 1), 50) };
const delayMs = Math.max(Number(values["delay-ms"]), 300);

const dbName = `jh_pilot_${Date.now()}_${randomBytes(3).toString("hex")}`;
const admin = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1, connectTimeoutMs: 30_000 });
await admin.query(`CREATE DATABASE ${dbName}`);
const pool = createPool(pgSettingsFromEnv(process.env, dbName), { max: 4, connectTimeoutMs: 30_000 });
let exit = 0;
try {
  await migrate(pool);
  const roles = new RolesRepo(pool);
  const user = await new CandidateRepo(pool).ensureUser("pilot");
  await roles.seedCatalog();
  const catalog = await roles.getCatalog();
  const roleSlugs = String(values.roles).split(",").map((s) => s.trim()).filter(Boolean);
  const saved = await roles.saveSelection(user.id, "pilot", {
    expectedRevision: 0, expectedCatalogVersion: catalog.catalogVersion, targetFamilies: [...new Set(catalog.roles.filter((r) => roleSlugs.includes(r.roleSlug)).map((r) => r.familySlug))],
    roleSlugs, locations: values["open-filters"] ? [] : [{ kind: "country", value: "United States" }, { kind: "remote", value: "Remote" }], workModes: ["remote", "hybrid", "onsite"], seniorityLevels: values["open-filters"] ? ["entry", "junior", "mid", "senior"] : ["entry", "junior", "mid"], searchBand: { minYears: 0, maxYears: 5 },
  });
  const plan = buildPlan({ selection: saved.selection, catalogRoles: catalog.roles, catalogVersion: catalog.catalogVersion, expectedRevision: saved.selection.revisionNo });
  const jobs = new JobsRepo(pool);
  const chosen = config.companies.slice(0, maxBoards);
  const { runId } = await jobs.createRun(user.id, plan, chosen.map((c) => ({ boardKey: boardKeyOf(c), company: c.company, ats: c.ats, board: c.board })), limits);
  const runner = new DiscoveryRunner({ repo: jobs, boards: () => config, delayMs, timeoutMs: 20_000, onEvent: (e) => { if (e.kind === "board-end") console.error(`[pilot] ${e.boardKey} -> ${e.status}${e.code ? ` ${e.code}` : ""}`); } });
  runner.enqueue(runId);
  await runner.idle();
  const run = (await jobs.getRun(user.id, runId))!;
  const listing = await jobs.listJobs(user.id, { limit: 100 });
  const blocked = run.boards.filter((b) => b.blocked).length;
  const failed = run.boards.filter((b) => b.status === "FAILED").length;
  const summary = {
    note: "Real official-board pilot with a SYNTHETIC selection in a throwaway database. Read-only GET requests. No eligibility evaluation. No applications.",
    startedAt: run.createdAt, finishedAt: run.finishedAt, status: run.status, limits, delayMs, rolesSelected: roleSlugs, openFilters: values["open-filters"] === true, limitReached: run.limitReached,
    boards: { attempted: run.boards.filter((b) => b.status !== "SKIPPED").length, configured: config.companies.length, ok: run.boards.filter((b) => b.status === "OK").length, failed, blocked, skipped: run.boards.filter((b) => b.status === "SKIPPED").length },
    postings: { read: run.progress.fetched, titleMatched: run.progress.titleMatched, locationExcluded: run.progress.locationExcluded, seniorityExcluded: run.progress.seniorityExcluded, verified: run.progress.verified, uniqueJobs: listing.total, duplicates: run.progress.duplicates, rejected: run.progress.rejected },
    perBoard: run.boards.map((b) => ({ board: b.boardKey, status: b.status, read: b.fetched, titleMatched: b.titleMatched, stored: b.stored, failure: b.failureCode, blocked: b.blocked, detail: b.failureDetail })),
    failures: run.failures.map((f) => ({ board: f.boardKey, stage: f.stage, code: f.code, retryable: f.retryable, blocked: f.blocked, detail: f.detail })),
    sampleListings: listing.jobs.slice(0, 8).map((j) => ({ company: j.company, title: j.title, location: j.location, band: j.bandStatus, url: j.officialUrl })),
  };
  mkdirSync(path.resolve("private-runtime", "pilot"), { recursive: true });
  const out = path.resolve("private-runtime", "pilot", `s3-pilot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.error(`[pilot] summary written to ${out}`);
} catch (error) {
  console.error(`[pilot] failed: ${error instanceof Error ? error.message : String(error)}`);
  exit = 1;
} finally {
  await pool.end().catch(() => undefined);
  if (!values["keep-db"]) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  else console.error(`[pilot] kept database ${dbName}`);
  await admin.end().catch(() => undefined);
}
process.exit(exit);

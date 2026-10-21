import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CAREER_OPS_ATS_SOURCES, runCareerOpsScan } from "../src/sources/careerops/careerops-runner.js";
import { ingestOffers } from "../src/sources/careerops/ingest.js";
import { validateOffers } from "../src/sources/careerops/careerops-schema.js";
import { openCheckpoint, sealCheckpoint } from "../src/discovery/ats/checkpoint.js";
import { collectEmployer, type PilotEmployer } from "../src/discovery/collection/collect-employer.js";
import { guardedGet } from "../src/discovery/collection/guarded-get.js";
import { toPersistItem } from "../src/discovery/collection/postgres-items.js";
import {
  employersOutsideWatchlist,
  mergeCanonical,
  mergeObserved,
  renderAuditHtml,
  toReviewCsv,
  type EmployerCounters,
  type ObservedRecord,
  type SourceError,
} from "../src/discovery/collection/records.js";
import { CandidateRepo } from "../src/db/candidate-repo.js";
import { JobsRepo } from "../src/db/jobs-repo.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, loadEnvFile, pgSettingsFromEnv } from "../src/db/pool.js";
import type { DiscoveryPlan } from "../src/jobs/planner.js";
import { updateJobs } from "../src/storage/job-store.js";

const outDir = path.resolve("private-runtime/m5.1/discovery/live-pilot");
const careerOpsHome = path.resolve("..", "career-ops-pin");
const careerOpsData = path.join(outDir, "careerops-data");
const pilotIds = ["google", "amazon-aws", "walmart-associates", "microsoft", "meta-platforms", "apple", "nvidia", "salesforce", "stripe", "datadog"];
const started = Date.now();
const employerTimes: Record<string, number> = {};

interface TargetRow {
  id: string;
  displayName: string;
  aliases?: string[];
  registryCareersUrlCandidate?: string | null;
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2));
}

function writeJsonl(name: string, rows: readonly unknown[]): void {
  writeFileSync(path.join(outDir, name), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
}

const targets = JSON.parse(readFileSync(path.resolve("docs/job_hunter_target_companies_83.json"), "utf8")) as { records: TargetRow[] };
const byId = new Map(targets.records.map((row) => [row.id, row]));
mkdirSync(careerOpsData, { recursive: true });

const checkpointPath = path.join(outDir, "checkpoint.json");
let completed = new Set<string>();
if (existsSync(checkpointPath)) {
  try {
    completed = new Set(openCheckpoint(JSON.parse(readFileSync(checkpointPath, "utf8"))).completedEmployerIds);
  } catch (error) {
    console.error(`checkpoint refused: ${error instanceof Error ? error.message : error}`);
  }
}

const priorResultsPath = path.join(outDir, "employer-results.json");
const priorCounters = new Map<string, EmployerCounters>();
if (existsSync(priorResultsPath)) {
  const prior = JSON.parse(readFileSync(priorResultsPath, "utf8")) as { employers?: EmployerCounters[] };
  for (const row of prior.employers ?? []) priorCounters.set(row.employerId, row);
}
const priorObserved: ObservedRecord[] = existsSync(path.join(outDir, "jobs-observed.jsonl"))
  ? readFileSync(path.join(outDir, "jobs-observed.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as ObservedRecord)
  : [];
let observed = priorObserved.filter((row) => completed.has(row.employerId));
let errors: SourceError[] = [];
const counters: EmployerCounters[] = [];

const fallbackCareers: Record<string, string> = {
  salesforce: "https://careers.salesforce.com/en/jobs/",
  stripe: "https://stripe.com/jobs",
  datadog: "https://careers.datadoghq.com/",
};
const get = (url: string) => guardedGet(url, { timeoutMs: 25_000, maxBytes: 2 * 1024 * 1024 });
const pace = () => new Promise<void>((resolve) => setTimeout(resolve, 400));

for (const id of pilotIds) {
  const row = byId.get(id);
  if (!row) continue;
  const careersUrl = row.registryCareersUrlCandidate ?? fallbackCareers[id];
  if (!careersUrl) {
    errors.push({ employerId: id, stage: "plan", url: null, message: "Target list has no careers URL candidate.", at: new Date().toISOString() });
    continue;
  }
  if (completed.has(id)) {
    console.log(`skip ${id} (checkpoint)`);
    const prior = priorCounters.get(id);
    if (prior) counters.push(prior);
    continue;
  }
  const employer: PilotEmployer = {
    id,
    displayName: row.displayName,
    careersUrl,
    nameTokens: [row.displayName, ...(row.aliases ?? [])].flatMap((name) => name.split(/[^A-Za-z0-9]+/)).filter((token) => token.length >= 3),
  };
  console.log(`collect ${id} ${employer.careersUrl}`);
  const began = Date.now();
  try {
    const result = await collectEmployer(employer, { get, pace, maxJds: 8 });
    counters.push(result.counters);
    observed = mergeObserved(observed, result.observed);
    errors.push(...result.errors);
    const canonicalPath = path.resolve("data/jobs.jsonl");
    if (result.canonical.length > 0) {
      await updateJobs(canonicalPath, (current) => mergeCanonical(current, result.canonical));
      await updateJobs(path.join(outDir, "canonical-jobs.jsonl"), (current) => mergeCanonical(current, result.canonical));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "collector failed";
    errors.push({ employerId: id, stage: "collector", url: employer.careersUrl, message, at: new Date().toISOString() });
    counters.push({
      employerId: id,
      displayName: row.displayName,
      searchAttempted: true,
      careerSiteReachable: false,
      atsIdentityVerified: false,
      atsType: null,
      careersUrl: employer.careersUrl,
      finalUrl: null,
      listingsObserved: 0,
      uniqueListings: 0,
      jobsPersisted: 0,
      fullJdsRetrieved: 0,
      validOfficialUrls: 0,
      knownPostingDates: 0,
      unknownPostingDates: 0,
      elapsedMs: Date.now() - began,
      truncated: false,
      status: "TRANSIENT_FAILURE",
      reason: message,
      failures: [message],
    });
  }
  employerTimes[id] = Date.now() - began;
  completed.add(id);
  writeFileSync(checkpointPath, JSON.stringify(sealCheckpoint("m51d1", [...completed])));
  writeJsonl("jobs-observed.jsonl", observed);
  console.log(`done ${id} ${counters.at(-1)?.status} listings=${counters.at(-1)?.listingsObserved ?? 0}`);
}

const resolved = observed.filter((row) => row.resolutionStatus === "resolved" && row.descriptionText);
writeJson("employer-results.json", { generatedAt: new Date().toISOString(), employers: counters });
writeJsonl("jobs-observed.jsonl", observed);
writeJsonl("jobs-resolved.jsonl", resolved);
writeFileSync(path.join(outDir, "jobs-review.csv"), toReviewCsv(observed));
writeFileSync(path.join(outDir, "jobs-audit.html"), renderAuditHtml({ generatedAt: new Date().toISOString(), employers: counters, jobs: observed }));
writeJson("source-errors.json", errors);

const postgres: Record<string, unknown> = { connected: false, migrations: [], persisted: 0, error: null };
if (loadEnvFile(path.resolve("infra/.env"))) {
  const pool = createPool(pgSettingsFromEnv(), { max: 2 });
  let pilotPool: ReturnType<typeof createPool> | null = null;
  try {
    await pool.query("SELECT 1");
    postgres.connected = true;
    const versions = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
    postgres.migrations = versions.rows.map((row) => row.version);
    let writer = pool;
    try {
      const migrated = await migrate(pool);
      postgres.appliedThisRun = migrated.applied;
    } catch (error) {
      const message = error instanceof Error ? error.message : "migrate failed";
      postgres.migrationWarning = message;
      const admin = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1 });
      try {
        const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'jh_m51d1'");
        if (exists.rowCount === 0) await admin.query("CREATE DATABASE jh_m51d1");
      } finally {
        await admin.end().catch(() => undefined);
      }
      pilotPool = createPool(pgSettingsFromEnv(process.env, "jh_m51d1"), { max: 2 });
      const migrated = await migrate(pilotPool);
      writer = pilotPool;
      postgres.database = "jh_m51d1";
      postgres.appliedThisRun = migrated.applied;
      const pilotVersions = await pilotPool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
      postgres.pilotMigrations = pilotVersions.rows.map((row) => row.version);
    }
    const items = [];
    const canonicalFile = path.join(outDir, "canonical-jobs.jsonl");
    if (existsSync(canonicalFile)) {
      for (const line of readFileSync(canonicalFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const item = toPersistItem(JSON.parse(line), new Date().toISOString());
        if (item) items.push(item);
      }
    }
    const boards = [...new Map(items.map((item) => [`${item.ats}:${item.board}`, { boardKey: `${item.ats}:${item.board}`, company: item.company, ats: item.ats, board: item.board }])).values()];
    if (boards.length > 0) {
      const user = await new CandidateRepo(writer).ensureUser("m51d1-collector");
      const plan: DiscoveryPlan = {
        selectionRevisionNo: 1,
        catalogVersion: 1,
        roles: [{ roleSlug: "broad-discovery", title: "Broad discovery", phrases: [] }],
        locations: [],
        workModes: [],
        seniorityLevels: [],
        searchBand: { minYears: 0, maxYears: 40 },
      };
      const repo = new JobsRepo(writer);
      const { runId } = await repo.createRun(user.id, plan, boards, { maxBoards: boards.length, maxCandidates: 500, maxMatchedPerBoard: 40 }, "discovery");
      await repo.markRunning(runId);
      let stored = 0;
      for (const board of boards) {
        const boardItems = items.filter((item) => item.ats === board.ats && item.board === board.board);
        const result = await repo.persistBoard(runId, board.boardKey, { fetched: boardItems.length, titleMatched: 0, locationExcluded: 0, seniorityExcluded: 0 }, boardItems, []);
        stored += result?.stored ?? 0;
      }
      await repo.finishRun(runId, "COMPLETED");
      postgres.persisted = stored;
      postgres.runId = runId;
    }
  } catch (error) {
    postgres.error = error instanceof Error ? error.message : "postgres failed";
  } finally {
    await pilotPool?.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
} else {
  postgres.error = "infra/.env is missing";
}

const portalsPath = path.join(careerOpsData, "portals.yml");
writeFileSync(portalsPath, "title_filter:\n  positive: []\ntracked_companies: []\njob_boards: []\n");
process.env.CAREER_OPS_ROOT = careerOpsData;
process.env.CAREER_OPS_PORTALS = portalsPath;
const reverseStarted = Date.now();
const reverse = await runCareerOpsScan({
  careerOpsHome,
  sinceDays: 14,
  atsCompanyLimit: 2,
  atsSources: [...CAREER_OPS_ATS_SOURCES],
  includeUndated: true,
  timeoutMs: 12 * 60 * 1000,
  maxStdoutBytes: 16 * 1024 * 1024,
});
const reverseMs = Date.now() - reverseStarted;
let reverseSummary: Record<string, unknown>;
if (reverse.kind === "success") {
  const { valid, invalid } = validateOffers(reverse.result.offers);
  const ingested = ingestOffers(valid, "dff9703a092e2872245aef09b096edcee054ac69");
  const imported = ingested.listings.map((listing) => ({
    employerId: null,
    employerName: listing.employerName,
    requisitionId: listing.sourceId,
    title: listing.title,
    location: listing.location,
    sourceUrl: listing.sourceUrl,
    postedAt: listing.postedAt,
    postingDatePrecision: listing.postingDatePrecision,
    descriptionText: null,
    recordClass: "live" as const,
    resolutionStatus: "pending" as const,
    atsType: listing.sourceKind,
  }));
  observed = mergeObserved(observed, imported);
  const outside = employersOutsideWatchlist(valid.map((offer) => offer.company), targets.records);
  const cacheDir = path.join(careerOpsData, "data", "cache", "ats-companies");
  const datasets = existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.endsWith(".json")).map((name) => {
    const file = path.join(cacheDir, name);
    const bytes = readFileSync(file);
    return { file: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), modifiedAt: statSync(file).mtime.toISOString() };
  }) : [];
  reverseSummary = {
    status: "EXECUTED",
    careerOpsHome,
    commit: "dff9703a092e2872245aef09b096edcee054ac69",
    sinceDays: reverse.result.sinceDays,
    companyCapPerFamily: 2,
    includeUndated: true,
    sources: reverse.result.sources,
    companiesAvailable: reverse.result.companiesAvailable,
    companiesScanned: reverse.result.companiesScanned,
    capHit: reverse.result.capHit,
    datasetStatus: reverse.result.datasetStatus,
    datasets,
    postingsKept: reverse.result.postingsKept,
    postingsDroppedNoDate: reverse.result.postingsDroppedNoDate,
    unreachableBoards: reverse.result.unreachableBoards,
    invalidOffers: invalid.length,
    imported: ingested.listings.length,
    employersOutsideWatchlist: outside.slice(0, 50),
    employersOutsideWatchlistCount: outside.length,
    completeMarketCoverage: false,
    elapsedMs: reverseMs,
    sampleOffers: valid.slice(0, 30),
  };
  writeJsonl("jobs-observed.jsonl", observed);
  writeFileSync(path.join(outDir, "jobs-review.csv"), toReviewCsv(observed));
  writeFileSync(path.join(outDir, "jobs-audit.html"), renderAuditHtml({ generatedAt: new Date().toISOString(), employers: counters, jobs: observed }));
} else {
  reverseSummary = {
    status: reverse.kind,
    elapsedMs: reverseMs,
    detail: "stderr" in reverse ? String(reverse.stderr).slice(0, 2000) : "message" in reverse ? reverse.message : reverse.kind,
    exitCode: "exitCode" in reverse ? reverse.exitCode : null,
    completeMarketCoverage: false,
  };
  errors.push({ employerId: null, stage: "reverse-ats", url: null, message: JSON.stringify(reverseSummary), at: new Date().toISOString() });
}
writeJson("reverse-ats-results.json", reverseSummary);
writeJson("source-errors.json", errors);

const benchmark = {
  condition: "live",
  pilotEmployers: pilotIds.length,
  employerMs: employerTimes,
  reverseAtsMs: reverseMs,
  wallMs: Date.now() - started,
  postgres,
  listings: observed.length,
  resolved: resolved.length,
};
writeJson("runtime-benchmark.json", benchmark);
console.log(JSON.stringify({ employers: counters.map((row) => ({ id: row.employerId, status: row.status, listings: row.listingsObserved, persisted: row.jobsPersisted, jds: row.fullJdsRetrieved })), reverse: reverse.kind, postgres }, null, 2));

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchBoardPostings, registryEntryFor, toPosting } from "../src/pipeline/discovery/board-discoverer.js";
import { evaluatePersistable, stampResolution } from "../src/domain/canonical-job.js";
import { postingDatePrecision } from "../src/discovery/posting-date.js";
import { classifyTransportFailure } from "../src/discovery/repair/classify-error.js";
import { contentHash, mergeObservations, type RawObservation } from "../src/discovery/repair/observations.js";
import { fetchWorkdayBoard } from "../src/discovery/repair/workday-directory.js";
import { toPersistItem } from "../src/discovery/collection/postgres-items.js";
import { CandidateRepo } from "../src/db/candidate-repo.js";
import { JobsRepo, type PersistItem } from "../src/db/jobs-repo.js";
import { createPool, loadEnvFile, pgSettingsFromEnv } from "../src/db/pool.js";
import type { DiscoveryPlan } from "../src/jobs/planner.js";
import type { JobPosting } from "../src/adapters/types.js";

const outDir = path.resolve("private-runtime/m5.1/discovery/repair");
mkdirSync(outDir, { recursive: true });
const started = new Date().toISOString();
const observations: RawObservation[] = [];
const providers: Record<string, unknown>[] = [];

function write(name: string, value: unknown): void {
  writeFileSync(path.join(outDir, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function rawFrom(input: Omit<RawObservation, "contentHash" | "descriptionStatus"> & { descriptionStatus?: RawObservation["descriptionStatus"] }): RawObservation {
  return {
    ...input,
    descriptionStatus: input.descriptionStatus ?? (input.descriptionText ? "retrieved" : "missing"),
    contentHash: contentHash(input.descriptionText),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const began = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - began };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 500));

async function greenhouseOrLever(provider: "greenhouse" | "lever", employer: string, board: string, corporateDomain?: string) {
  const endpoint = provider === "greenhouse"
    ? `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`
    : `https://api.lever.co/v0/postings/${board}?mode=json`;
  const began = Date.now();
  try {
    const company = { company: employer, ats: provider, board, ...(corporateDomain ? { corporateDomain } : {}) };
    const postings = await fetchBoardPostings(company, fetch, 30_000);
    const now = new Date().toISOString();
    const registry = registryEntryFor(company);
    const canonical: JobPosting[] = [];
    for (const posting of postings) {
      const dated = postingDatePrecision(posting.postingDate);
      observations.push(rawFrom({
        provider,
        employer,
        title: posting.title,
        sourceUrl: posting.url,
        sourcePostingId: posting.externalId,
        requisitionId: posting.externalId,
        location: posting.location,
        postedAt: dated.postedAt,
        postingDatePrecision: dated.precision,
        discoveredAt: now,
        descriptionText: posting.descriptionText || null,
        outcome: "SUCCESS",
      }));
      if (canonical.length >= 8) continue;
      const stamped = stampResolution(toPosting(company, posting, [], [], "", now), {
        sourceKind: provider,
        observedUrl: posting.url,
        observedAt: now,
        finalUrl: posting.url,
        extractionMethod: "ats-api",
        discoveredCompany: employer,
        registryEntry: registry,
        apiJobId: posting.externalId,
        now,
      });
      const gate = evaluatePersistable(stamped);
      if (gate.ok) canonical.push(gate.posting);
    }
    providers.push({
      provider,
      employer,
      endpoint,
      httpStatus: 200,
      outcome: postings.length ? "SUCCESS" : "EMPTY_BOARD",
      rawJobsObserved: postings.length,
      uniqueNormalized: new Set(postings.map((posting) => posting.externalId)).size,
      fullDescriptions: postings.filter((posting) => posting.descriptionText.length >= 200).length,
      exported: postings.length,
      elapsedMs: Date.now() - began,
      canonical: canonical.slice(0, 8),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    const status = /HTTP (\d+)/.exec(message)?.[1];
    const classified = classifyTransportFailure({ status: status ? Number(status) : null, message });
    providers.push({ provider, employer, endpoint, httpStatus: classified.httpStatus, outcome: classified.outcome, transient: classified.transient, detail: classified.detail, elapsedMs: Date.now() - began, rawJobsObserved: 0 });
  }
}

await greenhouseOrLever("greenhouse", "Stripe", "stripe", "stripe.com");
await pause();
await greenhouseOrLever("lever", "Spotify", "spotify");
await pause();

const ashby = await timed(async () => {
  const endpoint = "https://api.ashbyhq.com/posting-api/job-board/notion?includeCompensation=true";
  const response = await fetch(endpoint, { headers: { accept: "application/json" } });
  const body = await response.text();
  return { endpoint, response, body };
});
{
  const { endpoint, response, body } = ashby.value;
  if (!response.ok) {
    const classified = classifyTransportFailure({ status: response.status, message: `HTTP ${response.status}`, body });
    providers.push({ provider: "ashby", employer: "Notion", endpoint, httpStatus: response.status, outcome: classified.outcome, transient: classified.transient, detail: classified.detail, elapsedMs: ashby.ms, rawJobsObserved: 0 });
  } else {
    const parsed = JSON.parse(body) as { jobs?: { id?: string; title?: string; jobUrl?: string; location?: string; descriptionPlain?: string; publishedAt?: string }[] };
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    const now = new Date().toISOString();
    for (const job of jobs) {
      if (!job.jobUrl) continue;
      const dated = postingDatePrecision(job.publishedAt);
      observations.push(rawFrom({
        provider: "ashby",
        employer: "Notion",
        title: job.title ?? null,
        sourceUrl: job.jobUrl,
        sourcePostingId: job.id ?? null,
        requisitionId: job.id ?? null,
        location: job.location ?? null,
        postedAt: dated.postedAt,
        postingDatePrecision: dated.precision,
        discoveredAt: now,
        descriptionText: job.descriptionPlain ?? null,
        outcome: "SUCCESS",
      }));
    }
    providers.push({
      provider: "ashby",
      employer: "Notion",
      endpoint,
      httpStatus: 200,
      outcome: jobs.length ? "SUCCESS" : "EMPTY_BOARD",
      rawJobsObserved: jobs.length,
      uniqueNormalized: new Set(jobs.map((job) => job.id).filter(Boolean)).size,
      fullDescriptions: jobs.filter((job) => (job.descriptionPlain?.length ?? 0) >= 200).length,
      elapsedMs: ashby.ms,
    });
  }
}
await pause();

const workday = await timed(() => fetchWorkdayBoard("2020companies|wd1|external_careers", fetch, 25_000));
{
  const rejected = await fetchWorkdayBoard("wd103|wd1|aareon", fetch);
  let parsedJobs = 0;
  let outcome = "UNPROCESSABLE_RESPONSE";
  if (workday.value.status === 200) {
    try {
      const json = JSON.parse(workday.value.body) as { jobPostings?: { title?: string; externalPath?: string }[] };
      parsedJobs = Array.isArray(json.jobPostings) ? json.jobPostings.length : 0;
      outcome = parsedJobs ? "SUCCESS" : "EMPTY_BOARD";
      const board = workday.value.result.ok ? workday.value.result.board : null;
      const now = new Date().toISOString();
      for (const job of (JSON.parse(workday.value.body) as { jobPostings?: { title?: string; externalPath?: string; locationsText?: string }[] }).jobPostings ?? []) {
        if (!board || !job.externalPath) continue;
        observations.push(rawFrom({
          provider: "workday",
          employer: "2020companies",
          title: job.title ?? null,
          sourceUrl: `${board.careersUrl.replace(/\/$/, "")}${job.externalPath}`,
          sourcePostingId: job.externalPath,
          requisitionId: job.externalPath,
          location: job.locationsText ?? null,
          postedAt: null,
          postingDatePrecision: "unknown",
          discoveredAt: now,
          descriptionText: null,
          outcome: "SUCCESS",
        }));
      }
    } catch {
      outcome = "UNPROCESSABLE_RESPONSE";
    }
  } else if (workday.value.status) {
    outcome = classifyTransportFailure({ status: workday.value.status, message: `HTTP ${workday.value.status}`, body: workday.value.body }).outcome;
  }
  providers.push({
    provider: "workday",
    employer: "2020companies",
    endpoint: "https://2020companies.wd1.myworkdayjobs.com/wday/cxs/2020companies/external_careers/jobs",
    httpStatus: workday.value.status,
    outcome,
    rawJobsObserved: parsedJobs,
    descriptionNote: "List response has no full description. None was invented.",
    junkRejectedWithoutRequest: rejected.requested === false,
    junkReason: rejected.result.ok ? null : rejected.result.reason,
    elapsedMs: workday.ms,
  });
}
await pause();

const icims = await timed(async () => {
  const endpoint = "https://careers-22squared.icims.com/jobs/search?ss=1&in_iframe=1";
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });
  const body = await response.text();
  return { endpoint, status: response.status, body };
});
{
  const classified = classifyTransportFailure({ status: icims.value.status, message: `HTTP ${icims.value.status}`, body: icims.value.body });
  providers.push({
    provider: "icims",
    employer: "22squared",
    endpoint: icims.value.endpoint,
    method: "GET",
    httpStatus: icims.value.status,
    outcome: classified.outcome,
    transient: classified.transient,
    detail: classified.detail,
    title: icims.value.body.match(/<title>([^<]+)/)?.[1] ?? null,
    rawJobsObserved: 0,
    elapsedMs: icims.ms,
    note: "The pinned and local adapters both GET /jobs/search. The body is a human-verification page. The method was not changed and the challenge was not bypassed.",
  });
}

providers.push({
  provider: "bamboohr",
  employer: null,
  outcome: "INVALID_SOURCE_CONFIG",
  rawJobsObserved: 0,
  detail: "providers/bamboohr.mjs exists at Career Ops 7bb0460, but scan-ats-full.mjs does not register it. No verified board was selected, so no request was made.",
});

const canonicalJobs = providers.flatMap((row) => (Array.isArray((row as { canonical?: JobPosting[] }).canonical) ? (row as { canonical: JobPosting[] }).canonical : []));
for (const row of providers) delete (row as { canonical?: JobPosting[] }).canonical;

const postgres: Record<string, unknown> = { connected: false, database: process.env.JH_PG_DB ?? null, persisted: 0, duplicateCanonicalJobs: null };
const dedup: Record<string, unknown> = { passed: false };
if (loadEnvFile(path.resolve("infra/.env"))) {
  const pool = createPool(pgSettingsFromEnv(), { max: 2 });
  postgres.database = pgSettingsFromEnv().database;
  try {
    await pool.query("SELECT 1");
    postgres.connected = true;
    const reg = await pool.query<{ jobs: string | null }>("SELECT to_regclass('public.jobs') AS jobs");
    postgres.jobsTable = reg.rows[0]?.jobs ?? null;
    if (!reg.rows[0]?.jobs) {
      postgres.error = "The existing database has no jobs table. A second database was not created.";
    } else {
      const items = canonicalJobs.map((job) => toPersistItem(job, new Date().toISOString())).filter((item): item is PersistItem => item !== null).slice(0, 5);
      postgres.candidates = items.length;
      if (items.length >= 5) {
        const user = await new CandidateRepo(pool).ensureUser("p0-repair");
        const plan: DiscoveryPlan = {
          selectionRevisionNo: 1,
          catalogVersion: 1,
          roles: [{ roleSlug: "broad-discovery", title: "Broad discovery", phrases: [] }],
          locations: [],
          workModes: [],
          seniorityLevels: [],
          searchBand: { minYears: 0, maxYears: 40 },
        };
        const repo = new JobsRepo(pool);
        const board = { boardKey: `${items[0]!.ats}:${items[0]!.board}`, company: items[0]!.company, ats: items[0]!.ats, board: items[0]!.board };
        const limits = { maxBoards: 1, maxCandidates: 20, maxMatchedPerBoard: 5 };
        const first = await repo.createRun(user.id, plan, [board], limits, "import");
        await repo.markRunning(first.runId);
        const firstResult = await repo.persistBoard(first.runId, board.boardKey, { fetched: items.length, titleMatched: 0, locationExcluded: 0, seniorityExcluded: 0 }, items, []);
        await repo.finishRun(first.runId, "COMPLETED");
        const secondItems = items.map((item) => ({ ...item, observation: { ...item.observation, observedAt: new Date().toISOString() } }));
        const second = await repo.createRun(user.id, plan, [board], limits, "import");
        await repo.markRunning(second.runId);
        const secondResult = await repo.persistBoard(second.runId, board.boardKey, { fetched: secondItems.length, titleMatched: 0, locationExcluded: 0, seniorityExcluded: 0 }, secondItems, []);
        await repo.finishRun(second.runId, "COMPLETED");
        const ids = items.map((item) => item.atsIdentity);
        const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE ats_identity = ANY($1::text[])", [ids]);
        const seen = await pool.query<{ ats_identity: string; last_seen_at: string; descriptions: number }>(
          `SELECT j.ats_identity, j.last_seen_at::text, count(r.id)::int AS descriptions
           FROM jobs j LEFT JOIN job_revisions r ON r.job_id = j.id
           WHERE j.ats_identity = ANY($1::text[]) GROUP BY j.ats_identity, j.last_seen_at`,
          [ids],
        );
        postgres.persisted = count.rows[0]?.n ?? 0;
        postgres.firstRun = firstResult;
        postgres.secondRun = secondResult;
        dedup.passed = (count.rows[0]?.n ?? 0) === items.length && (secondResult?.newJobs ?? 1) === 0;
        dedup.canonicalJobs = count.rows[0]?.n ?? 0;
        dedup.identities = ids;
        dedup.first = firstResult;
        dedup.second = secondResult;
        dedup.rows = seen.rows;
      } else {
        postgres.error = `Only ${items.length} canonical postings were available to store.`;
      }
    }
  } catch (error) {
    postgres.error = error instanceof Error ? error.message : "postgres failed";
  } finally {
    await pool.end().catch(() => undefined);
  }
} else {
  postgres.error = "infra/.env is missing";
}

const merged = mergeObservations(observations, observations.map((row) => ({ ...row, descriptionText: null, descriptionStatus: "missing" as const, discoveredAt: new Date().toISOString() })));
write("raw-job-observations.jsonl", observations.map((row) => JSON.stringify(row)).join("\n") + (observations.length ? "\n" : ""));
write("normalized-jobs.jsonl", canonicalJobs.map((job) => JSON.stringify({ id: job.id, company: job.company, title: job.title, canonicalUrl: job.canonicalUrl, atsIdentity: job.atsIdentity, jdContentHash: job.jdContentHash })).join("\n") + (canonicalJobs.length ? "\n" : ""));
write("live-provider-results.json", { started, providers });
write("error-classification.json", providers.map((row) => ({ provider: row.provider, outcome: row.outcome, httpStatus: row.httpStatus ?? null, transient: row.transient ?? false })));
write("provider-validation.json", { workdayJunkRejected: providers.find((row) => row.provider === "workday") });
write("postgres-ingestion-results.json", postgres);
write("dedup-verification.json", dedup);
console.log(JSON.stringify({ providers: providers.map((row) => ({ provider: row.provider, outcome: row.outcome, raw: row.rawJobsObserved })), postgres, dedup }, null, 2));

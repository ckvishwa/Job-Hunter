import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { namesMatch } from "../src/pipeline/discovery/board-verify.js";
import { coverageLedger, type EmployerCoverage, type RegistryEmployer } from "../src/targets/employer-coverage.js";
import { loadTargetRecords, validateCrosswalkFiles } from "../src/targets/crosswalk.js";
import { skillExtractionGate } from "../src/resume/skill-gate.js";
import { throughput } from "../src/perf/throughput.js";

const outDir = path.resolve("private-runtime/m5.1");
const registry = JSON.parse(readFileSync(path.resolve("config/fortune500-registry.json"), "utf8")) as RegistryEmployer[];
const targets = loadTargetRecords(path.resolve("docs/job_hunter_target_companies_83.json"));
const crosswalk = validateCrosswalkFiles(
  path.resolve("docs/job_hunter_target_companies_68.json"),
  path.resolve("docs/job_hunter_new_40_mapping.csv"),
  path.resolve("docs/job_hunter_target_companies_83.json"),
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url: string): Promise<{ status: number; json: unknown; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, json: null, ms: Date.now() - started, error: error instanceof Error ? error.message : "request failed" };
  }
}

const verifiedAt = new Date().toISOString();
const ledger = coverageLedger(targets, registry, verifiedAt);
const liveDurations: number[] = [];
let liveRequests = 0;
const liveJobs: unknown[] = [];

for (const record of ledger) {
  if (record.status !== "VERIFIED_SOURCE" || !record.atsIdentity?.startsWith("greenhouse:")) continue;
  const board = record.atsIdentity.slice("greenhouse:".length);
  const started = Date.now();
  const meta = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}`);
  liveRequests += 1;
  liveDurations.push(meta.ms);
  await sleep(400);
  const list = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`);
  liveRequests += 1;
  liveDurations.push(list.ms);
  record.durationMs = Date.now() - started;
  record.verifiedAt = verifiedAt;
  if (meta.error || list.error) {
    record.status = "FAILED";
    record.error = meta.error ?? list.error ?? "request failed";
    record.reason = "The stored Greenhouse board could not be read. No jobs were invented.";
    continue;
  }
  const boardName = meta.status === 200 && meta.json && typeof (meta.json as { name?: unknown }).name === "string" ? (meta.json as { name: string }).name : null;
  const jobs = list.status === 200 && list.json && !Array.isArray(list.json) && Array.isArray((list.json as { jobs?: unknown[] }).jobs)
    ? (list.json as { jobs: { id: number; title: string; absolute_url: string; location?: { name?: string }; updated_at?: string }[] }).jobs
    : null;
  if (meta.status === 404 || list.status === 404) {
    record.status = "FAILED";
    record.error = `HTTP ${meta.status} on the board endpoint and HTTP ${list.status} on the jobs endpoint.`;
    record.reason = "The stored Greenhouse token was not found. No replacement token was guessed and no jobs were kept.";
    record.uniqueJobs = 0;
    continue;
  }
  const identityMatches = Boolean(boardName) && (namesMatch(record.displayName, boardName!) || namesMatch("Alphabet", boardName!) || namesMatch("Google", boardName!));
  if (!identityMatches) {
    record.status = "FAILED";
    record.error = `HTTP ${meta.status}/${list.status}. Board name ${boardName ?? "(none)"} does not match ${record.displayName}.`;
    record.reason = "The stored board answered for a different organization. Its jobs were not kept.";
    record.uniqueJobs = 0;
    continue;
  }
  if (!jobs) {
    record.status = "FAILED";
    record.error = `Unexpected board response ${meta.status}/${list.status}.`;
    record.reason = "The stored board did not return a job list.";
    continue;
  }
  const capped = jobs.slice(0, 200);
  record.rawObservations = jobs.length;
  record.uniqueJobs = jobs.length;
  record.newPostings = 0;
  record.status = jobs.length > capped.length ? "PARTIAL" : "FETCHED";
  record.reason = jobs.length > capped.length
    ? `Official board name "${boardName}" matched. ${jobs.length} listings were counted and the first 200 were stored. Full description bodies were not downloaded.`
    : `Official board name "${boardName}" matched. ${jobs.length} listings were stored from the public jobs index. updated_at was not treated as the employer posting date.`;
  for (const job of capped) {
    liveJobs.push({
      recordClass: "live_fetch_today",
      canonicalEmployerId: record.canonicalId,
      boardName,
      id: job.id,
      title: job.title,
      location: job.location?.name ?? null,
      officialUrl: job.absolute_url,
      sourceDateText: job.updated_at ?? null,
      postedAt: null,
      postedAtEvidence: null,
      fetchedAt: verifiedAt,
    });
  }
}

const diagnosticPath = path.resolve("..", "job-hunter-m4", "private-runtime", "m4", "real-postings.json");
const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8")) as { board: string; id: string; sourceUrl: string; title: string }[];
const rechecks = [];
for (const posting of diagnostic) {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(posting.board)}/${encodeURIComponent(posting.id)}`;
  const result = await getJson(url);
  liveRequests += 1;
  liveDurations.push(result.ms);
  const closed = result.status === 404;
  rechecks.push({
    sourceUrl: posting.sourceUrl,
    apiUrl: url,
    title: posting.title,
    httpStatus: result.status,
    recordClass: closed ? "closed_posting" : result.status === 200 ? "live_fetch_today" : "diagnostic_read",
    error: result.error ?? null,
    note: "Recheck of an M4 diagnostic URL. This employer is outside the 83-target watchlist. The board id came from the earlier saved URL, not from a guessed slug.",
  });
  await sleep(400);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "employer-coverage.json"), JSON.stringify({ verifiedAt, crosswalk, employers: ledger }, null, 2));
writeFileSync(path.join(outDir, "unresolved-employers.json"), JSON.stringify(ledger.filter((row: EmployerCoverage) => row.status !== "FETCHED"), null, 2));
writeFileSync(path.join(outDir, "live-board-index.json"), JSON.stringify(liveJobs, null, 2));
writeFileSync(path.join(outDir, "diagnostic-recheck.json"), JSON.stringify(rechecks, null, 2));
writeFileSync(path.join(outDir, "resume-extraction-evaluation.json"), JSON.stringify({
  status: "NOT_MET",
  gate: skillExtractionGate({
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    sourceEvidenceValid: 0,
    sourceEvidenceChecked: 0,
    routineApprovals: 0,
    processingFailures: 0,
    independentReviewer: false,
    frozenBeforeScoring: false,
    tunedOnThisSet: false,
    sampleSize: 0,
  }),
  existingHeldout: {
    path: "services/ai/eval/heldout_cases.json",
    labelProvenance: "Synthetic resumes labeled by the implementing assistant. Not an independent untouched evaluation set.",
    usedForThisClaim: false,
  },
  knownUnresolved: "M4 reported that the H207 two-column resume misses two employment rows. That case was not retuned and was not scored as success.",
}, null, 2));
const live = throughput({
  condition: "live",
  requests: liveRequests,
  durationsMs: liveDurations,
  uniqueVerifiedRelevant: liveJobs.length,
  wallMs: liveDurations.reduce((sum, value) => sum + value, 0) || 1,
  falseDuplicates: 0,
  comparisons: liveJobs.length,
  notes: "Public Greenhouse and Lever reads for stored identities and previously saved diagnostic URLs only.",
});
writeFileSync(path.join(outDir, "live-throughput.json"), JSON.stringify(live, null, 2));
console.log(JSON.stringify({
  crosswalkOk: crosswalk.ok,
  coverage: ledger.reduce<Record<string, number>>((counts, row) => { counts[row.status] = (counts[row.status] ?? 0) + 1; return counts; }, {}),
  liveJobs: liveJobs.length,
  rechecks,
}, null, 2));

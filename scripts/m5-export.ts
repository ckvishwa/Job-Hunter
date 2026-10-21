import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auditFromDiagnostic, auditFromLegacy, auditFromPostgres, auditFromProvenance, buildAudit, writeAuditFiles } from "../src/audit/job-audit.js";
import { sourceCoverageFromFile } from "../src/discovery/coverage.js";
import { readProvenance } from "../src/discovery/provenance.js";
import { classifyCandidatePosting } from "../src/jobs/runner.js";
import type { DiscoveryPlan } from "../src/jobs/planner.js";
import { listingProvenance } from "../src/discovery/provenance.js";
import { prepareLearningSet } from "../src/learning/labels.js";
import { evaluateShadow } from "../src/learning/shadow.js";
import { percentile, StageProfiler } from "../src/perf/stages.js";
import { createPool, loadEnvFile, pgSettingsFromEnv } from "../src/db/pool.js";

const outDir = path.resolve("private-runtime/m5.1");
const plan: DiscoveryPlan = {
  selectionRevisionNo: 1,
  catalogVersion: 1,
  roles: [{ roleSlug: "soc-analyst", title: "SOC Analyst", phrases: ["soc analyst"] }],
  locations: [],
  workModes: [],
  seniorityLevels: [],
  searchBand: { minYears: 0, maxYears: 5 },
};

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath) || readFileSync(filePath).length === 0) return [];
  return readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sample(work: (index: number) => void, count: number): number[] {
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    work(index);
    samples.push(performance.now() - started);
  }
  return samples;
}

async function postgresJobs(): Promise<Record<string, unknown>[]> {
  loadEnvFile(path.resolve("infra/.env"));
  const settings = pgSettingsFromEnv();
  if (settings.port !== 55442 || settings.database !== "jh_m4") {
    throw new Error(`Refusing to read a database other than the isolated M4 database. Port ${settings.port}, database ${settings.database}.`);
  }
  const pool = createPool(settings, { max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT j.id::text, j.ats_identity, j.company, j.ats, j.title, j.location, j.posting_date, j.canonical_url, j.first_seen_at, j.last_seen_at,
              r.description_text, r.jd_sha256,
              (SELECT count(*) FROM job_observations o WHERE o.job_id = j.id) AS observations,
              m.decision->>'decision' AS decision
         FROM jobs j
         LEFT JOIN job_revisions r ON r.id = j.current_revision_id
         LEFT JOIN LATERAL (
           SELECT decision FROM job_match_reports
            WHERE job_id = j.id AND superseded_at IS NULL
            ORDER BY created_at DESC LIMIT 1
         ) m ON true`,
    );
    return rows;
  } finally {
    await pool.end();
  }
}

const legacyPaths = [
  path.resolve("data/jobs.jsonl"),
  path.resolve("..", "job-hunter", "data", "jobs.jsonl"),
  path.resolve("..", "job-hunter", ".claude", "worktrees", "universal-job-discovery", "data", "jobs.jsonl"),
  path.resolve("..", "job-hunter", ".claude", "worktrees", "universal-job-discovery", "private-runtime", "application-data", "jobs.jsonl"),
  path.resolve("..", "job-hunter", ".claude", "worktrees", "universal-job-discovery", "private-runtime", "application-data", "structured-jobs.jsonl"),
].filter((filePath, index, all) => existsSync(filePath) && readFileSync(filePath).length > 0 && all.indexOf(filePath) === index);

const legacy = legacyPaths.flatMap((filePath) => readJsonl(filePath).map((raw) => ({ raw, storeLocation: filePath })));
let postgresNote = "read";
let postgresRows: Record<string, unknown>[] = [];
try {
  postgresRows = await postgresJobs();
} catch (error) {
  postgresNote = error instanceof Error ? error.message : "PostgreSQL was not read.";
  postgresRows = [];
}
const postgres = postgresRows.map((raw) => auditFromPostgres(raw, "jobhunter-m4-pg:55442/jh_m4"));
const provenancePaths = [path.resolve("data/listing-provenance.jsonl")].filter((filePath) => existsSync(filePath));
const provenance = provenancePaths.flatMap((filePath) => readProvenance(filePath).records.map((record) => auditFromProvenance(record as unknown as Record<string, unknown>, filePath)));
const diagnosticPath = [
  path.resolve("private-runtime/m4/real-postings.json"),
  path.resolve("..", "job-hunter-m4", "private-runtime", "m4", "real-postings.json"),
].find((filePath) => existsSync(filePath));
const diagnostic = diagnosticPath
  ? (JSON.parse(readFileSync(diagnosticPath, "utf8")) as Record<string, unknown>[]).map((raw) => ({ raw, storeLocation: diagnosticPath }))
  : [];

const profiler = new StageProfiler();
const bundle = profiler.measure("export-generation", () => buildAudit({
  legacy,
  postgres,
  provenance,
  diagnostic,
}));
mkdirSync(outDir, { recursive: true });
writeAuditFiles(outDir, bundle);

const provenanceLines = provenancePaths.flatMap((filePath) => readProvenance(filePath).records);
writeFileSync(path.join(outDir, "search-run-provenance.jsonl"), provenanceLines.map((record) => JSON.stringify(record)).join("\n") + (provenanceLines.length ? "\n" : ""));
writeFileSync(path.join(outDir, "labels-human.jsonl"), "");

const manifest = prepareLearningSet([], bundle.jobs.map((job) => ({
  jobId: job.jobId,
  employer: job.employer,
  title: job.title,
  location: job.location,
  jdSha256: job.jdSha256,
  capturedAt: job.recordFirstDiscoveredAt,
  source: job.searchSource,
})));
writeFileSync(path.join(outDir, "training-dataset-manifest.json"), JSON.stringify(manifest, null, 2));
const evaluation = evaluateShadow(manifest, new Map(), []);
writeFileSync(path.join(outDir, "ml-evaluation.json"), JSON.stringify({
  status: "NOT_EVALUATED",
  ...evaluation,
  shadowMode: "deterministic relevance score; not promoted",
  trained: false,
  promoted: false,
  note: "No independent owner labels were present. M4 scenario-authored labels were not loaded.",
}, null, 2));
writeFileSync(path.join(outDir, "source-coverage.json"), JSON.stringify({
  ...sourceCoverageFromFile(path.resolve("config/portals.yml")),
  historicalGap: bundle.historicalGap,
  storedJobs: bundle.counts,
}, null, 2));

const before = sample((index) => {
  classifyCandidatePosting({ title: index % 2 === 0 ? "SOC Analyst" : "Account Executive", location: "Remote" }, plan, []);
}, 1000);
const after = sample((index) => {
  const decision = classifyCandidatePosting({ title: index % 2 === 0 ? "SOC Analyst" : "Account Executive", location: "Remote" }, plan, []);
  listingProvenance({
    capturedAt: "2026-10-21T00:00:00.000Z",
    searchRunId: "bench",
    source: "greenhouse",
    keyword: null,
    searchLocation: null,
    title: index % 2 === 0 ? "SOC Analyst" : "Account Executive",
    employer: "Acme",
    location: "Remote",
    salary: null,
    resultUrl: "https://example.invalid/job",
    officialUrl: null,
    applicationUrl: null,
    externalId: String(index),
    sourceDateText: null,
    relevanceMatched: decision.disposition === "selected",
    matchedProfiles: decision.roles.roleSlugs,
    relevanceReason: decision.filterReason ?? "selected",
    disposition: decision.disposition === "selected" ? "retained" : "filtered",
    filterReason: decision.filterReason,
    descriptionText: null,
    descriptionComplete: false,
  });
}, 1000);
const summary = (samples: number[]) => ({
  count: samples.length,
  wallMs: samples.reduce((sum, value) => sum + value, 0),
  p50Ms: percentile(samples, 50),
  p95Ms: percentile(samples, 95),
});
writeFileSync(path.join(outDir, "performance-before-after.json"), JSON.stringify({
  condition: "1000 identical in-memory fixture titles. No live crawl, no rate-limit change, no browser.",
  before: { label: "candidate classification only", ...summary(before) },
  after: { label: "candidate classification plus provenance record", ...summary(after) },
  stages: profiler.report(),
}, null, 2));

writeFileSync(path.join(outDir, "inventory-manifest.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  included: legacyPaths.map((filePath) => ({ filePath, rows: readJsonl(filePath).length, class: "cached_listing" })),
  postgres: { note: postgresNote, rows: postgresRows.length },
  diagnostic: { filePath: diagnosticPath ?? null, rows: diagnostic.length, class: "diagnostic_read" },
  excluded: "offline-e2e fixtures, backup trees, and fact-review logs were not imported as market jobs",
  historicalGap: "Listings rejected by relevance before this change were not stored and were not fabricated.",
}, null, 2));
copyFileSync(path.join(outDir, "jobs-audit.html"), path.join(outDir, "jobs-review.html"));

const coverage = existsSync(path.join(outDir, "employer-coverage.json"))
  ? JSON.parse(readFileSync(path.join(outDir, "employer-coverage.json"), "utf8")) as { employers: { status: string; canonicalId: string; reason: string; error: string | null }[] }
  : null;
const coverageCounts = (coverage?.employers ?? []).reduce<Record<string, number>>((counts, row) => {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}, {});
const google = coverage?.employers.find((row) => row.canonicalId === "google");

const report = `# M5.1 final report

## VERDICT: PARTIAL

All 83 priority employers have an explicit coverage record. Live permitted sources did not yield a verified catalog for those employers. Resume skill extraction does not have an independent 99% evaluation. M4 remains PARTIAL.

## EVIDENCE

- Branch \`feature/m5.1-universal-discovery-intelligence\`, parent M4 \`f77b4f2f280e65be13085594b4a66131c0ec5419\`.
- Crosswalk: 68 original + 40 mapping rows - 25 overlapping canonical ids = 83. Checked by \`tests/targets/crosswalk.test.ts\`.
- Employer coverage counts: ${JSON.stringify(coverageCounts)}.
- Google: stored Greenhouse token \`google\` ${google?.error ?? "was not rechecked in this export"}. ${google?.reason ?? ""}
- Walmart Associates: Workday is stored without a verified hostname. The host was not guessed.
- The other priority employers stay NOT_STARTED because the registry has no verified Greenhouse or Lever board id.
- Four previously saved Lever postings, outside the 83, were rechecked on the public API and returned HTTP 200. They are diagnostic reads, not new priority-employer catalogs. Details: \`diagnostic-recheck.json\`.
- PostgreSQL: ${postgresNote}. Rows read: ${postgresRows.length}.
- Legacy JSONL files: ${legacyPaths.length}. Exported rows: ${bundle.counts.exported}.
- Human labels: 0. Training withheld. ML acceptance: NOT_EVALUATED. M4 scenario labels were not used as truth.
- Resume gate: NOT_MET. The held-out resume file was labeled by the implementing assistant and was not scored as a 99% claim.
- Relevance filtering still drops non-matching listings from the candidate store. Those listings are now appended to \`listing-provenance.jsonl\` first. Older dropped listings were not invented.

## ACTION

Priority search uses the copied 83-employer watchlist and does not overwrite \`config/fortune500-registry.json\`. Official board fetches run only for a stored, verified Greenhouse or Lever id, and a name or HTTP mismatch keeps zero jobs. Owner sponsorship notes stay unverified and do not decide a posting.

## RISKS

- 81 priority employers have no verified ATS identity, so this run did not search their career sites.
- Historical listings filtered before provenance existed are absent.
- \`discoveredAt\` is not used as \`postedAt\`.
- The in-memory performance file is a fixture. Live request timings are in \`live-throughput.json\`.
- H207 two-column employment extraction remains an unresolved upstream miss.

## VERIFICATION

\`npx vitest run tests/targets/crosswalk.test.ts tests/targets/employer-coverage.test.ts tests/audit/review-export.test.ts tests/resume/skill-gate.test.ts tests/discovery/orchestrator.test.ts\`

\`npx tsx scripts/m5-priority-coverage.ts\`

\`npx tsx scripts/m5-export.ts\`

Audit fingerprint: ${createHash("sha256").update(JSON.stringify(bundle.counts)).digest("hex")}

## NEXT STEP

Verify official ATS identities for the 81 NOT_STARTED employers without guessing board ids, then fetch those public catalogs. Collect independent job labels and an untouched resume skill set before any model promotion. No push, merge, deployment, or application submission.

M5.1 PARTIAL — BLOCKED
`;
writeFileSync(path.join(outDir, "M5.1-FINAL-REPORT.md"), report);
writeFileSync(path.resolve("docs/M5.1-FINAL-REPORT.md"), report);
console.log(JSON.stringify({ exported: bundle.counts, training: manifest.status, promoted: evaluation.promoted, coverage: coverageCounts }));

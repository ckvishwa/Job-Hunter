import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
].filter((filePath, index, all) => existsSync(filePath) && readFileSync(filePath).length > 0 && all.indexOf(filePath) === index);

const legacy = legacyPaths.flatMap((filePath) => readJsonl(filePath).map((raw) => ({ raw, storeLocation: filePath })));
const postgres = (await postgresJobs()).map((raw) => auditFromPostgres(raw, "jobhunter-m4-pg:55442/jh_m4"));
const provenancePaths = [path.resolve("data/listing-provenance.jsonl")].filter((filePath) => existsSync(filePath));
const provenance = provenancePaths.flatMap((filePath) => readProvenance(filePath).records.map((record) => auditFromProvenance(record as unknown as Record<string, unknown>, filePath)));
const diagnosticPath = path.resolve("private-runtime/m4/real-postings.json");
const diagnostic = existsSync(diagnosticPath)
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
  ...evaluation,
  shadowMode: "deterministic relevance score; not promoted",
  trained: false,
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

const report = `# M5.1 final report

## VERDICT: PARTIAL

The stored jobs are exported and the ingestion path now keeps a provenance record for listings the candidate filter does not store. Independent human labels do not exist yet, so no relevance model was trained and M4 remains blocked on its scenario-authored labels.

## EVIDENCE

- Existing M4 PostgreSQL catalog on 127.0.0.1:55442: ${bundle.counts.postgres} jobs.
- Legacy JSONL records exported: ${bundle.counts.legacyJsonl}, from ${legacyPaths.length} file(s).
- Provenance records from completed runs: ${bundle.counts.provenance}.
- Diagnostic reads included and labeled as diagnostic: ${bundle.counts.diagnostic}. These are not independent labels and are not newly collected catalog jobs.
- Exported audit rows: ${bundle.counts.exported}. The JSON, CSV, and HTML contain that full set.
- Newly collected live jobs in this run: 0. No board crawl was started.
- Human labels: 0. Training status: ${manifest.status}. Model promoted: false. M4 scenario labels used as truth: false.
- Disabled portal adapters were left disabled. Verified live sources this run: 0.

## ACTION

Candidate search still applies the saved role, seniority, and location options, and the candidate job list still stores only the selected postings. Every evaluated listing is appended to listing-provenance.jsonl before that filter. The audit page searches, pages, and can download owner labels. Shadow scoring can annotate a listing and cannot hard-reject it.

## RISKS

- Historical listings dropped before this change are absent. The export does not invent them.
- Source date text is not treated as an exact posting date.
- The performance comparison is an in-memory fixture, not a before-and-after live crawl.
- M4's independent-label gate is still open.

## VERIFICATION

\`npx tsx scripts/m5-export.ts\`

Audit fingerprint: ${createHash("sha256").update(JSON.stringify(bundle.counts)).digest("hex")}

## NEXT STEP

Review the local audit, label real listings in the HTML page, and keep M4 blocked until those labels are independent of the scenario file. No push, merge, deployment, or application submission.

M5.1 PARTIAL — BLOCKED ON INDEPENDENT LABELS
`;
writeFileSync(path.join(outDir, "M5.1-FINAL-REPORT.md"), report);
console.log(JSON.stringify({ exported: bundle.counts, training: manifest.status, promoted: evaluation.promoted }));

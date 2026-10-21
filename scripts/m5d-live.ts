import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unresolvedEmployer, workdayFromUrl, UPSTREAM_COMMIT, type EmployerResolution, type PriorityEmployer } from "../src/discovery/ats/employer-resolution.js";
import { assertFetchableUrl, readBounded } from "../src/discovery/security/url-guard.js";

const outDir = path.resolve("private-runtime/m5.1/discovery");
const prior = path.resolve("private-runtime/m5.1");
const targets = (JSON.parse(readFileSync(path.resolve("docs/job_hunter_target_companies_83.json"), "utf8")) as { records: PriorityEmployer[] }).records;
const started = Date.now();

async function get(url: string): Promise<{ status: number; finalUrl: string; body: string; ms: number; error?: string }> {
  const startedAt = Date.now();
  try {
    assertFetchableUrl(url);
    const response = await fetch(url, { redirect: "follow", headers: { Accept: "text/html,application/json" } });
    assertFetchableUrl(response.url);
    const body = await readBounded(response, 2 * 1024 * 1024);
    return { status: response.status, finalUrl: response.url, body, ms: Date.now() - startedAt };
  } catch (error) {
    return { status: 0, finalUrl: url, body: "", ms: Date.now() - startedAt, error: error instanceof Error ? error.message : "request failed" };
  }
}

const listings: Record<string, unknown>[] = [];
const byId = new Map(targets.map((row) => [row.id, unresolvedEmployer(row)]));

async function google(row: EmployerResolution): Promise<void> {
  const url = "https://www.google.com/about/careers/applications/jobs/results/?q=software%20engineer&location=United%20States&sort_by=date";
  if (url.includes("page=")) throw new Error("Google pagination is disallowed.");
  const result = await get(url);
  row.careersUrl = url;
  row.method = "google-careers-html-first-page";
  row.atsType = "google";
  row.verifiedAt = new Date().toISOString();
  const cards = [...result.body.matchAll(/jobs\/results\/(\d+)-([a-z0-9-]+)/g)];
  const ids = cards.map((match) => match[1]);
  if (result.error || result.status !== 200 || !result.finalUrl.startsWith("https://www.google.com/")) {
    row.status = result.status === 403 || result.status === 429 ? "ACCESS_RESTRICTED" : "TRANSIENT_FAILURE";
    row.reason = result.error ?? `HTTP ${result.status}`;
    return;
  }
  row.observedPostings = new Set(ids).size;
  row.uniqueUsPostings = row.observedPostings;
  row.resolvedJds = 0;
  row.status = row.observedPostings > 0 ? "VERIFIED" : "NOT_FOUND";
  row.reason = row.observedPostings > 0
    ? "First careers results page returned Google job links. Pagination was not requested because robots.txt disallows the page parameter."
    : "The careers page loaded and contained no job links. This is not reported as a searched empty board from a bad Greenhouse token.";
  for (const match of cards.slice(0, 20)) {
    const id = match[1];
    const slug = match[2];
    listings.push({
      employerId: "google",
      employerName: "Google",
      jobId: id,
      title: null,
      sourceUrl: `https://www.google.com/about/careers/applications/jobs/results/${id}-${slug}`,
      postedAt: null,
      postingDatePrecision: "unknown",
      description: null,
      recordClass: "live_fetch_today",
      resolutionStatus: "pending",
    });
  }
}

async function amazon(row: EmployerResolution): Promise<void> {
  const url = "https://www.amazon.jobs/en/search.json?base_query=&loc_query=United%20States&sort=recent&result_limit=10&offset=0";
  const result = await get(url);
  row.careersUrl = "https://www.amazon.jobs";
  row.method = "amazon.jobs-search-json";
  row.atsType = "amazon";
  row.verifiedAt = new Date().toISOString();
  if (result.error || result.status !== 200) {
    row.status = "TRANSIENT_FAILURE";
    row.reason = result.error ?? `HTTP ${result.status}`;
    return;
  }
  const parsed = JSON.parse(result.body) as { jobs?: { company_name?: string; title?: string; job_path?: string }[] };
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const owned = jobs.filter((job) => /amazon|aws/i.test(job.company_name ?? ""));
  row.observedPostings = owned.length;
  row.uniqueUsPostings = owned.length;
  row.status = owned.length > 0 ? "VERIFIED" : "IDENTITY_MISMATCH";
  row.reason = owned.length > 0
    ? "amazon.jobs returned a 10-row United States page. This is a slice, not the full board."
    : "The JSON page did not identify Amazon or AWS as the employer.";
  for (const job of owned) {
    listings.push({
      employerId: "amazon-aws",
      employerName: job.company_name,
      title: job.title ?? null,
      sourceUrl: job.job_path ? `https://www.amazon.jobs${job.job_path.startsWith("/") ? job.job_path : `/${job.job_path}`}` : null,
      postedAt: null,
      postingDatePrecision: "unknown",
      description: null,
      recordClass: "live_fetch_today",
      resolutionStatus: "pending",
    });
  }
}

async function walmart(row: EmployerResolution): Promise<void> {
  const result = await get("https://careers.walmart.com");
  row.method = "careers-redirect";
  row.verifiedAt = new Date().toISOString();
  row.careersUrl = result.finalUrl;
  const coords = workdayFromUrl(result.finalUrl);
  if (result.error) {
    row.status = "TRANSIENT_FAILURE";
    row.reason = result.error;
    return;
  }
  if (!coords) {
    row.status = result.status === 403 || result.status === 429 ? "ACCESS_RESTRICTED" : "NOT_FOUND";
    row.atsType = null;
    row.reason = `Final URL ${result.finalUrl} (HTTP ${result.status}) did not expose a Workday tenant, instance, and site. Coordinates were not invented.`;
    return;
  }
  if (!/walmart/i.test(result.body) && !/walmart/i.test(coords.tenant)) {
    row.status = "IDENTITY_MISMATCH";
    row.reason = `Workday host ${coords.hostname} did not identify Walmart.`;
    return;
  }
  row.atsType = "workday";
  row.status = "VERIFIED";
  row.reason = `Redirect exposed tenant ${coords.tenant}, instance ${coords.instance}, site ${coords.site}, host ${coords.hostname}. Job pages were not crawled in this pilot.`;
}

const pilots = ["google", "amazon-aws", "walmart-associates", "microsoft", "apple", "nvidia", "meta-platforms", "salesforce", "stripe", "datadog"];
const knownUrls: Record<string, string> = {
  microsoft: "https://careers.microsoft.com/",
  apple: "https://jobs.apple.com",
  nvidia: "https://www.nvidia.com/en-us/about-nvidia/careers/",
  "meta-platforms": "https://www.metacareers.com/",
  salesforce: "https://careers.salesforce.com/en/jobs/",
  stripe: "https://stripe.com/jobs",
  datadog: "https://careers.datadoghq.com/",
};

for (const id of pilots) {
  const row = byId.get(id);
  if (!row) continue;
  if (id === "google") await google(row);
  else if (id === "amazon-aws") await amazon(row);
  else if (id === "walmart-associates") await walmart(row);
  else {
    const url = knownUrls[id];
    const result = url ? await get(url) : { status: 0, finalUrl: "", body: "", ms: 0, error: "no careers URL" };
    row.careersUrl = result.finalUrl || url || null;
    row.method = "https-careers-probe";
    row.verifiedAt = new Date().toISOString();
    const name = row.displayName.split(" ")[0] ?? row.displayName;
    if (result.error || result.status === 0) {
      row.status = "TRANSIENT_FAILURE";
      row.reason = result.error ?? "no response";
    } else if (result.status === 403 || result.status === 429) {
      row.status = "ACCESS_RESTRICTED";
      row.reason = `HTTP ${result.status} from ${result.finalUrl}.`;
    } else if (result.status === 200 && new RegExp(name, "i").test(result.body)) {
      row.status = "VERIFIED";
      row.atsType = "company-careers-page";
      row.observedPostings = 0;
      row.reason = `HTTPS careers page identified ${name}. Posting enumeration was not claimed from this probe.`;
    } else {
      row.status = "NOT_FOUND";
      row.reason = `HTTP ${result.status} did not establish an ATS board for ${row.displayName}.`;
    }
  }
}

const employers = [...byId.values()];
mkdirSync(outDir, { recursive: true });
const counts = employers.reduce<Record<string, number>>((sum, row) => { sum[row.status] = (sum[row.status] ?? 0) + 1; return sum; }, {});
writeFileSync(path.join(outDir, "priority-employer-coverage.json"), JSON.stringify({ verifiedAt: new Date().toISOString(), counts, employers }, null, 2));
writeFileSync(path.join(outDir, "ats-resolution-results.json"), JSON.stringify(employers.filter((row) => pilots.includes(row.canonicalId)), null, 2));
writeFileSync(path.join(outDir, "upstream-audit.json"), JSON.stringify({
  repository: "https://github.com/career-ops-hq/career-ops",
  commit: UPSTREAM_COMMIT,
  license: "MIT",
  copyright: "Copyright (c) 2026 Santiago Fernández de Valderrama",
  reverseScanAts: ["greenhouse", "lever", "ashby", "workday", "icims", "bamboohr"],
  providerModulesPresent: true,
  copiedProviderModules: 0,
}, null, 2));
writeFileSync(path.join(outDir, "reverse-ats-coverage.json"), JSON.stringify({
  status: "NOT_RUN",
  reason: "The public directory scanner was not executed. Directory slugs are not verified employers until a board response matches the employer.",
  familiesAvailableInPinnedScanner: ["greenhouse", "lever", "ashby", "workday", "icims", "bamboohr"],
}, null, 2));
writeFileSync(path.join(outDir, "discovery-performance.json"), JSON.stringify({
  condition: "live",
  pilotEmployers: pilots.length,
  wallMs: Date.now() - started,
  note: "Ten HTTPS probes. No browser and no full-board crawl.",
}, null, 2));
writeFileSync(path.join(outDir, "jobs-full.json"), JSON.stringify(listings, null, 2));
writeFileSync(path.join(outDir, "source-health.json"), JSON.stringify({ counts, priorEvidenceDirectory: prior }, null, 2));
console.log(JSON.stringify({ counts, pilots: employers.filter((row) => pilots.includes(row.canonicalId)).map((row) => ({ id: row.canonicalId, status: row.status, observed: row.observedPostings, reason: row.reason })) }, null, 2));

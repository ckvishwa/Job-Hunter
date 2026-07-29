import path from "node:path";
import { runDiscover, type DiscoverFilters } from "../discovery/orchestrator.js";
import type { DiscoveryRunSummary } from "../discovery/report.js";
import { loadJobs } from "../storage/jsonl-store.js";
import { loadHuntState, saveHuntState } from "./hunt-state.js";
import { buildReportRows, type ReportRow } from "./report-rows.js";
import { writeCsvReport, writeHtmlReport, writeJsonReport } from "./writers.js";

// A job not re-seen in this many days is flagged stale (Task 3) -- excluded from the default
// report output unless --include-stale is passed.
const DEFAULT_STALE_DAYS = 14;
const DEFAULT_LOCATION = "United States";
const TOP_N = 10;

export interface HuntFilters {
  profileIds?: string[];
  location?: string;
  remoteOnly?: boolean;
  excludeOnsite?: boolean;
  states?: string[];
  includeUnknownLocation?: boolean;
  newOnly?: boolean;
  days?: number;
  includeSeen?: boolean;
  includeStale?: boolean;
  limit?: number;
  dryRun?: boolean;
}

export interface HuntPaths {
  sitesConfigPath: string;
  rolesConfigPath: string;
  portalsConfigPath: string;
  discoveredJobsPath: string;
  jobsStorePath: string;
  checkpointsPath: string;
  huntStatePath: string;
  outputDir: string;
}

export interface HuntSummary {
  totalDiscovered: number;
  ineligibleSeniority: number;
  locationMismatch: number;
  eligibleRetained: number;
  newJobs: number;
  top10: ReportRow[];
  resolutionTimeMs: number;
  reportPaths: { json: string; csv: string; html: string };
}

function huntStateKey(profileIds?: string[]): string {
  return profileIds?.length ? [...profileIds].sort().join(",") : "*";
}

export async function runHunt(
  paths: HuntPaths,
  filters: HuntFilters = {},
  runDiscoverFn: (
    discoverPaths: Parameters<typeof runDiscover>[0],
    discoverFilters: DiscoverFilters,
  ) => Promise<DiscoveryRunSummary> = runDiscover,
  // Test seam only -- the real CLI never passes this, always using the actual current time.
  // Lets tests fix "now" relative to fixture discoveredAt/lastSeenAt values instead of the
  // real wall clock, which would otherwise make old fixture timestamps spuriously "stale."
  nowOverride?: string,
): Promise<HuntSummary> {
  const requestedCountry = filters.location ?? DEFAULT_LOCATION;

  const discoverySummary = await runDiscoverFn(
    {
      sitesConfigPath: paths.sitesConfigPath,
      rolesConfigPath: paths.rolesConfigPath,
      portalsConfigPath: paths.portalsConfigPath,
      discoveredJobsPath: paths.discoveredJobsPath,
      jobsStorePath: paths.jobsStorePath,
      checkpointsPath: paths.checkpointsPath,
    },
    {
      profileIds: filters.profileIds,
      location: requestedCountry,
      dryRun: filters.dryRun,
    },
  );

  const huntState = loadHuntState(paths.huntStatePath);
  const key = huntStateKey(filters.profileIds);
  const previousHuntAt = huntState.lastSuccessfulHuntAt[key] ?? null;

  const allJobs = loadJobs(paths.jobsStorePath);
  const jobs = filters.profileIds?.length
    ? allJobs.filter((job) => job.matchedProfiles.some((p) => filters.profileIds!.includes(p)))
    : allJobs;

  const now = nowOverride ?? new Date().toISOString();
  const { rows, counts } = buildReportRows(jobs, {
    now,
    previousHuntAt,
    staleDays: DEFAULT_STALE_DAYS,
    requestedProfileIds: filters.profileIds ?? null,
    requestedCountry,
    requestedStates: filters.states ?? null,
    remoteOnly: !!filters.remoteOnly,
    excludeOnsite: !!filters.excludeOnsite,
    includeUnknownLocation: !!filters.includeUnknownLocation,
    newOnly: !!filters.newOnly,
    days: filters.days ?? null,
    includeSeen: !!filters.includeSeen,
    includeStale: !!filters.includeStale,
    limit: filters.limit ?? null,
  });

  const reportPaths = {
    json: path.join(paths.outputDir, "latest-jobs.json"),
    csv: path.join(paths.outputDir, "latest-jobs.csv"),
    html: path.join(paths.outputDir, "latest-jobs.html"),
  };
  writeJsonReport(reportPaths.json, rows);
  writeCsvReport(reportPaths.csv, rows);
  writeHtmlReport(reportPaths.html, rows);

  if (!filters.dryRun) {
    huntState.lastSuccessfulHuntAt[key] = now;
    saveHuntState(paths.huntStatePath, huntState);
  }

  return {
    totalDiscovered: counts.totalDiscovered,
    ineligibleSeniority: counts.ineligibleSeniority,
    locationMismatch: counts.locationMismatch,
    eligibleRetained: counts.eligibleRetained,
    newJobs: counts.newJobs,
    top10: rows.slice(0, TOP_N),
    resolutionTimeMs: discoverySummary.resolutionTimeMs,
    reportPaths,
  };
}

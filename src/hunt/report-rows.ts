import type { JobPosting } from "../adapters/types.js";
import { classifyEligibility, type SeniorityLevel } from "./eligibility.js";
import { parseLocation, type WorkArrangement } from "./location.js";
import { computeFreshness } from "./freshness.js";
import { scoreJob, type ScoreBreakdown } from "./scoring.js";
import { UNRESOLVED_PLACEHOLDER_PREFIX } from "../discovery/resolve-phase.js";

const DAY_MS = 86_400_000;

export interface ReportRow {
  rank: number;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  title: string;
  company: string;
  location: string;
  city: string | null;
  state: string | null;
  country: string | null;
  workArrangement: WorkArrangement;
  seniority: SeniorityLevel;
  requiredYearsMin: number | null;
  requiredYearsMax: number | null;
  matchedProfile: string;
  matchedKeywords: string[];
  postingAgeDays: number | null;
  applyUrl: string;
  source: string;
  eligibilityReasons: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
  isUpdated: boolean;
  isStale: boolean;
  unresolved: boolean;
}

export interface ReportRowOptions {
  now: string;
  previousHuntAt: string | null;
  staleDays: number;
  // The --profile filter active for this hunt run, or null if none. Used only to pick which
  // of a multi-profile job's matchedProfiles is reported as the row's primary -- the profile
  // actually being searched for, not whatever relevance.ts happened to record as primary at
  // discovery time (same rule the discovery orchestrator itself already applies).
  requestedProfileIds: string[] | null;
  requestedCountry: string | null;
  requestedStates: string[] | null;
  remoteOnly: boolean;
  excludeOnsite: boolean;
  includeUnknownLocation: boolean;
  newOnly: boolean;
  days: number | null;
  includeSeen: boolean;
  includeStale: boolean;
  limit: number | null;
}

export interface ReportRowCounts {
  totalDiscovered: number;
  ineligibleSeniority: number;
  locationMismatch: number;
  eligibleRetained: number;
  newJobs: number;
}

export interface ReportRowResult {
  rows: ReportRow[];
  counts: ReportRowCounts;
}

function pickMatchedProfile(matchedProfiles: string[], requestedProfileIds: string[] | null): string {
  if (requestedProfileIds?.length) {
    const requestedMatch = matchedProfiles.find((p) => requestedProfileIds.includes(p));
    if (requestedMatch) return requestedMatch;
  }
  return matchedProfiles[0] ?? "";
}

function passesLocationFilter(
  loc: ReturnType<typeof parseLocation>,
  options: ReportRowOptions,
): boolean {
  if (options.remoteOnly && loc.workArrangement !== "remote") return false;
  if (options.excludeOnsite && loc.workArrangement === "onsite") return false;

  if (options.requestedStates?.length) {
    return loc.state !== null && options.requestedStates.includes(loc.state);
  }
  if (options.requestedCountry) {
    if (loc.country === options.requestedCountry) return true;
    if (!loc.locationKnown && options.includeUnknownLocation) return true;
    return false;
  }
  return true;
}

function passesFreshnessFilter(
  freshnessInfo: ReturnType<typeof computeFreshness>,
  discoveredAtMs: number,
  nowMs: number,
  options: ReportRowOptions,
): boolean {
  if (freshnessInfo.isStale && !options.includeStale) return false;

  if (options.days !== null) {
    const ageDays = freshnessInfo.postingAgeDays ?? Math.floor((nowMs - discoveredAtMs) / DAY_MS);
    return ageDays <= options.days;
  }
  if (options.includeSeen) return true;
  return freshnessInfo.isNew;
}

export function buildReportRows(jobs: JobPosting[], options: ReportRowOptions): ReportRowResult {
  const counts: ReportRowCounts = {
    totalDiscovered: jobs.length,
    ineligibleSeniority: 0,
    locationMismatch: 0,
    eligibleRetained: 0,
    newJobs: 0,
  };

  const nowMs = Date.parse(options.now);
  const candidates: { job: JobPosting; breakdown: ScoreBreakdown; row: Omit<ReportRow, "rank"> }[] = [];

  for (const job of jobs) {
    const eligibility = classifyEligibility(job.title, job.descriptionText);
    if (!eligibility.eligible) {
      counts.ineligibleSeniority += 1;
      continue;
    }

    const loc = parseLocation(job.location, job.descriptionText);
    if (!passesLocationFilter(loc, options)) {
      counts.locationMismatch += 1;
      continue;
    }

    counts.eligibleRetained += 1;

    const freshnessInfo = computeFreshness(
      { discoveredAt: job.discoveredAt, lastSeenAt: job.lastSeenAt, postingDate: job.postingDate },
      { now: options.now, previousHuntAt: options.previousHuntAt, staleDays: options.staleDays },
    );
    if (freshnessInfo.isNew) counts.newJobs += 1;

    if (!passesFreshnessFilter(freshnessInfo, Date.parse(job.discoveredAt), nowMs, options)) continue;

    const breakdown = scoreJob(job, {
      eligibility,
      parsedLocation: loc,
      freshnessInfo,
      requestedCountry: options.requestedCountry,
      requestedStates: options.requestedStates,
      remoteOnly: options.remoteOnly,
    });

    candidates.push({
      job,
      breakdown,
      row: {
        score: breakdown.total,
        scoreBreakdown: breakdown,
        title: job.title,
        company: job.company,
        location: job.location ?? "",
        city: loc.city,
        state: loc.state,
        country: loc.country,
        workArrangement: loc.workArrangement,
        seniority: eligibility.seniority,
        requiredYearsMin: eligibility.requiredYearsMin,
        requiredYearsMax: eligibility.requiredYearsMax,
        matchedProfile: pickMatchedProfile(job.matchedProfiles, options.requestedProfileIds),
        matchedKeywords: job.matchedKeywords ?? [],
        postingAgeDays: freshnessInfo.postingAgeDays,
        applyUrl: job.applyUrl,
        source: job.source,
        eligibilityReasons: eligibility.reasons,
        firstSeenAt: job.discoveredAt,
        lastSeenAt: job.lastSeenAt,
        isNew: freshnessInfo.isNew,
        isUpdated: freshnessInfo.isUpdated,
        isStale: freshnessInfo.isStale,
        unresolved: job.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX),
      },
    });
  }

  candidates.sort((a, b) => {
    if (b.row.score !== a.row.score) return b.row.score - a.row.score;
    const ageA = a.row.postingAgeDays ?? Number.MAX_SAFE_INTEGER;
    const ageB = b.row.postingAgeDays ?? Number.MAX_SAFE_INTEGER;
    if (ageA !== ageB) return ageA - ageB;
    return a.row.title.localeCompare(b.row.title);
  });

  const limited = options.limit !== null ? candidates.slice(0, options.limit) : candidates;
  const rows: ReportRow[] = limited.map((c, i) => ({ rank: i + 1, ...c.row }));

  return { rows, counts };
}

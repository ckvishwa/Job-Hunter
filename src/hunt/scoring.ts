import type { JobPosting } from "../adapters/types.js";
import type { EligibilityResult } from "./eligibility.js";
import type { ParsedLocation } from "./location.js";
import type { FreshnessInfo } from "./freshness.js";
import { UNRESOLVED_PLACEHOLDER_PREFIX } from "../discovery/resolve-phase.js";

export interface ScoreBreakdown {
  titleRelevance: number;
  seniorityAlignment: number;
  yearsAlignment: number;
  locationAlignment: number;
  remoteAlignment: number;
  jdCompleteness: number;
  freshness: number;
  officialLink: number;
  penalties: number;
  total: number;
}

export interface ScoreContext {
  eligibility: EligibilityResult;
  parsedLocation: ParsedLocation;
  freshnessInfo: FreshnessInfo;
  requestedCountry: string | null;
  requestedStates: string[] | null;
  remoteOnly: boolean;
}

const KNOWN_ATS_HOSTS = ["greenhouse.io", "lever.co", "myworkdayjobs.com"];

function scoreTitleRelevance(job: JobPosting): number {
  return Math.min(20, (job.matchedKeywords?.length ?? 0) * 7);
}

function scoreSeniorityAlignment(eligibility: EligibilityResult): number {
  if (eligibility.seniority === "unknown") return 6;
  if (!eligibility.eligible) return 0;
  return 15;
}

function scoreYearsAlignment(eligibility: EligibilityResult): number {
  const { requiredYearsMin } = eligibility;
  if (requiredYearsMin === null) return 3;
  if (requiredYearsMin <= 1) return 10;
  if (requiredYearsMin <= 3) return 8;
  return 5;
}

function scoreLocationAlignment(loc: ParsedLocation, ctx: ScoreContext): number {
  if (ctx.requestedStates?.length && loc.state && ctx.requestedStates.includes(loc.state)) return 15;
  if (ctx.requestedCountry && loc.country === ctx.requestedCountry) return 15;
  if (!loc.locationKnown) return 7;
  return 0;
}

function scoreRemoteAlignment(loc: ParsedLocation, remoteOnly: boolean): number {
  if (remoteOnly) {
    if (loc.workArrangement === "remote") return 10;
    if (loc.workArrangement === "hybrid") return 3;
    return 0;
  }
  switch (loc.workArrangement) {
    case "remote":
      return 8;
    case "hybrid":
      return 6;
    case "onsite":
      return 4;
    default:
      return 2;
  }
}

function scoreJdCompleteness(descriptionText: string): number {
  if (descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)) return 0;
  if (descriptionText.length > 500) return 10;
  if (descriptionText.length > 150) return 6;
  if (descriptionText.length > 0) return 2;
  return 0;
}

function scoreFreshness(freshnessInfo: FreshnessInfo): number {
  if (freshnessInfo.isStale) return 0;
  if (freshnessInfo.isNew) return 10;
  if (freshnessInfo.isUpdated) return 6;
  const days = freshnessInfo.postingAgeDays;
  if (days === null) return 3;
  if (days <= 7) return 8;
  if (days <= 30) return 5;
  return 1;
}

function scoreOfficialLink(job: JobPosting): number {
  if (job.sourceType === "company-careers" || job.source.startsWith("company-careers")) return 10;
  if (KNOWN_ATS_HOSTS.some((host) => job.canonicalUrl.includes(host))) return 5;
  return 0;
}

function computePenalties(job: JobPosting, eligibility: EligibilityResult): number {
  let penalties = 0;
  if (eligibility.seniority === "unknown" && eligibility.requiredYearsMin === null) penalties += 5;
  if (job.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)) penalties += 10;
  return penalties;
}

export function scoreJob(job: JobPosting, ctx: ScoreContext): ScoreBreakdown {
  const titleRelevance = scoreTitleRelevance(job);
  const seniorityAlignment = scoreSeniorityAlignment(ctx.eligibility);
  const yearsAlignment = scoreYearsAlignment(ctx.eligibility);
  const locationAlignment = scoreLocationAlignment(ctx.parsedLocation, ctx);
  const remoteAlignment = scoreRemoteAlignment(ctx.parsedLocation, ctx.remoteOnly);
  const jdCompleteness = scoreJdCompleteness(job.descriptionText);
  const freshness = scoreFreshness(ctx.freshnessInfo);
  const officialLink = scoreOfficialLink(job);
  const penalties = computePenalties(job, ctx.eligibility);

  const rawSum =
    titleRelevance + seniorityAlignment + yearsAlignment + locationAlignment +
    remoteAlignment + jdCompleteness + freshness + officialLink - penalties;
  const total = Math.max(0, Math.min(100, rawSum));

  return {
    titleRelevance,
    seniorityAlignment,
    yearsAlignment,
    locationAlignment,
    remoteAlignment,
    jdCompleteness,
    freshness,
    officialLink,
    penalties,
    total,
  };
}

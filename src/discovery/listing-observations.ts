import path from "node:path";
import { appendJsonlRecords } from "../storage/jsonl-store.js";
import type { DiscoveredJobLite } from "./types.js";

/** A listing captured before relevance filtering. postedAt stays unknown unless a later verifier supplies evidence. */
export interface ListingObservation {
  kind: "listing-observation";
  capturedAt: string;
  searchRunId: string;
  source: string;
  keyword: string;
  searchLocation: string;
  title: string;
  employer: string;
  location: string;
  salary: string | null;
  resultUrl: string;
  officialUrl: string | null;
  externalId: string | null;
  department: string | null;
  /** Raw date text from the source. Never copied into postedAt. */
  sourceDateText: string | null;
  postedAt: null;
  postedAtStatus: "unknown";
  postedAtEvidence: null;
  relevanceMatched: boolean;
  disposition: "retained" | "filtered";
  filterReason: string | null;
  descriptionText: string | null;
  descriptionComplete: false;
}

export interface SearchRunRecord {
  kind: "search-run";
  searchRunId: string;
  source: string;
  keyword: string;
  location: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  listingsDiscovered: number;
  listingsRetained: number;
  error: string | null;
  skipped: boolean;
  skipReason: string | null;
}

export function listingObservationFromDiscovery(input: {
  job: DiscoveredJobLite;
  searchRunId: string;
  keyword: string;
  searchLocation: string;
  capturedAt: string;
  disposition: "retained" | "filtered";
  filterReason: string | null;
  relevanceMatched: boolean;
}): ListingObservation {
  const title = input.job.title?.trim() ?? "";
  if (!title) throw new Error("A listing observation needs a title.");
  return {
    kind: "listing-observation",
    capturedAt: input.capturedAt,
    searchRunId: input.searchRunId,
    source: input.job.source,
    keyword: input.keyword,
    searchLocation: input.searchLocation,
    title,
    employer: input.job.company,
    location: input.job.location,
    salary: input.job.salarySnippet,
    resultUrl: input.job.resultUrl,
    officialUrl: input.job.possibleOfficialUrl,
    externalId: input.job.sourceJobId,
    department: input.job.department,
    sourceDateText: input.job.postingAgeOrDate,
    postedAt: null,
    postedAtStatus: "unknown",
    postedAtEvidence: null,
    relevanceMatched: input.relevanceMatched,
    disposition: input.disposition,
    filterReason: input.filterReason,
    descriptionText: input.job.descriptionSnippet,
    descriptionComplete: false,
  };
}

export function appendListingObservations(filePath: string, records: readonly ListingObservation[]): void {
  appendJsonlRecords(filePath, records);
}

export function appendSearchRuns(filePath: string, records: readonly SearchRunRecord[]): void {
  appendJsonlRecords(filePath, records);
}

export function searchRun(
  searchRunId: string,
  source: string,
  keyword: string,
  location: string,
  durationMs: number,
  listingsDiscovered: number,
  listingsRetained: number,
  error: string | null,
  skipped: boolean,
  skipReason: string | null,
  now = new Date(),
): SearchRunRecord {
  return {
    kind: "search-run",
    searchRunId,
    source,
    keyword,
    location,
    startedAt: new Date(now.getTime() - durationMs).toISOString(),
    endedAt: now.toISOString(),
    durationMs,
    listingsDiscovered,
    listingsRetained,
    error,
    skipped,
    skipReason,
  };
}

export function defaultObservationPaths(discoveredJobsPath: string, overrides?: { observationsPath?: string; searchRunsPath?: string }): {
  observationsPath: string;
  searchRunsPath: string;
} {
  const dir = path.dirname(discoveredJobsPath);
  return {
    observationsPath: overrides?.observationsPath ?? path.join(dir, "listing-observations.jsonl"),
    searchRunsPath: overrides?.searchRunsPath ?? path.join(dir, "search-runs.jsonl"),
  };
}

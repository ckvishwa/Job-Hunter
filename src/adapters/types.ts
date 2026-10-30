import type { CollectSettings, RoleConfig, SiteConfig } from "../types.js";

export interface RoleSearch {
  keyword: string;
  profileIds: string[];
}

export interface DiscoveredJob {
  externalId: string;
  title: string;
  url: string;
  matchedProfiles: string[];
  rawMetadata?: Record<string, unknown>;
}

export interface RawJobDetail {
  externalId: string;
  title: string;
  descriptionText: string;
  descriptionHtml: string | null;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  requisitionId: string | null;
  postingDate: string | null;
  salaryText: string | null;
  canonicalUrl: string;
  applyUrl: string;
  rawMetadata: Record<string, unknown>;
}

/**
 * One sighting of a posting: where the listing was found, where the official page finally
 * resolved, and how the JD text was obtained. Persisted on JobPosting.sourceObservations.
 */
export interface SourceObservation {
  sourceKind: string;
  observedUrl: string;
  finalUrl: string;
  observedAt: string;
  // "ats-api": public Greenhouse/Lever/Workday JSON. "browser-dom": scraped from the page in headed Chrome.
  extractionMethod: "ats-api" | "browser-dom";
}

export interface JobPosting {
  id: string;
  source: string;
  sourceType: SiteConfig["adapter"] | "portal" | "company-careers";
  company: string;
  title: string;
  location: string | null;
  remoteType: string | null;
  employmentType: string | null;
  department: string | null;
  requisitionId: string | null;
  postingDate: string | null;
  discoveredAt: string;
  lastSeenAt: string;
  canonicalUrl: string;
  applyUrl: string;
  descriptionText: string;
  descriptionHtml: string | null;
  requiredYears: number | null;
  salaryText: string | null;
  matchedProfiles: string[];
  discoveredFrom: string[];
  discoveredUrl?: string;
  // Relevance evidence from src/discovery/relevance.ts's evaluateRelevance(), carried through
  // from DiscoveredJobLite. Optional/absent on jobs from the older src/runner/source-runner.ts
  // pipeline (its SourceAdapter.normalize() never runs relevance evaluation) -- never fabricated.
  matchedKeywords?: string[];
  relevanceReason?: string;
  // V1 Slice 1 canonical fields (src/domain/canonical-job.ts). Optional so legacy records and
  // the older src/runner pipeline stay valid; discovery output must carry all of them to be
  // persisted (evaluatePersistable).
  schemaVersion?: number;
  jdContentHash?: string;
  extractedAt?: string;
  resolutionStatus?: "resolved" | "unresolved";
  sourceObservations?: SourceObservation[];
  // "<ats>:<board>:<jobId>", e.g. "greenhouse:figma:5829751004". Distinct requisitions never share one.
  atsIdentity?: string;
  // Transient: why resolution failed. Never persisted (stripped by evaluatePersistable).
  resolutionFailure?: { code: string; detail: string };
  rawMetadata: Record<string, unknown>;
}

export interface SourceAdapter {
  sourceType: SiteConfig["adapter"];
  /**
   * Whether fetchJobDetails makes a real network/browser call per job (true for
   * Workday and the generic Playwright adapter) versus being a pure local transform
   * over already-fetched rawMetadata (false for Greenhouse and Lever). The runner
   * uses this to decide whether delayBetweenRequestsMs should apply -- there's no
   * reason to rate-limit a loop that never actually makes a per-job request.
   */
  fetchesPerJob: boolean;
  canHandle(site: SiteConfig): boolean;
  discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]>;
  fetchJobDetails(
    job: DiscoveredJob,
    site: SiteConfig,
    settings: CollectSettings,
  ): Promise<RawJobDetail>;
  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]): JobPosting;
}

export type { RoleConfig };

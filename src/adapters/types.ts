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

export interface JobPosting {
  id: string;
  source: string;
  sourceType: SiteConfig["adapter"];
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

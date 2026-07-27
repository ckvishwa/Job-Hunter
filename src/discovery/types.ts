export interface DiscoveredJobLite {
  source: string;
  searchKeyword: string;
  title: string;
  company: string;
  location: string;
  salarySnippet: string | null;
  resultUrl: string;
  possibleOfficialUrl: string | null;
  postingAgeOrDate: string | null;
  sourceJobId: string | null;
  discoveredAt: string;
  matchedProfiles: string[];
}

export interface DiscoveryCheckpoint {
  key: string; // "source::keyword::location"
  source: string;
  keyword: string;
  location: string;
  lastPage: number;
  completed: boolean;
  lastUpdated: string;
  sourceJobIds: string[];
  // company-careers only: company completion isn't sequential (company 5 can fail while
  // company 6 succeeds), unlike portal pagination's lastPage cursor. Tracked by stable
  // "company::corporateDomain" identity (not array index -- the registry can grow/reorder
  // between runs, and a raw index would silently point at the wrong company after that).
  // Optional so portal-adapter checkpoints are unaffected.
  completedCompanyKeys?: string[];
}

import type { Page } from "playwright";
import type { CollectSettings, SiteConfig } from "../types.js";

export interface DiscoveryContext {
  page: Page;
  keyword: string;
  location: string;
  settings: CollectSettings;
  checkpoint: DiscoveryCheckpoint;
  onPageProcessed: (jobs: DiscoveredJobLite[], nextPageNum: number) => Promise<void>;
  siteConfig?: SiteConfig;
  profileIds: string[];
  onVerificationPause?: () => void;
}

export interface PortalDiscoveryAdapter {
  source: string;
  discover(context: DiscoveryContext): Promise<void>;
}


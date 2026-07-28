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
import type { PortalConfig } from "../config/schema.js";

export interface DiscoveryContext {
  page: Page;
  keyword: string;
  location: string;
  settings: CollectSettings;
  checkpoint: DiscoveryCheckpoint;
  onPageProcessed: (jobs: DiscoveredJobLite[], nextPageNum: number) => Promise<void>;
  siteConfig?: SiteConfig;
  // Populated by the orchestrator for the 5 portal-search adapters (Task 7), from the
  // matching config/portals.yml entry. Optional because company-careers doesn't use it
  // (it builds its own synthetic SiteConfig from the Fortune 500 registry instead).
  portalConfig?: PortalConfig;
  profileIds: string[];
  onVerificationPause?: () => void;
  // Reporting (Task 15): called once per company actually attempted by company-careers.ts
  // (including structural skips -- those ARE attempts, just not full ATS-adapter runs) but
  // NOT for companies excluded by an active --company filter (never attempted at all). Only
  // meaningful to company-careers.ts; other adapters have no per-company concept.
  onCompanyProcessed?: () => void;
  // --company filter (CLI). Only meaningful to company-careers.ts; other adapters ignore it.
  companyFilter?: string;
}

export interface PortalDiscoveryAdapter {
  source: string;
  discover(context: DiscoveryContext): Promise<void>;
}


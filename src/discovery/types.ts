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
  // Ordered by src/discovery/relevance.ts's evaluateRelevance(): index 0 is the primary
  // profile. Empty only transiently during adapter construction, before the orchestrator's
  // relevance filter runs -- never empty on a job that actually reaches discoveredJobs.jsonl.
  matchedProfiles: string[];
  // "When available" lightweight fields (Profile Relevance phase) -- populated straight from
  // data an adapter's discovery-list response already carries (Greenhouse/Lever's board APIs
  // include department/team and a full description in the same call used to build the rest of
  // this object), never a separate fetch and never fabricated. null where the adapter's
  // discovery-list response doesn't carry it (e.g. Workday, whose list endpoint only returns
  // title + a path segment -- department/description require the per-job detail fetch that
  // only happens after a job is already retained).
  department: string | null;
  descriptionSnippet: string | null;
  // The --profile filter active for the run that discovered this job, or null if the run
  // considered all profiles. Distinct from matchedProfiles: this is what was SEARCHED FOR, not
  // what the relevance evaluation actually found.
  searchedProfile: string | null;
  // Evidence from relevance.ts's evaluateRelevance(): which configured keyword phrases /
  // domain-qualifier tokens matched, which lightweight field(s) they matched in, and a
  // human-readable summary. Empty/blank only on a job that predates this phase (never written
  // by current code -- every job that reaches discoveredJobs.jsonl now goes through
  // evaluateRelevance() first).
  matchedKeywords: string[];
  matchedFields: string[];
  relevanceReason: string;
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
  // Overrides which registry file company-careers.ts reads (defaults to the production
  // config/fortune500-registry.json). Used to point a controlled live-validation run at a
  // separate validation-only registry (e.g. config/fortune500-registry.validation.json) --
  // real Fortune 500 companies and validation-only test companies are never mixed in the same
  // file, so a run only ever sees one or the other, never both.
  companyRegistryPath?: string;
}

export interface PortalDiscoveryAdapter {
  source: string;
  discover(context: DiscoveryContext): Promise<void>;
}


export const ADAPTERS = ["greenhouse", "lever", "workday", "generic"] as const;
export type AdapterKind = (typeof ADAPTERS)[number];

export const PROFILES = ["sdet", "security", "cloud", "network"] as const;
export type ProfileKind = (typeof PROFILES)[number];

export interface WorkdayConfig {
  hostname: string;
  tenant: string;
  site: string;
}

export interface GenericSelectors {
  searchInputSelector: string;
  searchButtonSelector: string;
  resultCardSelector: string;
  jobLinkSelector: string;
  nextButtonSelector?: string;
  loadMoreSelector?: string;
  titleSelector: string;
  locationSelector: string;
  descriptionSelector: string;
  applyLinkSelector?: string;
}

export interface CollectSettings {
  maxPagesPerSource: number;
  maxJobsPerSource: number;
  navigationTimeoutMs: number;
  delayBetweenRequestsMs: number;
}

export interface SiteConfig {
  id: string;
  name: string;
  url: string;
  adapter: AdapterKind;
  enabled: boolean;
  greenhouse?: { boardToken?: string };
  lever?: { site?: string };
  workday?: WorkdayConfig;
  generic?: GenericSelectors;
}

export interface RoleConfig {
  id: string;
  profile: ProfileKind;
  keywords: string[];
}

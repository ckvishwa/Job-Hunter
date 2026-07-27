export const ADAPTERS = ["greenhouse", "lever", "workday", "generic"] as const;
export type AdapterKind = (typeof ADAPTERS)[number];

export const PROFILES = ["sdet", "security", "cloud", "network"] as const;
export type ProfileKind = (typeof PROFILES)[number];

export interface SiteConfig {
  id: string;
  name: string;
  url: string;
  adapter: AdapterKind;
  enabled: boolean;
}

export interface RoleConfig {
  id: string;
  profile: ProfileKind;
  keywords: string[];
}

import type { PortalDiscoveryAdapter } from "./types.js";
import { googleJobsDiscoveryAdapter } from "./adapters/google-jobs.js";
import { indeedDiscoveryAdapter } from "./adapters/indeed.js";
import { monsterDiscoveryAdapter } from "./adapters/monster.js";
import { linkedinPublicDiscoveryAdapter } from "./adapters/linkedin-public.js";
import { configurableGenericPortalAdapter } from "./adapters/configurable-generic-portal.js";
import { companyCareersDiscoveryAdapter } from "./adapters/company-careers.js";

const PORTAL_ADAPTERS: PortalDiscoveryAdapter[] = [
  googleJobsDiscoveryAdapter,
  indeedDiscoveryAdapter,
  monsterDiscoveryAdapter,
  linkedinPublicDiscoveryAdapter,
  configurableGenericPortalAdapter,
  companyCareersDiscoveryAdapter,
];

export function resolveDiscoveryAdapter(sourceName: string): PortalDiscoveryAdapter {
  const adapter = PORTAL_ADAPTERS.find(
    (a) => a.source.toLowerCase() === sourceName.toLowerCase(),
  );
  if (adapter) return adapter;

  // Fallback to configurable-generic-portal if it's a generic portal configured in config
  return configurableGenericPortalAdapter;
}

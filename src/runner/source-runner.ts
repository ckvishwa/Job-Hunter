import type { BrowserContext } from "playwright";
import { loadCollectSettings, loadRolesConfig, loadSitesConfig } from "../config/loader.js";
import { closePersistentChrome, launchPersistentChrome, registerShutdownOnSignal } from "../browser/launcher.js";
import { resolveAdapter } from "../adapters/registry.js";
import { loadJobs, updateJobs } from "../storage/jsonl-store.js";
import { mergeJobs } from "../dedup/deduplicator.js";
import type { GenericPlaywrightDeps } from "../adapters/generic-playwright.js";
import type { JobPosting, RoleSearch } from "../adapters/types.js";

export interface CollectPaths {
  sitesConfigPath: string;
  rolesConfigPath: string;
  jobsStorePath: string;
}

export interface CollectFilters {
  siteIds?: string[];
  profileIds?: string[];
  limit?: number;
}

export interface CollectSummary {
  sitesAttempted: number;
  sitesSucceeded: number;
  sitesFailed: number;
  listingsDiscovered: number;
  jdsExtracted: number;
  duplicatesRemoved: number;
  verificationPauses: number;
  jobsWritten: number;
  totalsByProfile: Record<string, number>;
  errors: { site: string; message: string }[];
}

function buildRoleSearches(
  roles: ReturnType<typeof loadRolesConfig>,
  profileFilter?: string[],
): RoleSearch[] {
  const byKeyword = new Map<string, Set<string>>();
  for (const role of roles) {
    if (profileFilter && !profileFilter.includes(role.profile)) continue;
    for (const keyword of role.keywords) {
      const key = keyword.toLowerCase();
      const set = byKeyword.get(key) ?? new Set<string>();
      set.add(role.profile);
      byKeyword.set(key, set);
    }
  }
  return [...byKeyword.entries()].map(([keyword, profiles]) => ({
    keyword,
    profileIds: [...profiles],
  }));
}

export async function runCollect(
  paths: CollectPaths,
  filters: CollectFilters = {},
  launchFn: typeof launchPersistentChrome = launchPersistentChrome,
  closeFn: typeof closePersistentChrome = closePersistentChrome,
): Promise<CollectSummary> {
  const sites = loadSitesConfig(paths.sitesConfigPath);
  const roles = loadRolesConfig(paths.rolesConfigPath);
  const settings = loadCollectSettings(paths.sitesConfigPath);
  const searches = buildRoleSearches(roles, filters.profileIds);

  const summary: CollectSummary = {
    sitesAttempted: 0,
    sitesSucceeded: 0,
    sitesFailed: 0,
    listingsDiscovered: 0,
    jdsExtracted: 0,
    duplicatesRemoved: 0,
    verificationPauses: 0,
    jobsWritten: 0,
    totalsByProfile: {},
    errors: [],
  };

  const targetSites = sites.filter(
    (site) => site.enabled && (!filters.siteIds || filters.siteIds.includes(site.id)),
  );

  let context: BrowserContext | undefined;
  let unregisterShutdown: (() => void) | undefined;
  async function ensureContext(): Promise<BrowserContext> {
    if (!context) {
      context = await launchFn();
      unregisterShutdown = registerShutdownOnSignal(context);
    }
    return context;
  }

  const collected: JobPosting[] = [];

  // The persistent Chrome context (if the generic adapter ever launched one) must be
  // closed once the whole run is done, or every collect invocation leaks a Chrome
  // process. try/finally here only closes it after all sites have been processed --
  // it does not affect pauseForVerification, which keeps the same context open across
  // a mid-run pause on stdin.
  try {
    for (const site of targetSites) {
      summary.sitesAttempted += 1;
      try {
        let genericDeps: GenericPlaywrightDeps | undefined;
        if (site.adapter === "generic") {
          genericDeps = {
            context: await ensureContext(),
            onVerificationPause: () => {
              summary.verificationPauses += 1;
            },
          };
        }

        const adapter = resolveAdapter(site, genericDeps);
        const discovered = await adapter.discoverJobs(site, searches, settings);
        summary.listingsDiscovered += discovered.length;

        for (const job of discovered) {
          const rawDetail = await adapter.fetchJobDetails(job, site, settings);
          summary.jdsExtracted += 1;
          const normalized = adapter.normalize(rawDetail, site, job.matchedProfiles);
          collected.push(normalized);
          if (adapter.fetchesPerJob && settings.delayBetweenRequestsMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, settings.delayBetweenRequestsMs));
          }
        }

        summary.sitesSucceeded += 1;
      } catch (err) {
        summary.sitesFailed += 1;
        summary.errors.push({ site: site.id, message: (err as Error).message });
      }
    }

    // `limit` caps how many newly-collected jobs get merged in this run — it must never
    // truncate the persisted store's pre-existing content (see Task 11 review fix).
    const cappedCollected =
      typeof filters.limit === "number" ? collected.slice(0, filters.limit) : collected;

    for (const job of cappedCollected) {
      for (const profileId of job.matchedProfiles) {
        summary.totalsByProfile[profileId] = (summary.totalsByProfile[profileId] ?? 0) + 1;
      }
    }

    const nowIso = new Date().toISOString();
    const baseline = loadJobs(paths.jobsStorePath);
    summary.duplicatesRemoved = baseline.length + cappedCollected.length - mergeJobs(baseline, cappedCollected, nowIso).length;
    const merged = await updateJobs(paths.jobsStorePath, (current) => mergeJobs(current, cappedCollected, nowIso));
    summary.jobsWritten = merged.length;

    return summary;
  } finally {
    unregisterShutdown?.();
    if (context) {
      await closeFn(context);
    }
  }
}

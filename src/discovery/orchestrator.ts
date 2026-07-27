import type { BrowserContext } from "playwright";
import { launchPersistentChrome } from "../browser/launcher.js";
import { loadCollectSettings, loadPortalsConfig, loadRolesConfig, loadSitesConfig } from "../config/loader.js";
import { getOrCreateCheckpoint, loadCheckpoints, saveCheckpoints } from "./checkpoints.js";
import { resolveDiscoveryAdapter } from "./registry.js";
import { appendDiscoveredJobs, loadJobs, saveJobs } from "../storage/jsonl-store.js";
import { mergeJobs } from "../dedup/deduplicator.js";
import { PostingResolver } from "../resolver/posting-resolver.js";
import type { DiscoveredJobLite, DiscoveryContext } from "./types.js";
import type { JobPosting } from "../adapters/types.js";
import type { SiteConfig } from "../types.js";
import { matchProfiles } from "../adapters/match-profiles.js";
import path from "node:path";

export interface DiscoverFilters {
  profileIds?: string[];
  sources?: string[];
  location?: string;
  limit?: number;
}

export interface DiscoverSummary {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  listingsDiscovered: number;
  jdsExtracted: number;
  duplicatesRemoved: number;
  jobsWritten: number;
  totalsByProfile: Record<string, number>;
  errors: { source: string; message: string }[];
}

export async function runDiscover(
  paths: {
    sitesConfigPath: string;
    rolesConfigPath: string;
    portalsConfigPath: string;
    discoveredJobsPath: string;
    jobsStorePath: string;
    checkpointsPath: string;
  },
  filters: DiscoverFilters = {},
  launchFn: typeof launchPersistentChrome = launchPersistentChrome,
): Promise<DiscoverSummary> {
  const roles = loadRolesConfig(paths.rolesConfigPath);
  const settings = loadCollectSettings(paths.sitesConfigPath);
  const sites = loadSitesConfig(paths.sitesConfigPath);
  const portalsConfig = loadPortalsConfig(paths.portalsConfigPath);

  const searchLocation = filters.location || "United States";
  const limit = filters.limit;

  // Determine target sources: config/portals.yml-driven portals (config-driven, not
  // hardcoded -- an entry only runs if its portals.yml `enabled: true`) + company-careers +
  // generic portals in sites.yml. Two distinct "generic" concepts exist (see design spec
  // §11): sites.yml's SiteConfig.generic (company career-page selectors) and portals.yml's
  // type: "generic" entries (generic job-search portals) are kept as separate source lists
  // so their resulting `source` strings/config lookups never get conflated, even though both
  // ultimately resolve to configurableGenericPortalAdapter via registry.ts's unmatched-id
  // fallback.
  const standardPortalIds = portalsConfig.filter((p) => p.enabled && p.type !== "generic").map((p) => p.id);
  const portalsYmlGenericIds = portalsConfig.filter((p) => p.enabled && p.type === "generic").map((p) => p.id);
  const companyCareers = "company-careers";

  const genericPortals = sites
    .filter((site) => site.enabled && site.adapter === "generic")
    .map((site) => site.id);

  let targetSources = [...standardPortalIds, companyCareers, ...genericPortals, ...portalsYmlGenericIds];

  if (filters.sources && filters.sources.length > 0) {
    targetSources = targetSources.filter((s) =>
      filters.sources!.some(
        (fs) =>
          fs.toLowerCase() === s.toLowerCase() ||
          (fs === "generic" && (genericPortals.includes(s) || portalsYmlGenericIds.includes(s))),
      ),
    );
  }

  // Determine target keywords and profiles
  const enabledRoles = roles.filter(
    (role) => !filters.profileIds || filters.profileIds.includes(role.profile),
  );

  const keywordsByProfile = new Map<string, string[]>();
  for (const role of enabledRoles) {
    keywordsByProfile.set(role.profile, role.keywords);
  }

  const roleSearches = enabledRoles.map((role) => ({
    keyword: role.keywords[0] || "",
    profileIds: [role.profile],
  }));

  // Summary object
  const summary: DiscoverSummary = {
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    listingsDiscovered: 0,
    jdsExtracted: 0,
    duplicatesRemoved: 0,
    jobsWritten: 0,
    totalsByProfile: {},
    errors: [],
  };

  // Launch Playwright Chrome context
  let context: BrowserContext | undefined;
  async function ensureContext(): Promise<BrowserContext> {
    if (!context) {
      context = await launchFn(undefined, { headless: false });
    }
    return context;
  }

  const checkpoints = loadCheckpoints(paths.checkpointsPath);
  const newlyDiscovered: DiscoveredJobLite[] = [];

  try {
    const playwrightContext = await ensureContext();
    const page = await playwrightContext.newPage();

    // PHASE 1: Portal Job Discovery
    for (const source of targetSources) {
      summary.sourcesAttempted += 1;
      let sourceSuccess = true;

      // Find the site configuration if it's a generic portal (sites.yml-driven)
      const siteConfig = sites.find((s) => s.id === source);
      // Find the matching portals.yml entry (standard portal types + portals.yml-driven
      // generic entries); undefined for company-careers and sites.yml-driven generic portals.
      const portalConfig = portalsConfig.find((p) => p.id === source);

      // Iterate over each target role/keyword
      for (const role of enabledRoles) {
        for (const keyword of role.keywords) {
          const checkpoint = getOrCreateCheckpoint(checkpoints, source, keyword, searchLocation);

          if (checkpoint.completed) {
            console.log(`[orchestrator] Checkpoint completed for ${source}::${keyword}::${searchLocation}. Skipping.`);
            continue;
          }

          console.log(`[orchestrator] Starting discovery for source="${source}", keyword="${keyword}", location="${searchLocation}"`);

          try {
            const adapter = resolveDiscoveryAdapter(source);
            
            // Build the DiscoveryContext
            const discoveryCtx: DiscoveryContext = {
              page,
              keyword,
              location: searchLocation,
              settings,
              checkpoint,
              onPageProcessed: async (jobs, nextPageNum) => {
                // Populate matchedProfiles
                for (const job of jobs) {
                  // Profile matching uses the title and the role configurations
                  const mappedSearches = enabledRoles.map((r) => ({
                    keyword: keyword,
                    profileIds: [r.profile],
                  }));
                  job.matchedProfiles = matchProfiles(job.title, mappedSearches);
                  if (job.matchedProfiles.length === 0) {
                    // Fallback to the current role's profile
                    job.matchedProfiles = [role.profile];
                  }
                  newlyDiscovered.push(job);
                }

                // Append newly discovered jobs page-by-page
                appendDiscoveredJobs(paths.discoveredJobsPath, jobs);
                summary.listingsDiscovered += jobs.length;

                // Update checkpoint
                checkpoint.lastPage = nextPageNum;
                checkpoint.lastUpdated = new Date().toISOString();
                saveCheckpoints(paths.checkpointsPath, checkpoints);
              },
              siteConfig,
              portalConfig,
              profileIds: [role.profile],
            };

            await adapter.discover(discoveryCtx);

            // Mark completed
            checkpoint.completed = true;
            saveCheckpoints(paths.checkpointsPath, checkpoints);

          } catch (err) {
            sourceSuccess = false;
            console.error(`[orchestrator] Failure on ${source} for keyword "${keyword}": ${(err as Error).message}`);
            summary.errors.push({ source: `${source}::${keyword}`, message: (err as Error).message });
          }
        }
      }

      if (sourceSuccess) {
        summary.sourcesSucceeded += 1;
      } else {
        summary.sourcesFailed += 1;
      }
    }

    await page.close();

    // PHASE 2: Official Posting Resolution and JD Extraction
    console.log(`[orchestrator] Discovery phase complete. Discovered ${newlyDiscovered.length} job(s) in this run.`);

    // Slice to the requested limit. Limit applies after discovery, not before searching.
    const jobsToResolve = typeof limit === "number" ? newlyDiscovered.slice(0, limit) : newlyDiscovered;
    console.log(`[orchestrator] Resolving details for ${jobsToResolve.length} job(s) (Limit: ${limit ?? "None"}).`);

    const resolver = new PostingResolver();
    const resolvedJobs: JobPosting[] = [];

    for (const job of jobsToResolve) {
      try {
        console.log(`[orchestrator] Resolving job: "${job.title}" at "${job.company}" (${job.resultUrl})`);
        const resolved = await resolver.resolve(job, playwrightContext);
        if (resolved) {
          resolvedJobs.push(resolved);
          summary.jdsExtracted += 1;

          // Apply delay between requests to avoid rate limits
          if (settings.delayBetweenRequestsMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, settings.delayBetweenRequestsMs));
          }
        }
      } catch (err) {
        console.error(`[orchestrator] Error resolving job "${job.title}": ${(err as Error).message}`);
      }
    }

    // PHASE 3: Deduplication & Saving
    const existingJobs = loadJobs(paths.jobsStorePath);
    const now = new Date().toISOString();
    const merged = mergeJobs(existingJobs, resolvedJobs, now);

    summary.duplicatesRemoved = existingJobs.length + resolvedJobs.length - merged.length;
    saveJobs(paths.jobsStorePath, merged);
    summary.jobsWritten = merged.length;

    // Track profile totals for the newly written jobs
    for (const job of resolvedJobs) {
      for (const profile of job.matchedProfiles) {
        summary.totalsByProfile[profile] = (summary.totalsByProfile[profile] ?? 0) + 1;
      }
    }

  } finally {
    if (context) {
      await context.close();
    }
  }

  return summary;
}

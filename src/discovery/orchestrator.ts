import type { BrowserContext } from "playwright";
import {
  closePersistentChrome,
  launchPersistentChrome,
  registerShutdownOnSignal,
  uniqueChromeProfileDir,
} from "../browser/launcher.js";
import { loadCollectSettings, loadPortalsConfig, loadRolesConfig, loadSitesConfig } from "../config/loader.js";
import { getOrCreateCheckpoint, loadCheckpoints, resetCheckpoints, saveCheckpoints } from "./checkpoints.js";
import { resolveDiscoveryAdapter } from "./registry.js";
import { appendDiscoveredJobs, loadJobs, saveJobs } from "../storage/jsonl-store.js";
import { mergeJobs } from "../dedup/deduplicator.js";
import { PostingResolver } from "../resolver/posting-resolver.js";
import type { DiscoveredJobLite, DiscoveryContext } from "./types.js";
import type { JobPosting } from "../adapters/types.js";
import type { SiteConfig } from "../types.js";
import { matchProfiles } from "../adapters/match-profiles.js";
import { buildSummary, type DiscoveryRunSummary, type RawDiscoveryCounters } from "./report.js";
import path from "node:path";

// The resolver's own placeholder-fallback string (posting-resolver.ts's final `details` when
// neither the ATS adapter path nor the DOM-scrape fallback produced anything) -- the only
// current, honest signal that a discovery could not be properly resolved. Kept here as a
// single source of truth for the officialPostingsResolved/unresolvedDiscoveries split below.
const UNRESOLVED_PLACEHOLDER_PREFIX = "Job posting found on ";

export interface DiscoverFilters {
  profileIds?: string[];
  sources?: string[];
  location?: string;
  limit?: number;
  company?: string;
  // Checkpoints are always consulted/retried on every run already (no non-resuming mode
  // exists) -- this flag is accepted for explicit-intent CLI callers but doesn't change
  // orchestrator behavior.
  resume?: boolean;
  // true = clear all checkpoints; string = clear only that source's checkpoints. Applied
  // before the run starts (see below).
  resetCheckpoint?: string | true;
  dryRun?: boolean;
  // Launch a fresh, unused Chrome profile for this run instead of the shared persistent one
  // -- for controlled live-validation runs that need to avoid contending with another run's
  // profile lock. Not for normal usage: the shared profile's persistence (cookies/logins) is
  // what makes manual-verification runs useful across invocations.
  isolatedProfile?: boolean;
  // Overrides the Fortune 500 registry file company-careers.ts and the resolver's
  // company-matching both read (defaults to config/fortune500-registry.json). Points a
  // controlled live-validation run at a separate validation-only registry instead --
  // real ranked companies and validation-only test companies are never mixed in one file.
  registryPath?: string;
}

function emptyCounters(): RawDiscoveryCounters {
  return {
    sourcesAttempted: 0,
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    companiesAttempted: 0,
    keywordsSearched: 0,
    pagesProcessed: 0,
    listingsDiscovered: 0,
    officialPostingsResolved: 0,
    unresolvedDiscoveries: 0,
    duplicatesMerged: 0,
    jdsExtracted: 0,
    verificationPauses: 0,
    jobsByProfile: {},
    jobsBySource: {},
    jobsWritten: 0,
    errors: [],
  };
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
  closeFn: typeof closePersistentChrome = closePersistentChrome,
): Promise<DiscoveryRunSummary> {
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

  // Raw counters, accumulated through the run and assembled into the reporting shape via
  // buildSummary() (Task 15) -- once at the very end of a full run, or immediately below for
  // the dry-run early return, so both paths produce the same DiscoveryRunSummary shape.
  const counters = emptyCounters();

  if (filters.dryRun) {
    counters.sourcesAttempted = targetSources.length;
    const totalIterations = targetSources.length * enabledRoles.reduce((n, role) => n + role.keywords.length, 0);
    console.log(
      `[orchestrator] Dry run: would attempt ${targetSources.length} source(s) x ${enabledRoles.length} role(s) ` +
        `(${totalIterations} source/keyword iteration(s) total). No browser launched, no data written.`,
    );
    if (filters.resetCheckpoint) {
      // Checkpoint loading (and the reset it would trigger) happens after this return --
      // a dry run never touches disk state, so --reset-checkpoint combined with --dry-run is
      // silently ignored rather than performed. Told explicitly here so it isn't a silent
      // surprise: rerun without --dry-run to actually apply the reset.
      console.log(`[orchestrator] Dry run: --reset-checkpoint was NOT applied (dry runs never write to disk). Rerun without --dry-run to apply it.`);
    }
    // Dry run never attempts anything else -- keywordsSearched/pagesProcessed/etc. stay at
    // their zero defaults from emptyCounters(). Routed through buildSummary anyway (rather
    // than a hand-built shape) so both return paths always produce the same structure.
    return buildSummary(counters);
  }

  // Launch Playwright Chrome context. isolatedProfile picks a fresh, unused profile dir
  // (avoids contending with another run's profile lock); omitted (undefined) uses the shared
  // persistent profile, launchPersistentChrome's own default. Whichever value is chosen here
  // is reused for closePersistentChrome below -- both must agree on the exact profile so
  // shutdown matches the process that was actually launched.
  const profileDir = filters.isolatedProfile ? uniqueChromeProfileDir() : undefined;
  let context: BrowserContext | undefined;
  let unregisterShutdown: (() => void) | undefined;
  async function ensureContext(): Promise<BrowserContext> {
    if (!context) {
      context = await launchFn(profileDir, { headless: false });
      unregisterShutdown = registerShutdownOnSignal(context, profileDir);
    }
    return context;
  }

  let checkpoints = loadCheckpoints(paths.checkpointsPath);
  if (filters.resetCheckpoint) {
    checkpoints = resetCheckpoints(
      checkpoints,
      filters.resetCheckpoint === true ? undefined : filters.resetCheckpoint,
    );
    // Save immediately so a crash mid-run doesn't lose the reset.
    saveCheckpoints(paths.checkpointsPath, checkpoints);
  }
  const newlyDiscovered: DiscoveredJobLite[] = [];

  try {
    const playwrightContext = await ensureContext();
    const page = await playwrightContext.newPage();

    // PHASE 1: Portal Job Discovery
    for (const source of targetSources) {
      counters.sourcesAttempted += 1;
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
          counters.keywordsSearched += 1;

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
                counters.listingsDiscovered += jobs.length;
                // Fires once per portal page AND once per company in company-careers.ts --
                // an honest, already-existing "processing unit" signal, not literally a
                // count of browser pages navigated.
                counters.pagesProcessed += 1;

                // Update checkpoint
                checkpoint.lastPage = nextPageNum;
                checkpoint.lastUpdated = new Date().toISOString();
                saveCheckpoints(paths.checkpointsPath, checkpoints);
              },
              siteConfig,
              portalConfig,
              profileIds: [role.profile],
              companyFilter: filters.company,
              companyRegistryPath: filters.registryPath,
              onVerificationPause: () => {
                counters.verificationPauses += 1;
              },
              onCompanyProcessed: () => {
                counters.companiesAttempted += 1;
              },
            };

            await adapter.discover(discoveryCtx);

            // Mark completed -- except for company-careers under an active --company filter:
            // a filtered run only ever attempts a subset of the registry, and company-careers
            // itself deliberately does not throw for companies it merely skipped (not
            // attempted, not failed). Marking the whole checkpoint completed here regardless
            // would make the orchestrator's own completed-checkpoint gate (above) skip
            // company-careers on every future run -- filtered or not -- permanently stranding
            // every company that was never targeted by this run's filter. Every other source
            // is unaffected by filters.company (only company-careers reads it at all).
            if (!(source === "company-careers" && filters.company)) {
              checkpoint.completed = true;
            }
            saveCheckpoints(paths.checkpointsPath, checkpoints);

          } catch (err) {
            sourceSuccess = false;
            console.error(`[orchestrator] Failure on ${source} for keyword "${keyword}": ${(err as Error).message}`);
            counters.errors.push({ source: `${source}::${keyword}`, message: (err as Error).message });
          }
        }
      }

      if (sourceSuccess) {
        counters.sourcesSucceeded += 1;
      } else {
        counters.sourcesFailed += 1;
      }
    }

    await page.close();

    // PHASE 2: Official Posting Resolution and JD Extraction
    console.log(`[orchestrator] Discovery phase complete. Discovered ${newlyDiscovered.length} job(s) in this run.`);

    // Slice to the requested limit. Limit applies after discovery, not before searching.
    const jobsToResolve = typeof limit === "number" ? newlyDiscovered.slice(0, limit) : newlyDiscovered;
    console.log(`[orchestrator] Resolving details for ${jobsToResolve.length} job(s) (Limit: ${limit ?? "None"}).`);

    const resolver = filters.registryPath ? new PostingResolver(filters.registryPath) : new PostingResolver();
    const resolvedJobs: JobPosting[] = [];

    for (const job of jobsToResolve) {
      try {
        console.log(`[orchestrator] Resolving job: "${job.title}" at "${job.company}" (${job.resultUrl})`);
        const resolved = await resolver.resolve(job, playwrightContext);
        if (resolved) {
          resolvedJobs.push(resolved);
          counters.jdsExtracted += 1;

          // resolve() itself never returns null (confirmed Task 10) -- the only current,
          // honest signal that a discovery could not be properly resolved is whether the
          // resolver fell all the way through to its own placeholder-fallback descriptionText.
          if (resolved.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)) {
            counters.unresolvedDiscoveries += 1;
          } else {
            counters.officialPostingsResolved += 1;
          }

          // Apply delay between requests to avoid rate limits
          if (settings.delayBetweenRequestsMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, settings.delayBetweenRequestsMs));
          }
        }
      } catch (err) {
        console.error(`[orchestrator] Error resolving job "${job.title}": ${(err as Error).message}`);
        // A resolve() call that itself throws (caught here) also counts as unresolved --
        // the discovery exists but nothing usable came out of resolution.
        counters.unresolvedDiscoveries += 1;
      }
    }

    // PHASE 3: Deduplication & Saving
    const existingJobs = loadJobs(paths.jobsStorePath);
    const now = new Date().toISOString();
    const merged = mergeJobs(existingJobs, resolvedJobs, now);

    counters.duplicatesMerged = existingJobs.length + resolvedJobs.length - merged.length;
    saveJobs(paths.jobsStorePath, merged);
    counters.jobsWritten = merged.length;

    // Track profile/source totals for the newly written jobs
    for (const job of resolvedJobs) {
      for (const profile of job.matchedProfiles) {
        counters.jobsByProfile[profile] = (counters.jobsByProfile[profile] ?? 0) + 1;
      }
      counters.jobsBySource[job.source] = (counters.jobsBySource[job.source] ?? 0) + 1;
    }

  } finally {
    // Runs on normal completion, a caught error, or any other exit from the try block above.
    // closePersistentChrome closes pages/context and bounded-waits for the OS process to
    // actually exit (force-killing it if needed) rather than trusting context.close() alone --
    // see launcher.ts for why. unregisterShutdown avoids a stale SIGINT handler trying to
    // close an already-closed context if the process later receives one.
    unregisterShutdown?.();
    if (context) {
      await closeFn(context, profileDir);
    }
  }

  return buildSummary(counters);
}

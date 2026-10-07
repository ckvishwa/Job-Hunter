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
import { appendDiscoveredJobs, appendJobFailures, loadJobs, saveJobs } from "../storage/jsonl-store.js";
import { mergeJobs } from "../dedup/deduplicator.js";
import { canonicalizeUrl } from "../dedup/canonicalize-url.js";
import { buildJobFailure, evaluatePersistable, type JobFailureCode } from "../domain/canonical-job.js";
import { PostingResolver } from "../resolver/posting-resolver.js";
import type { DiscoveredJobLite, DiscoveryContext } from "./types.js";
import type { JobPosting } from "../adapters/types.js";
import { evaluateRelevance } from "./relevance.js";
import { runResolutionPhase, UNRESOLVED_PLACEHOLDER_PREFIX } from "./resolve-phase.js";
import { buildSummary, type DiscoveryRunSummary, type RawDiscoveryCounters } from "./report.js";
import { randomBytes } from "node:crypto";
import path from "node:path";

const DEFAULT_RESOLVE_CONCURRENCY = 3;
const DEFAULT_RESOLVE_JOB_TIMEOUT_MS = 45_000;
const RESOLVE_PROGRESS_EVERY = 10;

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
  // CLI-only convenience (src/discovery/cli.ts): output directory for this run.
  dataDir?: string;
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
  // Bounded resolution behavior (Profile Relevance phase, Task 4). Undefined = the module's
  // own defaults (concurrency 3, 45s per-job timeout, no separate total-timeout cap).
  resolveConcurrency?: number;
  resolveJobTimeoutMs?: number;
  resolveTotalTimeoutMs?: number;
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
    listingsEvaluated: 0,
    discoveriesRejected: 0,
    relevantRetained: 0,
    retainedByProfile: {},
    resolutionsAttempted: 0,
    resolutionsSucceeded: 0,
    resolutionsTimedOut: 0,
    officialPostingsResolved: 0,
    unresolvedDiscoveries: 0,
    duplicatesMerged: 0,
    jdsExtracted: 0,
    verificationPauses: 0,
    jobsByProfile: {},
    jobsBySource: {},
    jobsWritten: 0,
    discoveryTimeMs: 0,
    resolutionTimeMs: 0,
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
    // Typed rejection log (see src/domain/canonical-job.ts JobFailure). Defaults to
    // job-failures.jsonl next to the jobs store.
    failuresPath?: string;
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
  const allPortalIds = portalsConfig.filter((p) => p.type !== "generic").map((p) => p.id);
  const allPortalsYmlGenericIds = portalsConfig.filter((p) => p.type === "generic").map((p) => p.id);
  const enabledPortalIds = portalsConfig.filter((p) => p.enabled && p.type !== "generic").map((p) => p.id);
  const enabledPortalsYmlGenericIds = portalsConfig.filter((p) => p.enabled && p.type === "generic").map((p) => p.id);
  const companyCareers = "company-careers";

  const allGenericPortals = sites.filter((site) => site.adapter === "generic").map((site) => site.id);
  const enabledGenericPortals = sites
    .filter((site) => site.enabled && site.adapter === "generic")
    .map((site) => site.id);

  let targetSources: string[];

  if (filters.sources && filters.sources.length > 0) {
    // Every known source id, regardless of its portals.yml/sites.yml `enabled` flag -- an
    // explicit --source is how a controlled/validation run opts a disabled entry in without
    // permanently flipping the config file. Unknown ids fail loudly instead of silently
    // running nothing (the previous behavior: an unrecognized/disabled id just vanished from
    // targetSources with no signal at all).
    const allKnownSourceIds = new Set([
      ...allPortalIds,
      companyCareers,
      ...allGenericPortals,
      ...allPortalsYmlGenericIds,
    ]);
    for (const requested of filters.sources) {
      const isKnown = [...allKnownSourceIds].some((id) => id.toLowerCase() === requested.toLowerCase());
      if (!isKnown && requested.toLowerCase() !== "generic") {
        throw new Error(
          `Unknown --source "${requested}". Known sources: ${[...allKnownSourceIds].sort().join(", ")} ` +
            `(or "generic" to match every generic-portal entry).`,
        );
      }
    }
    const everyKnownSource = [...allPortalIds, companyCareers, ...allGenericPortals, ...allPortalsYmlGenericIds];
    targetSources = everyKnownSource.filter((s) =>
      filters.sources!.some(
        (fs) =>
          fs.toLowerCase() === s.toLowerCase() ||
          (fs.toLowerCase() === "generic" && (allGenericPortals.includes(s) || allPortalsYmlGenericIds.includes(s))),
      ),
    );
  } else {
    // No explicit --source: only ever run what portals.yml/sites.yml itself opts in.
    targetSources = [...enabledPortalIds, companyCareers, ...enabledGenericPortals, ...enabledPortalsYmlGenericIds];
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
    const discoveryStart = Date.now();
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
                counters.listingsDiscovered += jobs.length;

                // Profile Relevance phase: evaluate every discovered listing against ALL 4
                // profiles' configured keywords + domain terms (relevance.ts) BEFORE it's ever
                // written to disk or considered for resolution -- an unrelated listing (e.g. an
                // "Account Executive" role a company-wide board dump surfaces regardless of
                // which keyword search found it) is rejected here, not silently tagged with
                // whatever profile happened to be searched at the time.
                const retained: DiscoveredJobLite[] = [];
                for (const job of jobs) {
                  counters.listingsEvaluated += 1;
                  const evaluation = evaluateRelevance(
                    { title: job.title, department: job.department, location: job.location, descriptionSnippet: job.descriptionSnippet },
                    roles,
                  );

                  // With an active --profile filter, only retain jobs relevant to one of the
                  // REQUESTED profiles -- a job that's genuinely relevant to some OTHER profile
                  // (e.g. "Network Engineer" surfacing during a --profile sdet run) is still
                  // correctly rejected for this run, matching "retain only <profile>-related
                  // candidates" rather than "retain anything relevant to any profile."
                  const requestedMatches = filters.profileIds?.length
                    ? evaluation.matchedProfiles.filter((p) => filters.profileIds!.includes(p))
                    : evaluation.matchedProfiles;

                  if (!evaluation.matched || requestedMatches.length === 0) {
                    counters.discoveriesRejected += 1;
                    continue; // Never store the full job for a rejected discovery.
                  }

                  // Primary = the first REQUESTED-and-matched profile (if --profile was given,
                  // so the profile the run was actually searching for is what gets reported as
                  // primary) else relevance.ts's own config-order primary.
                  const ordered = filters.profileIds?.length
                    ? [...requestedMatches, ...evaluation.matchedProfiles.filter((p) => !requestedMatches.includes(p))]
                    : evaluation.matchedProfiles;

                  job.matchedProfiles = ordered;
                  job.matchedKeywords = evaluation.matchedKeywords;
                  job.matchedFields = evaluation.matchedFields;
                  job.relevanceReason = evaluation.relevanceReason;
                  job.searchedProfile = filters.profileIds?.length ? filters.profileIds.join(",") : null;

                  counters.relevantRetained += 1;
                  const primary = ordered[0]!;
                  counters.retainedByProfile[primary] = (counters.retainedByProfile[primary] ?? 0) + 1;

                  retained.push(job);
                  newlyDiscovered.push(job);
                }

                // Only retained (relevant) jobs are ever written to discoveredJobs.jsonl --
                // rejected discoveries leave no trace beyond the rejection counter above.
                appendDiscoveredJobs(paths.discoveredJobsPath, retained);
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
    counters.discoveryTimeMs = Date.now() - discoveryStart;

    // PHASE 2: Official Posting Resolution and JD Extraction
    console.log(`[orchestrator] Discovery phase complete. Discovered ${newlyDiscovered.length} job(s) in this run.`);

    // Slice to the requested limit. newlyDiscovered only ever contains RETAINED (relevant)
    // jobs -- rejected discoveries never reach it (see onPageProcessed above) -- so the limit
    // is applied after relevance filtering and before resolution, exactly as required: it
    // bounds this run's candidates, never touches existing JSONL data (jobs.jsonl only ever
    // grows via mergeJobs below, discoveredJobs.jsonl is append-only), and slicing a
    // deterministically-ordered array keeps the result deterministic and idempotent across
    // reruns of the same input.
    // company-careers runs the whole board once per role keyword, so the same listing is
    // discovered several times in one run (each keyword has its own checkpoint). Resolve each
    // distinct listing once: key = employer + ATS job id, else the canonical listing URL.
    const seenListings = new Set<string>();
    const distinctDiscovered = newlyDiscovered.filter((job) => {
      const key = job.sourceJobId
        ? `${job.company.toLowerCase()}::${job.sourceJobId}`
        : `url::${canonicalizeUrl(job.resultUrl)}`;
      if (seenListings.has(key)) return false;
      seenListings.add(key);
      return true;
    });
    const jobsToResolve = typeof limit === "number" ? distinctDiscovered.slice(0, limit) : distinctDiscovered;
    console.log(`[orchestrator] Resolving details for ${jobsToResolve.length} job(s) (Limit: ${limit ?? "None"}).`);

    const resolver = filters.registryPath ? new PostingResolver(filters.registryPath) : new PostingResolver();

    // Captured ONCE, before any resolution/incremental-saving happens -- the true pre-run
    // baseline. Reused (never reloaded from disk mid-phase) for every incremental save AND the
    // final Phase 3 merge below, so duplicatesMerged is computed against what was on disk
    // BEFORE this run's own resolutions, not re-inflated by this run's own incremental writes
    // (reloading fresh inside persistIncrementally would make Phase 3 see its own already-
    // written jobs as "existing," miscounting every one of them as a duplicate).
    const existingJobsBeforeRun = loadJobs(paths.jobsStorePath);

    // Bounded resolution (Task 4): concurrency-limited, per-job and (optionally) total
    // timeouts, so one slow/stuck job (a real ~12-minute stall was observed live) can never
    // block the rest of a run. Incrementally persisted below via onJobResolved -- an interrupt
    // mid-resolution loses at most the one job in flight past the last completed save, not the
    // whole phase's progress.
    // Only postings that pass the canonical gate (official employer, real JD, valid schema)
    // are ever persisted to jobs.jsonl; every rejection becomes a typed JobFailure instead.
    const resolvedJobsSoFar: JobPosting[] = [];
    const failuresPath = paths.failuresPath ?? path.join(path.dirname(paths.jobsStorePath), "job-failures.jsonl");
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
    let failureCount = 0;
    const recordFailure = (code: JobFailureCode, detail: string, job: DiscoveredJobLite, targetUrl: string): void => {
      failureCount += 1;
      appendJobFailures(failuresPath, [
        buildJobFailure({
          code,
          stage: "resolution",
          runId,
          targetUrl,
          company: job.company,
          title: job.title,
          sourceJobId: job.sourceJobId,
          detail,
        }),
      ]);
      console.error(`[orchestrator] Rejected "${job.title}" at "${job.company}": ${code} - ${detail}`);
    };
    let saveChain: Promise<void> = Promise.resolve();
    const persistIncrementally = (): Promise<void> => {
      // Chained onto the previous save so concurrent workers' onJobResolved calls never
      // interleave a read-modify-write of jobs.jsonl (an unserialized second save, computed
      // from a stale read, could silently discard the first save's job).
      saveChain = saveChain.then(() => {
        const merged = mergeJobs(existingJobsBeforeRun, resolvedJobsSoFar, new Date().toISOString());
        saveJobs(paths.jobsStorePath, merged);
      });
      return saveChain;
    };

    const resolutionStart = Date.now();
    const resolvePhaseResult = await runResolutionPhase(
      jobsToResolve,
      (job) => {
        console.log(`[orchestrator] Resolving job: "${job.title}" at "${job.company}" (${job.resultUrl})`);
        return resolver.resolve(job, playwrightContext);
      },
      {
        concurrency: filters.resolveConcurrency ?? DEFAULT_RESOLVE_CONCURRENCY,
        perJobTimeoutMs: filters.resolveJobTimeoutMs ?? DEFAULT_RESOLVE_JOB_TIMEOUT_MS,
        totalTimeoutMs: filters.resolveTotalTimeoutMs,
        progressEvery: RESOLVE_PROGRESS_EVERY,
        delayBetweenRequestsMs: settings.delayBetweenRequestsMs,
        log: (message) => console.log(message),
        onJobResolved: async (posting, _index, _total, outcome, job) => {
          if (outcome === "timedOut") {
            recordFailure("RESOLUTION_TIMEOUT", "Resolution exceeded the per-job timeout.", job, job.resultUrl);
            return;
          }
          if (outcome === "errored" && posting.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)) {
            const reason = posting.descriptionText.split("Reason:")[1]?.trim() ?? "resolver produced no posting";
            recordFailure("RESOLUTION_ERROR", reason, job, job.resultUrl);
            return;
          }
          const gate = evaluatePersistable(posting);
          if (!gate.ok) {
            recordFailure(gate.failure.code as JobFailureCode, gate.failure.detail, job, posting.canonicalUrl || job.resultUrl);
            return;
          }
          resolvedJobsSoFar.push(gate.posting);
          await persistIncrementally();
        },
      },
    );
    await saveChain; // make sure the last incremental save has actually landed before Phase 3
    counters.resolutionTimeMs = Date.now() - resolutionStart;
    counters.resolutionsAttempted = resolvePhaseResult.attempted;
    counters.resolutionsSucceeded = resolvePhaseResult.succeeded;
    counters.resolutionsTimedOut = resolvePhaseResult.timedOut;
    counters.unresolvedDiscoveries = failureCount;
    counters.officialPostingsResolved = resolvedJobsSoFar.length;
    counters.jdsExtracted = resolvedJobsSoFar.length;
    const resolvedJobs = resolvedJobsSoFar;

    // PHASE 3: Deduplication & Saving. Authoritative final merge/save/counters, against the
    // SAME pre-run baseline the incremental saves above used -- idempotent with (and
    // supersedes) whatever they already wrote, so it's correct whether or not this point is
    // ever reached, and duplicatesMerged reflects genuine pre-existing duplicates rather than
    // this run's own incremental writes.
    const now = new Date().toISOString();
    const merged = mergeJobs(existingJobsBeforeRun, resolvedJobs, now);

    counters.duplicatesMerged = existingJobsBeforeRun.length + resolvedJobs.length - merged.length;
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

import type { DiscoveredJobLite } from "./types.js";
import type { JobPosting } from "../adapters/types.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

// The resolver's own placeholder-fallback string (posting-resolver.ts's final `details` when
// neither the ATS adapter path nor the DOM-scrape fallback produced anything) -- reused here so
// every "couldn't get a real JD" outcome (extraction failure inside resolve(), a per-job
// timeout, or resolve() throwing) is classified as unresolved by the SAME prefix check,
// wherever the caller inspects descriptionText.
export const UNRESOLVED_PLACEHOLDER_PREFIX = "Job posting found on ";

export interface ResolvePhaseOptions {
  // Bounded resolution behavior (Profile Relevance phase, Task 4) -- exists because a single
  // slow/stuck job (a real ~12-minute stall was observed live against AHEAD's Lever
  // verification page) must never be able to block the rest of a run indefinitely.
  concurrency: number;
  perJobTimeoutMs: number;
  // undefined = no separate cap; perJobTimeoutMs already bounds the worst case to roughly
  // (jobs.length / concurrency) * perJobTimeoutMs, which is usually enough on its own.
  totalTimeoutMs?: number;
  progressEvery: number;
  delayBetweenRequestsMs: number;
  // Called after each job resolves (success, timeout, or error) with the result so far --
  // lets the caller persist incrementally (clean shutdown: nothing resolved before an
  // interrupt is ever lost, since it's on disk by the time the interrupt could even land).
  // `outcome` tells the caller *why* a placeholder was produced (timed out vs errored) so it
  // can record an accurate typed failure instead of parsing the placeholder's description.
  onJobResolved?: (
    resolved: JobPosting,
    index: number,
    total: number,
    outcome: "succeeded" | "timedOut" | "errored",
    job: DiscoveredJobLite,
  ) => void | Promise<void>;
  log?: (message: string) => void;
}

export interface ResolvePhaseResult {
  resolvedJobs: JobPosting[];
  attempted: number;
  succeeded: number;
  timedOut: number;
  unresolved: number; // timedOut + errored + resolve()'s own internal placeholder fallback
  elapsedMs: number;
}

// Exported for reuse by any caller that has a DiscoveredJobLite it deliberately isn't running
// through the full resolver (e.g. a source that doesn't yet do JD resolution at all) but still
// needs an honestly-labeled JobPosting -- the SAME "unresolved" convention scoring.ts,
// report-rows.ts, and this module's own timeout/error paths already key off, not a second one.
export function buildPlaceholder(job: DiscoveredJobLite, reason: string): JobPosting {
  const now = new Date().toISOString();
  return {
    id: computeJobId(job.resultUrl),
    source: job.source,
    sourceType: "portal",
    company: job.company,
    title: job.title,
    location: job.location || null,
    remoteType: null,
    employmentType: null,
    department: job.department,
    requisitionId: job.sourceJobId,
    postingDate: job.postingAgeOrDate,
    discoveredAt: job.discoveredAt,
    lastSeenAt: now,
    canonicalUrl: job.resultUrl,
    applyUrl: job.resultUrl,
    descriptionText: `${UNRESOLVED_PLACEHOLDER_PREFIX}${job.source}. Full description not extracted. Reason: ${reason}`,
    descriptionHtml: null,
    requiredYears: null,
    salaryText: job.salarySnippet,
    matchedProfiles: job.matchedProfiles,
    discoveredFrom: [job.source],
    discoveredUrl: job.resultUrl,
    matchedKeywords: job.matchedKeywords,
    relevanceReason: job.relevanceReason,
    rawMetadata: {},
  };
}

interface ResolvedOutcome {
  __kind: "resolved";
  value: JobPosting | null;
}
interface ErroredOutcome {
  __kind: "errored";
  error: Error;
}

async function resolveOneJob(
  job: DiscoveredJobLite,
  resolveFn: (job: DiscoveredJobLite) => Promise<JobPosting | null>,
  perJobTimeoutMs: number,
): Promise<{ posting: JobPosting; outcome: "succeeded" | "timedOut" | "errored" }> {
  // Always attach a rejection handler to the real work promise, even if the timeout below wins
  // the race first -- otherwise an abandoned (post-timeout) rejection becomes an unhandled
  // rejection, which would trigger launcher.ts's process-level shutdown handler mid-run. That's
  // exactly the one-job-stalls-everything failure mode this module exists to prevent.
  const work: Promise<ResolvedOutcome | ErroredOutcome> = resolveFn(job).then(
    (value) => ({ __kind: "resolved", value }),
    (err: unknown) => ({ __kind: "errored", error: err instanceof Error ? err : new Error(String(err)) }),
  );

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), perJobTimeoutMs);
  });

  const raced = await Promise.race([work, timeout]);
  clearTimeout(timer!);

  if (raced === "timeout") {
    return { posting: buildPlaceholder(job, `Resolution timed out after ${perJobTimeoutMs}ms`), outcome: "timedOut" };
  }
  if (raced.__kind === "errored") {
    return { posting: buildPlaceholder(job, `Resolution error: ${raced.error.message}`), outcome: "errored" };
  }
  if (raced.value === null) {
    return { posting: buildPlaceholder(job, "resolve() returned no result"), outcome: "errored" };
  }
  const outcome = raced.value.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX) ? "errored" : "succeeded";
  return { posting: raced.value, outcome };
}

/**
 * Bounded-concurrency resolution over `jobs`: at most `options.concurrency` in flight at once,
 * each bounded by `options.perJobTimeoutMs`, the whole phase optionally bounded by
 * `options.totalTimeoutMs`. Every job produces a JobPosting -- on success, resolveFn's own
 * result; on timeout or error, a placeholder built from the job's own already-known lightweight
 * fields (title/company/location/salarySnippet/matchedProfiles), never silently dropped.
 */
export async function runResolutionPhase(
  jobs: DiscoveredJobLite[],
  resolveFn: (job: DiscoveredJobLite) => Promise<JobPosting | null>,
  options: ResolvePhaseOptions,
): Promise<ResolvePhaseResult> {
  const start = Date.now();
  const resolvedJobs: JobPosting[] = new Array(jobs.length);
  let succeeded = 0;
  let timedOut = 0;
  let unresolved = 0;
  let attempted = 0;
  let completedCount = 0;
  let cursor = 0;
  let totalTimeoutHit = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (options.totalTimeoutMs !== undefined && Date.now() - start > options.totalTimeoutMs) {
        totalTimeoutHit = true;
        return;
      }
      const i = cursor;
      if (i >= jobs.length) return;
      cursor += 1;
      const job = jobs[i]!;
      attempted += 1;
      const { posting, outcome } = await resolveOneJob(job, resolveFn, options.perJobTimeoutMs);
      resolvedJobs[i] = posting;
      if (outcome === "succeeded") succeeded += 1;
      else if (outcome === "timedOut") {
        timedOut += 1;
        unresolved += 1;
      } else {
        unresolved += 1;
      }
      completedCount += 1;
      await options.onJobResolved?.(posting, completedCount, jobs.length, outcome, job);
      if (completedCount % options.progressEvery === 0) {
        options.log?.(`[orchestrator] Resolved ${completedCount}/${jobs.length} jobs (${succeeded} succeeded, ${unresolved} unresolved).`);
      }
      if (options.delayBetweenRequestsMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayBetweenRequestsMs));
      }
    }
  }

  const workerCount = Math.max(1, Math.min(options.concurrency, jobs.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // Jobs never started because the total timeout was hit -- preserved with a reason, same as
  // any other unresolved outcome, never silently dropped from the output.
  if (totalTimeoutHit) {
    for (let i = 0; i < jobs.length; i++) {
      if (resolvedJobs[i] === undefined) {
        resolvedJobs[i] = buildPlaceholder(jobs[i]!, "Total resolution timeout exceeded before this job could start");
        unresolved += 1;
      }
    }
  }

  return {
    resolvedJobs: resolvedJobs.filter((r): r is JobPosting => r !== undefined),
    attempted,
    succeeded,
    timedOut,
    unresolved,
    elapsedMs: Date.now() - start,
  };
}

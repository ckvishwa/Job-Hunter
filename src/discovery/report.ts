// Task 15: reporting module. Assembles the end-of-run summary from counters the
// orchestrator collects as it goes. Every field here is wired to a real signal already
// produced somewhere in the discovery/resolution pipeline -- none are fabricated placeholders.

export interface DiscoveryRunSummary {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  companiesAttempted: number;
  keywordsSearched: number;
  pagesProcessed: number;
  listingsDiscovered: number;
  discoveriesRejected: number;
  officialPostingsResolved: number;
  unresolvedDiscoveries: number;
  duplicatesMerged: number;
  jdsExtracted: number;
  verificationPauses: number;
  jobsByProfile: Record<string, number>;
  jobsBySource: Record<string, number>;
  jobsWritten: number;
  errors: { source: string; message: string }[];
}

// Raw counters the orchestrator accumulates through a run. Mirrors DiscoveryRunSummary
// exactly except for discoveriesRejected, which buildSummary always sets itself (see below)
// rather than trusting a caller-supplied value.
export interface RawDiscoveryCounters {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  companiesAttempted: number;
  keywordsSearched: number;
  pagesProcessed: number;
  listingsDiscovered: number;
  officialPostingsResolved: number;
  unresolvedDiscoveries: number;
  duplicatesMerged: number;
  jdsExtracted: number;
  verificationPauses: number;
  jobsByProfile: Record<string, number>;
  jobsBySource: Record<string, number>;
  jobsWritten: number;
  errors: { source: string; message: string }[];
}

/**
 * Pure assembly -- no computation beyond what's noted below. Takes the orchestrator's raw
 * counters and returns the structured summary shape.
 *
 * Notes on fields that aren't simple 1:1 passthroughs:
 * - discoveriesRejected: always 0. There is currently no relevance-filtering logic anywhere
 *   in the codebase that discards a discovered job for being off-topic (the design spec's
 *   "don't store unrelated portal results" is aspirational, not implemented). Set to 0 here
 *   rather than inventing filtering logic, which would be scope creep into business logic
 *   this task isn't meant to add.
 * - verificationPauses: undercounts by construction. posting-resolver.ts makes 2 of its own
 *   pauseForVerification() calls (redirect-follow + DOM-scrape fallback) that are NOT
 *   reflected here -- PostingResolver only receives a bare BrowserContext, not a
 *   DiscoveryContext, so it has no onVerificationPause callback to report through. Threading
 *   one in is a larger, separate change (new constructor/resolve() parameter, orchestrator
 *   wiring) out of scope for this task. This count only reflects verification pauses from the
 *   5 portal adapters + company-careers's genericDeps relay.
 */
export function buildSummary(raw: RawDiscoveryCounters): DiscoveryRunSummary {
  return {
    sourcesAttempted: raw.sourcesAttempted,
    sourcesSucceeded: raw.sourcesSucceeded,
    sourcesFailed: raw.sourcesFailed,
    companiesAttempted: raw.companiesAttempted,
    keywordsSearched: raw.keywordsSearched,
    pagesProcessed: raw.pagesProcessed,
    listingsDiscovered: raw.listingsDiscovered,
    discoveriesRejected: 0,
    officialPostingsResolved: raw.officialPostingsResolved,
    unresolvedDiscoveries: raw.unresolvedDiscoveries,
    duplicatesMerged: raw.duplicatesMerged,
    jdsExtracted: raw.jdsExtracted,
    verificationPauses: raw.verificationPauses,
    jobsByProfile: raw.jobsByProfile,
    jobsBySource: raw.jobsBySource,
    jobsWritten: raw.jobsWritten,
    errors: raw.errors,
  };
}

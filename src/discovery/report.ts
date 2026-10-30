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
  // Profile Relevance phase: listingsEvaluated is every discovered listing that went through
  // relevance.ts's evaluateRelevance() -- equal to listingsDiscovered in current code (nothing
  // skips evaluation), kept as its own field because it's a conceptually distinct count (raw
  // discovery count vs. how many were actually checked for relevance) that a future change
  // could legitimately make diverge.
  listingsEvaluated: number;
  discoveriesRejected: number;
  relevantRetained: number;
  retainedByProfile: Record<string, number>;
  resolutionsAttempted: number;
  resolutionsSucceeded: number;
  resolutionsTimedOut: number;
  officialPostingsResolved: number;
  unresolvedDiscoveries: number;
  duplicatesMerged: number;
  jdsExtracted: number;
  verificationPauses: number;
  jobsByProfile: Record<string, number>;
  jobsBySource: Record<string, number>;
  jobsWritten: number;
  discoveryTimeMs: number;
  resolutionTimeMs: number;
  errors: { source: string; message: string }[];
}

// Raw counters the orchestrator accumulates through a run. Mirrors DiscoveryRunSummary
// field-for-field -- buildSummary is now a pure passthrough (see the historical note below on
// what used to differ).
export interface RawDiscoveryCounters {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  companiesAttempted: number;
  keywordsSearched: number;
  pagesProcessed: number;
  listingsDiscovered: number;
  listingsEvaluated: number;
  discoveriesRejected: number;
  relevantRetained: number;
  retainedByProfile: Record<string, number>;
  resolutionsAttempted: number;
  resolutionsSucceeded: number;
  resolutionsTimedOut: number;
  officialPostingsResolved: number;
  unresolvedDiscoveries: number;
  duplicatesMerged: number;
  jdsExtracted: number;
  verificationPauses: number;
  jobsByProfile: Record<string, number>;
  jobsBySource: Record<string, number>;
  jobsWritten: number;
  discoveryTimeMs: number;
  resolutionTimeMs: number;
  errors: { source: string; message: string }[];
}

/**
 * Pure assembly -- no computation. Takes the orchestrator's raw counters and returns the
 * structured summary shape (same shape today; kept as a separate function/type pair rather
 * than a type alias so a future field that DOES need real computation here, same as
 * discoveriesRejected used to before the Profile Relevance phase wired it to a real counter,
 * has somewhere to go without changing every call site).
 *
 * Note on verificationPauses: still undercounts by construction. posting-resolver.ts makes 2
 * of its own pauseForVerification() calls (redirect-follow + DOM-scrape fallback) that are NOT
 * reflected here -- PostingResolver only receives a bare BrowserContext, not a
 * DiscoveryContext, so it has no onVerificationPause callback to report through. Threading one
 * in is a larger, separate change (new constructor/resolve() parameter, orchestrator wiring)
 * out of scope for this task. This count only reflects verification pauses from the 5 portal
 * adapters + company-careers's genericDeps relay.
 */
export function buildSummary(raw: RawDiscoveryCounters): DiscoveryRunSummary {
  return { ...raw };
}

import { describe, expect, it } from "vitest";
import { buildSummary, type RawDiscoveryCounters } from "../../src/discovery/report.js";

// buildSummary is a pure assembly function -- these tests feed it a fake raw-counters object
// and assert the returned DiscoveryRunSummary shape/values, with no orchestrator involved.

function makeRawCounters(overrides: Partial<RawDiscoveryCounters> = {}): RawDiscoveryCounters {
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
    ...overrides,
  };
}

describe("buildSummary", () => {
  it("assembles a DiscoveryRunSummary that passes through each raw counter unchanged", () => {
    const raw = makeRawCounters({
      sourcesAttempted: 5,
      sourcesSucceeded: 4,
      sourcesFailed: 1,
      companiesAttempted: 12,
      keywordsSearched: 16,
      pagesProcessed: 20,
      listingsDiscovered: 87,
      listingsEvaluated: 87,
      discoveriesRejected: 17,
      relevantRetained: 70,
      retainedByProfile: { sdet: 70 },
      resolutionsAttempted: 60,
      resolutionsSucceeded: 55,
      resolutionsTimedOut: 2,
      officialPostingsResolved: 55,
      unresolvedDiscoveries: 5,
      duplicatesMerged: 3,
      jdsExtracted: 60,
      verificationPauses: 2,
      jobsByProfile: { sdet: 30, security: 15 },
      jobsBySource: { indeed: 25, "company-careers": 20 },
      jobsWritten: 67,
      discoveryTimeMs: 4200,
      resolutionTimeMs: 9800,
      errors: [{ source: "indeed::SDET", message: "boom" }],
    });

    const summary = buildSummary(raw);

    expect(summary.sourcesAttempted).toBe(5);
    expect(summary.sourcesSucceeded).toBe(4);
    expect(summary.sourcesFailed).toBe(1);
    expect(summary.companiesAttempted).toBe(12);
    expect(summary.keywordsSearched).toBe(16);
    expect(summary.pagesProcessed).toBe(20);
    expect(summary.listingsDiscovered).toBe(87);
    expect(summary.listingsEvaluated).toBe(87);
    expect(summary.discoveriesRejected).toBe(17);
    expect(summary.relevantRetained).toBe(70);
    expect(summary.retainedByProfile).toEqual({ sdet: 70 });
    expect(summary.resolutionsAttempted).toBe(60);
    expect(summary.resolutionsSucceeded).toBe(55);
    expect(summary.resolutionsTimedOut).toBe(2);
    expect(summary.officialPostingsResolved).toBe(55);
    expect(summary.unresolvedDiscoveries).toBe(5);
    expect(summary.duplicatesMerged).toBe(3);
    expect(summary.jdsExtracted).toBe(60);
    expect(summary.verificationPauses).toBe(2);
    expect(summary.jobsByProfile).toEqual({ sdet: 30, security: 15 });
    expect(summary.jobsBySource).toEqual({ indeed: 25, "company-careers": 20 });
    expect(summary.jobsWritten).toBe(67);
    expect(summary.discoveryTimeMs).toBe(4200);
    expect(summary.resolutionTimeMs).toBe(9800);
    expect(summary.errors).toEqual([{ source: "indeed::SDET", message: "boom" }]);
  });

  it("passes discoveriesRejected/relevantRetained/retainedByProfile through as real counters, not a hardcoded 0", () => {
    const summary = buildSummary(makeRawCounters({ discoveriesRejected: 42, relevantRetained: 8, retainedByProfile: { network: 8 } }));
    expect(summary.discoveriesRejected).toBe(42);
    expect(summary.relevantRetained).toBe(8);
    expect(summary.retainedByProfile).toEqual({ network: 8 });
  });

  it("produces a valid, all-zero summary from a run with zero sources attempted, rather than throwing", () => {
    const summary = buildSummary(makeRawCounters());

    expect(summary).toEqual({
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
    });
  });
});

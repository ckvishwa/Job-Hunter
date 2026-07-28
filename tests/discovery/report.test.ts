import { describe, expect, it } from "vitest";
import { buildSummary, type RawDiscoveryCounters } from "../../src/discovery/report.js";

// Task 15: buildSummary is a pure assembly function -- these tests feed it a fake raw-counters
// object and assert the returned DiscoveryRunSummary shape/values, with no orchestrator
// involved at all.

function makeRawCounters(overrides: Partial<RawDiscoveryCounters> = {}): RawDiscoveryCounters {
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
      officialPostingsResolved: 60,
      unresolvedDiscoveries: 10,
      duplicatesMerged: 3,
      jdsExtracted: 70,
      verificationPauses: 2,
      jobsByProfile: { sdet: 30, security: 15 },
      jobsBySource: { indeed: 25, "company-careers": 20 },
      jobsWritten: 67,
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
    expect(summary.officialPostingsResolved).toBe(60);
    expect(summary.unresolvedDiscoveries).toBe(10);
    expect(summary.duplicatesMerged).toBe(3);
    expect(summary.jdsExtracted).toBe(70);
    expect(summary.verificationPauses).toBe(2);
    expect(summary.jobsByProfile).toEqual({ sdet: 30, security: 15 });
    expect(summary.jobsBySource).toEqual({ indeed: 25, "company-careers": 20 });
    expect(summary.jobsWritten).toBe(67);
    expect(summary.errors).toEqual([{ source: "indeed::SDET", message: "boom" }]);
  });

  it("always reports discoveriesRejected as 0 -- no relevance-filtering logic exists anywhere in the codebase yet", () => {
    // Note: RawDiscoveryCounters has no discoveriesRejected field at all -- buildSummary sets
    // the output field itself unconditionally, so there's nothing a caller could even pass in
    // to make this non-zero. This test documents that as intentional, not an oversight.
    const summary = buildSummary(makeRawCounters());
    expect(summary.discoveriesRejected).toBe(0);
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
      discoveriesRejected: 0,
      officialPostingsResolved: 0,
      unresolvedDiscoveries: 0,
      duplicatesMerged: 0,
      jdsExtracted: 0,
      verificationPauses: 0,
      jobsByProfile: {},
      jobsBySource: {},
      jobsWritten: 0,
      errors: [],
    });
  });
});

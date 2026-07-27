import { describe, expect, it } from "vitest";
import { mergeJobs } from "../../src/dedup/deduplicator.js";
import type { JobPosting } from "../../src/adapters/types.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "id-1",
    source: "acme-greenhouse",
    sourceType: "greenhouse",
    company: "Acme",
    title: "SDET",
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "123",
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://acme.com/jobs/123",
    applyUrl: "https://acme.com/jobs/123",
    descriptionText: "We need a great SDET with 5 years experience.",
    descriptionHtml: null,
    requiredYears: 5,
    salaryText: null,
    matchedProfiles: ["sdet"],
    rawMetadata: {},
    ...overrides,
  };
}

describe("mergeJobs", () => {
  it("inserts a brand new job with discoveredAt = lastSeenAt = now", () => {
    const now = "2026-02-01T00:00:00.000Z";
    const result = mergeJobs([], [makeJob()], now);
    expect(result).toHaveLength(1);
    expect(result[0]!.discoveredAt).toBe(now);
    expect(result[0]!.lastSeenAt).toBe(now);
  });

  it("matches on canonical URL and preserves original discoveredAt", () => {
    const existing = [makeJob({ discoveredAt: "2026-01-01T00:00:00.000Z" })];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [makeJob({ title: "Senior SDET", lastSeenAt: now })];
    const result = mergeJobs(existing, incoming, now);

    expect(result).toHaveLength(1);
    expect(result[0]!.discoveredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result[0]!.lastSeenAt).toBe(now);
    expect(result[0]!.title).toBe("Senior SDET");
  });

  it("matches on source + requisitionId even if the URL changed", () => {
    const existing = [makeJob({ canonicalUrl: "https://acme.com/old-jobs/123" })];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [makeJob({ canonicalUrl: "https://acme.com/jobs/123?v=2" })];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(1);
  });

  it("falls back to normalized company+title+location when url/reqId don't match", () => {
    const existing = [
      makeJob({ canonicalUrl: "https://acme.com/a", requisitionId: null }),
    ];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [
      makeJob({
        canonicalUrl: "https://acme.com/b",
        requisitionId: null,
        title: "  sdet  ",
        location: "REMOTE",
      }),
    ];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(1);
  });

  it("falls back to JD fingerprint when nothing else matches", () => {
    const existing = [
      makeJob({
        canonicalUrl: "https://acme.com/a",
        requisitionId: null,
        title: "SDET I",
        location: "NYC",
      }),
    ];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [
      makeJob({
        canonicalUrl: "https://acme.com/b",
        requisitionId: null,
        title: "SDET II",
        location: "SF",
        descriptionText: "We need a great SDET with 5 years experience.",
      }),
    ];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(1);
  });

  it("does NOT merge two different requisitions that share a title", () => {
    const existing = [
      makeJob({
        canonicalUrl: "https://acme.com/jobs/1",
        requisitionId: "1",
        location: "NYC",
        descriptionText: "First distinct posting text about NYC role.",
      }),
    ];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [
      makeJob({
        canonicalUrl: "https://acme.com/jobs/2",
        requisitionId: "2",
        location: "Austin",
        descriptionText: "Second distinct posting text about Austin role.",
      }),
    ];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(2);
  });

  it("running the same incoming list twice does not duplicate", () => {
    const now1 = "2026-02-01T00:00:00.000Z";
    const now2 = "2026-02-02T00:00:00.000Z";
    const first = mergeJobs([], [makeJob()], now1);
    const second = mergeJobs(first, [makeJob()], now2);
    expect(second).toHaveLength(1);
    expect(second[0]!.discoveredAt).toBe(now1);
    expect(second[0]!.lastSeenAt).toBe(now2);
  });

  it("does not lose jobs when a merged job's URL changes and another incoming job reuses the old URL", () => {
    // Regression test: stale index entries must be cleaned up during merge.
    // Scenario: A (url U1, reqId R1) is merged with B (url U2, reqId R1),
    // then C (url U1, reqId R2) arrives. Without deindex, C incorrectly matches
    // the stale U1 entry and overwrites B. With deindex, C is recognized as distinct.
    const now = "2026-02-01T00:00:00.000Z";
    const existing = [
      makeJob({
        id: "id-a",
        canonicalUrl: "https://acme.com/old-url",
        requisitionId: "1",
        descriptionText: "Original posting for requisition 1.",
      }),
    ];
    const incoming = [
      // B matches A via requisitionId but has a new URL
      makeJob({
        id: "id-b",
        canonicalUrl: "https://acme.com/new-url",
        requisitionId: "1",
        descriptionText: "Updated posting for requisition 1.",
      }),
      // C is distinct (different requisitionId, title, location, description)
      // but reuses A's old URL. Should NOT match due to deindexing.
      makeJob({
        id: "id-c",
        canonicalUrl: "https://acme.com/old-url", // Same as A's original URL
        requisitionId: "2",
        title: "Different Job",
        location: "NYC",
        descriptionText: "Completely different posting for requisition 2.",
      }),
    ];

    const result = mergeJobs(existing, incoming, now);

    // Should have 2 jobs: A/B merged (1 record) + C (new record)
    expect(result).toHaveLength(2);

    // The merged job should have B's new fields but A's original id and discoveredAt
    const merged = result.find((j) => j.requisitionId === "1");
    expect(merged).toBeDefined();
    expect(merged!.canonicalUrl).toBe("https://acme.com/new-url");
    expect(merged!.descriptionText).toBe("Updated posting for requisition 1.");
    expect(merged!.id).toBe("id-a"); // Preserved from original

    // C should be intact with its own fields (not overwritten)
    const c = result.find((j) => j.requisitionId === "2");
    expect(c).toBeDefined();
    expect(c!.canonicalUrl).toBe("https://acme.com/old-url");
    expect(c!.title).toBe("Different Job");
    expect(c!.location).toBe("NYC");
    expect(c!.descriptionText).toBe("Completely different posting for requisition 2.");
  });
});

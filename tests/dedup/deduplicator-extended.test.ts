import { describe, expect, it } from "vitest";
import { mergeJobs, isGenericTitle } from "../../src/dedup/deduplicator.js";
import type { JobPosting } from "../../src/adapters/types.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "id-1",
    source: "google-jobs",
    sourceType: "portal",
    company: "Google",
    title: "Software Engineer",
    location: "Mountain View",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: null,
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://careers.google.com/jobs/123",
    applyUrl: "https://careers.google.com/jobs/123",
    descriptionText: "We are looking for a Software Engineer.",
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["cloud"],
    discoveredFrom: ["google-jobs"],
    rawMetadata: {},
    ...overrides,
  };
}

describe("Extended Deduplication & Provenance", () => {
  it("correctly identifies generic titles", () => {
    expect(isGenericTitle("Software Engineer")).toBe(true);
    expect(isGenericTitle("SDET")).toBe(true);
    expect(isGenericTitle("Manager")).toBe(true);
    expect(isGenericTitle("QA Automation Engineer")).toBe(false); // specific
    expect(isGenericTitle("Identity and Access Management Engineer")).toBe(false); // specific
  });

  it("does NOT merge two jobs with generic titles based on company, title, location", () => {
    // If the title is generic, company+title+location matches should be bypassed
    const existing = [
      makeJob({
        id: "job-1",
        title: "Software Engineer", // generic
        canonicalUrl: "https://careers.google.com/jobs/1",
        descriptionText: "First distinct description here that is long enough.",
      }),
    ];
    const incoming = [
      makeJob({
        id: "job-2",
        title: "Software Engineer", // generic
        canonicalUrl: "https://careers.google.com/jobs/2",
        descriptionText: "Second completely different description that is also long.",
      }),
    ];
    const result = mergeJobs(existing, incoming, "2026-02-01T00:00:00.000Z");
    expect(result).toHaveLength(2); // Should not merge!
  });

  it("merges discovery provenance (discoveredFrom) correctly", () => {
    const existing = [
      makeJob({
        canonicalUrl: "https://careers.google.com/jobs/123",
        discoveredFrom: ["google-jobs"],
      }),
    ];
    const incoming = [
      makeJob({
        canonicalUrl: "https://careers.google.com/jobs/123",
        discoveredFrom: ["indeed"],
      }),
    ];
    const result = mergeJobs(existing, incoming, "2026-02-01T00:00:00.000Z");
    expect(result).toHaveLength(1);
    expect(result[0]!.discoveredFrom).toContain("google-jobs");
    expect(result[0]!.discoveredFrom).toContain("indeed");
  });

  it("merges matchedProfiles during deduplication", () => {
    const existing = [
      makeJob({
        canonicalUrl: "https://careers.google.com/jobs/123",
        matchedProfiles: ["cloud"],
      }),
    ];
    const incoming = [
      makeJob({
        canonicalUrl: "https://careers.google.com/jobs/123",
        matchedProfiles: ["security"],
      }),
    ];
    const result = mergeJobs(existing, incoming, "2026-02-01T00:00:00.000Z");
    expect(result).toHaveLength(1);
    expect(result[0]!.matchedProfiles).toContain("cloud");
    expect(result[0]!.matchedProfiles).toContain("security");
  });

  it("a malformed URL in one incoming record doesn't throw and doesn't corrupt the merge for other records", () => {
    const existing = [
      makeJob({
        id: "existing-1",
        canonicalUrl: "https://careers.google.com/jobs/1",
        requisitionId: "req-1",
      }),
    ];
    const incoming = [
      // Malformed URL, no matching requisitionId/title/description tier -- must
      // still be kept in the result, not silently dropped.
      makeJob({
        id: "malformed-1",
        canonicalUrl: "not a url at all",
        requisitionId: "req-malformed",
        title: "Chaos Engineer",
        location: "Nowhere",
        descriptionText: "This record has a malformed canonical URL on purpose.",
      }),
      // Valid record that should merge into the existing job as normal.
      makeJob({
        id: "existing-1-update",
        canonicalUrl: "https://careers.google.com/jobs/1",
        requisitionId: "req-1",
        title: "Updated Title",
      }),
      // Valid, distinct new record that should be inserted as normal.
      makeJob({
        id: "fresh-1",
        canonicalUrl: "https://careers.google.com/jobs/2",
        requisitionId: "req-2",
        title: "Fresh Distinct Role",
        location: "Austin",
        descriptionText: "A completely separate posting for a fresh distinct role.",
      }),
    ];

    let result: JobPosting[] = [];
    expect(() => {
      result = mergeJobs(existing, incoming, "2026-02-01T00:00:00.000Z");
    }).not.toThrow();

    // 3 records expected: the malformed one, the merged existing+update, and the fresh one.
    expect(result).toHaveLength(3);

    const malformed = result.find((j) => j.canonicalUrl === "not a url at all");
    expect(malformed).toBeDefined();
    expect(malformed!.title).toBe("Chaos Engineer");

    const merged = result.find((j) => j.canonicalUrl === "https://careers.google.com/jobs/1");
    expect(merged).toBeDefined();
    expect(merged!.title).toBe("Updated Title");
    expect(merged!.id).toBe("existing-1"); // preserved from original, not the malformed record

    const fresh = result.find((j) => j.canonicalUrl === "https://careers.google.com/jobs/2");
    expect(fresh).toBeDefined();
    expect(fresh!.title).toBe("Fresh Distinct Role");
  });
});

import { describe, expect, it } from "vitest";
import { mergeJobs } from "../../src/dedup/deduplicator.js";
import type { JobPosting, SourceObservation } from "../../src/adapters/types.js";

const SHARED_DESCRIPTION =
  "Acme is hiring an engineer. You will design, build and test services, partner with product, " +
  "and own quality end to end. Requirements: strong debugging skills and clear communication.";

function obs(overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    sourceKind: "company-careers",
    observedUrl: "https://boards.greenhouse.io/acme/jobs/1?gh_jid=1",
    finalUrl: "https://job-boards.greenhouse.io/acme/jobs/1?gh_jid=1",
    observedAt: "2026-10-07T12:00:00.000Z",
    extractionMethod: "ats-api",
    ...overrides,
  };
}

function job(reqId: string, overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: `id-${reqId}`,
    source: "company-careers::acme",
    sourceType: "company-careers",
    company: "Acme",
    title: "Security Engineer",
    location: "Remote - US",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: reqId,
    postingDate: null,
    discoveredAt: "2026-10-07T12:00:00.000Z",
    lastSeenAt: "2026-10-07T12:00:00.000Z",
    canonicalUrl: `https://job-boards.greenhouse.io/acme/jobs/${reqId}?gh_jid=${reqId}`,
    applyUrl: `https://job-boards.greenhouse.io/acme/jobs/${reqId}?gh_jid=${reqId}`,
    descriptionText: SHARED_DESCRIPTION,
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["security"],
    discoveredFrom: ["company-careers"],
    atsIdentity: `greenhouse:acme:${reqId}`,
    sourceObservations: [obs({ finalUrl: `https://job-boards.greenhouse.io/acme/jobs/${reqId}?gh_jid=${reqId}` })],
    rawMetadata: {},
    ...overrides,
  };
}

describe("mergeJobs with stable ATS identity", () => {
  it("keeps distinct requisitions distinct even when title, location and description are identical", () => {
    const merged = mergeJobs([], [job("1"), job("2"), job("3")], "2026-10-07T13:00:00.000Z");
    expect(merged.map((j) => j.atsIdentity)).toEqual(["greenhouse:acme:1", "greenhouse:acme:2", "greenhouse:acme:3"]);
  });

  it("keeps them distinct across runs too (existing store vs a new requisition)", () => {
    const existing = mergeJobs([], [job("1")], "2026-10-07T13:00:00.000Z");
    const merged = mergeJobs(existing, [job("2")], "2026-10-08T13:00:00.000Z");
    expect(merged).toHaveLength(2);
  });

  it("repeated discovery of the same job merges into one record and keeps first-seen time", () => {
    const first = mergeJobs([], [job("1")], "2026-10-07T13:00:00.000Z");
    const again = mergeJobs(first, [job("1", { id: "different-id" })], "2026-10-08T13:00:00.000Z");
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(first[0]!.id);
    expect(again[0]!.discoveredAt).toBe("2026-10-07T13:00:00.000Z");
    expect(again[0]!.lastSeenAt).toBe("2026-10-08T13:00:00.000Z");
  });

  it("matches the same identity even after the host and tracking parameters change", () => {
    const first = mergeJobs([], [job("1")], "2026-10-07T13:00:00.000Z");
    const moved = job("1", {
      canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1?gh_jid=1&utm_source=x",
      requisitionId: null,
      title: "Renamed Title",
      descriptionText: `${SHARED_DESCRIPTION} Updated.`,
    });
    const again = mergeJobs(first, [moved], "2026-10-08T13:00:00.000Z");
    expect(again).toHaveLength(1);
    expect(again[0]!.title).toBe("Renamed Title");
  });

  it("does not grow sourceObservations when the same sighting repeats, and adds a genuinely new one", () => {
    const first = mergeJobs([], [job("1")], "2026-10-07T13:00:00.000Z");
    const same = mergeJobs(first, [job("1")], "2026-10-08T13:00:00.000Z");
    expect(same[0]!.sourceObservations).toHaveLength(1);

    const viaBrowser = job("1", {
      sourceObservations: [obs({ finalUrl: first[0]!.canonicalUrl, extractionMethod: "browser-dom" })],
    });
    const more = mergeJobs(same, [viaBrowser], "2026-10-09T13:00:00.000Z");
    expect(more[0]!.sourceObservations).toHaveLength(2);
  });

  it("upgrades a legacy record without identity when the same posting is re-resolved", () => {
    const legacy = job("1", { atsIdentity: undefined, sourceObservations: undefined });
    const merged = mergeJobs([legacy], [job("1")], "2026-10-08T13:00:00.000Z");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.atsIdentity).toBe("greenhouse:acme:1");
  });

  it("does not let a loose title/description match join two postings with conflicting identities", () => {
    const merged = mergeJobs([job("1")], [job("2", { canonicalUrl: "https://elsewhere.example/other", requisitionId: null })], "2026-10-08T13:00:00.000Z");
    expect(merged).toHaveLength(2);
  });
});

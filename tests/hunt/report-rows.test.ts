import { describe, expect, it } from "vitest";
import { buildReportRows, type ReportRowOptions } from "../../src/hunt/report-rows.js";
import type { JobPosting } from "../../src/adapters/types.js";
import { UNRESOLVED_PLACEHOLDER_PREFIX } from "../../src/discovery/resolve-phase.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: `id-${Math.random()}`,
    source: "company-careers",
    sourceType: "company-careers",
    company: "Acme",
    title: "SDET I",
    location: "Austin, TX",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "1",
    postingDate: null,
    discoveredAt: "2026-01-05T00:00:00.000Z",
    lastSeenAt: "2026-01-05T00:00:00.000Z",
    canonicalUrl: "https://acme.example/job/1",
    applyUrl: "https://acme.example/job/1",
    descriptionText: "We need an entry-level SDET with 1 year of experience.".repeat(10),
    descriptionHtml: null,
    requiredYears: 1,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["company-careers"],
    matchedKeywords: ["SDET"],
    relevanceReason: "test",
    rawMetadata: {},
    ...overrides,
  };
}

function baseOptions(overrides: Partial<ReportRowOptions> = {}): ReportRowOptions {
  return {
    now: "2026-01-05T00:00:00.000Z",
    previousHuntAt: null,
    staleDays: 14,
    requestedCountry: "United States",
    requestedStates: null,
    remoteOnly: false,
    excludeOnsite: false,
    includeUnknownLocation: false,
    newOnly: false,
    days: null,
    includeSeen: false,
    includeStale: false,
    limit: null,
    ...overrides,
  };
}

describe("buildReportRows", () => {
  it("drops a senior title and counts it as ineligibleSeniority", () => {
    const jobs = [makeJob({ title: "Senior SDET" }), makeJob({ title: "SDET I" })];
    const { rows, counts } = buildReportRows(jobs, baseOptions());
    expect(rows).toHaveLength(1);
    expect(counts.ineligibleSeniority).toBe(1);
    expect(counts.totalDiscovered).toBe(2);
  });

  it("drops a job in a mismatched country and counts it as locationMismatch", () => {
    const jobs = [makeJob({ location: "Berlin, Germany" }), makeJob({ location: "Austin, TX" })];
    const { rows, counts } = buildReportRows(jobs, baseOptions());
    expect(rows).toHaveLength(1);
    expect(counts.locationMismatch).toBe(1);
  });

  it("drops a job with unknown location by default", () => {
    const jobs = [makeJob({ location: "" })];
    const { rows, counts } = buildReportRows(jobs, baseOptions());
    expect(rows).toHaveLength(0);
    expect(counts.locationMismatch).toBe(1);
  });

  it("keeps an unknown-location job when --include-unknown-location is set", () => {
    const jobs = [makeJob({ location: "" })];
    const { rows } = buildReportRows(jobs, baseOptions({ includeUnknownLocation: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.country).toBeNull();
  });

  it("--remote-only keeps only remote-arrangement jobs", () => {
    const jobs = [makeJob({ location: "Remote - US" }), makeJob({ location: "Austin, TX (Onsite)" })];
    const { rows } = buildReportRows(jobs, baseOptions({ remoteOnly: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workArrangement).toBe("remote");
  });

  it("--exclude-onsite drops onsite jobs but keeps unknown-arrangement jobs", () => {
    const jobs = [makeJob({ location: "Austin, TX (Onsite)" }), makeJob({ location: "Austin, TX" })];
    const { rows } = buildReportRows(jobs, baseOptions({ excludeOnsite: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workArrangement).toBe("unknown");
  });

  it("--states keeps only jobs in the requested states", () => {
    const jobs = [makeJob({ location: "Austin, TX" }), makeJob({ location: "New York, NY" })];
    const { rows } = buildReportRows(jobs, baseOptions({ requestedStates: ["NY"] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("NY");
  });

  it("defaults to new-only: excludes a job not newly discovered since the previous hunt", () => {
    const jobs = [
      makeJob({ discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" }),
      makeJob({ discoveredAt: "2026-01-05T00:00:00.000Z", lastSeenAt: "2026-01-05T00:00:00.000Z" }),
    ];
    const { rows, counts } = buildReportRows(jobs, baseOptions({ previousHuntAt: "2026-01-04T00:00:00.000Z" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isNew).toBe(true);
    expect(counts.newJobs).toBe(1);
    expect(counts.eligibleRetained).toBe(2);
  });

  it("--include-seen includes previously-seen eligible jobs too", () => {
    const jobs = [
      makeJob({ discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-05T00:00:00.000Z" }),
      makeJob({ discoveredAt: "2026-01-05T00:00:00.000Z", lastSeenAt: "2026-01-05T00:00:00.000Z" }),
    ];
    const { rows } = buildReportRows(jobs, baseOptions({ previousHuntAt: "2026-01-04T00:00:00.000Z", includeSeen: true }));
    expect(rows).toHaveLength(2);
  });

  it("--days N keeps jobs discovered within the last N days regardless of previousHuntAt", () => {
    const jobs = [
      makeJob({ discoveredAt: "2025-12-01T00:00:00.000Z", lastSeenAt: "2025-12-01T00:00:00.000Z" }),
      makeJob({ discoveredAt: "2026-01-03T00:00:00.000Z", lastSeenAt: "2026-01-03T00:00:00.000Z" }),
    ];
    const { rows } = buildReportRows(jobs, baseOptions({ days: 7 }));
    expect(rows).toHaveLength(1);
  });

  it("excludes a stale job by default even under --include-seen", () => {
    const jobs = [
      makeJob({ discoveredAt: "2025-01-01T00:00:00.000Z", lastSeenAt: "2025-01-01T00:00:00.000Z" }),
    ];
    const { rows } = buildReportRows(jobs, baseOptions({ includeSeen: true }));
    expect(rows).toHaveLength(0);
  });

  it("--include-stale keeps a stale job", () => {
    const jobs = [
      makeJob({ discoveredAt: "2025-01-01T00:00:00.000Z", lastSeenAt: "2025-01-01T00:00:00.000Z" }),
    ];
    const { rows } = buildReportRows(jobs, baseOptions({ includeSeen: true, includeStale: true }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isStale).toBe(true);
  });

  it("ranks by score descending and assigns sequential rank starting at 1", () => {
    const jobs = [
      makeJob({ matchedKeywords: ["SDET"] }),
      makeJob({ matchedKeywords: ["SDET", "Test Automation Engineer", "QA"] }),
    ];
    const { rows } = buildReportRows(jobs, baseOptions());
    expect(rows[0]!.rank).toBe(1);
    expect(rows[1]!.rank).toBe(2);
    expect(rows[0]!.score).toBeGreaterThanOrEqual(rows[1]!.score);
  });

  it("produces a deterministic row order across repeated calls on identical input", () => {
    const jobs = [makeJob({ title: "SDET I" }), makeJob({ title: "QA Automation Engineer I" })];
    const a = buildReportRows(jobs, baseOptions());
    const b = buildReportRows(jobs, baseOptions());
    expect(a.rows.map((r) => r.title)).toEqual(b.rows.map((r) => r.title));
  });

  it("applies --limit after ranking", () => {
    const jobs = [makeJob(), makeJob(), makeJob()];
    const { rows } = buildReportRows(jobs, baseOptions({ limit: 2 }));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rank).toBe(1);
    expect(rows[1]!.rank).toBe(2);
  });

  it("flags unresolved jobs from the placeholder description prefix", () => {
    const jobs = [makeJob({ descriptionText: `${UNRESOLVED_PLACEHOLDER_PREFIX}foo. Full description not extracted.` })];
    const { rows } = buildReportRows(jobs, baseOptions());
    expect(rows[0]!.unresolved).toBe(true);
  });

  it("sets matchedProfile from the job's primary matchedProfiles entry", () => {
    const jobs = [makeJob({ matchedProfiles: ["cloud", "network"] })];
    const { rows } = buildReportRows(jobs, baseOptions());
    expect(rows[0]!.matchedProfile).toBe("cloud");
  });
});

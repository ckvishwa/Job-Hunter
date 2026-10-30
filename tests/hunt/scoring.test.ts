import { describe, expect, it } from "vitest";
import { scoreJob } from "../../src/hunt/scoring.js";
import type { JobPosting } from "../../src/adapters/types.js";
import type { EligibilityResult } from "../../src/hunt/eligibility.js";
import type { ParsedLocation } from "../../src/hunt/location.js";
import type { FreshnessInfo } from "../../src/hunt/freshness.js";
import { UNRESOLVED_PLACEHOLDER_PREFIX } from "../../src/discovery/resolve-phase.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "id-1",
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
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://acme.example/job/1",
    applyUrl: "https://acme.example/job/1",
    descriptionText: "A".repeat(600),
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["company-careers"],
    matchedKeywords: ["SDET", "Test Automation Engineer"],
    relevanceReason: "test",
    rawMetadata: {},
    ...overrides,
  };
}

const ELIGIBLE_ENTRY: EligibilityResult = {
  seniority: "entry-level",
  requiredYearsMin: 1,
  requiredYearsMax: 1,
  eligible: true,
  reasons: ["Description requires 1-1 years experience (within 0-3 year range)"],
};

const ELIGIBLE_UNKNOWN: EligibilityResult = {
  seniority: "unknown",
  requiredYearsMin: null,
  requiredYearsMax: null,
  eligible: true,
  reasons: ["No explicit seniority or years-of-experience signal found"],
};

const KNOWN_US_LOCATION: ParsedLocation = {
  raw: "Austin, TX",
  city: "Austin",
  state: "TX",
  country: "United States",
  workArrangement: "unknown",
  locationKnown: true,
};

const UNKNOWN_LOCATION: ParsedLocation = {
  raw: "Remote",
  city: null,
  state: null,
  country: null,
  workArrangement: "remote",
  locationKnown: false,
};

const FRESH_NEW: FreshnessInfo = { postingAgeDays: null, isNew: true, isUpdated: false, isStale: false };

function baseCtx() {
  return {
    eligibility: ELIGIBLE_ENTRY,
    parsedLocation: KNOWN_US_LOCATION,
    freshnessInfo: FRESH_NEW,
    requestedCountry: "United States",
    requestedStates: null as string[] | null,
    remoteOnly: false,
  };
}

describe("scoreJob", () => {
  it("gives full title relevance for 3+ matched keywords, capped at 20", () => {
    const job = makeJob({ matchedKeywords: ["a", "b", "c", "d", "e"] });
    const result = scoreJob(job, baseCtx());
    expect(result.titleRelevance).toBe(20);
  });

  it("scales title relevance down for fewer matched keywords", () => {
    const job = makeJob({ matchedKeywords: ["a"] });
    const result = scoreJob(job, baseCtx());
    expect(result.titleRelevance).toBe(7);
  });

  it("gives full seniority alignment for an explicit entry-level match", () => {
    const result = scoreJob(makeJob(), baseCtx());
    expect(result.seniorityAlignment).toBe(15);
  });

  it("gives a reduced seniority alignment for unknown/neutral seniority", () => {
    const result = scoreJob(makeJob(), { ...baseCtx(), eligibility: ELIGIBLE_UNKNOWN });
    expect(result.seniorityAlignment).toBe(6);
  });

  it("gives full years alignment for 0-1 years required", () => {
    const result = scoreJob(makeJob(), baseCtx());
    expect(result.yearsAlignment).toBe(10);
  });

  it("gives reduced years alignment when years are unknown", () => {
    const result = scoreJob(makeJob(), { ...baseCtx(), eligibility: ELIGIBLE_UNKNOWN });
    expect(result.yearsAlignment).toBe(3);
  });

  it("gives full location alignment when parsed country matches the requested country", () => {
    const result = scoreJob(makeJob(), baseCtx());
    expect(result.locationAlignment).toBe(15);
  });

  it("gives reduced location alignment for an unknown location", () => {
    const result = scoreJob(makeJob(), { ...baseCtx(), parsedLocation: UNKNOWN_LOCATION });
    expect(result.locationAlignment).toBe(7);
  });

  it("gives zero location alignment for a mismatched country", () => {
    const germanLocation: ParsedLocation = { ...KNOWN_US_LOCATION, country: "Germany", state: null };
    const result = scoreJob(makeJob(), { ...baseCtx(), parsedLocation: germanLocation });
    expect(result.locationAlignment).toBe(0);
  });

  it("gives full remote alignment for a remote job when --remote-only is requested", () => {
    const remoteLoc: ParsedLocation = { ...KNOWN_US_LOCATION, workArrangement: "remote" };
    const result = scoreJob(makeJob(), { ...baseCtx(), parsedLocation: remoteLoc, remoteOnly: true });
    expect(result.remoteAlignment).toBe(10);
  });

  it("gives zero remote alignment for an onsite job when --remote-only is requested", () => {
    const onsiteLoc: ParsedLocation = { ...KNOWN_US_LOCATION, workArrangement: "onsite" };
    const result = scoreJob(makeJob(), { ...baseCtx(), parsedLocation: onsiteLoc, remoteOnly: true });
    expect(result.remoteAlignment).toBe(0);
  });

  it("gives full JD completeness for a long description", () => {
    const result = scoreJob(makeJob({ descriptionText: "A".repeat(600) }), baseCtx());
    expect(result.jdCompleteness).toBe(10);
  });

  it("gives zero JD completeness for an unresolved placeholder description", () => {
    const result = scoreJob(makeJob({ descriptionText: `${UNRESOLVED_PLACEHOLDER_PREFIX}foo. Full description not extracted.` }), baseCtx());
    expect(result.jdCompleteness).toBe(0);
  });

  it("gives full freshness score for a new job", () => {
    const result = scoreJob(makeJob(), baseCtx());
    expect(result.freshness).toBe(10);
  });

  it("gives zero freshness score for a stale job", () => {
    const stale: FreshnessInfo = { postingAgeDays: 40, isNew: false, isUpdated: false, isStale: true };
    const result = scoreJob(makeJob(), { ...baseCtx(), freshnessInfo: stale });
    expect(result.freshness).toBe(0);
  });

  it("gives full official-link score for a company-careers job", () => {
    const result = scoreJob(makeJob({ sourceType: "company-careers", source: "company-careers" }), baseCtx());
    expect(result.officialLink).toBe(10);
  });

  it("gives a mid official-link score for a known ATS domain with no registry match", () => {
    const job = makeJob({ sourceType: "portal", source: "indeed", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1" });
    const result = scoreJob(job, baseCtx());
    expect(result.officialLink).toBe(5);
  });

  it("gives zero official-link score for an unresolved/unknown source", () => {
    const job = makeJob({ sourceType: "portal", source: "indeed", canonicalUrl: "https://indeed.com/rc/clk?jk=1" });
    const result = scoreJob(job, baseCtx());
    expect(result.officialLink).toBe(0);
  });

  it("applies an unclear-requirements penalty when seniority is unknown with no years signal", () => {
    const result = scoreJob(makeJob(), { ...baseCtx(), eligibility: ELIGIBLE_UNKNOWN });
    expect(result.penalties).toBeGreaterThanOrEqual(5);
  });

  it("applies an unresolved-JD penalty on top of the zero jdCompleteness", () => {
    const job = makeJob({ descriptionText: `${UNRESOLVED_PLACEHOLDER_PREFIX}foo. Full description not extracted.` });
    const result = scoreJob(job, baseCtx());
    expect(result.penalties).toBeGreaterThanOrEqual(10);
  });

  it("clamps total at 0 even when penalties would drive it negative", () => {
    const job = makeJob({
      descriptionText: `${UNRESOLVED_PLACEHOLDER_PREFIX}foo. Full description not extracted.`,
      matchedKeywords: [],
      sourceType: "portal",
      source: "indeed",
      canonicalUrl: "https://indeed.com/rc/clk?jk=1",
    });
    const germanLocation: ParsedLocation = { ...UNKNOWN_LOCATION, country: "Germany" };
    const stale: FreshnessInfo = { postingAgeDays: 99, isNew: false, isUpdated: false, isStale: true };
    const result = scoreJob(job, { ...baseCtx(), eligibility: ELIGIBLE_UNKNOWN, parsedLocation: germanLocation, freshnessInfo: stale });
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("computes total as the clamped sum of components minus penalties", () => {
    const result = scoreJob(makeJob(), baseCtx());
    const rawSum =
      result.titleRelevance + result.seniorityAlignment + result.yearsAlignment + result.locationAlignment +
      result.remoteAlignment + result.jdCompleteness + result.freshness + result.officialLink - result.penalties;
    expect(result.total).toBe(Math.max(0, Math.min(100, rawSum)));
  });

  it("never exceeds 100", () => {
    const result = scoreJob(makeJob(), baseCtx());
    expect(result.total).toBeLessThanOrEqual(100);
  });
});

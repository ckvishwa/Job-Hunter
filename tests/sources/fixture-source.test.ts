import { describe, expect, test } from "vitest";
import { FixtureSource } from "../../src/sources/fixture-source.js";
import type { JobPosting } from "../../src/adapters/types.js";

const JOB: JobPosting = {
  id: "job-1",
  source: "fixture",
  sourceType: "portal",
  company: "Acme",
  title: "SDET",
  location: "Remote",
  remoteType: "remote",
  employmentType: null,
  department: null,
  requisitionId: null,
  postingDate: null,
  discoveredAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  canonicalUrl: "https://example.com/job-1",
  applyUrl: "https://example.com/job-1",
  descriptionText: "desc",
  descriptionHtml: null,
  requiredYears: null,
  salaryText: null,
  matchedProfiles: [],
  discoveredFrom: ["fixture"],
  rawMetadata: {},
};

describe("FixtureSource", () => {
  test("has id 'fixture'", () => {
    expect(new FixtureSource([]).id).toBe("fixture");
  });

  test("discover returns exactly the jobs it was constructed with, with health reflecting their count", async () => {
    const source = new FixtureSource([JOB]);

    const result = await source.discover({});

    expect(result.jobs).toEqual([JOB]);
    expect(result.health).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(result.errors).toEqual([]);
  });
});

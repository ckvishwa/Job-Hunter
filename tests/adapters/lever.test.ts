import { afterEach, describe, expect, it, vi } from "vitest";
import { leverAdapter } from "../../src/adapters/lever.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const site: SiteConfig = {
  id: "acme-lever",
  name: "Acme",
  url: "https://jobs.lever.co/acme",
  adapter: "lever",
  enabled: true,
};

const settings: CollectSettings = {
  maxPagesPerSource: 100,
  maxJobsPerSource: 5000,
  navigationTimeoutMs: 30000,
  delayBetweenRequestsMs: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const postings = [
  {
    id: "abc-123",
    text: "Network Engineer",
    categories: { commitment: "Full-time", location: "Austin, TX", team: "Infrastructure" },
    hostedUrl: "https://jobs.lever.co/acme/abc-123",
    applyUrl: "https://jobs.lever.co/acme/abc-123/apply",
    descriptionPlain: "5 years of networking experience required.",
    createdAt: 1735689600000,
  },
];

describe("leverAdapter", () => {
  it("canHandle returns true only for lever sites", () => {
    expect(leverAdapter.canHandle(site)).toBe(true);
    expect(leverAdapter.canHandle({ ...site, adapter: "greenhouse" })).toBe(false);
  });

  it("discovers postings and tags matched profiles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(postings)));
    const discovered = await leverAdapter.discoverJobs(
      site,
      [{ keyword: "network", profileIds: ["network"] }],
      settings,
    );
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.matchedProfiles).toEqual(["network"]);
  });

  it("fetchJobDetails + normalize produce a full JobPosting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(postings)));
    const [discovered] = await leverAdapter.discoverJobs(site, [], settings);
    const raw = await leverAdapter.fetchJobDetails(discovered!, site, settings);
    const job = leverAdapter.normalize(raw, site, ["network"]);

    expect(job.sourceType).toBe("lever");
    expect(job.location).toBe("Austin, TX");
    expect(job.department).toBe("Infrastructure");
    expect(job.employmentType).toBe("Full-time");
    expect(job.requiredYears).toBe(5);
    expect(job.applyUrl).toBe("https://jobs.lever.co/acme/abc-123/apply");
  });

  it("throws a clear error on a malformed (non-array) response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ not: "an array" })));
    await expect(leverAdapter.discoverJobs(site, [], settings)).rejects.toThrow(/unexpected/);
  });

  it("throws a clear error when verification is detected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Checking your browser before accessing", { status: 503 })),
    );
    await expect(leverAdapter.discoverJobs(site, [], settings)).rejects.toThrow(/Verification required/);
  });

  it("caps results at maxJobsPerSource", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...postings[0], id: `id-${i}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(many)));
    const discovered = await leverAdapter.discoverJobs(site, [], { ...settings, maxJobsPerSource: 2 });
    expect(discovered).toHaveLength(2);
  });
});

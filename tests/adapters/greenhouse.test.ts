import { afterEach, describe, expect, it, vi } from "vitest";
import { greenhouseAdapter } from "../../src/adapters/greenhouse.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const site: SiteConfig = {
  id: "acme-greenhouse",
  name: "Acme",
  url: "https://boards.greenhouse.io/acme",
  adapter: "greenhouse",
  enabled: true,
};

const settings: CollectSettings = {
  maxPagesPerSource: 100,
  maxJobsPerSource: 5000,
  navigationTimeoutMs: 30000,
  delayBetweenRequestsMs: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("greenhouseAdapter", () => {
  it("canHandle returns true only for greenhouse sites", () => {
    expect(greenhouseAdapter.canHandle(site)).toBe(true);
    expect(greenhouseAdapter.canHandle({ ...site, adapter: "lever" })).toBe(false);
  });

  it("declares fetchesPerJob: false (fetchJobDetails is a pure local transform, no per-job network call)", () => {
    expect(greenhouseAdapter.fetchesPerJob).toBe(false);
  });

  it("discovers jobs from the board and tags matched profiles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobs: [
            {
              id: 1,
              title: "SDET II",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
              location: { name: "Remote" },
              departments: [{ name: "Quality" }],
              content: "<p>5 years of test automation required.</p>",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
            {
              id: 2,
              title: "Barista",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
              content: "<p>Make coffee.</p>",
            },
          ],
        }),
      ),
    );

    const discovered = await greenhouseAdapter.discoverJobs(
      site,
      [{ keyword: "sdet", profileIds: ["sdet"] }],
      settings,
    );

    expect(discovered).toHaveLength(2);
    expect(discovered[0]!.matchedProfiles).toEqual(["sdet"]);
    expect(discovered[1]!.matchedProfiles).toEqual([]);
  });

  it("fetchJobDetails + normalize produce a full JobPosting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobs: [
            {
              id: 1,
              title: "SDET II",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
              location: { name: "Remote" },
              departments: [{ name: "Quality" }],
              content: "<p>5 years of test automation required.</p>",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    const [discovered] = await greenhouseAdapter.discoverJobs(
      site,
      [{ keyword: "sdet", profileIds: ["sdet"] }],
      settings,
    );
    const raw = await greenhouseAdapter.fetchJobDetails(discovered!, site, settings);
    const job = greenhouseAdapter.normalize(raw, site, discovered!.matchedProfiles);

    expect(job.company).toBe("Acme");
    expect(job.sourceType).toBe("greenhouse");
    expect(job.title).toBe("SDET II");
    expect(job.location).toBe("Remote");
    expect(job.department).toBe("Quality");
    expect(job.requisitionId).toBe("1");
    expect(job.descriptionText).toBe("5 years of test automation required.");
    expect(job.requiredYears).toBe(5);
    expect(job.matchedProfiles).toEqual(["sdet"]);
  });

  it("throws a clear error on a malformed (non-JSON) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    await expect(greenhouseAdapter.discoverJobs(site, [], settings)).rejects.toThrow(/non-JSON/);
  });

  it("throws a clear error when a verification challenge is detected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><body>Please verify you are human.</body></html>", { status: 403 }),
      ),
    );
    await expect(greenhouseAdapter.discoverJobs(site, [], settings)).rejects.toThrow(
      /Verification required/,
    );
  });

  it("caps results at maxJobsPerSource", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      title: `Job ${i}`,
      absolute_url: `https://boards.greenhouse.io/acme/jobs/${i}`,
      content: "<p>text</p>",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ jobs })));
    const discovered = await greenhouseAdapter.discoverJobs(site, [], { ...settings, maxJobsPerSource: 2 });
    expect(discovered).toHaveLength(2);
  });

  it("throws when no board token can be determined", async () => {
    const badSite: SiteConfig = { ...site, url: "https://example.com/careers" };
    await expect(greenhouseAdapter.discoverJobs(badSite, [], settings)).rejects.toThrow(
      /board token/,
    );
  });
});

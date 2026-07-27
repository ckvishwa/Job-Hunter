import { afterEach, describe, expect, it, vi } from "vitest";
import { workdayAdapter } from "../../src/adapters/workday.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const site: SiteConfig = {
  id: "acme-workday",
  name: "Acme",
  url: "https://acme.wd1.myworkdayjobs.com/External",
  adapter: "workday",
  enabled: true,
  workday: { hostname: "acme.wd1.myworkdayjobs.com", tenant: "acme", site: "External" },
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

describe("workdayAdapter", () => {
  it("declares fetchesPerJob: true (fetchJobDetails makes a real per-job network call)", () => {
    expect(workdayAdapter.fetchesPerJob).toBe(true);
  });

  it("throws when the site has no workday config block", async () => {
    const badSite: SiteConfig = { ...site, workday: undefined };
    await expect(workdayAdapter.discoverJobs(badSite, [], settings)).rejects.toThrow(
      /no workday config/,
    );
  });

  it("paginates by offset until jobPostings is empty", async () => {
    const page1 = {
      total: 3,
      jobPostings: [
        { title: "SOC Analyst", externalPath: "req-1" },
        { title: "SOC Analyst II", externalPath: "req-2" },
      ],
    };
    const page2 = { total: 3, jobPostings: [{ title: "SOC Lead", externalPath: "req-3" }] };
    const page3 = { total: 3, jobPostings: [] };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))
      .mockResolvedValueOnce(jsonResponse(page3));
    vi.stubGlobal("fetch", fetchMock);

    const discovered = await workdayAdapter.discoverJobs(
      site,
      [{ keyword: "soc", profileIds: ["security"] }],
      settings,
    );

    expect(discovered).toHaveLength(3);
    expect(discovered.every((j) => j.matchedProfiles.includes("security"))).toBe(true);
  });

  it("stops pagination once offset reaches total", async () => {
    const onlyPage = { total: 1, jobPostings: [{ title: "Cloud Engineer", externalPath: "req-1" }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(onlyPage));
    vi.stubGlobal("fetch", fetchMock);

    await workdayAdapter.discoverJobs(site, [{ keyword: "cloud", profileIds: ["cloud"] }], settings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects maxPagesPerSource as a safety cap", async () => {
    const neverEndingPage = {
      total: 999999,
      jobPostings: [{ title: "X", externalPath: "req-x" }],
    };
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse(neverEndingPage));
    vi.stubGlobal("fetch", fetchMock);

    await workdayAdapter.discoverJobs(site, [{ keyword: "x", profileIds: ["cloud"] }], {
      ...settings,
      maxPagesPerSource: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a clear error on an unrecognized response shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => jsonResponse({ unexpected: true })));
    await expect(
      workdayAdapter.discoverJobs(site, [{ keyword: "x", profileIds: [] }], settings),
    ).rejects.toThrow(/unrecognized/);
  });

  it("fetchJobDetails + normalize produce a full JobPosting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobPostingInfo: {
            title: "SOC Analyst",
            jobDescription: "<p>3 years of SOC experience needed.</p>",
            location: "Remote - US",
            timeType: "Full time",
            jobReqId: "R-1234",
            startDate: "2026-01-01",
          },
        }),
      ),
    );

    const job = {
      externalId: "req-1",
      title: "SOC Analyst",
      url: "https://acme.wd1.myworkdayjobs.com/External/job/req-1",
      matchedProfiles: ["security"],
    };
    const raw = await workdayAdapter.fetchJobDetails(job, site, settings);
    const posting = workdayAdapter.normalize(raw, site, ["security"]);

    expect(posting.sourceType).toBe("workday");
    expect(posting.requisitionId).toBe("R-1234");
    expect(posting.requiredYears).toBe(3);
    expect(posting.location).toBe("Remote - US");
  });
});

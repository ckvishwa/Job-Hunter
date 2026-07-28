import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CompanyRegistryEntry } from "../../src/config/schema.js";
import type { DiscoveredJob, RawJobDetail, SourceAdapter } from "../../src/adapters/types.js";
import type { DiscoveryCheckpoint, DiscoveredJobLite } from "../../src/discovery/types.js";

const { discoverJobsA, discoverJobsB, resolveAdapterMock, loadCompanyRegistryMock } = vi.hoisted(() => {
  return {
    discoverJobsA: vi.fn(),
    discoverJobsB: vi.fn(),
    resolveAdapterMock: vi.fn(),
    loadCompanyRegistryMock: vi.fn(),
  };
});

vi.mock("../../src/adapters/registry.js", () => ({
  resolveAdapter: resolveAdapterMock,
}));

vi.mock("../../src/config/loader.js", () => ({
  loadCompanyRegistry: loadCompanyRegistryMock,
}));

// Imported after the mocks above so companyCareersDiscoveryAdapter picks up the mocked deps.
const { companyCareersDiscoveryAdapter } = await import("../../src/discovery/adapters/company-careers.js");

function makeRegistry(): CompanyRegistryEntry[] {
  return [
    {
      company: "CompanyA",
      fortuneRank: null,
      corporateDomain: "companya.com",
      careersUrl: "https://companya.com/careers",
      atsType: "greenhouse",
      atsTenantOrBoardId: "companya",
      atsWorkdaySite: null,
      verificationStatus: "verified",
      lastVerifiedDate: "2026-01-01",
    },
    {
      company: "CompanyB",
      fortuneRank: null,
      corporateDomain: "companyb.com",
      careersUrl: "https://companyb.com/careers",
      atsType: "greenhouse",
      atsTenantOrBoardId: "companyb",
      atsWorkdaySite: null,
      verificationStatus: "verified",
      lastVerifiedDate: "2026-01-01",
    },
  ];
}

function fakeAdapter(discoverJobs: (...args: unknown[]) => Promise<DiscoveredJob[]>): SourceAdapter {
  return {
    sourceType: "greenhouse",
    fetchesPerJob: true, // skip fetchJobDetails path -- not under test here
    canHandle: () => true,
    discoverJobs: discoverJobs as SourceAdapter["discoverJobs"],
    fetchJobDetails: async (): Promise<RawJobDetail> => {
      throw new Error("fetchJobDetails should not be called when fetchesPerJob is true");
    },
    normalize: () => {
      throw new Error("normalize not used by company-careers adapter");
    },
  };
}

function makeCheckpoint(): DiscoveryCheckpoint {
  return {
    key: "company-careers::sdet::us",
    source: "company-careers",
    keyword: "sdet",
    location: "us",
    lastPage: 0,
    completed: false,
    lastUpdated: "2026-01-01",
    sourceJobIds: [],
  };
}

function makeContext(
  checkpoint: DiscoveryCheckpoint,
  onPageProcessed: (jobs: DiscoveredJobLite[], nextPageNum: number) => Promise<void>,
  companyFilter?: string,
) {
  return {
    page: { context: () => ({}) } as unknown as import("playwright").Page,
    keyword: "sdet",
    location: "us",
    settings: { delayBetweenRequestsMs: 0, maxPages: 1, maxDiscoveries: 100 } as unknown as import("../../src/types.js").CollectSettings,
    checkpoint,
    onPageProcessed,
    profileIds: ["sdet-qa"],
    companyFilter,
  };
}

describe("companyCareersDiscoveryAdapter resume behavior", () => {
  beforeEach(() => {
    discoverJobsA.mockReset();
    discoverJobsB.mockReset();
    resolveAdapterMock.mockReset();
    loadCompanyRegistryMock.mockReset();
    loadCompanyRegistryMock.mockReturnValue(makeRegistry());

    resolveAdapterMock.mockImplementation((site: { name: string }) => {
      if (site.name === "CompanyA") {
        return fakeAdapter(discoverJobsA);
      }
      return fakeAdapter(discoverJobsB);
    });
  });

  it("retries a company that failed on run 1, and does not re-process a company that already succeeded", async () => {
    discoverJobsA.mockResolvedValue([
      { externalId: "a1", title: "SDET", url: "https://companya.com/jobs/a1", matchedProfiles: ["sdet-qa"] },
    ]);
    discoverJobsB.mockRejectedValueOnce(new Error("network blip"));

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async () => {});

    // Run 1: CompanyA succeeds, CompanyB fails. discover() should throw so the orchestrator
    // never marks checkpoint.completed = true (which would prevent a future --resume from
    // ever re-entering this adapter).
    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).rejects.toThrow();

    expect(discoverJobsA).toHaveBeenCalledTimes(1);
    expect(discoverJobsB).toHaveBeenCalledTimes(1);
    expect(checkpoint.completedCompanyKeys).toEqual(["companya::companya.com"]); // only CompanyA marked done

    // Run 2 ("--resume"): CompanyB now succeeds.
    discoverJobsB.mockResolvedValueOnce([
      { externalId: "b1", title: "SDET", url: "https://companyb.com/jobs/b1", matchedProfiles: ["sdet-qa"] },
    ]);

    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).resolves.toBeUndefined();

    // CompanyA was already completed -- must not be re-processed.
    expect(discoverJobsA).toHaveBeenCalledTimes(1);
    // CompanyB was retried exactly once more.
    expect(discoverJobsB).toHaveBeenCalledTimes(2);
    expect(checkpoint.completedCompanyKeys).toEqual(
      expect.arrayContaining(["companya::companya.com", "companyb::companyb.com"]),
    );
    expect(checkpoint.completedCompanyKeys).toHaveLength(2);
  });

  it("does not silently lose or misattribute progress when the registry array is reordered between runs", async () => {
    discoverJobsA.mockResolvedValue([
      { externalId: "a1", title: "SDET", url: "https://companya.com/jobs/a1", matchedProfiles: ["sdet-qa"] },
    ]);
    discoverJobsB.mockRejectedValueOnce(new Error("network blip"));

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async () => {});

    // Run 1: CompanyA (index 0) succeeds, CompanyB (index 1) fails.
    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).rejects.toThrow();
    expect(checkpoint.completedCompanyKeys).toEqual(["companya::companya.com"]);

    // Simulate the registry being reordered before the next run (e.g. a new company
    // inserted at the front) -- CompanyB is now at index 0, CompanyA at index 1.
    loadCompanyRegistryMock.mockReturnValue([...makeRegistry()].reverse());
    discoverJobsB.mockResolvedValueOnce([
      { externalId: "b1", title: "SDET", url: "https://companyb.com/jobs/b1", matchedProfiles: ["sdet-qa"] },
    ]);

    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).resolves.toBeUndefined();

    // Keyed by identity, not position: CompanyA (still completed, now at index 1) must NOT
    // be re-processed just because it moved; CompanyB (now at index 0) must still be retried.
    expect(discoverJobsA).toHaveBeenCalledTimes(1);
    expect(discoverJobsB).toHaveBeenCalledTimes(2);
  });
});

describe("companyCareersDiscoveryAdapter real-data extraction and structural skips", () => {
  beforeEach(() => {
    discoverJobsA.mockReset();
    discoverJobsB.mockReset();
    resolveAdapterMock.mockReset();
    loadCompanyRegistryMock.mockReset();
  });

  it("uses fetchJobDetails for the real location instead of fabricating one (greenhouse)", async () => {
    const registry: CompanyRegistryEntry[] = [
      {
        company: "CompanyA",
        fortuneRank: null,
        corporateDomain: "companya.com",
        careersUrl: "https://companya.com/careers",
        atsType: "greenhouse",
        atsTenantOrBoardId: "companya",
        atsWorkdaySite: null,
        verificationStatus: "verified",
        lastVerifiedDate: "2026-01-01",
      },
    ];
    loadCompanyRegistryMock.mockReturnValue(registry);

    discoverJobsA.mockResolvedValue([
      { externalId: "a1", title: "SDET", url: "https://companya.com/jobs/a1", matchedProfiles: ["sdet-qa"] },
    ]);
    const fetchJobDetails = vi.fn(async (): Promise<RawJobDetail> => ({
      externalId: "a1",
      title: "SDET",
      descriptionText: "desc",
      descriptionHtml: null,
      location: "Austin, TX",
      department: null,
      employmentType: null,
      requisitionId: null,
      postingDate: null,
      salaryText: null,
      canonicalUrl: "https://companya.com/jobs/a1",
      applyUrl: "https://companya.com/jobs/a1",
      rawMetadata: {},
    }));

    resolveAdapterMock.mockImplementation(
      (): SourceAdapter => ({
        sourceType: "greenhouse",
        fetchesPerJob: false, // exercises the fetchJobDetails-for-real-location path
        canHandle: () => true,
        discoverJobs: discoverJobsA as SourceAdapter["discoverJobs"],
        fetchJobDetails,
        normalize: () => {
          throw new Error("normalize not used by company-careers adapter");
        },
      }),
    );

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async (_jobs: DiscoveredJobLite[], _nextPageNum: number) => {});

    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).resolves.toBeUndefined();

    expect(fetchJobDetails).toHaveBeenCalledTimes(1);
    const [jobs] = onPageProcessed.mock.calls[0] as [DiscoveredJobLite[], number];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.location).toBe("Austin, TX");
  });

  it("skips a workday entry with atsWorkdaySite: null without calling any adapter, and marks it completed", async () => {
    const registry: CompanyRegistryEntry[] = [
      {
        company: "CompanyW",
        fortuneRank: null,
        corporateDomain: "companyw.com",
        careersUrl: "https://companyw.com/careers",
        atsType: "workday",
        atsTenantOrBoardId: null,
        atsWorkdaySite: null,
        verificationStatus: "unverified",
        lastVerifiedDate: null,
      },
    ];
    loadCompanyRegistryMock.mockReturnValue(registry);

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async (_jobs: DiscoveredJobLite[], _nextPageNum: number) => {});

    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).resolves.toBeUndefined();

    expect(resolveAdapterMock).not.toHaveBeenCalled();
    const [jobs] = onPageProcessed.mock.calls[0] as [DiscoveredJobLite[], number];
    expect(jobs).toEqual([]);
    expect(checkpoint.completedCompanyKeys).toEqual(["companyw::companyw.com"]);
  });

  it("skips a generic entry with no genericSelectors without calling any adapter, and marks it completed", async () => {
    const registry: CompanyRegistryEntry[] = [
      {
        company: "CompanyG",
        fortuneRank: null,
        corporateDomain: "companyg.com",
        careersUrl: "https://companyg.com/careers",
        atsType: "generic",
        atsTenantOrBoardId: null,
        atsWorkdaySite: null,
        // genericSelectors intentionally omitted
        verificationStatus: "unverified",
        lastVerifiedDate: null,
      },
    ];
    loadCompanyRegistryMock.mockReturnValue(registry);

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async (_jobs: DiscoveredJobLite[], _nextPageNum: number) => {});

    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed)),
    ).resolves.toBeUndefined();

    expect(resolveAdapterMock).not.toHaveBeenCalled();
    const [jobs] = onPageProcessed.mock.calls[0] as [DiscoveredJobLite[], number];
    expect(jobs).toEqual([]);
    expect(checkpoint.completedCompanyKeys).toEqual(["companyg::companyg.com"]);
  });
});

describe("companyCareersDiscoveryAdapter --company filter", () => {
  beforeEach(() => {
    discoverJobsA.mockReset();
    discoverJobsB.mockReset();
    resolveAdapterMock.mockReset();
    loadCompanyRegistryMock.mockReset();
    loadCompanyRegistryMock.mockReturnValue(makeRegistry());

    resolveAdapterMock.mockImplementation((site: { name: string }) => {
      if (site.name === "CompanyA") {
        return fakeAdapter(discoverJobsA);
      }
      return fakeAdapter(discoverJobsB);
    });
  });

  it("only attempts the matching company, case-insensitively, and doesn't throw for the filtered-out one", async () => {
    discoverJobsA.mockResolvedValue([
      { externalId: "a1", title: "SDET", url: "https://companya.com/jobs/a1", matchedProfiles: ["sdet-qa"] },
    ]);

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async () => {});

    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed, "companya")),
    ).resolves.toBeUndefined();

    // Only CompanyA was attempted; CompanyB was filtered out, never called.
    expect(discoverJobsA).toHaveBeenCalledTimes(1);
    expect(discoverJobsB).not.toHaveBeenCalled();
    // Only the matching company is marked completed -- the filtered-out one is not attempted,
    // not counted as ready/skipped, and doesn't trigger the "not completed" throw.
    expect(checkpoint.completedCompanyKeys).toEqual(["companya::companya.com"]);
  });

  it("processes the previously filtered-out company on a later run with a different --company", async () => {
    discoverJobsA.mockResolvedValue([
      { externalId: "a1", title: "SDET", url: "https://companya.com/jobs/a1", matchedProfiles: ["sdet-qa"] },
    ]);
    discoverJobsB.mockResolvedValue([
      { externalId: "b1", title: "SDET", url: "https://companyb.com/jobs/b1", matchedProfiles: ["sdet-qa"] },
    ]);

    const checkpoint = makeCheckpoint();
    const onPageProcessed = vi.fn(async () => {});

    // Run 1: filter to CompanyA only.
    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed, "CompanyA")),
    ).resolves.toBeUndefined();
    expect(checkpoint.completedCompanyKeys).toEqual(["companya::companya.com"]);

    // Run 2 ("--resume"): filter to CompanyB. CompanyA stays completed (not re-attempted);
    // CompanyB, previously filtered out, is now attempted and completes.
    await expect(
      companyCareersDiscoveryAdapter.discover(makeContext(checkpoint, onPageProcessed, "CompanyB")),
    ).resolves.toBeUndefined();

    expect(discoverJobsA).toHaveBeenCalledTimes(1);
    expect(discoverJobsB).toHaveBeenCalledTimes(1);
    expect(checkpoint.completedCompanyKeys).toEqual(
      expect.arrayContaining(["companya::companya.com", "companyb::companyb.com"]),
    );
    expect(checkpoint.completedCompanyKeys).toHaveLength(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createGenericPlaywrightAdapter,
  validateGenericSelectors,
} from "../../src/adapters/generic-playwright.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const baseSite: SiteConfig = {
  id: "acme-generic",
  name: "Acme",
  url: "https://acme.com/careers",
  adapter: "generic",
  enabled: true,
  generic: {
    searchInputSelector: "#search",
    searchButtonSelector: "#go",
    resultCardSelector: ".card",
    jobLinkSelector: ".card a",
    loadMoreSelector: ".load-more",
    titleSelector: "h1",
    locationSelector: ".loc",
    descriptionSelector: ".desc",
    applyLinkSelector: "a.apply",
  },
};

const settings: CollectSettings = {
  maxPagesPerSource: 5,
  maxJobsPerSource: 100,
  navigationTimeoutMs: 1000,
  delayBetweenRequestsMs: 0,
};

describe("validateGenericSelectors", () => {
  it("throws naming the missing key when a required selector is absent", () => {
    const badSite = { ...baseSite, generic: { ...baseSite.generic!, titleSelector: "" as unknown as string } };
    delete (badSite.generic as Record<string, unknown>).titleSelector;
    expect(() => validateGenericSelectors(badSite)).toThrow(/titleSelector/);
  });

  it("throws when the generic block is entirely missing", () => {
    expect(() => validateGenericSelectors({ ...baseSite, generic: undefined })).toThrow(
      /no generic selector block/,
    );
  });

  it("passes for a fully configured selector block", () => {
    expect(() => validateGenericSelectors(baseSite)).not.toThrow();
  });
});

function makeFakePage(script: {
  linkBatches: string[][];
  hasLoadMoreAfterBatch: boolean[];
}) {
  let callIndex = 0;
  const clicked: string[] = [];

  const page = {
    url: () => "https://acme.com/careers",
    content: async () => "<html>no captcha here</html>",
    title: async () => "Careers",
    goto: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockImplementation(async (selector: string) => {
      clicked.push(selector);
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn().mockImplementation(async () => {
      const batch = script.linkBatches[Math.min(callIndex, script.linkBatches.length - 1)];
      return batch;
    }),
    $eval: vi.fn().mockResolvedValue("value"),
    $: vi.fn().mockImplementation(async (selector: string) => {
      const hasMore = script.hasLoadMoreAfterBatch[callIndex] ?? false;
      callIndex += 1;
      return hasMore ? { click: vi.fn().mockResolvedValue(undefined) } : null;
    }),
  };
  return { page, clicked };
}

describe("createGenericPlaywrightAdapter", () => {
  it("stops pagination when no load-more button remains", async () => {
    const { page } = makeFakePage({
      linkBatches: [
        ["https://acme.com/jobs/1", "https://acme.com/jobs/2"],
        ["https://acme.com/jobs/1", "https://acme.com/jobs/2", "https://acme.com/jobs/3"],
      ],
      hasLoadMoreAfterBatch: [true, false],
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };

    const adapter = createGenericPlaywrightAdapter({ context: context as never });
    const discovered = await adapter.discoverJobs(
      baseSite,
      [{ keyword: "sdet", profileIds: ["sdet"] }],
      settings,
    );

    expect(discovered.length).toBeGreaterThanOrEqual(2);
    expect(discovered.every((j) => j.matchedProfiles.includes("sdet"))).toBe(true);
  });

  it("extracts title/location/description via configured selectors", async () => {
    const { page } = makeFakePage({ linkBatches: [[]], hasLoadMoreAfterBatch: [false] });
    page.$eval = vi
      .fn()
      .mockResolvedValueOnce("SDET II")
      .mockResolvedValueOnce("Remote")
      .mockResolvedValueOnce("<p>Great job</p>")
      .mockResolvedValueOnce("https://acme.com/jobs/1/apply");
    const context = { newPage: vi.fn().mockResolvedValue(page) };

    const adapter = createGenericPlaywrightAdapter({ context: context as never });
    const raw = await adapter.fetchJobDetails(
      { externalId: "https://acme.com/jobs/1", title: "", url: "https://acme.com/jobs/1", matchedProfiles: [] },
      baseSite,
      settings,
    );

    expect(raw.title).toBe("SDET II");
    expect(raw.location).toBe("Remote");
    expect(raw.descriptionText).toBe("Great job");
    expect(raw.applyUrl).toBe("https://acme.com/jobs/1/apply");
  });

  it("normalize produces a full JobPosting", () => {
    const context = { newPage: vi.fn() };
    const adapter = createGenericPlaywrightAdapter({ context: context as never });
    const posting = adapter.normalize(
      {
        externalId: "https://acme.com/jobs/1",
        title: "SDET II",
        descriptionText: "5 years required",
        descriptionHtml: "<p>5 years required</p>",
        location: "Remote",
        department: null,
        employmentType: null,
        requisitionId: null,
        postingDate: null,
        salaryText: null,
        canonicalUrl: "https://acme.com/jobs/1",
        applyUrl: "https://acme.com/jobs/1",
        rawMetadata: {},
      },
      baseSite,
      ["sdet"],
    );
    expect(posting.sourceType).toBe("generic");
    expect(posting.requiredYears).toBe(5);
    expect(posting.matchedProfiles).toEqual(["sdet"]);
  });
});

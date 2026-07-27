import { describe, expect, it, vi } from "vitest";
import { indeedDiscoveryAdapter } from "../../src/discovery/adapters/indeed.js";
import { monsterDiscoveryAdapter } from "../../src/discovery/adapters/monster.js";
import { linkedinPublicDiscoveryAdapter } from "../../src/discovery/adapters/linkedin-public.js";
import { googleJobsDiscoveryAdapter } from "../../src/discovery/adapters/google-jobs.js";
import { configurableGenericPortalAdapter } from "../../src/discovery/adapters/configurable-generic-portal.js";
import type { DiscoveryCheckpoint, DiscoveredJobLite, DiscoveryContext } from "../../src/discovery/types.js";
import type { CollectSettings, SiteConfig } from "../../src/types.js";

const settings: CollectSettings = {
  maxPagesPerSource: 2,
  maxJobsPerSource: 10,
  navigationTimeoutMs: 1000,
  delayBetweenRequestsMs: 0,
};

function makeFakeCard(overrides: Record<string, string> = {}) {
  return {
    $eval: vi.fn().mockImplementation(async (selector: string, fn: (el: any) => any) => {
      const lower = selector.toLowerCase();
      if (
        lower.includes("jcs-jobtitle") ||
        lower.includes("link") ||
        selector === "a" ||
        lower.includes("href") ||
        lower.startsWith("a.") ||
        lower.includes("a.title")
      ) {
        return fn({ href: overrides.href || "https://example.com/job/123" });
      }
      if (lower.includes("title") || lower.includes("h2") || lower.includes("h3") || lower.includes("heading")) {
        return fn({ textContent: overrides.title || "Software Engineer" });
      }
      if (lower.includes("company") || lower.includes("subtitle") || lower.includes("h4")) {
        return fn({ textContent: overrides.company || "Acme Corp" });
      }
      if (lower.includes("location") || lower.includes("loc")) {
        return fn({ textContent: overrides.location || "Remote" });
      }
      if (lower.includes("salary")) {
        return fn({ textContent: overrides.salary || "$120k - $140k" });
      }
      if (lower.includes("date") || lower.includes("time")) {
        return fn({ textContent: overrides.date || "2 days ago" });
      }
      return "";
    }),
    getAttribute: vi.fn().mockImplementation(async (attr: string) => {
      if (attr === "data-job-id" || attr === "data-entity-urn" || attr === "id") {
        return overrides.jobId || "jk_123";
      }
      return null;
    }),
  };
}

function makeFakePage(cards: any[], contentText = "<html></html>") {
  return {
    url: () => "https://example.com/jobs",
    content: async () => contentText,
    title: async () => "Job Board",
    goto: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    $$: vi.fn().mockResolvedValue(cards),
    $eval: vi.fn().mockResolvedValue(""),
    $: vi.fn().mockResolvedValue({
      click: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue(undefined),
    }),
    evaluate: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue({
      newPage: vi.fn(),
    }),
  };
}

describe("Indeed Discovery Adapter", () => {
  it("paginates and extracts listings correctly", async () => {
    const cards = [makeFakeCard({ title: "SDET", company: "Acme", href: "https://indeed.com/viewjob?jk=123", jobId: "123" })];
    const page = makeFakePage(cards);
    
    const checkpoint: DiscoveryCheckpoint = {
      key: "indeed::sdet::us",
      source: "indeed",
      keyword: "sdet",
      location: "us",
      lastPage: 0,
      completed: false,
      lastUpdated: "",
      sourceJobIds: [],
    };

    const processed: DiscoveredJobLite[] = [];
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "sdet",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async (jobs) => {
        processed.push(...jobs);
      },
    };

    await indeedDiscoveryAdapter.discover(context);

    expect(page.goto).toHaveBeenCalled();
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("SDET");
    expect(processed[0]!.company).toBe("Acme");
    expect(processed[0]!.sourceJobId).toBe("123");
  });
});

describe("Monster Discovery Adapter", () => {
  it("extracts listings correctly", async () => {
    const cards = [makeFakeCard({ title: "Security Analyst", company: "SecureCo", href: "https://monster.com/jobs/123", jobId: "123" })];
    const page = makeFakePage(cards);
    
    const checkpoint: DiscoveryCheckpoint = {
      key: "monster::security::us",
      source: "monster",
      keyword: "security",
      location: "us",
      lastPage: 0,
      completed: false,
      lastUpdated: "",
      sourceJobIds: [],
    };

    const processed: DiscoveredJobLite[] = [];
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "security",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async (jobs) => {
        processed.push(...jobs);
      },
    };

    await monsterDiscoveryAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Security Analyst");
  });
});

describe("LinkedIn Public Discovery Adapter", () => {
  it("extracts listings correctly", async () => {
    const cards = [makeFakeCard({ title: "Cloud Engineer", company: "Cloudy", href: "https://linkedin.com/jobs/view/789", jobId: "789" })];
    const page = makeFakePage(cards);
    
    const checkpoint: DiscoveryCheckpoint = {
      key: "linkedin-public::cloud::us",
      source: "linkedin-public",
      keyword: "cloud",
      location: "us",
      lastPage: 0,
      completed: false,
      lastUpdated: "",
      sourceJobIds: [],
    };

    const processed: DiscoveredJobLite[] = [];
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "cloud",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async (jobs) => {
        processed.push(...jobs);
      },
    };

    await linkedinPublicDiscoveryAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Cloud Engineer");
  });
});

describe("Google Jobs Discovery Adapter", () => {
  it("extracts and scrolls to load listings", async () => {
    const cards = [makeFakeCard({ title: "Network Admin", company: "NetCo", jobId: "net_1" })];
    const page = makeFakePage(cards);
    
    const checkpoint: DiscoveryCheckpoint = {
      key: "google-jobs::network::us",
      source: "google-jobs",
      keyword: "network",
      location: "us",
      lastPage: 0,
      completed: false,
      lastUpdated: "",
      sourceJobIds: [],
    };

    const processed: DiscoveredJobLite[] = [];
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "network",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async (jobs) => {
        processed.push(...jobs);
      },
    };

    await googleJobsDiscoveryAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Network Admin");
  });
});

describe("Configurable Generic Portal Adapter", () => {
  it("extracts listings based on custom selectors", async () => {
    const cards = [makeFakeCard({ title: "SDET Custom", company: "Acme", href: "https://custom.com/job/1", jobId: "1" })];
    const page = makeFakePage(cards);
    
    const siteConfig: SiteConfig = {
      id: "custom-portal",
      name: "Custom Portal",
      url: "https://custom.com/search",
      adapter: "generic",
      enabled: true,
      generic: {
        searchInputSelector: "#q",
        searchButtonSelector: "#submit",
        resultCardSelector: ".job-item",
        jobLinkSelector: "a.title",
        titleSelector: "h3",
        locationSelector: ".loc",
        descriptionSelector: ".desc",
      },
    };

    const checkpoint: DiscoveryCheckpoint = {
      key: "custom-portal::sdet::us",
      source: "custom-portal",
      keyword: "sdet",
      location: "us",
      lastPage: 0,
      completed: false,
      lastUpdated: "",
      sourceJobIds: [],
    };

    const processed: DiscoveredJobLite[] = [];
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "sdet",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async (jobs: DiscoveredJobLite[]) => {
        processed.push(...jobs);
      },
      siteConfig,
    } as any;

    await configurableGenericPortalAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("SDET Custom");
  });
});

import { describe, expect, it, vi } from "vitest";
import { indeedDiscoveryAdapter } from "../../src/discovery/adapters/indeed.js";
import { monsterDiscoveryAdapter } from "../../src/discovery/adapters/monster.js";
import { linkedinPublicDiscoveryAdapter } from "../../src/discovery/adapters/linkedin-public.js";
import { googleJobsDiscoveryAdapter } from "../../src/discovery/adapters/google-jobs.js";
import { configurableGenericPortalAdapter } from "../../src/discovery/adapters/configurable-generic-portal.js";
import type { DiscoveryCheckpoint, DiscoveredJobLite, DiscoveryContext } from "../../src/discovery/types.js";
import type { CollectSettings, SiteConfig } from "../../src/types.js";
import type { PortalConfig } from "../../src/config/schema.js";

const settings: CollectSettings = {
  maxPagesPerSource: 2,
  maxJobsPerSource: 10,
  navigationTimeoutMs: 1000,
  delayBetweenRequestsMs: 0,
};

// Shared defaults for the zod-defaulted PortalConfig fields (maxPages, maxDiscoveries,
// navigationTimeoutMs, delayBetweenActionsMs, requiresLogin, onVerification) -- these are
// required in the inferred PortalConfig type because the schema applies `.default(...)`.
function makePortalConfig(overrides: Partial<PortalConfig> & Pick<PortalConfig, "id" | "type" | "baseUrl" | "resultCardSelector" | "titleSelector" | "locationSelector">): PortalConfig {
  return {
    enabled: false,
    maxPages: 10,
    maxDiscoveries: 500,
    navigationTimeoutMs: 30000,
    delayBetweenActionsMs: 0,
    requiresLogin: false,
    onVerification: "pause",
    ...overrides,
  };
}

// Values below mirror config/portals.yml's real entries (extracted, not invented) so these
// tests exercise the real config shape, not a hardcoded fallback.
const indeedPortalConfig = makePortalConfig({
  id: "indeed",
  type: "indeed",
  baseUrl: "https://www.indeed.com/jobs",
  keywordParam: "q",
  locationParam: "l",
  resultCardSelector: ".job_seen_beacon",
  jobLinkSelector: "a.jcs-JobTitle",
  titleSelector: "span[id^='jobTitle']",
  locationSelector: "[data-testid='text-location']",
  companySelector: "[data-testid='company-name']",
  salarySelector: ".salary-snippet-container, .estimated-salary-container",
  dateSelector: "span.date",
});

const monsterPortalConfig = makePortalConfig({
  id: "monster",
  type: "monster",
  baseUrl: "https://www.monster.com/jobs/search",
  keywordParam: "q",
  locationParam: "where",
  resultCardSelector: "article, [data-testid='job-card'], [class*='JobCard']",
  jobLinkSelector: "a",
  titleSelector: "[data-testid='job-title'], [class*='Title'], h2",
  locationSelector: "[data-testid='job-location'], [class*='Location']",
  companySelector: "[data-testid='job-company'], [class*='Company']",
  salarySelector: "[data-testid='job-salary'], [class*='Salary']",
  dateSelector: "[data-testid='job-date'], [class*='Date']",
});

const linkedinPortalConfig = makePortalConfig({
  id: "linkedin-public",
  type: "linkedin-public",
  baseUrl: "https://www.linkedin.com/jobs/search",
  keywordParam: "keywords",
  locationParam: "location",
  resultCardSelector: ".job-search-card, .base-search-card, li[data-id]",
  jobLinkSelector: "a.base-card__full-link, a",
  titleSelector: ".base-search-card__title, h3",
  locationSelector: ".job-search-card__location, span[class*='location']",
  companySelector: ".base-search-card__subtitle, h4, [class*='subtitle']",
  salarySelector: ".job-search-card__salary-info",
  dateSelector: "time, .job-search-card__listdate",
});

const googleJobsPortalConfig = makePortalConfig({
  id: "google-jobs",
  type: "google-jobs",
  baseUrl: "https://www.google.com/search",
  keywordParam: "q",
  resultCardSelector: "li[data-job-id], [role='treeitem'], .i3PoEe, [class*='JobCard']",
  titleSelector: "[role='heading'], [class*='Title'], h2, h3",
  locationSelector: ".SuWscb, .Qk3OTc, [class*='Location'], [class*='location']",
  companySelector: ".t7YFBb, .wTabPo, [class*='Company'], [class*='company']",
  salarySelector: "[class*='Salary'], [class*='salary']",
  dateSelector: "[class*='Date'], [class*='date'], span:has-text('ago')",
});

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
      profileIds: ["sdet"],
      portalConfig: indeedPortalConfig,
    };

    await indeedDiscoveryAdapter.discover(context);

    expect(page.goto).toHaveBeenCalled();
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("SDET");
    expect(processed[0]!.company).toBe("Acme");
    expect(processed[0]!.sourceJobId).toBe("123");
  });

  it("throws a clear error when no portalConfig is provided", async () => {
    const page = makeFakePage([]);
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
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "sdet",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async () => undefined,
      profileIds: ["sdet"],
    };

    await expect(indeedDiscoveryAdapter.discover(context)).rejects.toThrow(/portalConfig/);
  });

  it("reads selector/URL values from portalConfig rather than a hardcoded fallback", async () => {
    const cards = [makeFakeCard({ title: "Custom Title", company: "Custom Co", href: "https://custom.example.com/job/999?jk=999", jobId: "999" })];
    const page = makeFakePage(cards);

    const customPortalConfig = makePortalConfig({
      id: "indeed",
      type: "indeed",
      baseUrl: "https://custom.example.com/search",
      keywordParam: "kw",
      locationParam: "loc",
      resultCardSelector: ".custom-job-card",
      jobLinkSelector: ".custom-job-link",
      titleSelector: ".custom-title",
      locationSelector: ".custom-location",
      companySelector: ".custom-company",
    });

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
      profileIds: ["sdet"],
      portalConfig: customPortalConfig,
    };

    await indeedDiscoveryAdapter.discover(context);

    // Proves the adapter actually read the custom config values, not a lingering hardcoded
    // literal: the card selector passed to page.$$ is the custom one, not ".job_seen_beacon".
    expect(page.$$).toHaveBeenCalledWith(".custom-job-card");
    expect(page.$$).not.toHaveBeenCalledWith(".job_seen_beacon");
    // The goto URL uses the custom baseUrl + custom param names, not indeed.com/q/l.
    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(gotoUrl).toContain("https://custom.example.com/search?kw=sdet&loc=us");
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Custom Title");
    expect(processed[0]!.company).toBe("Custom Co");
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
      profileIds: ["security"],
      portalConfig: monsterPortalConfig,
    };

    await monsterDiscoveryAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Security Analyst");
  });

  it("throws a clear error when no portalConfig is provided", async () => {
    const page = makeFakePage([]);
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
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "security",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async () => undefined,
      profileIds: ["security"],
    };

    await expect(monsterDiscoveryAdapter.discover(context)).rejects.toThrow(/portalConfig/);
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
      profileIds: ["cloud"],
      portalConfig: linkedinPortalConfig,
    };

    await linkedinPublicDiscoveryAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Cloud Engineer");
  });

  it("throws a clear error when no portalConfig is provided", async () => {
    const page = makeFakePage([]);
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
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "cloud",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async () => undefined,
      profileIds: ["cloud"],
    };

    await expect(linkedinPublicDiscoveryAdapter.discover(context)).rejects.toThrow(/portalConfig/);
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
      profileIds: ["network"],
      portalConfig: googleJobsPortalConfig,
    };

    await googleJobsDiscoveryAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("Network Admin");
  });

  it("throws a clear error when no portalConfig is provided", async () => {
    const page = makeFakePage([]);
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
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "network",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async () => undefined,
      profileIds: ["network"],
    };

    await expect(googleJobsDiscoveryAdapter.discover(context)).rejects.toThrow(/portalConfig/);
  });
});

describe("Configurable Generic Portal Adapter", () => {
  it("extracts listings based on custom selectors from sites.yml's SiteConfig.generic", async () => {
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
      profileIds: ["sdet"],
    };

    await configurableGenericPortalAdapter.discover(context);
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("SDET Custom");
  });

  it("extracts listings based on a portals.yml-driven generic PortalConfig", async () => {
    const cards = [makeFakeCard({ title: "QA Custom", company: "Beta Corp", href: "https://example-generic.com/job/42", jobId: "42" })];
    const page = makeFakePage(cards);

    const portalConfig: PortalConfig = makePortalConfig({
      id: "example-generic-portal",
      type: "generic",
      baseUrl: "https://example-generic.com/jobs/search",
      searchInputSelector: "#search-input",
      searchButtonSelector: "#search-button",
      resultCardSelector: ".generic-job-card",
      jobLinkSelector: "a.generic-link",
      titleSelector: ".generic-title",
      locationSelector: ".generic-location",
      companySelector: ".generic-company",
    });

    const checkpoint: DiscoveryCheckpoint = {
      key: "example-generic-portal::sdet::us",
      source: "example-generic-portal",
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
      portalConfig,
      profileIds: ["sdet"],
    };

    await configurableGenericPortalAdapter.discover(context);

    expect(page.$$).toHaveBeenCalledWith(".generic-job-card");
    expect(processed).toHaveLength(1);
    expect(processed[0]!.title).toBe("QA Custom");
    expect(processed[0]!.company).toBe("Beta Corp");
    expect(processed[0]!.source).toBe("example-generic-portal");
  });

  it("throws a clear error when neither portalConfig nor siteConfig is provided", async () => {
    const page = makeFakePage([]);
    const checkpoint: DiscoveryCheckpoint = {
      key: "unknown::sdet::us",
      source: "unknown",
      keyword: "sdet",
      location: "us",
      lastPage: 0,
      completed: false,
      lastUpdated: "",
      sourceJobIds: [],
    };
    const context: DiscoveryContext = {
      page: page as any,
      keyword: "sdet",
      location: "us",
      settings,
      checkpoint,
      onPageProcessed: async () => undefined,
      profileIds: ["sdet"],
    };

    await expect(configurableGenericPortalAdapter.discover(context)).rejects.toThrow(
      /requires either portalConfig or siteConfig/,
    );
  });
});

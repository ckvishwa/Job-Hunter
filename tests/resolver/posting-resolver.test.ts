import { describe, expect, it, vi, beforeEach } from "vitest";
import { PostingResolver, resolveRedirects } from "../../src/resolver/posting-resolver.js";
import type { DiscoveredJobLite } from "../../src/discovery/types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

vi.stubGlobal("fetch", vi.fn());

describe("PostingResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves basic redirects using fetch", async () => {
    const mockRes = {
      url: "https://careers.google.com/jobs/results/123",
      ok: true,
      json: async () => ({}),
    };
    (fetch as any).mockResolvedValue(mockRes);

    const resolved = await resolveRedirects("https://indeed.com/rc/clk?jk=123");
    expect(resolved).toBe("https://careers.google.com/jobs/results/123");
  });

  it("resolves and extracts using ATS adapter when matched in registry", async () => {
    const job: DiscoveredJobLite = {
      source: "indeed",
      searchKeyword: "sdet",
      title: "QA Automation",
      company: "AHEAD",
      location: "Remote",
      salarySnippet: null,
      resultUrl: "https://jobs.lever.co/thinkahead/123",
      possibleOfficialUrl: null,
      postingAgeOrDate: null,
      sourceJobId: "123",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      matchedProfiles: ["sdet"],
    };

    // Mock fetch for redirect resolution & API info
    const mockRes = {
      url: "https://jobs.lever.co/thinkahead/123",
      ok: true,
      json: async () => ({
        id: "123",
        text: "QA Automation",
        hostedUrl: "https://jobs.lever.co/thinkahead/123",
        description: "We are looking for QA Automation",
        descriptionPlain: "We are looking for QA Automation",
        categories: { location: "Remote" },
        applyUrl: "https://jobs.lever.co/thinkahead/123/apply",
      }),
    };
    (fetch as any).mockResolvedValue(mockRes);

    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue("<html>no captcha</html>"),
      title: vi.fn().mockResolvedValue("QA Automation"),
      close: vi.fn().mockResolvedValue(undefined),
      url: () => "https://jobs.lever.co/thinkahead/123",
    };

    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };

    const resolver = new PostingResolver();
    const resolved = await resolver.resolve(job, mockContext as any);

    expect(resolved).not.toBeNull();
    expect(resolved!.company).toBe("AHEAD");
    expect(resolved!.sourceType).toBe("company-careers");
    expect(resolved!.canonicalUrl).toBe("https://jobs.lever.co/thinkahead/123");
  });

  it("extracts using fallback scraping when no ATS matches", async () => {
    const job: DiscoveredJobLite = {
      source: "linkedin-public",
      searchKeyword: "security",
      title: "Security Analyst",
      company: "Unknown Corp",
      location: "New York",
      salarySnippet: null,
      resultUrl: "https://unknown.com/careers/456",
      possibleOfficialUrl: null,
      postingAgeOrDate: null,
      sourceJobId: "456",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      matchedProfiles: ["security"],
    };

    // Mock fetch to return same URL (no redirect)
    (fetch as any).mockImplementation(async (url: string) => ({
      url,
      ok: true,
      json: async () => ({}),
    }));

    const mockPage = {
      goto: vi.fn().mockResolvedValue(undefined),
      content: vi.fn().mockResolvedValue("<html>no captcha</html>"),
      title: vi.fn().mockResolvedValue("Security Analyst at Unknown Corp"),
      close: vi.fn().mockResolvedValue(undefined),
      url: () => "https://unknown.com/careers/456",
      evaluate: vi.fn().mockResolvedValue("<div class='description'>This is a job description for Security Analyst.</div>"),
    };

    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
    };

    const resolver = new PostingResolver();
    const resolved = await resolver.resolve(job, mockContext as any);

    expect(resolved).not.toBeNull();
    expect(resolved!.company).toBe("Unknown Corp");
    expect(resolved!.sourceType).toBe("portal");
    expect(resolved!.descriptionText).toContain("This is a job description");
  });
});

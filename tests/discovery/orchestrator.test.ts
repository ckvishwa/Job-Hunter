import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { DiscoveryContext, PortalDiscoveryAdapter } from "../../src/discovery/types.js";

// Task 12 scope only: verify keyword/profile orchestration wiring against the real
// config/roles.yml (+ real, all-disabled config/sites.yml and config/portals.yml, which
// collapse targetSources down to just ["company-careers"] -- confirmed during the Task 7
// review). The fake adapter below stands in for company-careers.ts entirely so its own
// internals (registry loading, ATS delegation) never execute; that's already covered by
// tests/discovery/company-careers.test.ts. Task 13 will add the rest of this file's coverage
// (portal failure isolation, browser lifecycle, incremental checkpoint saves, dry-run).

const { discoverMock } = vi.hoisted(() => ({ discoverMock: vi.fn() }));

vi.mock("../../src/discovery/registry.js", () => ({
  resolveDiscoveryAdapter: (): PortalDiscoveryAdapter => ({
    source: "company-careers",
    discover: discoverMock,
  }),
}));

// Imported after the mock above so the orchestrator picks up the mocked registry.
const { runDiscover } = await import("../../src/discovery/orchestrator.js");

function fakeLaunchFn(): Promise<BrowserContext> {
  const fakePage = { close: vi.fn(async () => {}) } as unknown as Page;
  const fakeContext = {
    newPage: vi.fn(async () => fakePage),
    close: vi.fn(async () => {}),
  } as unknown as BrowserContext;
  return Promise.resolve(fakeContext);
}

function makePaths() {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-orchestrator-"));
  return {
    sitesConfigPath: path.resolve("config/sites.yml"),
    rolesConfigPath: path.resolve("config/roles.yml"),
    portalsConfigPath: path.resolve("config/portals.yml"),
    discoveredJobsPath: path.join(dir, "discovered-jobs.jsonl"),
    jobsStorePath: path.join(dir, "jobs.jsonl"),
    checkpointsPath: path.join(dir, "checkpoints.json"),
  };
}

const ROLE_KEYWORDS: Record<string, string[]> = {
  sdet: [
    "SDET",
    "QA Automation Engineer",
    "Software Development Engineer in Test",
    "Test Automation Engineer",
  ],
  security: [
    "SOC Analyst",
    "Security Analyst",
    "Security Operations Center",
    "Incident Response Analyst",
  ],
  cloud: [
    "IAM Engineer",
    "Cloud Security Engineer",
    "Identity and Access Management",
    "Cloud Engineer",
  ],
  network: [
    "NOC Engineer",
    "Network Engineer",
    "Network Operations Center",
    "Network Administrator",
  ],
};

const ALL_KEYWORDS = Object.values(ROLE_KEYWORDS).flat();

describe("orchestrator keyword/profile wiring (Task 12)", () => {
  let calls: { keyword: string; profileIds: string[] }[] = [];

  beforeEach(() => {
    calls = [];
    discoverMock.mockReset();
    discoverMock.mockImplementation(async (context: DiscoveryContext) => {
      calls.push({ keyword: context.keyword, profileIds: context.profileIds });
    });
  });

  it("runs all 4 profiles' full keyword sets when no profile filter is given", async () => {
    await runDiscover(makePaths(), {}, fakeLaunchFn);

    expect(calls).toHaveLength(16);

    const calledKeywords = calls.map((c) => c.keyword).sort();
    expect(calledKeywords).toEqual([...ALL_KEYWORDS].sort());

    for (const [profile, keywords] of Object.entries(ROLE_KEYWORDS)) {
      for (const keyword of keywords) {
        const call = calls.find((c) => c.keyword === keyword);
        expect(call).toBeDefined();
        expect(call!.profileIds).toEqual([profile]);
      }
    }
  });

  it("runs only the requested profile's keywords when filters.profileIds is set", async () => {
    await runDiscover(makePaths(), { profileIds: ["sdet"] }, fakeLaunchFn);

    expect(calls).toHaveLength(4);

    const calledKeywords = calls.map((c) => c.keyword).sort();
    expect(calledKeywords).toEqual([...ROLE_KEYWORDS.sdet!].sort());

    for (const call of calls) {
      expect(call.profileIds).toEqual(["sdet"]);
    }

    const otherKeywords = ALL_KEYWORDS.filter((k) => !ROLE_KEYWORDS.sdet!.includes(k));
    for (const keyword of otherKeywords) {
      expect(calls.some((c) => c.keyword === keyword)).toBe(false);
    }
  });
});

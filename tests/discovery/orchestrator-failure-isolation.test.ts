import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { DiscoveredJobLite, DiscoveryContext, PortalDiscoveryAdapter } from "../../src/discovery/types.js";
import type { PortalConfig } from "../../src/config/schema.js";
import type { CollectSettings, RoleConfig, SiteConfig } from "../../src/types.js";
import { loadDiscoveredJobs } from "../../src/storage/jsonl-store.js";

// Task 13: "a portal that throws does not stop another portal from running." The shipped,
// real config/portals.yml + config/sites.yml collapse targetSources down to a single source
// (see the Task 12 comment in orchestrator.test.ts) -- there's no second real, enabled
// source to exercise cross-source failure isolation with. This test therefore mocks
// config/loader.js's loaders with synthetic 2-portal data instead of the real config files.
// Kept in its own file (rather than a describe block in orchestrator.test.ts) so this
// module-level config mock -- which vi.mock hoists for the whole file -- never leaks into
// and changes the real-config assertions the other 8 orchestrator tests depend on.

const { discoverIndeedMock, discoverMonsterMock } = vi.hoisted(() => ({
  discoverIndeedMock: vi.fn(),
  discoverMonsterMock: vi.fn(),
}));

vi.mock("../../src/discovery/registry.js", () => ({
  resolveDiscoveryAdapter: (source: string): PortalDiscoveryAdapter => {
    if (source === "indeed") return { source: "indeed", discover: discoverIndeedMock };
    if (source === "monster") return { source: "monster", discover: discoverMonsterMock };
    // company-careers is also unconditionally part of every orchestrator run's
    // targetSources (see orchestrator.ts); give it a harmless no-op so this test's
    // assertions stay focused on indeed vs. monster.
    return { source, discover: async () => {} };
  },
}));

// Monster's discovered job flows into Phase 2's real PostingResolver.resolve() call -- must
// never make a genuine network attempt. See the identical stub + rationale in
// orchestrator.test.ts: resolves to a different .invalid url so resolution completes via the
// fast fetch-only path and the placeholder fallback, never touching real network/timers.
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    url: "https://example.invalid/resolved-elsewhere",
    ok: true,
    text: async () => "{}",
    json: async () => ({}),
  }),
);

function makePortalConfig(id: string, type: PortalConfig["type"]): PortalConfig {
  return {
    id,
    type,
    enabled: true,
    baseUrl: `https://${id}.example.com/jobs`,
    resultCardSelector: ".card",
    titleSelector: ".title",
    locationSelector: ".location",
    maxPages: 10,
    maxDiscoveries: 500,
    navigationTimeoutMs: 30000,
    delayBetweenActionsMs: 1000,
    requiresLogin: false,
    onVerification: "pause",
  };
}

vi.mock("../../src/config/loader.js", () => ({
  loadRolesConfig: (): RoleConfig[] => [{ id: "sdet-role", profile: "sdet", keywords: ["SDET"] }],
  loadSitesConfig: (): SiteConfig[] => [],
  loadPortalsConfig: (): PortalConfig[] => [makePortalConfig("indeed", "indeed"), makePortalConfig("monster", "monster")],
  loadCollectSettings: (): CollectSettings => ({
    maxPagesPerSource: 100,
    maxJobsPerSource: 5000,
    navigationTimeoutMs: 30000,
    delayBetweenRequestsMs: 0,
  }),
  // Also imported (unmocked-module-wide) by PostingResolver's constructor in Phase 2 --
  // runDiscover always instantiates a PostingResolver even when this test's only
  // discovered job resolves via the network-failure fallback path, never actually
  // consulting the registry's contents.
  loadCompanyRegistry: () => [],
}));

// Imported after the mocks above so the orchestrator picks up the mocked registry + config.
const { runDiscover } = await import("../../src/discovery/orchestrator.js");

function fakeLaunchFn(): Promise<BrowserContext> {
  const fakePage = { close: vi.fn(async () => {}) } as unknown as Page;
  const fakeContext = {
    newPage: vi.fn(async () => fakePage),
    close: vi.fn(async () => {}),
  } as unknown as BrowserContext;
  return Promise.resolve(fakeContext);
}

// Real closePersistentChrome spawns a real subprocess to confirm OS process exit -- never
// acceptable in a test. Shutdown mechanics are covered in isolation by
// tests/browser/launcher.test.ts.
const fakeCloseFn = vi.fn(async () => {});

function makePaths() {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-orchestrator-failure-"));
  return {
    sitesConfigPath: path.resolve("config/sites.yml"), // unused: loadSitesConfig is mocked above
    rolesConfigPath: path.resolve("config/roles.yml"), // unused: loadRolesConfig is mocked above
    portalsConfigPath: path.resolve("config/portals.yml"), // unused: loadPortalsConfig is mocked above
    discoveredJobsPath: path.join(dir, "discovered-jobs.jsonl"),
    jobsStorePath: path.join(dir, "jobs.jsonl"),
    checkpointsPath: path.join(dir, "checkpoints.json"),
  };
}

describe("orchestrator cross-source failure isolation (Task 13)", () => {
  beforeEach(() => {
    discoverIndeedMock.mockReset();
    discoverMonsterMock.mockReset();

    discoverIndeedMock.mockImplementation(async () => {
      throw new Error("indeed exploded");
    });

    discoverMonsterMock.mockImplementation(async (context: DiscoveryContext) => {
      const job: DiscoveredJobLite = {
        source: "monster",
        searchKeyword: context.keyword,
        title: "Monster Job",
        company: "Acme",
        location: "United States",
        salarySnippet: null,
        resultUrl: "https://example.invalid/monster-job/1",
        possibleOfficialUrl: null,
        postingAgeOrDate: null,
        sourceJobId: "monster-job-1",
        discoveredAt: new Date().toISOString(),
        matchedProfiles: [],
      };
      await context.onPageProcessed([job], 1);
    });
  });

  it("keeps running monster's real work after indeed throws, and persists monster's discoveries to disk", async () => {
    const paths = makePaths();

    const summary = await runDiscover(paths, {}, fakeLaunchFn, fakeCloseFn);

    expect(discoverIndeedMock).toHaveBeenCalledTimes(1);
    expect(discoverMonsterMock).toHaveBeenCalledTimes(1);

    // runDiscover itself must not throw (already implied by reaching this line) -- indeed's
    // failure is recorded, not propagated.
    expect(
      summary.errors.some(
        (e) => e.source.includes("indeed") && e.message.includes("indeed exploded"),
      ),
    ).toBe(true);

    // Monster's discovery genuinely made it to disk, proving indeed's failure didn't prevent
    // monster's real work from completing and being persisted.
    const discovered = loadDiscoveredJobs(paths.discoveredJobsPath);
    expect(discovered.some((j) => j.sourceJobId === "monster-job-1")).toBe(true);
  });
});

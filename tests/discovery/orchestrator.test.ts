import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe("orchestrator --dry-run (Task 14)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
  });

  it("never launches the browser or calls any adapter, but still reports sourcesAttempted", async () => {
    const launchFn = vi.fn(fakeLaunchFn);

    const summary = await runDiscover(makePaths(), { dryRun: true }, launchFn);

    expect(launchFn).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
    // Real, all-disabled config/sites.yml + config/portals.yml collapse targetSources down to
    // just ["company-careers"] (see the Task 12 comment above) -- so a dry run should report
    // exactly 1 source attempted, 0 of everything else since nothing actually ran.
    expect(summary.sourcesAttempted).toBe(1);
    expect(summary.sourcesSucceeded).toBe(0);
    expect(summary.sourcesFailed).toBe(0);
    expect(summary.listingsDiscovered).toBe(0);
    expect(summary.jobsWritten).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("respects --profile filtering in the dry-run sourcesAttempted computation (still 1, since targetSources doesn't depend on profile)", async () => {
    const launchFn = vi.fn(fakeLaunchFn);

    const summary = await runDiscover(makePaths(), { dryRun: true, profileIds: ["sdet"] }, launchFn);

    expect(launchFn).not.toHaveBeenCalled();
    expect(summary.sourcesAttempted).toBe(1);
  });

  it("does NOT apply --reset-checkpoint under --dry-run -- a dry run never touches disk state", async () => {
    const launchFn = vi.fn(fakeLaunchFn);
    const paths = makePaths();
    const existingCheckpoints = {
      "company-careers::sdet::us": {
        key: "company-careers::sdet::us",
        source: "company-careers",
        keyword: "sdet",
        location: "us",
        lastPage: 0,
        completed: true,
        lastUpdated: "2026-01-01",
        sourceJobIds: [],
      },
    };
    writeFileSync(paths.checkpointsPath, JSON.stringify(existingCheckpoints), "utf-8");

    await runDiscover(paths, { dryRun: true, resetCheckpoint: true }, launchFn);

    // Untouched: dry runs return before checkpoint loading/reset ever happens.
    expect(existsSync(paths.checkpointsPath)).toBe(true);
    expect(JSON.parse(readFileSync(paths.checkpointsPath, "utf-8"))).toEqual(existingCheckpoints);
  });
});

describe("orchestrator --company filter must not prematurely mark company-careers completed (Task 14)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
  });

  // Regression coverage for a bug found during Task 14 review: company-careers.ts
  // deliberately does NOT throw when a --company filter causes it to only attempt a subset
  // of the registry (a narrow, legitimate success). But if the orchestrator unconditionally
  // marked checkpoint.completed = true on any non-throwing discover() call, that success
  // would permanently mark the WHOLE checkpoint (this source::keyword::location) done --
  // and the orchestrator skips calling discover() again for any already-completed
  // checkpoint, filtered or not -- silently stranding every company the filter excluded,
  // forever, until a manual --reset-checkpoint. This only shows up at the orchestrator
  // level: tests/discovery/company-careers.test.ts calls discover() directly and never
  // exercises the orchestrator's own completed-checkpoint gate.
  it("does not mark the checkpoint completed after a successful --company-filtered run, so a later unfiltered run still invokes discover() again", async () => {
    discoverMock.mockResolvedValue(undefined); // simulates company-careers resolving cleanly under a --company filter

    const paths = makePaths();
    await runDiscover(paths, { company: "Google" }, fakeLaunchFn);

    expect(discoverMock).toHaveBeenCalledTimes(16); // once per role/keyword, per Task 12

    // A second, unfiltered run must still call discover() for every keyword again -- proving
    // the checkpoint was NOT marked completed by the filtered run above.
    discoverMock.mockReset();
    discoverMock.mockResolvedValue(undefined);
    await runDiscover(paths, {}, fakeLaunchFn);

    expect(discoverMock).toHaveBeenCalledTimes(16);
  });

  it("still marks the checkpoint completed normally for a run with no --company filter", async () => {
    discoverMock.mockResolvedValue(undefined);

    const paths = makePaths();
    await runDiscover(paths, {}, fakeLaunchFn);
    expect(discoverMock).toHaveBeenCalledTimes(16);

    // Second run, still no filter: every checkpoint should now be completed, so discover()
    // must NOT be called again.
    discoverMock.mockReset();
    await runDiscover(paths, {}, fakeLaunchFn);
    expect(discoverMock).not.toHaveBeenCalled();
  });
});

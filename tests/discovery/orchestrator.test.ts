import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type { DiscoveredJobLite, DiscoveryContext, PortalDiscoveryAdapter } from "../../src/discovery/types.js";
import { loadDiscoveredJobs } from "../../src/storage/jsonl-store.js";
import { discoveredJob as canonicalJob, greenhousePayload, makeFetchRouter, writeRegistry } from "../helpers/canonical-fixtures.js";

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

// Any test that pushes a job through onPageProcessed (Task 13's incremental-persistence
// test) causes runDiscover's Phase 2 to call PostingResolver.resolve() on it for real --
// that must never make a genuine network call. Stubbed globally (harmless/unused for tests
// that never discover a job): resolves to a DIFFERENT .invalid url than the request, which
// makes resolveRedirectsWithPlaywright return via its fast fetch-only path without ever
// touching the fake Playwright context/page, and makes detectAtsType/matchCompany both miss
// (an .invalid url matches no ATS pattern), so resolution completes via the placeholder
// fallback -- fast, deterministic, zero real I/O, zero real retry/backoff delay.
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue({
    url: "https://example.invalid/resolved-elsewhere",
    ok: true,
    text: async () => "{}",
    json: async () => ({}),
  }),
);

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

// Real closePersistentChrome spawns a real subprocess (findOwningProcessIds) to confirm the
// OS Chrome process actually exited -- never acceptable in a test. A no-op stands in
// everywhere runDiscover is called in this file; actual close-mechanics are covered in
// isolation by tests/browser/launcher.test.ts.
const fakeCloseFn = vi.fn(async () => {});

beforeEach(() => {
  fakeCloseFn.mockClear();
});

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
    await runDiscover(makePaths(), {}, fakeLaunchFn, fakeCloseFn);

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
    await runDiscover(makePaths(), { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);

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

describe("orchestrator reporting counters (Task 15)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
  });

  it("keywordsSearched matches the real 16-keyword count from config/roles.yml (Task-12-style setup)", async () => {
    discoverMock.mockResolvedValue(undefined);

    const summary = await runDiscover(makePaths(), {}, fakeLaunchFn, fakeCloseFn);

    expect(summary.keywordsSearched).toBe(16);
  });

  it("companiesAttempted increments once per onCompanyProcessed() call the discovery adapter makes", async () => {
    // Simulates company-careers.ts attempting a fixed, known number of companies (3) on every
    // keyword call it receives -- lets this test assert an exact companiesAttempted total
    // without needing the real Fortune 500 registry involved at all.
    discoverMock.mockImplementation(async (context: DiscoveryContext) => {
      context.onCompanyProcessed?.();
      context.onCompanyProcessed?.();
      context.onCompanyProcessed?.();
    });

    // Filtered to the sdet profile only -- 4 keywords (see ROLE_KEYWORDS.sdet above) x 3
    // onCompanyProcessed() calls each = 12.
    const summary = await runDiscover(makePaths(), { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);

    expect(summary.companiesAttempted).toBe(12);
  });
});

describe("orchestrator --dry-run (Task 14)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
  });

  it("never launches the browser or calls any adapter, but still reports sourcesAttempted", async () => {
    const launchFn = vi.fn(fakeLaunchFn);

    const summary = await runDiscover(makePaths(), { dryRun: true }, launchFn, fakeCloseFn);

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

    const summary = await runDiscover(makePaths(), { dryRun: true, profileIds: ["sdet"] }, launchFn, fakeCloseFn);

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

    await runDiscover(paths, { dryRun: true, resetCheckpoint: true }, launchFn, fakeCloseFn);

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
    await runDiscover(paths, { company: "Google" }, fakeLaunchFn, fakeCloseFn);

    expect(discoverMock).toHaveBeenCalledTimes(16); // once per role/keyword, per Task 12

    // A second, unfiltered run must still call discover() for every keyword again -- proving
    // the checkpoint was NOT marked completed by the filtered run above.
    discoverMock.mockReset();
    discoverMock.mockResolvedValue(undefined);
    await runDiscover(paths, {}, fakeLaunchFn, fakeCloseFn);

    expect(discoverMock).toHaveBeenCalledTimes(16);
  });

  it("still marks the checkpoint completed normally for a run with no --company filter", async () => {
    discoverMock.mockResolvedValue(undefined);

    const paths = makePaths();
    await runDiscover(paths, {}, fakeLaunchFn, fakeCloseFn);
    expect(discoverMock).toHaveBeenCalledTimes(16);

    // Second run, still no filter: every checkpoint should now be completed, so discover()
    // must NOT be called again.
    discoverMock.mockReset();
    await runDiscover(paths, {}, fakeLaunchFn, fakeCloseFn);
    expect(discoverMock).not.toHaveBeenCalled();
  });
});

describe("orchestrator --source semantics (Task 1 restart)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    discoverMock.mockResolvedValue(undefined);
  });

  // Real config/portals.yml ships every entry disabled -- fine for the "default only runs
  // enabled sources" half of this suite, but "an explicitly-selected disabled source still
  // runs" and "enabled-by-default" both need a portal that's actually enabled. A small,
  // schema-valid fixture file (not the real config) keeps this independent of whatever real
  // config/portals.yml happens to contain.
  function makePathsWithPortals(portalsYaml: string) {
    const paths = makePaths();
    const dir = path.dirname(paths.checkpointsPath);
    const portalsConfigPath = path.join(dir, "portals.yml");
    writeFileSync(portalsConfigPath, portalsYaml, "utf-8");
    return { ...paths, portalsConfigPath };
  }

  const MIXED_PORTALS_YAML = `
settings:
  maxPagesPerSource: 1
  maxJobsPerSource: 5
  navigationTimeoutMs: 30000
  delayBetweenRequestsMs: 0
portals:
  - id: test-enabled
    type: indeed
    enabled: true
    baseUrl: "https://example.invalid/enabled"
    resultCardSelector: ".card"
    titleSelector: ".title"
    locationSelector: ".loc"
  - id: test-disabled
    type: monster
    enabled: false
    baseUrl: "https://example.invalid/disabled"
    resultCardSelector: ".card"
    titleSelector: ".title"
    locationSelector: ".loc"
`;

  it("runs an enabled: true portal by default, with no --source given", async () => {
    const paths = makePathsWithPortals(MIXED_PORTALS_YAML);
    await runDiscover(paths, { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);

    // company-careers (always present) + test-enabled x 4 sdet keywords = 8 calls; test-disabled never runs.
    expect(discoverMock).toHaveBeenCalledTimes(8);
  });

  it("skips an enabled: false portal by default", async () => {
    const paths = makePathsWithPortals(MIXED_PORTALS_YAML);
    await runDiscover(paths, { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);

    // Only company-careers + test-enabled ran (8 calls total, asserted above) -- if
    // test-disabled had also run that would be 12. Cross-checked here via a dedicated run
    // scoped to --source test-disabled below, which proves it CAN run when asked.
    expect(discoverMock).toHaveBeenCalledTimes(8);
  });

  it("runs an enabled: false portal when explicitly selected via --source, without mutating portals.yml", async () => {
    const paths = makePathsWithPortals(MIXED_PORTALS_YAML);
    const before = readFileSync(paths.portalsConfigPath, "utf-8");

    await runDiscover(paths, { profileIds: ["sdet"], sources: ["test-disabled"] }, fakeLaunchFn, fakeCloseFn);

    // Only test-disabled x 4 sdet keywords -- company-careers and test-enabled are excluded
    // by the explicit --source filter, same as before this fix.
    expect(discoverMock).toHaveBeenCalledTimes(4);

    const after = readFileSync(paths.portalsConfigPath, "utf-8");
    expect(after).toBe(before);
  });

  it("runs multiple explicitly-selected sources together, including a disabled one and company-careers", async () => {
    const paths = makePathsWithPortals(MIXED_PORTALS_YAML);

    await runDiscover(
      paths,
      { profileIds: ["sdet"], sources: ["test-disabled", "company-careers"] },
      fakeLaunchFn,
      fakeCloseFn,
    );

    // test-disabled (4) + company-careers (4) = 8; test-enabled excluded since it wasn't named.
    expect(discoverMock).toHaveBeenCalledTimes(8);
  });

  it("rejects an unknown --source with a clear error and never launches the browser", async () => {
    const paths = makePathsWithPortals(MIXED_PORTALS_YAML);
    const launchFn = vi.fn(fakeLaunchFn);

    await expect(
      runDiscover(paths, { sources: ["totally-not-a-real-source"] }, launchFn, fakeCloseFn),
    ).rejects.toThrow(/Unknown --source "totally-not-a-real-source"/);

    expect(launchFn).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("still accepts the special \"generic\" wildcard alongside real ids", async () => {
    const paths = makePathsWithPortals(MIXED_PORTALS_YAML);

    // "generic" matches zero entries in this fixture (neither portal is type: generic) but
    // must not itself be rejected as unknown.
    await expect(
      runDiscover(paths, { sources: ["generic", "company-careers"] }, fakeLaunchFn, fakeCloseFn),
    ).resolves.toBeDefined();
  });
});

describe("orchestrator relevance filtering + limit placement (Profile Relevance phase)", () => {
  function relevantJob(id: string): DiscoveredJobLite {
    return {
      source: "company-careers",
      searchKeyword: "SDET",
      title: "SDET II",
      company: "Acme",
      location: "Remote",
      salarySnippet: null,
      resultUrl: `https://example.invalid/job/${id}`,
      possibleOfficialUrl: null,
      postingAgeOrDate: null,
      sourceJobId: id,
      discoveredAt: new Date().toISOString(),
      matchedProfiles: [],
      department: null,
      descriptionSnippet: null,
      searchedProfile: null,
      matchedKeywords: [],
      matchedFields: [],
      relevanceReason: "",
    };
  }

  // The real, live false-positive this whole phase exists to fix: a company-wide board dump
  // surfacing something totally unrelated regardless of which keyword search found it.
  function irrelevantJob(id: string): DiscoveredJobLite {
    return { ...relevantJob(id), title: "Account Executive, Emerging Enterprise" };
  }

  beforeEach(() => {
    discoverMock.mockReset();
  });

  // Real config/sites.yml's settings.delayBetweenRequestsMs (500ms) applies as a genuine
  // setTimeout-based inter-job throttle in Phase 2 -- fake timers so these tests don't each
  // burn real wall-clock time on it (same pattern as the "incremental checkpoint" describe
  // block below).
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an irrelevant job and retains a relevant one, with real evidence fields populated on the retained job", async () => {
    discoverMock.mockImplementationOnce(async (context: DiscoveryContext) => {
      await context.onPageProcessed([relevantJob("r1"), irrelevantJob("i1")], 1);
    });
    discoverMock.mockResolvedValue(undefined);

    const paths = makePaths();
    vi.useFakeTimers();
    const summaryPromise = runDiscover(paths, { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);
    await vi.advanceTimersByTimeAsync(2000);
    const summary = await summaryPromise;

    expect(summary.listingsDiscovered).toBe(2);
    expect(summary.listingsEvaluated).toBe(2);
    expect(summary.discoveriesRejected).toBe(1);
    expect(summary.relevantRetained).toBe(1);
    expect(summary.retainedByProfile).toEqual({ sdet: 1 });

    const discovered = loadDiscoveredJobs(paths.discoveredJobsPath);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.sourceJobId).toBe("r1");
    expect(discovered[0]!.matchedProfiles).toContain("sdet");
    expect(discovered[0]!.matchedKeywords.length).toBeGreaterThan(0);
    expect(discovered[0]!.matchedFields).toContain("title");
    expect(discovered[0]!.relevanceReason.length).toBeGreaterThan(0);
    expect(discovered[0]!.searchedProfile).toBe("sdet");
  });

  it("never invokes resolution for a rejected job -- rejected discoveries incur zero resolution cost", async () => {
    discoverMock.mockImplementationOnce(async (context: DiscoveryContext) => {
      await context.onPageProcessed([irrelevantJob("i1"), irrelevantJob("i2")], 1);
    });
    discoverMock.mockResolvedValue(undefined);

    const paths = makePaths();
    const summary = await runDiscover(paths, { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);

    expect(summary.discoveriesRejected).toBe(2);
    expect(summary.relevantRetained).toBe(0);
    expect(summary.resolutionsAttempted).toBe(0);
    expect(loadDiscoveredJobs(paths.discoveredJobsPath)).toHaveLength(0);
  });

  it("applies --limit after relevance filtering, not before -- every retained job is written to discoveredJobs.jsonl regardless of limit, but only `limit` many are resolved", async () => {
    discoverMock.mockImplementationOnce(async (context: DiscoveryContext) => {
      const jobs = Array.from({ length: 5 }, (_, i) => relevantJob(`r${i}`));
      await context.onPageProcessed(jobs, 1);
    });
    discoverMock.mockResolvedValue(undefined);

    const paths = makePaths();
    vi.useFakeTimers();
    const summaryPromise = runDiscover(paths, { profileIds: ["sdet"], limit: 2 }, fakeLaunchFn, fakeCloseFn);
    await vi.advanceTimersByTimeAsync(2000);
    const summary = await summaryPromise;

    expect(summary.relevantRetained).toBe(5);
    // Limit never truncates discoveredJobs.jsonl -- all 5 retained jobs are on disk.
    expect(loadDiscoveredJobs(paths.discoveredJobsPath)).toHaveLength(5);
    // Only the first 2 (the limit) were actually resolved.
    expect(summary.resolutionsAttempted).toBe(2);
  });

  it("is deterministic and idempotent: rerunning after a completed run discovers/resolves/writes nothing new", async () => {
    // V1 Slice 1: only a verified, complete posting is persisted (jobs.jsonl no longer accepts
    // an unverifiable "Acme @ example.invalid" placeholder), so this idempotency check now
    // resolves a real-shaped Greenhouse posting against a temp registry through the same
    // production resolver. Same intent as before: second run adds nothing and skips discover().
    const router = makeFetchRouter({ greenhouse: { "101": greenhousePayload(101) } });
    const defaultFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(router.impl));
    try {
      const paths = makePaths();
      const registryPath = writeRegistry();
      discoverMock.mockImplementationOnce(async (context: DiscoveryContext) => {
        await context.onPageProcessed([canonicalJob("101")], 1);
      });
      discoverMock.mockResolvedValue(undefined);
      vi.useFakeTimers();
      const summary1Promise = runDiscover(paths, { profileIds: ["sdet"], registryPath }, fakeLaunchFn, fakeCloseFn);
      await vi.advanceTimersByTimeAsync(2000);
      const summary1 = await summary1Promise;
      expect(summary1.jobsWritten).toBe(1);
      expect(summary1.relevantRetained).toBe(1);

      discoverMock.mockReset();
      discoverMock.mockResolvedValue(undefined); // every checkpoint is already completed -> discover() is never even called again
      const summary2Promise = runDiscover(paths, { profileIds: ["sdet"], registryPath }, fakeLaunchFn, fakeCloseFn);
      await vi.advanceTimersByTimeAsync(2000);
      const summary2 = await summary2Promise;

      expect(discoverMock).not.toHaveBeenCalled();
      expect(summary2.listingsDiscovered).toBe(0);
      expect(summary2.relevantRetained).toBe(0);
      expect(summary2.jobsWritten).toBe(summary1.jobsWritten); // no growth
      expect(loadDiscoveredJobs(paths.discoveredJobsPath)).toHaveLength(1); // still exactly the one retained job, no duplicate append
    } finally {
      vi.stubGlobal("fetch", defaultFetch);
    }
  });

  it("does not persist an unverifiable placeholder posting: it becomes a typed failure instead (V1 Slice 1)", async () => {
    discoverMock.mockImplementationOnce(async (context: DiscoveryContext) => {
      await context.onPageProcessed([relevantJob("r1")], 1);
    });
    discoverMock.mockResolvedValue(undefined);
    const paths = makePaths();
    vi.useFakeTimers();
    const summaryPromise = runDiscover(paths, { profileIds: ["sdet"] }, fakeLaunchFn, fakeCloseFn);
    await vi.advanceTimersByTimeAsync(2000);
    const summary = await summaryPromise;

    expect(summary.jobsWritten).toBe(0);
    expect(summary.unresolvedDiscoveries).toBe(1);
  });
});

describe("orchestrator browser context lifecycle (Task 13)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    discoverMock.mockResolvedValue(undefined);
  });

  it("launches the shared browser context once and closes it exactly once for a full run, not per-keyword", async () => {
    const fakePage = { close: vi.fn(async () => {}) } as unknown as Page;
    const fakeContext = {
      newPage: vi.fn(async () => fakePage),
      close: vi.fn(async () => {}),
    } as unknown as BrowserContext;
    const launchFn = vi.fn(async () => fakeContext);

    await runDiscover(makePaths(), {}, launchFn, fakeCloseFn);

    // Real config collapses to 1 source x 16 keywords (see the Task 12 comment above), so
    // 16 discover() calls all share the one lazily-launched context. Shutdown mechanics
    // themselves (closing pages, bounded-waiting for the OS process, force-kill fallback) are
    // exercised in isolation by tests/browser/launcher.test.ts -- this test only proves the
    // orchestrator calls its close function exactly once, with the actual launched context,
    // not once per keyword.
    expect(discoverMock).toHaveBeenCalledTimes(16);
    expect(launchFn).toHaveBeenCalledTimes(1);
    expect(fakeCloseFn).toHaveBeenCalledTimes(1);
    expect(fakeCloseFn).toHaveBeenCalledWith(fakeContext, undefined);
  });
});

describe("orchestrator incremental checkpoint/discovery persistence (Task 13)", () => {
  beforeEach(() => {
    discoverMock.mockReset();
  });

  // beforeEach/afterEach (not an inline vi.useFakeTimers()/useRealTimers() pair inside the
  // test body) so real timers are guaranteed restored even if an assertion throws before
  // reaching an inline cleanup call, and regardless of test execution order within this file.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("persists a job and checkpoint progress reported via onPageProcessed before the adapter's own later throw, proving writes happen inside the callback, not batched at the end", async () => {
    const crashingJob: DiscoveredJobLite = {
      source: "company-careers",
      searchKeyword: "SDET",
      // Must actually be relevance-eligible (SDET is an exact configured keyword phrase) --
      // the orchestrator's relevance filter now rejects a bare "test" without a paired tech
      // role word.
      title: "SDET Crash Test Job",
      company: "Acme",
      location: "United States",
      salarySnippet: null,
      resultUrl: "https://example.invalid/job/1",
      possibleOfficialUrl: null,
      postingAgeOrDate: null,
      sourceJobId: "crash-job-1",
      discoveredAt: new Date().toISOString(),
      matchedProfiles: [],
      department: null,
      descriptionSnippet: null,
      searchedProfile: null,
      matchedKeywords: [],
      matchedFields: [],
      relevanceReason: "",
    };

    // Only the FIRST discover() call reports progress then crashes; every other keyword
    // call (of the 16 the real config drives) resolves cleanly and does nothing, keeping
    // this test focused on the one crashing call.
    discoverMock.mockImplementationOnce(async (context: DiscoveryContext) => {
      await context.onPageProcessed([crashingJob], 3);
      throw new Error("adapter crashed after reporting progress");
    });
    discoverMock.mockResolvedValue(undefined);

    const paths = makePaths();
    // Real config/sites.yml's settings.delayBetweenRequestsMs (500) applies as a genuine
    // setTimeout-based inter-request throttle in Phase 2 after the one resolved job -- fake
    // timers so this test doesn't burn 500ms of real wall-clock time on it.
    vi.useFakeTimers();
    const summaryPromise = runDiscover(paths, {}, fakeLaunchFn, fakeCloseFn);
    await vi.advanceTimersByTimeAsync(600);
    const summary = await summaryPromise;

    // The orchestrator's own per-keyword try/catch absorbs the adapter's throw -- runDiscover
    // itself must not throw, and the failure shows up as a recorded error, not a crash.
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.message).toContain("adapter crashed after reporting progress");

    // The job reported via onPageProcessed before the throw must be on disk already --
    // read straight from discoveredJobsPath, not from the summary/return value.
    const discovered = loadDiscoveredJobs(paths.discoveredJobsPath);
    expect(discovered.some((j) => j.sourceJobId === "crash-job-1")).toBe(true);

    // The checkpoint for that specific keyword must reflect the lastPage/lastUpdated
    // progress saved inside the callback -- and must NOT be marked completed, since the
    // adapter never returned successfully from discover() for it.
    const checkpoints = JSON.parse(readFileSync(paths.checkpointsPath, "utf-8")) as Record<
      string,
      { lastPage: number; completed: boolean; lastUpdated: string }
    >;
    const crashedCheckpoint = Object.values(checkpoints).find((c) => c.lastPage === 3);
    expect(crashedCheckpoint).toBeDefined();
    expect(crashedCheckpoint!.completed).toBe(false);
    expect(typeof crashedCheckpoint!.lastUpdated).toBe("string");
  });
});

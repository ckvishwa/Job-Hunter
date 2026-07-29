import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { runHunt, type HuntPaths } from "../../src/hunt/run-hunt.js";
import { saveJobs } from "../../src/storage/jsonl-store.js";
import { loadHuntState } from "../../src/hunt/hunt-state.js";
import type { JobPosting } from "../../src/adapters/types.js";
import type { DiscoveryRunSummary } from "../../src/discovery/report.js";

const TMP_DIR = path.resolve("tests/hunt/.tmp-run-hunt");
// Fixed "now" for every runHunt call in this file -- keeps fixture discoveredAt/lastSeenAt
// values within the 14-day staleness window regardless of the real wall clock.
const NOW = "2026-01-06T00:00:00.000Z";

function makePaths(): HuntPaths {
  return {
    sitesConfigPath: path.resolve("config/sites.yml"),
    rolesConfigPath: path.resolve("config/roles.yml"),
    portalsConfigPath: path.resolve("config/portals.yml"),
    discoveredJobsPath: path.join(TMP_DIR, "discovered-jobs.jsonl"),
    jobsStorePath: path.join(TMP_DIR, "jobs.jsonl"),
    checkpointsPath: path.join(TMP_DIR, "checkpoints.json"),
    huntStatePath: path.join(TMP_DIR, "hunt-state.json"),
    outputDir: path.join(TMP_DIR, "output"),
  };
}

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: `id-${Math.random()}`,
    source: "company-careers",
    sourceType: "company-careers",
    company: "Acme",
    title: "SDET I",
    location: "Austin, TX",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "1",
    postingDate: null,
    discoveredAt: "2026-01-05T00:00:00.000Z",
    lastSeenAt: "2026-01-05T00:00:00.000Z",
    canonicalUrl: "https://acme.example/job/1",
    applyUrl: "https://acme.example/job/1",
    descriptionText: "We need an entry-level SDET with 1 year of experience.".repeat(10),
    descriptionHtml: null,
    requiredYears: 1,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["company-careers"],
    matchedKeywords: ["SDET"],
    relevanceReason: "test",
    rawMetadata: {},
    ...overrides,
  };
}

function stubDiscoverSummary(): DiscoveryRunSummary {
  return {
    sourcesAttempted: 1, sourcesSucceeded: 1, sourcesFailed: 0, companiesAttempted: 1,
    keywordsSearched: 1, pagesProcessed: 1, listingsDiscovered: 1, listingsEvaluated: 1,
    discoveriesRejected: 0, relevantRetained: 1, retainedByProfile: { sdet: 1 },
    resolutionsAttempted: 1, resolutionsSucceeded: 1, resolutionsTimedOut: 0,
    officialPostingsResolved: 1, unresolvedDiscoveries: 0, duplicatesMerged: 0, jdsExtracted: 1,
    verificationPauses: 0, jobsByProfile: { sdet: 1 }, jobsBySource: { "company-careers": 1 },
    jobsWritten: 1, discoveryTimeMs: 10, resolutionTimeMs: 20, errors: [],
  };
}

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("runHunt", () => {
  it("builds reports from jobs.jsonl and returns a summary with counts and top10", async () => {
    const paths = makePaths();
    mkdirSync(TMP_DIR, { recursive: true });
    saveJobs(paths.jobsStorePath, [makeJob(), makeJob({ id: "id-2", title: "Senior SDET" })]);

    const summary = await runHunt(paths, { profileIds: ["sdet"], location: "United States" }, async () => stubDiscoverSummary(), NOW);

    expect(summary.totalDiscovered).toBe(2);
    expect(summary.ineligibleSeniority).toBe(1);
    expect(summary.eligibleRetained).toBe(1);
    expect(summary.top10).toHaveLength(1);
    expect(summary.top10[0]!.title).toBe("SDET I");
    expect(existsSync(summary.reportPaths.json)).toBe(true);
    expect(existsSync(summary.reportPaths.csv)).toBe(true);
    expect(existsSync(summary.reportPaths.html)).toBe(true);
  });

  it("saves hunt-state after a successful (non-dry-run) run, keyed by profile", async () => {
    const paths = makePaths();
    mkdirSync(TMP_DIR, { recursive: true });
    saveJobs(paths.jobsStorePath, [makeJob()]);

    await runHunt(paths, { profileIds: ["sdet"], location: "United States" }, async () => stubDiscoverSummary(), NOW);

    const state = loadHuntState(paths.huntStatePath);
    expect(state.lastSuccessfulHuntAt.sdet).toBe(NOW);
  });

  it("does not save hunt-state on a --dry-run", async () => {
    const paths = makePaths();
    mkdirSync(TMP_DIR, { recursive: true });
    saveJobs(paths.jobsStorePath, [makeJob()]);

    await runHunt(paths, { profileIds: ["sdet"], location: "United States", dryRun: true }, async () => stubDiscoverSummary(), NOW);

    expect(existsSync(paths.huntStatePath)).toBe(false);
  });

  it("returns zero newJobs on a --new-only rerun with nothing changed since the previous hunt", async () => {
    const paths = makePaths();
    mkdirSync(TMP_DIR, { recursive: true });
    saveJobs(paths.jobsStorePath, [makeJob()]);

    const first = await runHunt(paths, { profileIds: ["sdet"], location: "United States" }, async () => stubDiscoverSummary(), NOW);
    expect(first.newJobs).toBe(1);

    // Nothing new discovered/merged between runs -- jobs.jsonl is untouched. A later "now"
    // for the rerun, same as a real next-day hunt.
    const laterNow = "2026-01-07T00:00:00.000Z";
    const second = await runHunt(
      paths,
      { profileIds: ["sdet"], location: "United States", newOnly: true },
      async () => stubDiscoverSummary(),
      laterNow,
    );
    expect(second.newJobs).toBe(0);
    expect(second.top10).toHaveLength(0);
  });

  it("preserves firstSeenAt and advances lastSeenAt across reruns when a job is re-merged", async () => {
    const paths = makePaths();
    mkdirSync(TMP_DIR, { recursive: true });
    const original = makeJob({ discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z" });
    saveJobs(paths.jobsStorePath, [original]);

    await runHunt(paths, { profileIds: ["sdet"], location: "United States", includeSeen: true }, async () => stubDiscoverSummary(), NOW);

    // Simulate a later re-merge (same job, lastSeenAt advanced) as the discovery/dedup layer
    // would do -- discoveredAt (firstSeenAt) must never change on a re-merge.
    saveJobs(paths.jobsStorePath, [{ ...original, lastSeenAt: "2026-01-10T00:00:00.000Z" }]);

    const second = await runHunt(
      paths,
      { profileIds: ["sdet"], location: "United States", includeSeen: true },
      async () => stubDiscoverSummary(),
      "2026-01-11T00:00:00.000Z",
    );

    expect(second.top10[0]!.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(second.top10[0]!.lastSeenAt).toBe("2026-01-10T00:00:00.000Z");
  });

  it("produces a byte-identical JSON report across two runs with unchanged input", async () => {
    const paths = makePaths();
    mkdirSync(TMP_DIR, { recursive: true });
    saveJobs(paths.jobsStorePath, [makeJob()]);

    // dryRun on both calls: never touches hunt-state, so previousHuntAt stays null (bootstrap)
    // across both runs -- isolates this test to "same input -> same output" determinism.
    // Same fixed "now" both times too, since the freshness/score breakdown otherwise depends
    // on it.
    await runHunt(paths, { profileIds: ["sdet"], location: "United States", includeSeen: true, dryRun: true }, async () => stubDiscoverSummary(), NOW);
    const firstJson = readFileSync(path.join(paths.outputDir, "latest-jobs.json"), "utf-8");

    await runHunt(paths, { profileIds: ["sdet"], location: "United States", includeSeen: true, dryRun: true }, async () => stubDiscoverSummary(), NOW);
    const secondJson = readFileSync(path.join(paths.outputDir, "latest-jobs.json"), "utf-8");

    expect(secondJson).toBe(firstJson);
  });
});

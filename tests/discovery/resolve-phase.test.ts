import { describe, expect, it, vi, afterEach } from "vitest";
import { runResolutionPhase, UNRESOLVED_PLACEHOLDER_PREFIX } from "../../src/discovery/resolve-phase.js";
import type { DiscoveredJobLite } from "../../src/discovery/types.js";
import type { JobPosting } from "../../src/adapters/types.js";

function makeJob(overrides: Partial<DiscoveredJobLite> = {}): DiscoveredJobLite {
  return {
    source: "company-careers",
    searchKeyword: "SDET",
    title: "SDET",
    company: "Acme",
    location: "Remote",
    salarySnippet: null,
    resultUrl: "https://acme.example/job/1",
    possibleOfficialUrl: null,
    postingAgeOrDate: null,
    sourceJobId: "1",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    matchedProfiles: ["sdet"],
    department: null,
    descriptionSnippet: null,
    searchedProfile: "sdet",
    matchedKeywords: ["SDET"],
    matchedFields: ["title"],
    relevanceReason: "test",
    ...overrides,
  };
}

function makePosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "id-1",
    source: "company-careers",
    sourceType: "company-careers",
    company: "Acme",
    title: "SDET",
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "1",
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://acme.example/job/1",
    applyUrl: "https://acme.example/job/1",
    descriptionText: "Real full description of the role.",
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["company-careers"],
    rawMetadata: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runResolutionPhase", () => {
  it("resolves every job successfully when resolveFn always resolves quickly", async () => {
    const jobs = [makeJob({ sourceJobId: "1" }), makeJob({ sourceJobId: "2" })];
    const resolveFn = vi.fn(async (job: DiscoveredJobLite) => makePosting({ id: job.sourceJobId! }));

    const result = await runResolutionPhase(jobs, resolveFn, {
      concurrency: 3,
      perJobTimeoutMs: 5000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });

    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.timedOut).toBe(0);
    expect(result.unresolved).toBe(0);
    expect(result.resolvedJobs).toHaveLength(2);
  });

  it("isolates one job's failure from the rest -- a throw in resolveFn doesn't stop other jobs", async () => {
    const jobs = [makeJob({ sourceJobId: "1" }), makeJob({ sourceJobId: "2" }), makeJob({ sourceJobId: "3" })];
    const resolveFn = vi.fn(async (job: DiscoveredJobLite) => {
      if (job.sourceJobId === "2") throw new Error("boom");
      return makePosting({ id: job.sourceJobId! });
    });

    const result = await runResolutionPhase(jobs, resolveFn, {
      concurrency: 1, // sequential, so job 2's throw can't accidentally short-circuit job 3
      perJobTimeoutMs: 5000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });

    expect(result.attempted).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.unresolved).toBe(1);
    expect(result.resolvedJobs).toHaveLength(3);
    const failed = result.resolvedJobs.find((r) => r.requisitionId === "2");
    expect(failed!.descriptionText).toContain(UNRESOLVED_PLACEHOLDER_PREFIX);
    expect(failed!.descriptionText).toContain("boom");
  });

  it("preserves a per-job timeout as a placeholder with a reason, never silently dropping it", async () => {
    vi.useFakeTimers();
    const jobs = [makeJob({ sourceJobId: "slow" })];
    const resolveFn = vi.fn(() => new Promise<JobPosting>(() => {})); // never resolves

    const promise = runResolutionPhase(jobs, resolveFn, {
      concurrency: 1,
      perJobTimeoutMs: 1000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.timedOut).toBe(1);
    expect(result.unresolved).toBe(1);
    expect(result.resolvedJobs).toHaveLength(1);
    expect(result.resolvedJobs[0]!.descriptionText).toContain("timed out after 1000ms");
    expect(result.resolvedJobs[0]!.descriptionText).toContain(UNRESOLVED_PLACEHOLDER_PREFIX);
  });

  it("respects the total-timeout budget -- jobs never started are preserved with a reason, not silently dropped", async () => {
    vi.useFakeTimers();
    const jobs = [makeJob({ sourceJobId: "1" }), makeJob({ sourceJobId: "2" }), makeJob({ sourceJobId: "3" })];
    let callCount = 0;
    const resolveFn = vi.fn((job: DiscoveredJobLite) => {
      callCount += 1;
      // Job 1 takes 2000ms (pushes elapsed past the 1000ms total budget); jobs 2/3 should
      // never even start once the budget's exceeded.
      return new Promise<JobPosting>((resolve) => {
        setTimeout(() => resolve(makePosting({ id: job.sourceJobId! })), 2000);
      });
    });

    const promise = runResolutionPhase(jobs, resolveFn, {
      concurrency: 1,
      perJobTimeoutMs: 10_000, // long enough that job 1 finishes on its own, not via per-job timeout
      totalTimeoutMs: 1000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;

    expect(callCount).toBe(1); // only job 1 was ever started
    expect(result.attempted).toBe(1);
    expect(result.resolvedJobs).toHaveLength(3); // all 3 still present in the output
    const neverStarted = result.resolvedJobs.filter((r) => r.descriptionText.includes("Total resolution timeout"));
    expect(neverStarted).toHaveLength(2);
  });

  it("respects the concurrency cap -- no more than N jobs in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jobs = Array.from({ length: 6 }, (_, i) => makeJob({ sourceJobId: String(i) }));
    const resolveFn = vi.fn(async (job: DiscoveredJobLite) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return makePosting({ id: job.sourceJobId! });
    });

    await runResolutionPhase(jobs, resolveFn, {
      concurrency: 2,
      perJobTimeoutMs: 5000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("calls onJobResolved once per completed job, for incremental persistence", async () => {
    const jobs = [makeJob({ sourceJobId: "1" }), makeJob({ sourceJobId: "2" })];
    const resolveFn = vi.fn(async (job: DiscoveredJobLite) => makePosting({ id: job.sourceJobId! }));
    const onJobResolved = vi.fn();

    await runResolutionPhase(jobs, resolveFn, {
      concurrency: 3,
      perJobTimeoutMs: 5000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
      onJobResolved,
    });

    expect(onJobResolved).toHaveBeenCalledTimes(2);
  });

  it("logs progress every N completed jobs, not more often", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => makeJob({ sourceJobId: String(i) }));
    const resolveFn = vi.fn(async (job: DiscoveredJobLite) => makePosting({ id: job.sourceJobId! }));
    const log = vi.fn();

    await runResolutionPhase(jobs, resolveFn, {
      concurrency: 1,
      perJobTimeoutMs: 5000,
      progressEvery: 2,
      delayBetweenRequestsMs: 0,
      log,
    });

    // 5 jobs, progressEvery 2 -> logs after job 2 and job 4 (not after 1, 3, 5).
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("classifies resolveFn's own internal unresolved-placeholder result (not a throw, not a timeout) as unresolved, not succeeded", async () => {
    const jobs = [makeJob()];
    const resolveFn = vi.fn(async () =>
      makePosting({ descriptionText: `${UNRESOLVED_PLACEHOLDER_PREFIX}company-careers. Full description not extracted.` }),
    );

    const result = await runResolutionPhase(jobs, resolveFn, {
      concurrency: 1,
      perJobTimeoutMs: 5000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });

    expect(result.succeeded).toBe(0);
    expect(result.unresolved).toBe(1);
  });

  it("returns quickly with an empty result for zero jobs, never dividing by zero or hanging", async () => {
    const resolveFn = vi.fn();
    const result = await runResolutionPhase([], resolveFn, {
      concurrency: 3,
      perJobTimeoutMs: 5000,
      progressEvery: 10,
      delayBetweenRequestsMs: 0,
    });
    expect(result.resolvedJobs).toEqual([]);
    expect(result.attempted).toBe(0);
    expect(resolveFn).not.toHaveBeenCalled();
  });
});

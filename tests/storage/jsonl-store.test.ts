import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendDiscoveredJobs, loadDiscoveredJobs, loadJobs, saveJobs } from "../../src/storage/jsonl-store.js";
import type { JobPosting } from "../../src/adapters/types.js";
import type { DiscoveredJobLite } from "../../src/discovery/types.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "job-1",
    source: "acme-greenhouse",
    sourceType: "greenhouse",
    company: "Acme",
    title: "SDET",
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "123",
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://acme.com/jobs/123",
    applyUrl: "https://acme.com/jobs/123",
    descriptionText: "Test description",
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["acme-greenhouse"],
    rawMetadata: {},
    ...overrides,
  };
}

describe("jsonl-store", () => {
  it("returns an empty array when the file does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    expect(loadJobs(path.join(dir, "jobs.jsonl"))).toEqual([]);
  });

  it("round-trips jobs through save and load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    const jobs = [makeJob(), makeJob({ id: "job-2", requisitionId: "456" })];

    saveJobs(filePath, jobs);
    expect(loadJobs(filePath)).toEqual(jobs);
  });

  it("creates the parent directory if missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "nested", "jobs.jsonl");
    saveJobs(filePath, [makeJob()]);
    expect(existsSync(filePath)).toBe(true);
  });

  it("does not leave a .tmp file behind after saving", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    saveJobs(filePath, [makeJob()]);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("skips malformed lines instead of crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    const goodJob = makeJob();
    require("node:fs").writeFileSync(
      filePath,
      `${JSON.stringify(goodJob)}\nnot valid json\n`,
      "utf-8",
    );
    expect(loadJobs(filePath)).toEqual([goodJob]);
  });

  it("writes one JSON object per line with no trailing commas", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    saveJobs(filePath, [makeJob(), makeJob({ id: "job-2" })]);
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

function makeDiscoveredJob(overrides: Partial<DiscoveredJobLite> = {}): DiscoveredJobLite {
  return {
    source: "acme-greenhouse",
    searchKeyword: "sdet",
    title: "SDET",
    company: "Acme",
    location: "Remote",
    salarySnippet: null,
    resultUrl: "https://acme.com/jobs/123",
    possibleOfficialUrl: null,
    postingAgeOrDate: null,
    sourceJobId: "123",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    matchedProfiles: ["sdet"],
    ...overrides,
  };
}

describe("jsonl-store discovery-lite (DiscoveredJobLite)", () => {
  it("skips malformed lines instead of crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "discovered.jsonl");
    const goodJob = makeDiscoveredJob();
    require("node:fs").writeFileSync(
      filePath,
      `${JSON.stringify(goodJob)}\nnot valid json\n`,
      "utf-8",
    );
    expect(loadDiscoveredJobs(filePath)).toEqual([goodJob]);
  });

  // ponytail: appendDiscoveredJobs is a pure append with no dedup of its own —
  // re-discovery dedup lives one layer up, in each adapter's checkpoint.sourceJobIds
  // check (see src/discovery/adapters/*.ts) before onPageProcessed/appendDiscoveredJobs
  // is ever called. This test pins the actual (non-deduping) storage-layer behavior.
  it("appends without deduping — re-appending the same record produces a duplicate (dedup is the caller's job)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "discovered.jsonl");
    const job = makeDiscoveredJob();

    appendDiscoveredJobs(filePath, [job]);
    appendDiscoveredJobs(filePath, [job]);

    expect(loadDiscoveredJobs(filePath)).toEqual([job, job]);
  });
});

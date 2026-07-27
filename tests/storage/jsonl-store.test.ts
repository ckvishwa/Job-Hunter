import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadJobs, saveJobs } from "../../src/storage/jsonl-store.js";
import type { JobPosting } from "../../src/adapters/types.js";

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

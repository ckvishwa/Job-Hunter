import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildJobFailure } from "../../src/domain/canonical-job.js";
import { appendJobFailures, loadJobFailures, loadJobs, saveJobs } from "../../src/storage/jsonl-store.js";

function failure(id: string) {
  return buildJobFailure({
    code: "EMPTY_DESCRIPTION",
    stage: "resolution",
    runId: "run-test",
    targetUrl: `https://boards.greenhouse.io/acme/jobs/${id}`,
    company: "Acme",
    title: "SDET",
    sourceJobId: id,
    detail: "empty",
  });
}

describe("job failure log", () => {
  it("appends records across calls and loads them back", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "job-hunter-failures-")), "nested", "job-failures.jsonl");
    appendJobFailures(file, []);
    appendJobFailures(file, [failure("1")]);
    appendJobFailures(file, [failure("2"), failure("3")]);
    expect(loadJobFailures(file).map((f) => f.sourceJobId)).toEqual(["1", "2", "3"]);
    expect(readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
  });

  it("returns an empty list for a missing file and skips a malformed line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-failures-"));
    expect(loadJobFailures(path.join(dir, "absent.jsonl"))).toEqual([]);
    const file = path.join(dir, "f.jsonl");
    writeFileSync(file, `${JSON.stringify(failure("1"))}\n{not json\n`, "utf-8");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadJobFailures(file)).toHaveLength(1);
    errors.mockRestore();
  });
});

describe("saveJobs durability", () => {
  it("replaces the store atomically and leaves no temp file behind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-save-"));
    const file = path.join(dir, "jobs.jsonl");
    saveJobs(file, []);
    expect(loadJobs(file)).toEqual([]);
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });
});

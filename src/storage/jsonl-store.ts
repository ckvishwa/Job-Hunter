import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DiscoveredJobLite } from "../discovery/types.js";
import type { JobFailure } from "../domain/canonical-job.js";
import { writeFileDurable } from "./job-store.js";

// Authoritative jobs.jsonl access (strict load, guarded save, locked update) lives in job-store.ts;
// re-exported so existing import sites keep working.
export { JobStoreError, loadJobs, saveJobs, updateJobs } from "./job-store.js";

export function loadDiscoveredJobs(filePath: string): DiscoveredJobLite[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const jobs: DiscoveredJobLite[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      jobs.push(JSON.parse(trimmed) as DiscoveredJobLite);
    } catch {
      console.error(`Skipping malformed JSONL line in ${filePath}`);
    }
  }
  return jobs;
}

export function saveDiscoveredJobs(filePath: string, jobs: DiscoveredJobLite[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + (jobs.length ? "\n" : "");
  writeFileDurable(tmpPath, content);
  renameSync(tmpPath, filePath);
}

export function appendDiscoveredJobs(filePath: string, jobs: DiscoveredJobLite[]): void {
  if (jobs.length === 0) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + "\n";
  appendFileSync(filePath, content, "utf-8");
}

/** Durable append of JSON records (one per line, fsync before returning). Not for authoritative state. */
export function appendJsonlRecords(filePath: string, records: readonly unknown[]): void {
  if (records.length === 0) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, records.map((record) => JSON.stringify(record)).join("\n") + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Appends typed failure records (data/job-failures.jsonl) and fsyncs before returning. */
export function appendJobFailures(filePath: string, failures: JobFailure[]): void {
  appendJsonlRecords(filePath, failures);
}

export function loadJobFailures(filePath: string): JobFailure[] {
  if (!existsSync(filePath)) return [];
  const failures: JobFailure[] = [];
  for (const line of readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      failures.push(JSON.parse(trimmed) as JobFailure);
    } catch {
      console.error(`Skipping malformed JSONL line in ${filePath}`);
    }
  }
  return failures;
}

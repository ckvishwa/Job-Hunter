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
import type { JobPosting } from "../adapters/types.js";
import type { DiscoveredJobLite } from "../discovery/types.js";
import type { JobFailure } from "../domain/canonical-job.js";

export function loadJobs(filePath: string): JobPosting[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const jobs: JobPosting[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      jobs.push(JSON.parse(trimmed) as JobPosting);
    } catch {
      console.error(`Skipping malformed JSONL line in ${filePath}`);
    }
  }
  return jobs;
}

// Write + fsync the temp file BEFORE the rename, so a power loss after saveJobs() returns can
// never leave the store pointing at a file whose bytes were never flushed to disk.
function writeFileDurable(tmpPath: string, content: string): void {
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content, null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function saveJobs(filePath: string, jobs: JobPosting[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + (jobs.length ? "\n" : "");
  writeFileDurable(tmpPath, content);
  renameSync(tmpPath, filePath);
}

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

/** Appends typed failure records (data/job-failures.jsonl) and fsyncs before returning. */
export function appendJobFailures(filePath: string, failures: JobFailure[]): void {
  if (failures.length === 0) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  try {
    writeSync(fd, failures.map((failure) => JSON.stringify(failure)).join("\n") + "\n", null, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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

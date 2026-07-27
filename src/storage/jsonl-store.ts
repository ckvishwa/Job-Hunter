import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JobPosting } from "../adapters/types.js";
import type { DiscoveredJobLite } from "../discovery/types.js";

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

export function saveJobs(filePath: string, jobs: JobPosting[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + (jobs.length ? "\n" : "");
  writeFileSync(tmpPath, content, "utf-8");
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
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function appendDiscoveredJobs(filePath: string, jobs: DiscoveredJobLite[]): void {
  if (jobs.length === 0) return;
  mkdirSync(dirname(filePath), { recursive: true });
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + "\n";
  appendFileSync(filePath, content, "utf-8");
}


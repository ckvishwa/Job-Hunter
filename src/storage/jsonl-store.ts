import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JobPosting } from "../adapters/types.js";

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

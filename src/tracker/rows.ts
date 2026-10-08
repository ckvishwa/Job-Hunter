import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { JobPosting } from "../adapters/types.js";
import { loadJobs } from "../storage/job-store.js";

// The tracker is a read-only projection of the authoritative stores (jobs.jsonl and the per-run
// application records under the output directory). Nothing here writes to those stores, and no code
// reads the generated workbook back: a deleted or edited tracker is simply rebuilt.

export const TRACKER_COLUMNS = ["Company", "Title", "ATS", "Official URL", "JD hash", "Decision", "Resume variant", "State", "Last update", "Blocking reason"] as const;

export interface TrackerRow {
  company: string;
  title: string;
  ats: string;
  officialUrl: string;
  jdHash: string;
  decision: string;
  resumeVariant: string;
  state: string;
  lastUpdate: string;
  blockingReason: string;
}

export interface TrackerSources {
  jobsPath: string;
  outputDir: string;
}

export interface TrackerBuild {
  rows: TrackerRow[];
  /** Files that could not be read; the row is still emitted from what is known, never dropped silently. */
  problems: string[];
}

function readJson(file: string, problems: string[]): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    problems.push(`unreadable: ${path.basename(path.dirname(file))}/${path.basename(file)}`);
    return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function reasonText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("; ");
  return text(value);
}

interface RunDir {
  jobId: string;
  jdHash: string;
  dir: string;
}

function listRunDirs(outputDir: string): RunDir[] {
  if (!existsSync(outputDir)) return [];
  const runs: RunDir[] = [];
  for (const job of readdirSync(outputDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    for (const hash of readdirSync(path.join(outputDir, job.name), { withFileTypes: true })) {
      if (hash.isDirectory()) runs.push({ jobId: job.name, jdHash: hash.name, dir: path.join(outputDir, job.name, hash.name) });
    }
  }
  return runs;
}

function rowFromRun(job: JobPosting | undefined, run: RunDir, problems: string[]): TrackerRow {
  const records = readdirSync(run.dir)
    .filter((f) => /^application-.*\.json$/.test(f))
    .map((f) => ({ file: path.join(run.dir, f), data: readJson(path.join(run.dir, f), problems) }))
    .filter((r): r is { file: string; data: Record<string, unknown> } => r.data !== null);
  const stamp = (r: { file: string; data: Record<string, unknown> }) => text(r.data.createdAt) || new Date(statSync(r.file).mtimeMs).toISOString();
  const application = [...records].sort((a, b) => stamp(a).localeCompare(stamp(b))).at(-1)?.data;
  const planFile = path.join(run.dir, "resume-plan.json");
  const plan = existsSync(planFile) ? readJson(planFile, problems) : null;
  const checkpointFile = path.join(run.dir, "pipeline-checkpoint.json");
  const checkpoint = existsSync(checkpointFile) ? readJson(checkpointFile, problems) : null;
  const checkpointDecision = ((checkpoint?.stages as Record<string, unknown> | undefined)?.decision as Record<string, unknown> | undefined)?.outcome;
  const atsIdentity = text(job?.atsIdentity) || text(application?.atsIdentity);
  const modified = [...records.map((r) => r.file), ...(plan ? [planFile] : []), ...(checkpoint ? [checkpointFile] : [])].map((f) => statSync(f).mtimeMs);
  return {
    company: job?.company ?? "",
    title: job?.title ?? "",
    ats: atsIdentity.split(":")[0] ?? "",
    officialUrl: job?.canonicalUrl ?? "",
    jdHash: run.jdHash,
    decision: text(plan?.decisionOutcome) || text(checkpointDecision),
    resumeVariant: text(plan?.lane),
    state: text(application?.outcome) || (job?.resolutionStatus === "resolved" ? "RESOLVED" : "DISCOVERED"),
    lastUpdate: text(application?.createdAt) || (modified.length ? new Date(Math.max(...modified)).toISOString() : ""),
    blockingReason: reasonText(application?.reason),
  };
}

/** One row per (job, JD revision). A job with no run output yet appears once, from its stored record. */
export function buildTrackerRows(sources: TrackerSources): TrackerBuild {
  const problems: string[] = [];
  const jobs = existsSync(sources.jobsPath) ? loadJobs(sources.jobsPath) : [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const runs = listRunDirs(sources.outputDir);
  const rows: TrackerRow[] = runs.map((run) => rowFromRun(byId.get(run.jobId), run, problems));
  const covered = new Set(runs.map((r) => `${r.jobId}::${r.jdHash}`));
  for (const job of jobs) {
    if (covered.has(`${job.id}::${job.jdContentHash ?? ""}`)) continue;
    rows.push({
      company: job.company,
      title: job.title,
      ats: (job.atsIdentity ?? "").split(":")[0] ?? "",
      officialUrl: job.canonicalUrl,
      jdHash: job.jdContentHash ?? "",
      decision: "",
      resumeVariant: "",
      state: job.resolutionStatus === "resolved" ? "RESOLVED" : "DISCOVERED",
      lastUpdate: job.extractedAt || job.lastSeenAt || job.discoveredAt,
      blockingReason: "",
    });
  }
  rows.sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title) || a.jdHash.localeCompare(b.jdHash));
  return { rows, problems };
}

export const rowToCells = (r: TrackerRow): string[] => [r.company, r.title, r.ats, r.officialUrl, r.jdHash, r.decision, r.resumeVariant, r.state, r.lastUpdate, r.blockingReason].map((v) => v.trim());

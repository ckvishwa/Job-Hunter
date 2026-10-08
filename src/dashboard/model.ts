import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadBoardList } from "../pipeline/discovery/board-discoverer.js";
import { loadJobs } from "../storage/job-store.js";
import { buildTrackerRows, type TrackerRow } from "../tracker/rows.js";

// Read-only projection of the authoritative stores for the local dashboard. Rows come from the same
// buildTrackerRows the tracker uses. Nothing here writes. Output is a whitelist of fields: no candidate
// facts, form answers, resume text or blocking-reason prose ever leaves this module.

export const DAILY_TARGET = { total: 30, SECURITY: 24, QA: 6 } as const;
export const FUNNEL_ORDER = ["MANUAL_WATCH", "DISCOVERED", "RESOLVED", "WAITING_FOR_USER", "BLOCKED", "REJECT", "READY_TO_SUBMIT"] as const;
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** Stage-level persistence, stated honestly: what writes data the dashboard can read. */
export const STAGE_EMITTERS = [
  { stage: "board discovery", emitsRunEvents: false, persists: "jobs.jsonl only (run totals are printed, not stored)" },
  { stage: "JD resolution", emitsRunEvents: false, persists: "jobs.jsonl (resolutionStatus, jdContentHash)" },
  { stage: "extraction / coverage", emitsRunEvents: false, persists: "pipeline-checkpoint.json, written once at run end" },
  { stage: "decision", emitsRunEvents: false, persists: "pipeline-checkpoint.json, resume-plan.json" },
  { stage: "resume plan / render", emitsRunEvents: false, persists: "resume-plan.json, application-*.json" },
  { stage: "application form", emitsRunEvents: false, persists: "application-*.json" },
  { stage: "board verify", emitsRunEvents: false, persists: "nothing (stdout JSON only)" },
] as const;

export interface DashboardSources {
  dataDir: string;
  outputDir: string;
  boardsPath?: string;
  now?: string;
}

export interface JobView {
  company: string;
  title: string;
  track: string;
  location: string;
  locationFlag: string;
  flags: string[];
  ats: string;
  state: string;
  decision: string;
  officialUrl: string;
  lastUpdate: string;
}

export interface StageView {
  stage: string;
  status: string;
  errorCode: string;
}

export interface ActivityView {
  active: boolean;
  /** No run events are emitted, so no live feed exists. */
  events: { status: "no data"; reason: string };
  latestCheckpoint: null | {
    company: string;
    title: string;
    updatedAt: string;
    outcome: string;
    stages: StageView[];
  };
  typedErrors: { company: string; title: string; stage: string; errorCode: string }[];
}

export interface DashboardSnapshot {
  generatedAt: string;
  funnel: { stage: string; count: number }[];
  activity: ActivityView;
  queue: { status: "no data"; reason: string; target: typeof DAILY_TARGET; byTrack: Record<string, number> };
  boards: { status: "ok" | "no data"; reason?: string; verifyResults: { status: "no data"; reason: string }; companies: { company: string; ats: string; board: string; ledgerJobs: number }[] };
  flags: { flag: string; count: number }[];
  jobs: JobView[];
  stageEmitters: typeof STAGE_EMITTERS;
  problems: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isHttps = (u: string) => /^https:\/\//i.test(u);

function flagsOf(r: TrackerRow): string[] {
  return [r.noSponsorship, r.clearanceRequired, r.yearsRequired ? "YEARS_REQUIRED" : "", r.remoteExcludesCt, r.locationFlag === "LOCATION_UNKNOWN" ? "LOCATION_UNKNOWN" : "", r.entrySignal ? "ENTRY_SIGNAL" : ""].filter(Boolean);
}

function readCheckpoints(outputDir: string, problems: string[]): { jobId: string; data: Record<string, unknown>; mtime: string }[] {
  if (!existsSync(outputDir)) return [];
  const found: { jobId: string; data: Record<string, unknown>; mtime: string }[] = [];
  for (const job of readdirSync(outputDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    for (const hash of readdirSync(path.join(outputDir, job.name), { withFileTypes: true })) {
      if (!hash.isDirectory()) continue;
      const file = path.join(outputDir, job.name, hash.name, "pipeline-checkpoint.json");
      if (!existsSync(file)) continue;
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as unknown;
        if (data && typeof data === "object" && !Array.isArray(data)) found.push({ jobId: job.name, data: data as Record<string, unknown>, mtime: str((data as Record<string, unknown>).updatedAt) });
      } catch {
        problems.push(`unreadable: ${job.name}/${hash.name}/pipeline-checkpoint.json`);
      }
    }
  }
  return found;
}

function stagesOf(data: Record<string, unknown>): StageView[] {
  const stages = data.stages && typeof data.stages === "object" ? (data.stages as Record<string, unknown>) : {};
  return Object.entries(stages).flatMap(([stage, value]) => {
    if (!value || typeof value !== "object") return [];
    const v = value as Record<string, unknown>;
    return [{ stage, status: str(v.status) || str(v.outcome), errorCode: str(v.errorCode) }];
  });
}

export function buildDashboardSnapshot(sources: DashboardSources): DashboardSnapshot {
  const now = sources.now ?? new Date().toISOString();
  const jobsPath = path.join(sources.dataDir, "jobs.jsonl");
  const { rows, problems } = buildTrackerRows({ jobsPath, outputDir: sources.outputDir, now });

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const known = new Set<string>(FUNNEL_ORDER);
  const funnel = [...FUNNEL_ORDER.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })), ...[...counts].filter(([s]) => !known.has(s)).map(([stage, count]) => ({ stage, count }))];

  const flagCounts = new Map<string, number>();
  for (const r of rows) for (const f of flagsOf(r)) flagCounts.set(f, (flagCounts.get(f) ?? 0) + 1);

  const byId = new Map(existsSync(jobsPath) ? loadJobs(jobsPath).map((j) => [j.id, j]) : []);
  const checkpoints = readCheckpoints(sources.outputDir, problems).sort((a, b) => a.mtime.localeCompare(b.mtime));
  const latest = checkpoints.at(-1);
  const latestJob = latest ? byId.get(latest.jobId) : undefined;
  const typedErrors = checkpoints.flatMap((c) =>
    stagesOf(c.data).filter((s) => s.errorCode).map((s) => ({ company: byId.get(c.jobId)?.company ?? "", title: byId.get(c.jobId)?.title ?? "", stage: s.stage, errorCode: s.errorCode })),
  ).slice(-20);
  const latestMs = latest ? Date.parse(latest.mtime) : NaN;
  const activity: ActivityView = {
    active: Number.isFinite(latestMs) && Date.parse(now) - latestMs >= 0 && Date.parse(now) - latestMs < ACTIVE_WINDOW_MS,
    events: { status: "no data", reason: "No stage emits run events yet; pipeline-checkpoint.json is written once at run end, so there is no live feed or event history." },
    latestCheckpoint: latest ? { company: latestJob?.company ?? "", title: latestJob?.title ?? "", updatedAt: latest.mtime, outcome: str(latest.data.outcome), stages: stagesOf(latest.data) } : null,
    typedErrors,
  };

  const byTrack: Record<string, number> = { SECURITY: 0, QA: 0 };
  for (const r of rows) if (r.track in byTrack) byTrack[r.track] = (byTrack[r.track] ?? 0) + 1;

  const ledgerByCompany = new Map<string, number>();
  for (const j of byId.values()) ledgerByCompany.set(j.company, (ledgerByCompany.get(j.company) ?? 0) + 1);
  const boards: DashboardSnapshot["boards"] = {
    status: "no data",
    verifyResults: { status: "no data", reason: "boards:verify prints JSON to stdout and stores nothing; ledgerJobs below is a count from jobs.jsonl, not a verification." },
    companies: [],
  };
  if (!sources.boardsPath || !existsSync(sources.boardsPath)) boards.reason = "No company boards file found.";
  else {
    try {
      boards.companies = loadBoardList(sources.boardsPath).companies.map((c) => ({ company: c.company, ats: c.ats, board: c.board, ledgerJobs: ledgerByCompany.get(c.company) ?? 0 }));
      boards.status = "ok";
    } catch {
      boards.reason = "Company boards file failed validation.";
    }
  }

  return {
    generatedAt: now,
    funnel,
    activity,
    queue: { status: "no data", reason: "No daily queue or per-day application counter is stored. byTrack counts all ledger rows, not today's queue.", target: DAILY_TARGET, byTrack },
    boards,
    flags: [...flagCounts].map(([flag, count]) => ({ flag, count })).sort((a, b) => b.count - a.count || a.flag.localeCompare(b.flag)),
    jobs: rows.map((r) => ({ company: r.company, title: r.title, track: r.track, location: r.location, locationFlag: r.locationFlag, flags: flagsOf(r), ats: r.ats, state: r.state, decision: r.decision, officialUrl: isHttps(r.officialUrl) ? r.officialUrl : "", lastUpdate: r.lastUpdate })),
    stageEmitters: STAGE_EMITTERS,
    problems,
  };
}

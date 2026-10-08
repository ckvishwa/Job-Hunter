import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DEFAULT_RUN_EVENTS_PATH, readRunEvents, type RunEvent } from "../events/run-events.js";
import { loadBoardList } from "../pipeline/discovery/board-discoverer.js";
import { loadJobs } from "../storage/job-store.js";
import { buildTrackerRows, type TrackerRow } from "../tracker/rows.js";

// Read-only projection of the authoritative stores for the local dashboard. Rows come from the same
// buildTrackerRows the tracker uses. Nothing here writes. Output is a whitelist of fields: no candidate
// facts, form answers, resume text or blocking-reason prose ever leaves this module.

export const DAILY_TARGET = { total: 30, SECURITY: 24, QA: 6 } as const;
export const FUNNEL_ORDER = ["MANUAL_WATCH", "DISCOVERED", "RESOLVED", "WAITING_FOR_USER", "BLOCKED", "REJECT", "READY_TO_SUBMIT"] as const;
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/** What each stage persists and whether it appends run events (src/events/run-events.ts). */
export const STAGE_EMITTERS = [
  { stage: "board discovery (boards:discover)", emitsRunEvents: true, persists: "run + per-company stage events; jobs.jsonl" },
  { stage: "portal discovery (discover / runDiscover)", emitsRunEvents: true, persists: "run + per-source stage events; jobs.jsonl" },
  { stage: "pipeline: lane / extraction / decision / resume plan / application", emitsRunEvents: true, persists: "run + stage events; pipeline-checkpoint.json at run end; application-*.json" },
  { stage: "LinkedIn and search discovery", emitsRunEvents: false, persists: "its own session files; no run events yet" },
  { stage: "JD resolution", emitsRunEvents: false, persists: "jobs.jsonl (resolutionStatus, jdContentHash); no separate stage events" },
  { stage: "board verify", emitsRunEvents: false, persists: "nothing (stdout JSON only)" },
] as const;

export interface DashboardSources {
  dataDir: string;
  outputDir: string;
  boardsPath?: string;
  /** Run-event JSONL. Defaults to private-runtime/run-events.jsonl under the working directory. */
  eventsPath?: string;
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

export interface EventView {
  at: string;
  runId: string;
  runType: string;
  kind: string;
  stage: string;
  company: string;
  jobId: string;
  outcome: string;
  errorCode: string;
  durationMs: number | null;
}

export interface ActivityView {
  /** True only when the newest run has a run.start, no run.end, and an event less than ACTIVE_WINDOW_MS old. */
  active: boolean;
  run: null | { runId: string; runType: string; startedAt: string; endedAt: string; outcome: string };
  /** Innermost stage with a stage.start and no stage.end in the newest run. */
  current: null | { stage: string; company: string; jobId: string; startedAt: string };
  events: { status: "no data"; reason: string } | { status: "ok"; items: EventView[]; skippedLines: number };
  latestCheckpoint: null | {
    company: string;
    title: string;
    updatedAt: string;
    outcome: string;
    stages: StageView[];
  };
  typedErrors: { source: "events" | "checkpoint"; company: string; title: string; stage: string; errorCode: string }[];
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

// entrySignal is read defensively: it exists on TrackerRow only once the tracker's entry-signal column is committed.
function flagsOf(r: TrackerRow): string[] {
  return [r.noSponsorship, r.clearanceRequired, r.yearsRequired ? "YEARS_REQUIRED" : "", r.remoteExcludesCt, r.locationFlag === "LOCATION_UNKNOWN" ? "LOCATION_UNKNOWN" : "", (r as { entrySignal?: string }).entrySignal ? "ENTRY_SIGNAL" : ""].filter(Boolean);
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

const NO_EVENTS_REASON = "No run events file yet. Run boards:discover, discover or pipeline and it appears under private-runtime/.";

function eventView(e: RunEvent): EventView {
  return { at: e.at, runId: e.runId, runType: e.runType, kind: e.kind, stage: e.stage ?? "", company: e.company ?? "", jobId: e.jobId ?? "", outcome: e.outcome ?? "", errorCode: e.errorCode ?? "", durationMs: e.durationMs ?? null };
}

function eventsActivity(eventsPath: string, nowMs: number): Pick<ActivityView, "active" | "run" | "current" | "events"> & { errors: EventView[] } {
  const { events, skippedLines } = readRunEvents(eventsPath);
  if (events.length === 0) return { active: false, run: null, current: null, events: { status: "no data", reason: NO_EVENTS_REASON }, errors: [] };
  // File order is write order; the newest run is the one whose last event is last in the file.
  const lastRunId = events[events.length - 1]!.runId;
  const runEvents = events.filter((e) => e.runId === lastRunId);
  const start = runEvents.find((e) => e.kind === "run.start");
  const end = runEvents.find((e) => e.kind === "run.end");
  const lastMs = Date.parse(runEvents[runEvents.length - 1]!.at);
  const open: RunEvent[] = [];
  for (const e of runEvents) {
    if (e.kind === "stage.start") open.push(e);
    else if (e.kind === "stage.end") {
      let i = open.length - 1;
      while (i >= 0 && !(open[i]!.stage === e.stage && open[i]!.company === e.company && open[i]!.jobId === e.jobId)) i -= 1;
      if (i >= 0) open.splice(i, 1);
    }
  }
  const active = !!start && !end && nowMs - lastMs >= 0 && nowMs - lastMs < ACTIVE_WINDOW_MS;
  const current = active ? open[open.length - 1] : undefined;
  return {
    active,
    run: start ? { runId: lastRunId, runType: start.runType, startedAt: start.at, endedAt: end?.at ?? "", outcome: end?.outcome ?? "" } : null,
    current: current ? { stage: current.stage ?? "", company: current.company ?? "", jobId: current.jobId ?? "", startedAt: current.at } : null,
    events: { status: "ok", items: events.slice(-20).map(eventView), skippedLines },
    errors: events.filter((e) => e.errorCode !== undefined).slice(-20).map(eventView),
  };
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
  const checkpointErrors = checkpoints.flatMap((c) =>
    stagesOf(c.data).filter((s) => s.errorCode).map((s) => ({ source: "checkpoint" as const, company: byId.get(c.jobId)?.company ?? "", title: byId.get(c.jobId)?.title ?? "", stage: s.stage, errorCode: s.errorCode })),
  );
  const live = eventsActivity(path.resolve(sources.eventsPath ?? DEFAULT_RUN_EVENTS_PATH), Date.parse(now));
  const eventErrors = live.errors.map((e) => ({ source: "events" as const, company: e.company, title: "", stage: e.stage || e.kind, errorCode: e.errorCode }));
  const activity: ActivityView = {
    active: live.active,
    run: live.run,
    current: live.current,
    events: live.events,
    latestCheckpoint: latest ? { company: latestJob?.company ?? "", title: latestJob?.title ?? "", updatedAt: latest.mtime, outcome: str(latest.data.outcome), stages: stagesOf(latest.data) } : null,
    typedErrors: [...checkpointErrors, ...eventErrors].slice(-20),
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

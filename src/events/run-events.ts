import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

// Append-only run-event log (JSONL). One line per event, never rewritten, never truncated.
//
// Redaction is structural: an event has no free-text field. Every string is either a fixed enum
// member, a code matching CODE_RE, or a short label (company / job id) stripped of control
// characters and capped. JD text, candidate facts, answers, error messages and URLs cannot be
// expressed in this schema. An error is recorded by its typed code only; anything that is not a
// plain code becomes "UNTYPED_ERROR".
//
// Recovery: a crash can leave a partial last line with no newline. The writer starts its first
// append of a process on a fresh line when the file does not end in "\n", and the reader skips any
// line that does not parse as a valid event (counting them). Nothing already written is modified.

export const RUN_TYPES = ["boards", "discovery", "pipeline"] as const;
export type RunType = (typeof RUN_TYPES)[number];
export const EVENT_KINDS = ["run.start", "run.end", "stage.start", "stage.end"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const OUTCOMES = ["OK", "ERROR", "SKIPPED"] as const;
export type StageOutcome = (typeof OUTCOMES)[number];

export interface RunEvent {
  v: 1;
  seq: number;
  at: string;
  runId: string;
  runType: RunType;
  kind: EventKind;
  stage?: string;
  company?: string;
  jobId?: string;
  /** Short result label, e.g. READY_TO_SUBMIT or OK. Same alphabet as an error code. */
  outcome?: string;
  errorCode?: string;
  durationMs?: number;
}

export const DEFAULT_RUN_EVENTS_PATH = path.join("private-runtime", "run-events.jsonl");

const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
// Control characters and Unicode line/paragraph separators (0x2028, 0x2029) are replaced by a space.
const CONTROL_RE = new RegExp("[\u0000-\u001f\u007f-\u009f\u2028\u2029]", "g");

export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && CODE_RE.test(value) ? value : undefined;
}

export function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; name?: unknown };
    return safeCode(e.code) ?? safeCode(e.name) ?? "UNTYPED_ERROR";
  }
  return "UNTYPED_ERROR";
}

function label(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned || undefined;
}

export interface EventFields {
  stage?: string;
  company?: string;
  jobId?: string;
  outcome?: string;
  errorCode?: unknown;
  durationMs?: number;
}

/** Builds the redacted event. Unknown or malformed fields are dropped, never copied through. */
export function sanitizeEvent(base: { seq: number; at: string; runId: string; runType: RunType; kind: EventKind }, fields: EventFields): RunEvent {
  const event: RunEvent = { v: 1, seq: base.seq, at: base.at, runId: base.runId, runType: base.runType, kind: base.kind };
  const stage = safeCode(fields.stage);
  if (stage) event.stage = stage;
  const company = label(fields.company, 120);
  if (company) event.company = company;
  if (typeof fields.jobId === "string" && ID_RE.test(fields.jobId)) event.jobId = fields.jobId;
  const outcome = safeCode(fields.outcome);
  if (outcome) event.outcome = outcome;
  if (fields.errorCode !== undefined) event.errorCode = safeCode(fields.errorCode) ?? "UNTYPED_ERROR";
  if (typeof fields.durationMs === "number" && Number.isFinite(fields.durationMs) && fields.durationMs >= 0) event.durationMs = Math.round(fields.durationMs);
  return event;
}

export function parseEventLine(line: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (e.v !== 1 || !Number.isInteger(e.seq) || typeof e.at !== "string" || Number.isNaN(Date.parse(e.at)) || typeof e.runId !== "string" || !ID_RE.test(e.runId)) return null;
  if (!RUN_TYPES.includes(e.runType as RunType) || !EVENT_KINDS.includes(e.kind as EventKind)) return null;
  // Re-sanitize on read: a hand-edited or foreign line cannot smuggle extra keys into the dashboard.
  return sanitizeEvent(
    { seq: e.seq as number, at: e.at, runId: e.runId, runType: e.runType as RunType, kind: e.kind as EventKind },
    { stage: e.stage as string, company: e.company as string, jobId: e.jobId as string, outcome: e.outcome as string, errorCode: e.errorCode, durationMs: e.durationMs as number },
  );
}

export interface ReadResult {
  events: RunEvent[];
  /** Lines that were not valid events (typically one partial trailing line after a crash). */
  skippedLines: number;
}

export function readRunEvents(filePath: string): ReadResult {
  if (!existsSync(filePath)) return { events: [], skippedLines: 0 };
  const events: RunEvent[] = [];
  let skippedLines = 0;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = parseEventLine(line);
    if (event) events.push(event);
    else skippedLines += 1;
  }
  return { events, skippedLines };
}

function endsWithNewline(filePath: string): boolean {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export interface StageHandle {
  end(outcome?: string, errorCode?: unknown): void;
}

export interface RunEventLog {
  readonly runId: string;
  readonly runType: RunType;
  /** Writes that failed (disk full, permissions). Logging never throws into the run. */
  readonly failedWrites: number;
  runStart(fields?: { company?: string; jobId?: string }): void;
  runEnd(outcome: string, errorCode?: unknown): void;
  stageStart(stage: string, fields?: { company?: string; jobId?: string }): StageHandle;
  /** Records a stage that failed without throwing (a typed rejection): a start/end pair with ERROR and the code. */
  failed(stage: string, fields: { company?: string; jobId?: string }, errorCode: unknown): void;
  /** Runs fn between stage.start and stage.end; records ERROR + typed code and rethrows on failure. */
  stage<T>(stage: string, fields: { company?: string; jobId?: string }, fn: () => Promise<T> | T): Promise<T>;
}

export interface RunEventOptions {
  filePath?: string;
  now?: () => string;
  runId?: string;
  /** Monotonic clock for durations (milliseconds). */
  clock?: () => number;
}

export function createRunEventLog(runType: RunType, options: RunEventOptions = {}): RunEventLog {
  const filePath = path.resolve(options.filePath ?? process.env.JOB_HUNTER_RUN_EVENTS ?? DEFAULT_RUN_EVENTS_PATH);
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock ?? (() => performance.now());
  const runId = options.runId ?? `${runType}-${now().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  let seq = 0;
  let failedWrites = 0;
  let checkedTail = false;
  let runStartedAt: number | null = null;

  const write = (kind: EventKind, fields: EventFields) => {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      let prefix = "";
      if (!checkedTail) {
        if (existsSync(filePath) && !endsWithNewline(filePath)) prefix = "\n";
        checkedTail = true;
      }
      seq += 1;
      const event = sanitizeEvent({ seq, at: now(), runId, runType, kind }, fields);
      appendFileSync(filePath, `${prefix}${JSON.stringify(event)}\n`, "utf8");
    } catch {
      failedWrites += 1;
    }
  };

  const log: RunEventLog = {
    runId,
    runType,
    get failedWrites() {
      return failedWrites;
    },
    runStart(fields = {}) {
      runStartedAt = clock();
      write("run.start", fields);
    },
    runEnd(outcome, errorCode) {
      write("run.end", { outcome, errorCode, durationMs: runStartedAt === null ? undefined : clock() - runStartedAt });
    },
    stageStart(stage, fields = {}) {
      const started = clock();
      write("stage.start", { stage, ...fields });
      let ended = false;
      return {
        end(outcome = "OK", errorCode) {
          if (ended) return;
          ended = true;
          write("stage.end", { stage, ...fields, outcome: errorCode === undefined ? outcome : "ERROR", errorCode, durationMs: clock() - started });
        },
      };
    },
    failed(stage, fields, errorCode) {
      log.stageStart(stage, fields).end("ERROR", errorCode);
    },
    async stage(stage, fields, fn) {
      const handle = log.stageStart(stage, fields);
      try {
        const result = await fn();
        handle.end("OK");
        return result;
      } catch (error) {
        handle.end("ERROR", errorCodeOf(error));
        throw error;
      }
    },
  };
  return log;
}

/** A log that records nothing; the default when a caller does not opt in (tests, library use). */
export function noopRunEventLog(runType: RunType = "pipeline"): RunEventLog {
  const handle: StageHandle = { end() {} };
  return { runId: "noop", runType, failedWrites: 0, runStart() {}, runEnd() {}, stageStart: () => handle, failed() {}, stage: async (_s, _f, fn) => fn() };
}

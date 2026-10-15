import { z } from "zod";

// Read-only projection of docs/PROGRESS_LEDGER.json for the internal Project dashboard.
//
// The Python script scripts/sync_progress.py is the authority for ledger rules. These functions are a faithful port of the
// rules the dashboard needs (phase state, evidence validation, next task) and are pinned to it by golden fixtures and a
// parity test (tests/project/ledger-parity.test.ts). Nothing here writes to the ledger or invents a status.

export const TASK_STATUSES = ["PLANNED", "REPORTED_UNVERIFIED", "IN_PROGRESS", "BLOCKED", "QA_REVIEW", "VERIFIED"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
const KNOWN_STATUS: ReadonlySet<string> = new Set(TASK_STATUSES);

const text = z.string().default("");
const evidenceSchema = z
  .object({
    commit_sha: text, test_command: text, test_result: text, test_log_or_ci: text, qa_reviewer: text, qa_signoff_at: text, notes: text,
  })
  .passthrough();

const taskSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    status: z.string(),
    evidence: evidenceSchema.default({}),
    owner_role: z.string().nullable().default(null),
    reviewer_role: z.string().nullable().default(null),
    github_issue: z.number().int().positive().nullable().default(null),
    branch: z.string().nullable().default(null),
    pull_request: z.number().int().positive().nullable().default(null),
    priority: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();

const phaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    depends_on: z.array(z.string()).default([]),
    prd_refs: z.array(z.string()).default([]),
    exit_criterion: z.string().default(""),
    blocker: z.string().nullable().default(null),
    qa_signoff: z.object({ reviewer: text, approved_at: text, evidence: text }).passthrough().default({}),
    tasks: z.array(taskSchema),
  })
  .passthrough();

export const ledgerSchema = z
  .object({
    schema_version: z.union([z.string(), z.number()]).optional(),
    name: z.string().default(""),
    baseline: z.string().default(""),
    prd_sha256: z.string().default(""),
    status_claim: z.string().default(""),
    phases: z.array(phaseSchema).min(1),
    collaboration: z
      .object({ github_accounts: z.record(z.string()).default({}) })
      .passthrough()
      .default({}),
  })
  .passthrough();

export type Ledger = z.infer<typeof ledgerSchema>;
export type LedgerPhase = Ledger["phases"][number];
export type LedgerTask = LedgerPhase["tasks"][number];

export class LedgerShapeError extends Error {}

/** Throws LedgerShapeError (with field paths only, never values) when the structure cannot be used at all. */
export function parseLedger(raw: unknown): Ledger {
  const parsed = ledgerSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)").join(", ");
    throw new LedgerShapeError(`The ledger structure is not valid (see: ${where}).`);
  }
  return parsed.data;
}

// --- phase state (port of sync_progress.state) ---------------------------------------------------------------------------

export type PhaseState = TaskStatus;

export function phaseStates(ledger: Ledger): Map<string, PhaseState> {
  const index = new Map(ledger.phases.map((p) => [p.id, p]));
  const cache = new Map<string, PhaseState>();
  const visiting = new Set<string>();
  const state = (phase: LedgerPhase): PhaseState => {
    const hit = cache.get(phase.id);
    if (hit) return hit;
    if (visiting.has(phase.id)) return "BLOCKED"; // a dependency cycle can never be green
    visiting.add(phase.id);
    let result: PhaseState;
    if (phase.blocker) result = "BLOCKED";
    else {
      const tasks = phase.tasks;
      const any = (s: string) => tasks.some((t) => t.status === s);
      const dependenciesOk = phase.depends_on.every((d) => {
        const dep = index.get(d);
        return dep !== undefined && state(dep) === "VERIFIED";
      });
      const sign = phase.qa_signoff;
      const approved = Boolean(sign.reviewer && sign.approved_at && sign.evidence);
      if (tasks.length > 0 && tasks.every((t) => t.status === "VERIFIED") && dependenciesOk && approved) result = "VERIFIED";
      else if (any("BLOCKED")) result = "BLOCKED";
      else if (any("QA_REVIEW")) result = "QA_REVIEW";
      else if (any("IN_PROGRESS")) result = "IN_PROGRESS";
      else if (any("VERIFIED")) result = "IN_PROGRESS";
      else if (any("REPORTED_UNVERIFIED")) result = "REPORTED_UNVERIFIED";
      else result = "PLANNED";
    }
    visiting.delete(phase.id);
    cache.set(phase.id, result);
    return result;
  };
  for (const p of ledger.phases) state(p);
  return cache;
}

// --- validation (port of sync_progress.validate, minus the PRD file check which sources.ts supplies) -------------------

const HEX_SHA = /^[0-9a-fA-F]{7,40}$/;

/** Errors for one task, with the same wording as the Python checker. Empty means the recorded status is internally consistent. */
export function taskErrors(task: LedgerTask): string[] {
  const errors: string[] = [];
  const ev = task.evidence;
  if (!KNOWN_STATUS.has(task.status)) errors.push(`${task.id}: invalid status ${task.status}`);
  if (task.status === "QA_REVIEW" || task.status === "VERIFIED") {
    for (const field of ["commit_sha", "test_command", "test_result", "test_log_or_ci"] as const) {
      if (!ev[field]) errors.push(`${task.id}: ${task.status} requires evidence.${field}`);
    }
    if (ev.commit_sha && !HEX_SHA.test(ev.commit_sha)) errors.push(`${task.id}: commit_sha must be actual 7–40 hex characters`);
    if (ev.test_result && ev.test_result !== "PASS") errors.push(`${task.id}: ${task.status} must cite a PASS result (real logs independently verified)`);
  }
  if (task.status === "VERIFIED") {
    for (const field of ["qa_reviewer", "qa_signoff_at"] as const) {
      if (!ev[field]) errors.push(`${task.id}: VERIFIED requires independent ${field}`);
    }
  }
  return errors;
}

export interface Governance {
  /** Ledger-wide problems (PRD hash, duplicate ids, bad dependencies, phase sign-off). */
  ledgerErrors: string[];
  /** Per task id. */
  taskErrors: Map<string, string[]>;
}

export function governance(ledger: Ledger, prdSha256: string | null): Governance {
  const ledgerErrors: string[] = [];
  if (prdSha256 === null) ledgerErrors.push("Missing docs/PRD.md");
  else if (prdSha256 !== ledger.prd_sha256) ledgerErrors.push("PRD SHA256 differs from locked baseline: require approved ADR and deliberate PRD version/hash update.");
  const ids = ledger.phases.map((p) => p.id);
  if (new Set(ids).size !== ids.length) ledgerErrors.push("Duplicate phase ids");
  const known = new Set(ids);
  const earlier = new Set<string>();
  const perTask = new Map<string, string[]>();
  for (const p of ledger.phases) {
    for (const dep of p.depends_on) {
      if (!known.has(dep)) ledgerErrors.push(`${p.id}: missing dependency ${dep}`);
      if (!earlier.has(dep)) ledgerErrors.push(`${p.id}: dependency ${dep} not earlier in ledger (possible cycle)`);
    }
    earlier.add(p.id);
    const taskIds = p.tasks.map((t) => t.id);
    if (new Set(taskIds).size !== taskIds.length) ledgerErrors.push(`${p.id}: duplicate task ids`);
    for (const t of p.tasks) perTask.set(t.id, taskErrors(t));
    if (p.qa_signoff.approved_at && !p.qa_signoff.reviewer) ledgerErrors.push(`${p.id}: signoff time without reviewer`);
  }
  return { ledgerErrors, taskErrors: perTask };
}

/** A VERIFIED status counts only when the ledger rules accept its evidence. */
export function isAcceptedVerified(task: LedgerTask, gov: Governance): boolean {
  return task.status === "VERIFIED" && (gov.taskErrors.get(task.id) ?? []).length === 0;
}

// --- next task (port of sync_progress.next_task) -------------------------------------------------------------------------

export function nextTask(ledger: Ledger, states: Map<string, PhaseState>): { phase: string; id: string; name: string; status: string } | null {
  for (const p of ledger.phases) {
    if (!p.depends_on.every((d) => states.get(d) === "VERIFIED")) continue;
    for (const t of p.tasks) {
      if (["IN_PROGRESS", "PLANNED", "REPORTED_UNVERIFIED", "BLOCKED"].includes(t.status)) return { phase: p.id, id: t.id, name: t.name, status: t.status };
    }
  }
  return null;
}

// Pure view-model for the Project page: types of the read-only /api/v1/project/* payloads, filtering, grouping and PRD linking.
// No DOM and no network here, so the rules are unit-tested (tests/web/project-model.test.ts).

export type Status = "PLANNED" | "REPORTED_UNVERIFIED" | "IN_PROGRESS" | "BLOCKED" | "QA_REVIEW" | "VERIFIED";

export interface Overview {
  ledger: { name: string; baseline: string; statusClaim: string; source: string; sourceUrl: string };
  counts: { phases: number; phasesVerified: number; tasks: number; byStatus: Record<Status, number>; verified: number; percentVerified: number };
  gate: { label: string; phaseId: string; phaseName: string; state: Status; passed: boolean; blocker: string | null; exitCriterion: string };
  nextTask: { phase: string; id: string; name: string; status: string } | null;
  qaQueue: Array<{ id: string; name: string; reviewerRole: string | null }>;
  latestEvidence: Array<{ taskId: string; status: string; commit: string | null; pullRequest: number | null; links: TaskLinks; accepted: boolean }>;
  prd: { source: string; sourceUrl: string; lockedSha256: string; sha256: string | null; hashMatches: boolean };
  validation: { ok: boolean; ledgerErrors: string[]; taskErrorCount: number; errors: string[] };
  team: Array<{ role: string; handle: string; title: string; url: string }>;
}

export interface TaskLinks { issue: string | null; pullRequest: string | null; commit: string | null; branch: string | null }

export interface Phase {
  id: string; name: string; dependsOn: string[]; prdRefs: string[]; exitCriterion: string; blocker: string | null; state: Status;
  qaSignoff: { reviewer: string; approvedAt: string; evidence: string };
  totalTasks: number; verifiedTasks: number; percent: number; byStatus: Record<Status, number>;
  waitingOn: string[]; dependenciesMet: boolean; taskIds: string[];
}

export type EvidenceState = "accepted" | "awaiting-qa" | "invalid" | "partial" | "none";

export interface Task {
  id: string; name: string; phaseId: string; phaseName: string; status: Status; accepted: boolean;
  ownerRole: string | null; reviewerRole: string | null; priority: string | number | null;
  githubIssue: number | null; pullRequest: number | null; branch: string | null; links: TaskLinks;
  prdRefs: string[]; dependencies: string[]; waitingOn: string[]; blocker: string | null;
  evidenceState: EvidenceState; evidence: Array<{ field: string; value: string; recorded: boolean }>;
  validationErrors: string[]; nextAction: string; ktLinks: Array<{ title: string; path: string; url: string }>;
}

export interface PrdSection { id: string; level: number; title: string; number: string | null; parentId: string | null; body: string }
export interface Prd { title: string; version: string | null; source: string; sourceUrl: string; sha256: string; lockedSha256: string; hashMatches: boolean; intro: string; sections: PrdSection[] }
export interface Notebook { source: string; sourceUrl: string; intro: string; entries: Array<{ id: string; date: string | null; title: string; body: string }> }

// --- presentation of statuses ----------------------------------------------------------------------------------------------
// Colour is never the only signal: every status has a glyph and a label. "Verified" is shown as done only when the ledger
// accepted its evidence; a recorded-but-rejected VERIFIED is its own warning state.

export const STATUS_ORDER: Status[] = ["PLANNED", "REPORTED_UNVERIFIED", "IN_PROGRESS", "QA_REVIEW", "BLOCKED", "VERIFIED"];
export const STATUS_LABEL: Record<Status, string> = {
  PLANNED: "Planned", REPORTED_UNVERIFIED: "Reported, unverified", IN_PROGRESS: "In progress", QA_REVIEW: "QA review", BLOCKED: "Blocked", VERIFIED: "Verified",
};
export const STATUS_GLYPH: Record<Status, string> = { PLANNED: "○", REPORTED_UNVERIFIED: "◇", IN_PROGRESS: "◐", QA_REVIEW: "◑", BLOCKED: "■", VERIFIED: "✓" };

export function statusKey(task: Pick<Task, "status" | "accepted">): string {
  return task.status === "VERIFIED" && !task.accepted ? "rejected" : task.status.toLowerCase();
}
export function statusText(task: Pick<Task, "status" | "accepted">): string {
  return task.status === "VERIFIED" && !task.accepted ? "Recorded verified, evidence not accepted" : STATUS_LABEL[task.status] ?? task.status;
}

export const ROLE_LABEL: Record<string, string> = { DEVELOPER: "ckvishwa (Developer)", HANI: "Hani456 (QA)", PRODUCT_OWNER: "Product Owner" };
export function roleName(role: string | null, team: Overview["team"]): string {
  if (!role) return "Unassigned";
  const member = team.find((m) => m.role === role);
  if (member) return member.handle;
  return role === "PRODUCT_OWNER" ? "Product Owner" : role;
}

export function percentText(n: number): string {
  return `${n}%`;
}

// --- board ---------------------------------------------------------------------------------------------------------------------

export const BOARD_COLUMNS: Array<{ key: Status; title: string }> = [
  { key: "PLANNED", title: "Planned" },
  { key: "REPORTED_UNVERIFIED", title: "Reported (unverified)" },
  { key: "IN_PROGRESS", title: "In progress" },
  { key: "QA_REVIEW", title: "QA review" },
  { key: "BLOCKED", title: "Blocked" },
  { key: "VERIFIED", title: "Verified" },
];

export interface TaskFilter { query: string; phase: string; owner: string; status: string }
export const NO_FILTER: TaskFilter = { query: "", phase: "", owner: "", status: "" };

export function filterTasks(tasks: Task[], f: TaskFilter): Task[] {
  const q = f.query.trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.phase && t.phaseId !== f.phase) return false;
    if (f.owner && t.ownerRole !== f.owner) return false;
    if (f.status && t.status !== f.status) return false;
    if (!q) return true;
    return [t.id, t.name, t.phaseId, t.phaseName, t.ownerRole ?? "", t.reviewerRole ?? "", t.status, t.githubIssue ? `#${t.githubIssue}` : ""].some((v) => v.toLowerCase().includes(q));
  });
}

export function groupByStatus(tasks: Task[]): Record<Status, Task[]> {
  const out = Object.fromEntries(STATUS_ORDER.map((s) => [s, [] as Task[]])) as Record<Status, Task[]>;
  for (const t of tasks) (out[t.status] ?? (out[t.status] = [])).push(t);
  return out;
}

// --- team ----------------------------------------------------------------------------------------------------------------------

export interface TeamView {
  assigned: Task[];
  awaitingReview: Task[];
  reviewerOn: number;
  blockers: Array<{ taskId: string; text: string }>;
  ktLinks: Array<{ title: string; url: string }>;
}

/** Assignment follows owner_role / reviewer_role in the ledger; PRODUCT_OWNER work is the Technical Lead's. Having an assignee proves nothing about progress. */
export function teamView(tasks: Task[], role: string): TeamView {
  const owns = (t: Task) => t.ownerRole === role || (role === "DEVELOPER" && t.ownerRole === "PRODUCT_OWNER");
  const assigned = tasks.filter(owns);
  const awaitingReview = tasks.filter((t) => t.reviewerRole === role && t.status === "QA_REVIEW");
  const blockers = assigned.filter((t) => t.status === "BLOCKED" || (t.blocker && t.status !== "VERIFIED")).map((t) => ({ taskId: t.id, text: t.blocker ?? "Marked blocked in the ledger." }));
  const kt = new Map<string, string>();
  for (const t of assigned) for (const k of t.ktLinks) kt.set(k.url, k.title);
  return { assigned, awaitingReview, reviewerOn: tasks.filter((t) => t.reviewerRole === role).length, blockers, ktLinks: [...kt].map(([url, title]) => ({ title, url })) };
}

// --- PRD -----------------------------------------------------------------------------------------------------------------------

export type PrdTarget = { kind: "section"; number: string } | { kind: "search"; query: string };

/** "PRD §12 P0" -> section 12; "FR-0301–0308" -> search "FR-0301"; "G3" -> search "G3". */
export function prdRefTarget(ref: string): PrdTarget {
  const sec = /§\s*(\d+(?:\.\d+)*)/.exec(ref);
  if (sec) return { kind: "section", number: sec[1]! };
  const token = /[A-Za-z]+-?\d+/.exec(ref);
  return { kind: "search", query: token ? token[0]! : ref.trim() };
}

export function sectionForNumber(prd: Prd, number: string): PrdSection | null {
  return prd.sections.find((s) => s.number === number) ?? null;
}

export interface PrdHit { section: PrdSection; count: number }

export function searchPrd(prd: Prd, query: string): PrdHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: PrdHit[] = [];
  for (const s of prd.sections) {
    const hay = `${s.title}\n${s.body}`.toLowerCase();
    let count = 0;
    for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) count += 1;
    if (count > 0) hits.push({ section: s, count });
  }
  return hits;
}

// --- hash routing ---------------------------------------------------------------------------------------------------------------

export const TABS = ["overview", "prd", "roadmap", "board", "team", "notebook"] as const;
export type Tab = (typeof TABS)[number];
export interface Route { tab: Tab; arg: string | null; query: string | null; task: string | null }

/** `#/prd/<section>`, `#/prd?q=text`, `#/roadmap/<phase>`, `#/task/<id>` (opens the detail dialog over the previous tab). Unknown input falls back to overview. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", qs = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ""; } });
  const query = new URLSearchParams(qs).get("q");
  if (parts[0] === "task" && parts[1]) return { tab: "board", arg: null, query: null, task: parts[1] };
  const tab = (TABS as readonly string[]).includes(parts[0] ?? "") ? (parts[0] as Tab) : "overview";
  return { tab, arg: parts[1] ?? null, query: query && query.length <= 80 ? query : null, task: null };
}

export function routeHref(tab: Tab, arg?: string | null, query?: string | null): string {
  const base = `#/${tab}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
  return query ? `${base}?q=${encodeURIComponent(query)}` : base;
}
export const taskHref = (id: string): string => `#/task/${encodeURIComponent(id)}`;

import {
  TASK_STATUSES, governance, isAcceptedVerified, nextTask, parseLedger, phaseStates,
  type Governance, type Ledger, type LedgerPhase, type LedgerTask, type PhaseState,
} from "./ledger.js";
import { splitNotebook, splitSections } from "./markdown.js";
import { KT_FILES, PROJECT_FILES, ProjectSourceError, type ProjectSources } from "./sources.js";

// Builds the JSON the Project dashboard reads. Every number is computed from the ledger records on each request; nothing is cached
// or hard-coded, and nothing here can change a status. A VERIFIED task counts as done only when the ledger rules accept its evidence.

export const DEFAULT_REPO_URL = "https://github.com/ckvishwa/Job-Hunter";

const TEAM_TITLES: Record<string, string> = {
  DEVELOPER: "Technical Lead, AI/ML Architect and Principal Developer",
  HANI: "Senior AI/ML & SDET Intern",
};
const EVIDENCE_FIELDS = ["commit_sha", "test_command", "test_result", "test_log_or_ci", "qa_reviewer", "qa_signoff_at", "notes"] as const;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const SAFE_HANDLE = /^[A-Za-z0-9-]{1,39}$/;
const SHA = /^[0-9a-fA-F]{7,40}$/;

export interface ProjectOptions {
  sources: ProjectSources;
  repoUrl?: string;
}

interface Loaded {
  ledger: Ledger;
  gov: Governance;
  states: Map<string, PhaseState>;
  prd: { text: string; sha256: string; path: string } | null;
  repo: string;
}

async function load(opts: ProjectOptions): Promise<Loaded> {
  const file = await opts.sources.readFixed("ledger");
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch {
    throw new ProjectSourceError("PROJECT_SOURCE_INVALID", PROJECT_FILES.ledger, "The progress ledger is not valid JSON.");
  }
  let ledger: Ledger;
  try {
    ledger = parseLedger(raw);
  } catch (error) {
    throw new ProjectSourceError("PROJECT_SOURCE_INVALID", PROJECT_FILES.ledger, error instanceof Error ? error.message : "The progress ledger is not valid.");
  }
  let prd: Loaded["prd"] = null;
  try {
    prd = await opts.sources.readFixed("prd");
  } catch (error) {
    if (!(error instanceof ProjectSourceError) || error.code !== "PROJECT_SOURCE_MISSING") throw error;
  }
  return { ledger, gov: governance(ledger, prd?.sha256 ?? null), states: phaseStates(ledger), prd, repo: (opts.repoUrl ?? DEFAULT_REPO_URL).replace(/\/+$/, "") };
}

// --- links ---------------------------------------------------------------------------------------------------------------

function blob(repo: string, relative: string): string {
  return `${repo}/blob/HEAD/${relative}`;
}
function taskLinks(repo: string, t: LedgerTask) {
  const sha = t.evidence.commit_sha;
  return {
    issue: t.github_issue ? `${repo}/issues/${t.github_issue}` : null,
    pullRequest: t.pull_request ? `${repo}/pull/${t.pull_request}` : null,
    commit: sha && SHA.test(sha) ? `${repo}/commit/${sha}` : null,
    branch: t.branch && SAFE_BRANCH.test(t.branch) && !t.branch.includes("..") ? `${repo}/tree/${t.branch}` : null,
  };
}

// --- tasks ---------------------------------------------------------------------------------------------------------------

type EvidenceState = "accepted" | "awaiting-qa" | "invalid" | "partial" | "none";

function evidenceState(t: LedgerTask, errors: string[]): EvidenceState {
  const recorded = EVIDENCE_FIELDS.filter((f) => f !== "notes").some((f) => Boolean(t.evidence[f]));
  if (errors.length > 0) return "invalid";
  if (t.status === "VERIFIED") return "accepted";
  if (t.status === "QA_REVIEW") return "awaiting-qa";
  return recorded ? "partial" : "none";
}

function nextAction(t: LedgerTask, phase: LedgerPhase, errors: string[]): string {
  if (errors.length > 0) return "Fix the recorded evidence so the ledger check passes; this status is not accepted until then.";
  switch (t.status) {
    case "PLANNED": return "Not started. Start work, then record the actual commit and test evidence.";
    case "IN_PROGRESS": return "Finish the work, record commit_sha, test_command, test_result (PASS) and test_log_or_ci, then request QA_REVIEW.";
    case "QA_REVIEW": return `${t.reviewer_role ?? "The reviewer"} reproduces the recorded test independently and records qa_reviewer and qa_signoff_at.`;
    case "BLOCKED": return phase.blocker ? `Clear the blocker: ${phase.blocker}` : "Clear the blocker, then resume.";
    case "REPORTED_UNVERIFIED": return "Re-verify against the current code before relying on this report.";
    case "VERIFIED": return "None. Verified with accepted evidence.";
    default: return "Correct the status in the ledger.";
  }
}

async function ktIndex(opts: ProjectOptions): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of KT_FILES) {
    const text = await opts.sources.readOptional(file);
    if (text !== null) out.push({ file, text });
  }
  return out;
}

function ktLinksFor(taskId: string, index: Array<{ file: string; text: string }>, repo: string) {
  const re = new RegExp(`(^|[^A-Za-z0-9-])${taskId.replace(/[^A-Za-z0-9-]/g, "")}($|[^A-Za-z0-9-])`);
  return index.filter((k) => re.test(k.text)).map((k) => ({ title: k.file.split("/").pop()!, path: k.file, url: blob(repo, k.file) }));
}

export async function tasksView(opts: ProjectOptions) {
  const { ledger, gov, states, repo } = await load(opts);
  const kt = await ktIndex(opts);
  const tasks = ledger.phases.flatMap((phase) =>
    phase.tasks.map((t) => {
      const errors = gov.taskErrors.get(t.id) ?? [];
      const deps = phase.depends_on;
      const waitingOn = deps.filter((d) => states.get(d) !== "VERIFIED");
      return {
        id: t.id,
        name: t.name,
        phaseId: phase.id,
        phaseName: phase.name,
        status: t.status,
        accepted: isAcceptedVerified(t, gov),
        ownerRole: t.owner_role,
        reviewerRole: t.reviewer_role,
        priority: t.priority ?? null,
        githubIssue: t.github_issue,
        pullRequest: t.pull_request,
        branch: t.branch,
        links: taskLinks(repo, t),
        prdRefs: phase.prd_refs,
        dependencies: deps,
        waitingOn,
        blocker: t.status === "BLOCKED" || phase.blocker ? phase.blocker : null,
        evidenceState: evidenceState(t, errors),
        evidence: EVIDENCE_FIELDS.map((field) => ({ field, value: t.evidence[field] ?? "", recorded: Boolean(t.evidence[field]) })),
        validationErrors: errors,
        nextAction: nextAction(t, phase, errors),
        ktLinks: ktLinksFor(t.id, kt, repo),
      };
    }),
  );
  return { tasks };
}

// --- phases --------------------------------------------------------------------------------------------------------------

export async function phasesView(opts: ProjectOptions) {
  const { ledger, gov, states } = await load(opts);
  const phases = ledger.phases.map((p) => {
    const total = p.tasks.length;
    const verified = p.tasks.filter((t) => isAcceptedVerified(t, gov)).length;
    const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, p.tasks.filter((t) => t.status === s).length]));
    const waitingOn = p.depends_on.filter((d) => states.get(d) !== "VERIFIED");
    return {
      id: p.id, name: p.name, dependsOn: p.depends_on, prdRefs: p.prd_refs, exitCriterion: p.exit_criterion, blocker: p.blocker,
      state: states.get(p.id) ?? "PLANNED", qaSignoff: { reviewer: p.qa_signoff.reviewer, approvedAt: p.qa_signoff.approved_at, evidence: p.qa_signoff.evidence },
      totalTasks: total, verifiedTasks: verified, percent: total === 0 ? 0 : Math.floor((verified * 100) / total), byStatus,
      waitingOn, dependenciesMet: waitingOn.length === 0, taskIds: p.tasks.map((t) => t.id),
    };
  });
  return { phases };
}

// --- overview ------------------------------------------------------------------------------------------------------------

export async function overviewView(opts: ProjectOptions) {
  const { ledger, gov, states, prd, repo } = await load(opts);
  const all = ledger.phases.flatMap((p) => p.tasks.map((t) => ({ t, p })));
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, all.filter(({ t }) => t.status === s).length]));
  const total = all.length;
  const verified = all.filter(({ t }) => isAcceptedVerified(t, gov)).length;
  const next = nextTask(ledger, states);
  const gatePhase = ledger.phases[0]!;
  const gateState = states.get(gatePhase.id) ?? "PLANNED";
  const accounts = ledger.collaboration.github_accounts;
  const team = (["DEVELOPER", "HANI"] as const)
    .filter((role) => accounts[role] && SAFE_HANDLE.test(accounts[role]!))
    .map((role) => ({ role, handle: accounts[role]!, title: TEAM_TITLES[role]!, url: `https://github.com/${accounts[role]}` }));
  const taskErrorTotal = [...gov.taskErrors.values()].reduce((n, e) => n + e.length, 0);
  const allErrors = [...gov.ledgerErrors, ...[...gov.taskErrors.values()].flat()];
  return {
    ledger: { name: ledger.name, baseline: ledger.baseline, statusClaim: ledger.status_claim, source: PROJECT_FILES.ledger, sourceUrl: blob(repo, PROJECT_FILES.ledger) },
    counts: {
      phases: ledger.phases.length,
      phasesVerified: ledger.phases.filter((p) => states.get(p.id) === "VERIFIED").length,
      tasks: total, byStatus, verified,
      percentVerified: total === 0 ? 0 : Math.floor((verified * 100) / total),
    },
    gate: {
      label: "Gate A", phaseId: gatePhase.id, phaseName: gatePhase.name, state: gateState, passed: gateState === "VERIFIED",
      blocker: gatePhase.blocker, exitCriterion: gatePhase.exit_criterion,
    },
    nextTask: next,
    qaQueue: all.filter(({ t }) => t.status === "QA_REVIEW").map(({ t }) => ({ id: t.id, name: t.name, reviewerRole: t.reviewer_role })),
    latestEvidence: all
      .filter(({ t }) => t.evidence.commit_sha || t.pull_request)
      .slice(-6)
      .map(({ t }) => ({ taskId: t.id, status: t.status, commit: t.evidence.commit_sha || null, pullRequest: t.pull_request, links: taskLinks(repo, t), accepted: isAcceptedVerified(t, gov) })),
    prd: {
      source: PROJECT_FILES.prd, sourceUrl: blob(repo, PROJECT_FILES.prd), lockedSha256: ledger.prd_sha256,
      sha256: prd?.sha256 ?? null, hashMatches: prd ? prd.sha256 === ledger.prd_sha256 : false,
    },
    validation: { ok: allErrors.length === 0, ledgerErrors: gov.ledgerErrors, taskErrorCount: taskErrorTotal, errors: allErrors.slice(0, 50) },
    team,
  };
}

// --- PRD and notebook ----------------------------------------------------------------------------------------------------

export async function prdView(opts: ProjectOptions) {
  const loaded = await load(opts);
  const file = loaded.prd ?? (await opts.sources.readFixed("prd"));
  const { intro, sections } = splitSections(file.text, 1, 3);
  const title = /^#\s+(.+)$/m.exec(file.text)?.[1]?.trim() ?? "Product Requirements";
  const version = /^\s*\*{0,2}version\*{0,2}\s*[:|-]\s*(.+)$/im.exec(file.text)?.[1]?.replace(/[*_`]/g, "").trim() ?? null;
  return {
    title, version, source: file.path, sourceUrl: blob(loaded.repo, file.path), sha256: file.sha256, lockedSha256: loaded.ledger.prd_sha256,
    hashMatches: file.sha256 === loaded.ledger.prd_sha256, intro, sections,
  };
}

export async function notebookView(opts: ProjectOptions) {
  const file = await opts.sources.readFixed("notebook");
  const repo = (opts.repoUrl ?? DEFAULT_REPO_URL).replace(/\/+$/, "");
  const { intro, entries } = splitNotebook(file.text);
  return { source: file.path, sourceUrl: blob(repo, file.path), intro, entries };
}

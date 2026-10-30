// Pure view-model for the home dashboard: it only re-states what the API already holds. No DOM, no network, so it is unit tested.
// Nothing here invents a number: every count is a sum or a copy of API data, and a missing source is reported as missing.

export interface ResumeRow {
  resumeId: string;
  fileType: string;
  createdAt: string;
  state: string;
  errorCode: string | null;
  counts: { pending: number; approved: number; rejected: number };
}

export interface Gap { code: string; message: string }
export interface Requirement { id: string; label: string; importance: string; met: boolean }
export interface Rec {
  roleSlug: string;
  title: string;
  familyName: string;
  familyTier: string;
  support: string;
  status: string;
  gaps: Gap[];
  evidence: { coreMet: number; coreTotal: number; minCoreMatches: number; requirements?: Requirement[] };
}
export interface NoMatch { roleSlug: string; title: string; familyName: string; familyTier: string }
export interface Bucket { monthsLower: number; monthsUpper: number; gaps: Array<{ from: string; to: string; months: number }> }
export interface Selection {
  revisionNo: number;
  roleSlugs: string[];
  targetFamilies: string[];
  locations: Array<{ kind: string; value: string }>;
  workModes: string[];
  seniorityLevels: string[];
  searchBand: { minYears: number; maxYears: number };
}
export interface RolesState {
  catalogVersion: number;
  experience: { status: string; buckets: Record<string, Bucket>; issues: Array<{ code: string; severity: string; message: string }>; asOf: string };
  suggestedSearchBand: { minYears: number; maxYears: number; basis: string };
  recommendations: Rec[];
  noMatch: NoMatch[];
  staleDecisions: Array<{ roleSlug: string; title: string }>;
  selection: Selection | null;
}

export interface DiscoverySummary {
  boardsConfigured: boolean;
  latestRun: { status: string; progress: { verified: number; boardsDone: number; boardsTotal: number } } | null;
}

export interface DashboardInput {
  /** S3 status. undefined = the caller does not know about discovery (S3 is shown as upcoming); null = it could not be loaded. */
  discovery?: DiscoverySummary | null;
  /** null = that source could not be loaded (distinct from "loaded and empty"). */
  resumes: ResumeRow[] | null;
  roles: RolesState | null;
  /** Count of explicitly stated sensitive facts. Values are never shown on the dashboard. */
  statementCount: number | null;
}

export type StepStatus = "not-started" | "in-progress" | "done" | "upcoming";
export interface PipelineStep { id: "S1" | "S2" | "S3"; title: string; status: StepStatus; detail: string }

export type NextAction =
  | { kind: "link"; label: string; reason: string; href: string }
  | { kind: "wait"; label: string; reason: string }
  | { kind: "retry"; label: string; reason: string }
  | { kind: "none"; label: string; reason: string };

export interface ExperienceSummary {
  status: "NO_DATA" | "OK" | "REVIEW" | "UNKNOWN";
  professional: { lower: number; upper: number } | null;
  internship: { lower: number; upper: number } | null;
  summary: string;
  uncertainty: string;
  issueMessages: string[];
}

export interface RoleItem { roleSlug: string; title: string; family: string; support: string; status: string; coreMet: number; coreTotal: number; gaps: string[] }

export interface DashboardView {
  resumeStatus: { loaded: boolean; total: number; processing: number; failed: number; latest: { fileType: string; createdAt: string; state: string; errorCode: string | null } | null };
  facts: { loaded: boolean; pending: number; approved: number; rejected: number; statements: number | null };
  experience: ExperienceSummary | null;
  cyberRoles: { items: RoleItem[]; hiddenCount: number; otherSuggestionCount: number; staleCount: number } | null;
  selection: { revisionNo: number; roles: Array<{ slug: string; title: string }>; places: string[]; workModes: string[]; levels: string[]; band: string } | null;
  hasSavedSelection: boolean;
  pipeline: PipelineStep[];
  next: NextAction;
  missing: string[];
}

export const monthsText = (lo: number, hi: number): string => (lo === hi ? `${lo} months` : `${lo}–${hi} months`);
export const yearsText = (lo: number, hi: number): string => (lo === hi ? `${(lo / 12).toFixed(1)} years` : `${(lo / 12).toFixed(1)}–${(hi / 12).toFixed(1)} years`);

const MAX_ROLES_SHOWN = 6;

function summarizeExperience(r: RolesState): ExperienceSummary {
  const professional = r.experience.buckets.professional;
  const internship = r.experience.buckets.internship;
  const status = (["NO_DATA", "OK", "REVIEW"] as const).find((s) => s === r.experience.status) ?? "UNKNOWN";
  const issueMessages = r.experience.issues.map((i) => i.message).slice(0, 3);
  if (status === "NO_DATA" || !professional) {
    return {
      status: status === "NO_DATA" ? "NO_DATA" : "UNKNOWN", professional: null, internship: null, issueMessages,
      summary: "No experience is counted yet.",
      uncertainty: "Experience is counted only from jobs you approved and classified. Approve your employment facts to see a figure.",
    };
  }
  const pro = { lower: professional.monthsLower, upper: professional.monthsUpper };
  const intern = internship && (internship.monthsUpper > 0) ? { lower: internship.monthsLower, upper: internship.monthsUpper } : null;
  const gapCount = professional.gaps.length;
  return {
    status, professional: pro, internship: intern, issueMessages,
    summary: `${monthsText(pro.lower, pro.upper)} of verified professional work (${yearsText(pro.lower, pro.upper)}).`,
    uncertainty:
      "Dates are month precision, so this is a range, not an exact figure. Overlapping jobs are counted once. Internships, study, projects and skill mentions never add professional time." +
      (gapCount ? ` ${gapCount} gap${gapCount === 1 ? "" : "s"} between jobs ${gapCount === 1 ? "is" : "are"} not counted.` : "") +
      (status === "REVIEW" ? " Some facts need your review before this can be trusted." : ""),
  };
}

export function buildDashboard(input: DashboardInput): DashboardView {
  const resumes = input.resumes;
  const roles = input.roles;
  const missing: string[] = [];
  if (resumes === null) missing.push("resumes");
  if (roles === null) missing.push("roles");
  if (input.discovery === null) missing.push("discovery status");

  const list = resumes ?? [];
  const processing = list.filter((r) => r.state === "UPLOADED" || r.state === "EXTRACTING").length;
  const failed = list.filter((r) => r.state === "FAILED").length;
  const proposed = list.filter((r) => r.state === "PROPOSED");
  const sum = (key: "pending" | "approved" | "rejected"): number => list.reduce((n, r) => n + r.counts[key], 0);
  const facts = { loaded: resumes !== null, pending: sum("pending"), approved: sum("approved"), rejected: sum("rejected"), statements: input.statementCount };
  const latest = list[0] ?? null; // the API returns newest first

  const titles = new Map<string, string>();
  for (const r of roles?.recommendations ?? []) titles.set(r.roleSlug, r.title);
  for (const r of roles?.noMatch ?? []) titles.set(r.roleSlug, r.title);
  const titleOf = (slug: string): string => titles.get(slug) ?? slug.replace(/-/g, " ");

  const cyber = (roles?.recommendations ?? []).filter((r) => r.familyTier === "primary");
  const cyberRoles = roles
    ? {
        items: cyber.slice(0, MAX_ROLES_SHOWN).map((r): RoleItem => ({
          roleSlug: r.roleSlug, title: r.title, family: r.familyName, support: r.support, status: r.status,
          coreMet: r.evidence.coreMet, coreTotal: r.evidence.coreTotal, gaps: r.gaps.map((g) => g.message).slice(0, 2),
        })),
        hiddenCount: Math.max(0, cyber.length - MAX_ROLES_SHOWN),
        otherSuggestionCount: roles.recommendations.length - cyber.length,
        staleCount: roles.staleDecisions.length,
      }
    : null;

  const sel = roles?.selection ?? null;
  const hasSavedSelection = !!sel && sel.roleSlugs.length > 0;
  const selection = sel
    ? {
        revisionNo: sel.revisionNo,
        roles: sel.roleSlugs.map((slug) => ({ slug, title: titleOf(slug) })),
        places: sel.locations.map((l) => (l.kind === "remote" ? "Remote" : l.value)),
        workModes: sel.workModes,
        levels: sel.seniorityLevels,
        band: `${sel.searchBand.minYears}–${sel.searchBand.maxYears} years requested in postings`,
      }
    : null;

  // --- pipeline -----------------------------------------------------------------------------------------------------------------
  const s1Done = facts.approved > 0 && facts.pending === 0 && processing === 0;
  const s1: PipelineStep = {
    id: "S1", title: "Resume and facts",
    status: resumes === null ? "not-started" : list.length === 0 ? "not-started" : s1Done ? "done" : "in-progress",
    detail:
      resumes === null ? "Status unavailable right now."
      : list.length === 0 ? "No resume uploaded yet."
      : processing > 0 ? "Reading your resume."
      : facts.pending > 0 ? `${facts.pending} proposed fact${facts.pending === 1 ? "" : "s"} still need your decision.`
      : facts.approved === 0 ? "No fact is approved yet." : `${facts.approved} fact${facts.approved === 1 ? "" : "s"} approved.`,
  };
  const s2: PipelineStep = {
    id: "S2", title: "Roles and experience",
    status: roles === null ? "not-started" : facts.approved === 0 ? "not-started" : hasSavedSelection ? "done" : "in-progress",
    detail:
      roles === null ? "Status unavailable right now."
      : facts.approved === 0 ? "Starts once you approve facts."
      : hasSavedSelection ? `${sel!.roleSlugs.length} role${sel!.roleSlugs.length === 1 ? "" : "s"} selected by you.`
      : "Review suggestions and choose the roles to search.",
  };
  const d = input.discovery;
  const run = d?.latestRun ?? null;
  const runActive = !!run && (run.status === "QUEUED" || run.status === "RUNNING");
  const s3: PipelineStep =
    d === undefined ? { id: "S3", title: "Official openings", status: "upcoming", detail: "Upcoming. Not built yet: no jobs have been searched, so none are shown." }
    : d === null ? { id: "S3", title: "Official openings", status: "not-started", detail: "Status unavailable right now." }
    : !hasSavedSelection ? { id: "S3", title: "Official openings", status: "not-started", detail: "Starts once you save a role selection." }
    : !run ? { id: "S3", title: "Official openings", status: "not-started", detail: d.boardsConfigured ? "Ready: read official employer boards for your selected roles." : "No employer boards are configured yet." }
    : runActive ? { id: "S3", title: "Official openings", status: "in-progress", detail: `Reading boards: ${run.progress.boardsDone} of ${run.progress.boardsTotal} done.` }
    : run.status === "COMPLETED" || run.status === "PARTIAL"
      ? { id: "S3", title: "Official openings", status: "done", detail: `${run.progress.verified} verified official listing${run.progress.verified === 1 ? "" : "s"}${run.status === "PARTIAL" ? " (some boards failed)" : ""}. Eligibility is not evaluated yet.` }
      : { id: "S3", title: "Official openings", status: "in-progress", detail: `The last run ${run.status.toLowerCase()}. Start another from Jobs.` };

  // --- next action ------------------------------------------------------------------------------------------------------------------
  const reviewable = proposed.find((r) => r.counts.pending > 0) ?? proposed[0] ?? null;
  let next: NextAction;
  if (resumes === null) next = { kind: "retry", label: "Reload your resume status", reason: "The resume list could not be loaded." };
  else if (list.length === 0) next = { kind: "link", label: "Upload your resume", reason: "Everything starts from a PDF or DOCX resume.", href: "/resumes" };
  else if (processing > 0 && proposed.length === 0) next = { kind: "wait", label: "Wait for the resume to finish processing", reason: "This page does not update on its own; reload in a moment." };
  else if (proposed.length === 0) next = { kind: "link", label: "Upload the resume again", reason: `Processing failed${latest?.errorCode ? ` (${latest.errorCode})` : ""}.`, href: "/resumes" };
  else if (facts.pending > 0 && reviewable) next = { kind: "link", label: `Review ${facts.pending} proposed fact${facts.pending === 1 ? "" : "s"}`, reason: "Nothing is used until you approve it.", href: `/review?id=${encodeURIComponent(reviewable.resumeId)}` };
  else if (facts.approved === 0 && reviewable) next = { kind: "link", label: "Approve at least one fact", reason: "Every proposed fact was rejected or none were found.", href: `/review?id=${encodeURIComponent(reviewable.resumeId)}` };
  else if (roles === null) next = { kind: "retry", label: "Reload role suggestions", reason: "The role data could not be loaded." };
  else if (roles.staleDecisions.length > 0) next = { kind: "link", label: `Re-check ${roles.staleDecisions.length} role decision${roles.staleDecisions.length === 1 ? "" : "s"}`, reason: "The evidence behind an earlier decision changed.", href: "/roles" };
  else if (!hasSavedSelection) next = { kind: "link", label: "Choose the roles you want to search", reason: "Your selection, not the suggestions, decides what is searched later.", href: "/roles" };
  else if (d === undefined) next = { kind: "none", label: "Nothing else is needed right now", reason: "Job discovery (S3) is upcoming. Your selection is saved." };
  else if (d === null) next = { kind: "retry", label: "Reload discovery status", reason: "The discovery status could not be loaded." };
  else if (!run) next = d.boardsConfigured
    ? { kind: "link", label: "Find official openings for your roles", reason: "Orbital reads official employer boards for the roles you selected.", href: "/jobs" }
    : { kind: "link", label: "Configure employer boards", reason: "Discovery needs a list of official employer boards.", href: "/jobs" };
  else if (runActive) next = { kind: "link", label: "Discovery is running", reason: "Watch its progress on the Jobs page.", href: "/jobs" };
  else next = { kind: "link", label: run.progress.verified > 0 ? `Review ${run.progress.verified} official listing${run.progress.verified === 1 ? "" : "s"}` : "Review the discovery run", reason: "Whether you qualify is not evaluated yet.", href: "/jobs" };

  return {
    resumeStatus: { loaded: resumes !== null, total: list.length, processing, failed, latest: latest ? { fileType: latest.fileType, createdAt: latest.createdAt, state: latest.state, errorCode: latest.errorCode } : null },
    facts, experience: roles ? summarizeExperience(roles) : null, cyberRoles, selection, hasSavedSelection,
    pipeline: [s1, s2, s3], next, missing,
  };
}

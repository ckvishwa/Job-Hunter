import { describe, expect, it } from "vitest";
import { buildDashboard, monthsText, type DashboardInput, type ResumeRow, type RolesState } from "../../web/src/lib/dashboard-model.js";

const resume = (over: Partial<ResumeRow> = {}): ResumeRow => ({
  resumeId: "11111111-1111-4111-8111-111111111111", fileType: "docx", createdAt: "2026-10-09T12:00:00Z", state: "PROPOSED", errorCode: null,
  counts: { pending: 0, approved: 0, rejected: 0 }, ...over,
});

const bucket = (lo = 0, hi = 0) => ({ monthsLower: lo, monthsUpper: hi, gaps: [] as Array<{ from: string; to: string; months: number }> });
const roles = (over: Partial<RolesState> = {}): RolesState => ({
  catalogVersion: 1,
  experience: { status: "NO_DATA", buckets: { professional: bucket(), internship: bucket() }, issues: [], asOf: "2026-10-09" },
  suggestedSearchBand: { minYears: 0, maxYears: 5, basis: "x" },
  recommendations: [], noMatch: [], staleDecisions: [], selection: null, ...over,
});
const rec = (slug: string, tier: string, over = {}) => ({
  roleSlug: slug, title: slug.toUpperCase(), familyName: "Family", familyTier: tier, support: "SUPPORTED", status: "PROPOSED",
  gaps: [{ code: "G", message: "gap one" }, { code: "G", message: "gap two" }, { code: "G", message: "gap three" }],
  evidence: { coreMet: 2, coreTotal: 3, minCoreMatches: 2 }, ...over,
});
const build = (over: Partial<DashboardInput>) => buildDashboard({ resumes: [], roles: roles(), statementCount: 0, ...over });
const EN_DASH = "–";

describe("dashboard view model", () => {
  it("brand-new user: nothing is invented, the next step is upload, S3 is upcoming", () => {
    const v = build({});
    expect(v.resumeStatus).toMatchObject({ loaded: true, total: 0 });
    expect(v.facts).toMatchObject({ pending: 0, approved: 0, rejected: 0 });
    expect(v.next).toMatchObject({ kind: "link", href: "/resumes", label: "Upload your resume" });
    expect(v.pipeline.map((s) => [s.id, s.status])).toEqual([["S1", "not-started"], ["S2", "not-started"], ["S3", "upcoming"]]);
    expect(v.experience?.status).toBe("NO_DATA");
    expect(v.experience?.professional).toBeNull();
    expect(v.cyberRoles?.items).toEqual([]);
    expect(v.selection).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/%|\$\d|salary/i);
  });

  it("sums fact counts across resumes and sends the user to the resume that has pending facts", () => {
    const a = resume({ resumeId: "a", counts: { pending: 0, approved: 2, rejected: 1 } });
    const b = resume({ resumeId: "b", counts: { pending: 3, approved: 1, rejected: 0 } });
    const v = build({ resumes: [a, b] });
    expect(v.facts).toMatchObject({ pending: 3, approved: 3, rejected: 1 });
    expect(v.next).toMatchObject({ kind: "link", label: "Review 3 proposed facts", href: "/review?id=b" });
    expect(v.pipeline[0]).toMatchObject({ status: "in-progress" });
  });

  it("processing, failed and unreadable states each get their own next step", () => {
    expect(build({ resumes: [resume({ state: "EXTRACTING" })] }).next.kind).toBe("wait");
    const failed = build({ resumes: [resume({ state: "FAILED", errorCode: "NO_TEXT_LAYER" })] });
    expect(failed.next).toMatchObject({ kind: "link", href: "/resumes", label: "Upload the resume again" });
    expect(failed.next.reason).toContain("NO_TEXT_LAYER");
    const none = build({ resumes: null });
    expect(none.next.kind).toBe("retry");
    expect(none.missing).toEqual(["resumes"]);
    expect(none.facts.loaded).toBe(false);
  });

  it("a failed roles source is reported as missing, not as an empty list", () => {
    const v = build({ resumes: [resume({ counts: { pending: 0, approved: 2, rejected: 0 } })], roles: null });
    expect(v.cyberRoles).toBeNull();
    expect(v.experience).toBeNull();
    expect(v.next).toMatchObject({ kind: "retry", label: "Reload role suggestions" });
    expect(v.missing).toEqual(["roles"]);
  });

  it("experience keeps its uncertainty: a month-precision range, never a point figure", () => {
    const r = roles({ experience: { status: "OK", buckets: { professional: bucket(18, 19), internship: bucket(3, 4) }, issues: [], asOf: "2026-10-09" } });
    const v = build({ resumes: [resume({ counts: { pending: 0, approved: 4, rejected: 0 } })], roles: r });
    expect(v.experience?.summary).toContain(`18${EN_DASH}19 months`);
    expect(v.experience?.uncertainty).toMatch(/range, not an exact figure/);
    expect(v.experience?.uncertainty).toMatch(/never add professional time/);
    expect(v.experience?.internship).toEqual({ lower: 3, upper: 4 });
    expect(monthsText(5, 5)).toBe("5 months");
  });

  it("splits primary (cybersecurity) roles from secondary tracks and caps the list", () => {
    const recommendations = [...Array.from({ length: 8 }, (_, i) => rec(`cyber-${i}`, "primary")), rec("sdet", "secondary"), rec("cloud", "secondary")];
    const v = build({ resumes: [resume({ counts: { pending: 0, approved: 3, rejected: 0 } })], roles: roles({ recommendations }) });
    expect(v.cyberRoles?.items).toHaveLength(6);
    expect(v.cyberRoles?.hiddenCount).toBe(2);
    expect(v.cyberRoles?.otherSuggestionCount).toBe(2);
    expect(v.cyberRoles?.items[0]!.gaps).toEqual(["gap one", "gap two"]); // evidence gaps are shown, capped at two
  });

  it("an approved selection completes S2 but never S3; stale decisions come before choosing roles", () => {
    const selection = { revisionNo: 2, roleSlugs: ["soc-analyst"], targetFamilies: ["soc-blue-team"], locations: [{ kind: "remote", value: "Remote" }, { kind: "country", value: "United States" }], workModes: ["remote"], seniorityLevels: ["junior"], searchBand: { minYears: 0, maxYears: 5 } };
    const base = { resumes: [resume({ counts: { pending: 0, approved: 3, rejected: 0 } })] };
    const done = build({ ...base, roles: roles({ selection, recommendations: [rec("soc-analyst", "primary", { title: "SOC Analyst" })] }) });
    expect(done.pipeline.map((s) => s.status)).toEqual(["done", "done", "upcoming"]);
    expect(done.selection).toMatchObject({ revisionNo: 2, places: ["Remote", "United States"], roles: [{ slug: "soc-analyst", title: "SOC Analyst" }] });
    expect(done.next.kind).toBe("none");
    expect(done.pipeline[2]!.detail).toMatch(/Not built yet/);

    const stale = build({ ...base, roles: roles({ selection, staleDecisions: [{ roleSlug: "x", title: "X" }] }) });
    expect(stale.next).toMatchObject({ kind: "link", href: "/roles" });
    expect(stale.next.label).toMatch(/Re-check 1 role decision/);

    const unchosen = build({ ...base, roles: roles() });
    expect(unchosen.next).toMatchObject({ label: "Choose the roles you want to search", href: "/roles" });
    expect(unchosen.pipeline[1]!.status).toBe("in-progress");
  });

  it("S1 is only done when facts are approved and none are pending or processing", () => {
    expect(build({ resumes: [resume({ counts: { pending: 1, approved: 2, rejected: 0 } })] }).pipeline[0]!.status).toBe("in-progress");
    expect(build({ resumes: [resume({ counts: { pending: 0, approved: 2, rejected: 0 } })] }).pipeline[0]!.status).toBe("done");
    expect(build({ resumes: [resume({ counts: { pending: 0, approved: 0, rejected: 4 } })] }).next.label).toBe("Approve at least one fact");
  });
});

describe("dashboard view model: S3 official discovery", () => {
  const selection = { revisionNo: 1, roleSlugs: ["soc-analyst"], targetFamilies: ["soc-blue-team"], locations: [], workModes: [], seniorityLevels: [], searchBand: { minYears: 0, maxYears: 5 } };
  const ready = { resumes: [resume({ counts: { pending: 0, approved: 3, rejected: 0 } })], roles: roles({ selection, recommendations: [rec("soc-analyst", "primary", { title: "SOC Analyst" })] }) };
  const run = (status: string, verified = 0, done = 0, total = 5) => ({ status, progress: { verified, boardsDone: done, boardsTotal: total } });

  it("without a saved selection discovery cannot start; with one and no run it is ready and the next step is Jobs", () => {
    const none = build({ ...ready, roles: roles(), discovery: { boardsConfigured: true, latestRun: null } });
    expect(none.pipeline[2]).toMatchObject({ id: "S3", status: "not-started" });
    expect(none.pipeline[2]!.detail).toMatch(/once you save a role selection/);
    const idle = build({ ...ready, discovery: { boardsConfigured: true, latestRun: null } });
    expect(idle.pipeline[2]).toMatchObject({ status: "not-started" });
    expect(idle.next).toMatchObject({ kind: "link", href: "/jobs", label: "Find official openings for your roles" });
    expect(build({ ...ready, discovery: { boardsConfigured: false, latestRun: null } }).next.label).toBe("Configure employer boards");
  });

  it("reports an active run, a finished run and a failed run without inventing numbers", () => {
    expect(build({ ...ready, discovery: { boardsConfigured: true, latestRun: run("RUNNING", 0, 2, 5) } }).pipeline[2]).toMatchObject({ status: "in-progress", detail: "Reading boards: 2 of 5 done." });
    const done = build({ ...ready, discovery: { boardsConfigured: true, latestRun: run("PARTIAL", 5, 5) } });
    expect(done.pipeline[2]).toMatchObject({ status: "done" });
    expect(done.pipeline[2]!.detail).toMatch(/5 verified official listings \(some boards failed\)\. Eligibility is not evaluated yet/);
    expect(done.next).toMatchObject({ href: "/jobs", label: "Review 5 official listings" });
    expect(build({ ...ready, discovery: { boardsConfigured: true, latestRun: run("FAILED") } }).pipeline[2]!.status).toBe("in-progress");
    expect(build({ ...ready, discovery: { boardsConfigured: true, latestRun: run("COMPLETED", 0, 5) } }).next.label).toBe("Review the discovery run");
  });

  it("an unloadable discovery status is reported as missing, not as 'no run'", () => {
    const v = build({ ...ready, discovery: null });
    expect(v.missing).toEqual(["discovery status"]);
    expect(v.next.kind).toBe("retry");
  });
});

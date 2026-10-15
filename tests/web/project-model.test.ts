import { describe, expect, it } from "vitest";
import { isSafeHref, parseInline, parseMarkdown } from "../../web/src/lib/markdown-lite.js";
import {
  BOARD_COLUMNS, NO_FILTER, filterTasks, groupByStatus, parseRoute, prdRefTarget, roleName, routeHref, searchPrd, statusKey, statusText, teamView, type Prd, type Task,
} from "../../web/src/lib/project-model.js";

// Pure rules of the Project page. Fixtures are synthetic; expected values are worked out by hand.

const task = (over: Partial<Task>): Task => ({
  id: "X-01", name: "Name", phaseId: "X", phaseName: "Phase X", status: "PLANNED", accepted: false, ownerRole: "DEVELOPER", reviewerRole: "HANI", priority: null,
  githubIssue: null, pullRequest: null, branch: null, links: { issue: null, pullRequest: null, commit: null, branch: null }, prdRefs: [], dependencies: [], waitingOn: [],
  blocker: null, evidenceState: "none", evidence: [], validationErrors: [], nextAction: "", ktLinks: [], ...over,
});
const tasks: Task[] = [
  task({ id: "P0-01", name: "Inventory branches", phaseId: "P0", phaseName: "Audit", status: "IN_PROGRESS", githubIssue: 2 }),
  task({ id: "P0-02", name: "Verify database backup", phaseId: "P0", phaseName: "Audit", status: "PLANNED", ownerRole: "DEVELOPER" }),
  task({ id: "P0-07", name: "Run pytest suites", phaseId: "P0", phaseName: "Audit", status: "QA_REVIEW", ownerRole: "HANI", reviewerRole: "DEVELOPER", ktLinks: [{ title: "LOCAL_SETUP.md", path: "docs/kt/LOCAL_SETUP.md", url: "u1" }] }),
  task({ id: "P1-01", name: "Parser", phaseId: "P1", phaseName: "Parsing", status: "BLOCKED", ownerRole: "HANI", reviewerRole: "DEVELOPER", blocker: "Waiting for fixtures" }),
  task({ id: "P1-02", name: "Fake done", phaseId: "P1", phaseName: "Parsing", status: "VERIFIED", accepted: false, ownerRole: "PRODUCT_OWNER" }),
  task({ id: "P1-03", name: "Real done", phaseId: "P1", phaseName: "Parsing", status: "VERIFIED", accepted: true }),
];

describe("task filters", () => {
  it("searches id, name, phase, owner and issue number, case-insensitively", () => {
    const ids = (query: string) => filterTasks(tasks, { ...NO_FILTER, query }).map((t) => t.id);
    expect(ids("p0-01")).toEqual(["P0-01"]);
    expect(ids("DATABASE")).toEqual(["P0-02"]);
    expect(ids("parsing")).toEqual(["P1-01", "P1-02", "P1-03"]);
    expect(ids("#2")).toEqual(["P0-01"]);
    expect(ids("hani")).toEqual(["P0-01", "P0-02", "P0-07", "P1-01", "P1-02", "P1-03"]); // owner OR reviewer role
    expect(ids("product_owner")).toEqual(["P1-02"]);
    expect(ids("nothing-matches")).toEqual([]);
  });

  it("combines phase, owner and status filters", () => {
    expect(filterTasks(tasks, { ...NO_FILTER, phase: "P1", owner: "HANI" }).map((t) => t.id)).toEqual(["P1-01"]);
    expect(filterTasks(tasks, { ...NO_FILTER, status: "VERIFIED" }).map((t) => t.id)).toEqual(["P1-02", "P1-03"]);
    expect(filterTasks(tasks, { query: "p", phase: "P0", owner: "", status: "PLANNED" }).map((t) => t.id)).toEqual(["P0-02"]);
    expect(filterTasks(tasks, NO_FILTER)).toHaveLength(6);
  });

  it("groups tasks into one column per status and keeps all statuses present", () => {
    const g = groupByStatus(tasks);
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual(["PLANNED", "REPORTED_UNVERIFIED", "IN_PROGRESS", "QA_REVIEW", "BLOCKED", "VERIFIED"]);
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length]))).toEqual({ PLANNED: 1, REPORTED_UNVERIFIED: 0, IN_PROGRESS: 1, BLOCKED: 1, QA_REVIEW: 1, VERIFIED: 2 });
  });
});

describe("status presentation", () => {
  it("never presents unaccepted VERIFIED as verified", () => {
    expect(statusKey(tasks[4]!)).toBe("rejected");
    expect(statusText(tasks[4]!)).toBe("Recorded verified, evidence not accepted");
    expect(statusKey(tasks[5]!)).toBe("verified");
    expect(statusText(tasks[5]!)).toBe("Verified");
    expect(statusText(tasks[0]!)).toBe("In progress");
  });
});

describe("team view", () => {
  it("assigns by role, folds Product Owner work into the lead and reports review and blockers", () => {
    const dev = teamView(tasks, "DEVELOPER");
    expect(dev.assigned.map((t) => t.id)).toEqual(["P0-01", "P0-02", "P1-02", "P1-03"]);
    expect(dev.awaitingReview.map((t) => t.id)).toEqual(["P0-07"]); // the developer reviews the QA-owned task
    const hani = teamView(tasks, "HANI");
    expect(hani.assigned.map((t) => t.id)).toEqual(["P0-07", "P1-01"]);
    expect(hani.blockers).toEqual([{ taskId: "P1-01", text: "Waiting for fixtures" }]);
    expect(teamView([task({ id: "Q-1", status: "QA_REVIEW", ownerRole: "DEVELOPER", reviewerRole: "HANI" })], "HANI").awaitingReview.map((t) => t.id)).toEqual(["Q-1"]);
    expect(hani.ktLinks).toEqual([{ title: "LOCAL_SETUP.md", url: "u1" }]);
  });

  it("names roles from the team list and never invents a person", () => {
    const team = [{ role: "DEVELOPER", handle: "ckvishwa", title: "", url: "" }];
    expect(roleName("DEVELOPER", team)).toBe("ckvishwa");
    expect(roleName("PRODUCT_OWNER", team)).toBe("Product Owner");
    expect(roleName(null, team)).toBe("Unassigned");
  });
});

const prd: Prd = {
  title: "T", version: null, source: "docs/PRD.md", sourceUrl: "", sha256: "a", lockedSha256: "a", hashMatches: true, intro: "",
  sections: [
    { id: "s1", level: 1, title: "1. Overview", number: "1", parentId: null, body: "Alpha beta. FR-0301 appears here and FR-0301 again." },
    { id: "s2", level: 1, title: "2. Other", number: "2", parentId: null, body: "Gamma." },
  ],
};

describe("PRD links and search", () => {
  it("maps ledger PRD references to a section or a search", () => {
    expect(prdRefTarget("PRD §12 P0")).toEqual({ kind: "section", number: "12" });
    expect(prdRefTarget("PRD §2.1")).toEqual({ kind: "section", number: "2.1" });
    expect(prdRefTarget("FR-0301–0308")).toEqual({ kind: "search", query: "FR-0301" });
    expect(prdRefTarget("G3")).toEqual({ kind: "search", query: "G3" });
  });

  it("counts matches per section and ignores case", () => {
    expect(searchPrd(prd, "fr-0301").map((h) => [h.section.id, h.count])).toEqual([["s1", 2]]);
    expect(searchPrd(prd, "gamma").map((h) => h.section.id)).toEqual(["s2"]);
    expect(searchPrd(prd, "  ")).toEqual([]);
    expect(searchPrd(prd, "overview").map((h) => h.section.id)).toEqual(["s1"]); // titles are searched too
  });
});

describe("hash routes", () => {
  it("parses tabs, arguments, queries and task links, falling back to overview", () => {
    expect(parseRoute("")).toMatchObject({ tab: "overview", task: null });
    expect(parseRoute("#/roadmap/P3")).toMatchObject({ tab: "roadmap", arg: "P3" });
    expect(parseRoute("#/prd?q=FR-0301")).toMatchObject({ tab: "prd", arg: null, query: "FR-0301" });
    expect(parseRoute("#/task/P0-01")).toMatchObject({ task: "P0-01" });
    expect(parseRoute("#/not-a-tab")).toMatchObject({ tab: "overview" });
    expect(parseRoute("#/prd/%E0%A4%A")).toMatchObject({ tab: "prd" }); // malformed escape does not throw
    expect(routeHref("prd", "s 1", "a&b")).toBe("#/prd/s%201?q=a%26b");
  });
});

describe("safe markdown", () => {
  it("only links http(s) URLs; every other scheme is shown as text", () => {
    expect(isSafeHref("https://example.com/x")).toBe(true);
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "//evil.example", "/relative", "file:///etc/passwd", ""]) {
      expect(isSafeHref(bad), bad).toBe(false);
    }
    const nodes = parseInline("[click](javascript:alert(1)) and [ok](https://example.com)");
    expect(nodes.filter((n) => n.t === "link").map((n) => (n.t === "link" ? n.href : ""))).toEqual(["https://example.com"]);
    expect(nodes.slice(0, 2)).toEqual([{ t: "text", text: "click (javascript:alert(1))" }, { t: "text", text: " and " }]);
  });

  it("treats raw HTML as literal text, never as markup", () => {
    const [block] = parseMarkdown("<script>alert(1)</script> and <img src=x onerror=alert(1)>");
    expect(block).toEqual({ t: "p", text: "<script>alert(1)</script> and <img src=x onerror=alert(1)>" });
    const inline = parseInline("<b>x</b>");
    expect(inline).toEqual([{ t: "text", text: "<b>x</b>" }]);
  });

  it("parses headings, lists, tables, fences and quotes", () => {
    const blocks = parseMarkdown(["# H", "para one", "- a", "- b", "", "1. x", "", "| c1 | c2 |", "|---|---|", "| v1 | v2 |", "", "```", "# not heading", "```", "> quoted"].join("\n"));
    expect(blocks).toEqual([
      { t: "h", level: 1, text: "H" },
      { t: "p", text: "para one" },
      { t: "list", ordered: false, items: ["a", "b"] },
      { t: "list", ordered: true, items: ["x"] },
      { t: "table", header: ["c1", "c2"], rows: [["v1", "v2"]] },
      { t: "code", text: "# not heading" },
      { t: "quote", text: "quoted" },
    ]);
  });
});

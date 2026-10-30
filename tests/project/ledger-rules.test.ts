import { describe, expect, it } from "vitest";
import { LedgerShapeError, governance, isAcceptedVerified, nextTask, parseLedger, phaseStates } from "../../src/project/ledger.js";
import { createProjectSources } from "../../src/project/sources.js";
import { overviewView, phasesView, tasksView } from "../../src/project/views.js";
import { makeProjectRoot, synthLedger } from "../helpers/project-fixtures.js";

// Expected values below were worked out by hand from synthLedger() (tests/helpers/project-fixtures.ts) using the rules in
// scripts/sync_progress.py, not produced by the code under test. tests/project/ledger-parity.test.ts also runs the Python script.

describe("project ledger rules", () => {
  it("derives phase states exactly like the progress checker", () => {
    const ledger = parseLedger(synthLedger("x"));
    expect(Object.fromEntries(phaseStates(ledger))).toEqual({
      A0: "BLOCKED", // phase blocker wins
      A1: "VERIFIED", // all verified + dependencies ok + QA sign-off
      A2: "QA_REVIEW", // a QA_REVIEW task; its unverified dependency does not change the phase state
      A3: "IN_PROGRESS", // verified tasks but no phase sign-off
      A4: "BLOCKED", // a BLOCKED task
      A5: "REPORTED_UNVERIFIED",
      A6: "PLANNED", // no tasks
    });
  });

  it("picks the first dependency-unblocked task like --next", () => {
    const ledger = parseLedger(synthLedger("x"));
    expect(nextTask(ledger, phaseStates(ledger))).toEqual({ phase: "A0", id: "A0-01", name: "Task A0-01", status: "IN_PROGRESS" });
  });

  it("accepts VERIFIED only with consistent evidence", () => {
    const ledger = parseLedger(synthLedger("x"));
    const gov = governance(ledger, "x");
    const byId = new Map(ledger.phases.flatMap((p) => p.tasks).map((t) => [t.id, t]));
    expect(isAcceptedVerified(byId.get("A1-01")!, gov)).toBe(true);
    expect(isAcceptedVerified(byId.get("A4-01")!, gov)).toBe(false);
    expect(gov.taskErrors.get("A4-01")).toEqual([
      "A4-01: commit_sha must be actual 7–40 hex characters",
      "A4-01: VERIFIED must cite a PASS result (real logs independently verified)",
    ]);
    expect(gov.ledgerErrors).toEqual([]);
  });

  it("flags a PRD hash mismatch, a missing PRD and bad dependencies", () => {
    const ledger = parseLedger(synthLedger("locked"));
    expect(governance(ledger, "other").ledgerErrors).toEqual(["PRD SHA256 differs from locked baseline: require approved ADR and deliberate PRD version/hash update."]);
    expect(governance(ledger, null).ledgerErrors).toEqual(["Missing docs/PRD.md"]);
    const bad = synthLedger("locked");
    bad.phases[1]!.depends_on = ["NOPE", "A2"];
    expect(governance(parseLedger(bad), "locked").ledgerErrors).toEqual([
      "A1: missing dependency NOPE",
      "A1: dependency NOPE not earlier in ledger (possible cycle)",
      "A1: dependency A2 not earlier in ledger (possible cycle)",
    ]);
  });

  it("rejects an unusable structure without echoing values", () => {
    expect(() => parseLedger({ phases: [] })).toThrow(LedgerShapeError);
    const bad = { phases: [{ id: "A", name: "n", tasks: "SECRET-VALUE" }] };
    expect(() => parseLedger(bad)).toThrow(/phases\.0\.tasks/);
    try { parseLedger(bad); } catch (e) { expect(String(e)).not.toContain("SECRET-VALUE"); }
  });
});

describe("project views over a synthetic checkout", () => {
  const opts = (root: string) => ({ sources: createProjectSources(root), repoUrl: "https://github.com/acme/repo" });

  it("counts from real task records and never counts non-accepted work as done", async () => {
    const p = makeProjectRoot();
    try {
      const o = await overviewView(opts(p.root));
      expect(o.counts.phases).toBe(7);
      expect(o.counts.tasks).toBe(10);
      expect(o.counts.byStatus).toEqual({ PLANNED: 2, REPORTED_UNVERIFIED: 2, IN_PROGRESS: 1, BLOCKED: 1, QA_REVIEW: 1, VERIFIED: 3 });
      expect(o.counts.verified).toBe(2); // A4-01 is recorded VERIFIED but fails the evidence rules
      expect(o.counts.percentVerified).toBe(20);
      expect(o.counts.phasesVerified).toBe(1);
      expect(o.gate).toMatchObject({ label: "Gate A", phaseId: "A0", state: "BLOCKED", passed: false, blocker: "Gate is red" });
      expect(o.qaQueue).toEqual([{ id: "A2-02", name: "Task A2-02", reviewerRole: "HANI" }]);
      expect(o.nextTask?.id).toBe("A0-01");
      expect(o.validation.ok).toBe(false);
      expect(o.validation.taskErrorCount).toBe(2);
      expect(o.prd.hashMatches).toBe(true);
      expect(o.team.map((t) => t.handle)).toEqual(["dev-user", "qa-user"]);
      expect(o.latestEvidence.map((e) => e.taskId)).toContain("A0-01");
    } finally { p.cleanup(); }
  });

  it("shows zero verified when nothing is verified", async () => {
    const p = makeProjectRoot({ ledger: (l) => ({ ...l, phases: l.phases.map((ph) => ({ ...ph, tasks: ph.tasks.map((t) => ({ ...t, status: "PLANNED" })) })) }) });
    try {
      const o = await overviewView(opts(p.root));
      expect(o.counts.verified).toBe(0);
      expect(o.counts.percentVerified).toBe(0);
      expect(o.counts.byStatus.VERIFIED).toBe(0);
      expect(o.gate.state).toBe("BLOCKED");
    } finally { p.cleanup(); }
  });

  it("computes phase progress and dependency waiting from the ledger", async () => {
    const p = makeProjectRoot();
    try {
      const { phases } = await phasesView(opts(p.root));
      const byId = Object.fromEntries(phases.map((x) => [x.id, x]));
      expect(byId.A1).toMatchObject({ totalTasks: 1, verifiedTasks: 1, percent: 100, state: "VERIFIED", dependenciesMet: true });
      expect(byId.A2).toMatchObject({ totalTasks: 2, verifiedTasks: 0, percent: 0, waitingOn: ["A0"], dependenciesMet: false });
      expect(byId.A4).toMatchObject({ totalTasks: 3, verifiedTasks: 0, percent: 0 }); // the fake VERIFIED does not count
      expect(byId.A6).toMatchObject({ totalTasks: 0, percent: 0, state: "PLANNED" });
      expect(byId.A0!.blocker).toBe("Gate is red");
    } finally { p.cleanup(); }
  });

  it("builds task detail with distinct evidence states, correct GitHub links and KT links", async () => {
    const p = makeProjectRoot();
    try {
      const { tasks } = await tasksView(opts(p.root));
      const t = Object.fromEntries(tasks.map((x) => [x.id, x]));
      expect(t["A0-01"]!.links).toEqual({
        issue: "https://github.com/acme/repo/issues/2", pullRequest: "https://github.com/acme/repo/pull/7",
        commit: "https://github.com/acme/repo/commit/deadbee", branch: "https://github.com/acme/repo/tree/feature/x",
      });
      expect(t["A0-01"]!.evidenceState).toBe("partial");
      expect(t["A0-02"]!.evidenceState).toBe("none");
      expect(t["A0-02"]!.links).toEqual({ issue: null, pullRequest: null, commit: null, branch: null });
      expect(t["A1-01"]!.evidenceState).toBe("accepted");
      expect(t["A2-02"]!.evidenceState).toBe("awaiting-qa");
      expect(t["A4-01"]).toMatchObject({ evidenceState: "invalid", accepted: false });
      expect(t["A4-01"]!.links.commit).toBeNull(); // "zzzz" is not a SHA
      expect(t["A2-01"]!.waitingOn).toEqual(["A0"]);
      expect(t["A0-01"]!.ktLinks.map((k) => k.title)).toEqual(["LOCAL_SETUP.md"]);
      expect(t["A0-01"]!.ktLinks[0]!.url).toBe("https://github.com/acme/repo/blob/HEAD/docs/kt/LOCAL_SETUP.md");
      expect(t["A1-01"]!.ktLinks).toEqual([]);
    } finally { p.cleanup(); }
  });

  it("does not build a link from an unsafe branch name", async () => {
    const p = makeProjectRoot({ ledger: (l) => { l.phases[0]!.tasks[0]!.branch = "x/../../evil?q=1"; return l; } });
    try {
      const { tasks } = await tasksView(opts(p.root));
      expect(tasks[0]!.links.branch).toBeNull();
    } finally { p.cleanup(); }
  });
});

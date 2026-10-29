import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Synthetic project sources for the Project dashboard tests. Nothing here is real ledger data.

export const SYNTH_PRD = [
  "# SYNTH PRODUCT",
  "",
  "Version: 9.9 (synthetic)",
  "",
  "# 1. Overview",
  "Intro text with <script>alert('prd')</script> and a [link](javascript:alert(1)).",
  "",
  "## 1.1 Goals",
  "Goal text. FR-0001 is referenced here.",
  "",
  "# 2. Baseline",
  "```",
  "# not a heading inside a fence",
  "```",
  "Baseline text.",
  "",
  "# 12. Roadmap",
  "Roadmap text.",
  "",
].join("\n");

export const SYNTH_NOTEBOOK = [
  "# Notebook",
  "",
  "Intro line.",
  "",
  "## 2026-01-02 — First <img src=x onerror=alert(1)> session",
  "- did a thing",
  "",
  "## 2026-01-03 — Second session",
  "Handoff text.",
  "",
].join("\n");

const emptyEvidence = { commit_sha: "", test_command: "", test_result: "", test_log_or_ci: "", qa_reviewer: "", qa_signoff_at: "", notes: "" };
const task = (id: string, status: string, over: Record<string, unknown> = {}, evidence: Record<string, string> = {}) => ({
  id, name: `Task ${id}`, status, evidence: { ...emptyEvidence, ...evidence }, owner_role: "DEVELOPER", reviewer_role: "HANI",
  github_issue: null as number | null, branch: null as string | null, pull_request: null as number | null, ...over,
});
const goodEvidence = { commit_sha: "abc1234", test_command: "npm test", test_result: "PASS", test_log_or_ci: "ci/run/1" };
const noSign = { reviewer: "", approved_at: "", evidence: "" };

/** Phases chosen to cover every branch of the phase-state rules. */
export function synthLedger(prdSha256: string) {
  return {
    schema_version: 1,
    name: "Synthetic ledger",
    baseline: "synthetic baseline",
    prd_sha256: prdSha256,
    status_claim: "synthetic",
    allowed_task_statuses: ["PLANNED", "REPORTED_UNVERIFIED", "IN_PROGRESS", "BLOCKED", "QA_REVIEW", "VERIFIED"],
    collaboration: { github_accounts: { DEVELOPER: "dev-user", HANI: "qa-user" } },
    phases: [
      { id: "A0", name: "Gate phase", depends_on: [] as string[], prd_refs: ["PRD §2", "G8"], exit_criterion: "Gate exit", blocker: "Gate is red" as string | null, qa_signoff: noSign,
        tasks: [task("A0-01", "IN_PROGRESS", { github_issue: 2, branch: "feature/x", pull_request: 7 }, { commit_sha: "deadbee" }), task("A0-02", "PLANNED")] },
      { id: "A1", name: "Fully verified", depends_on: [], prd_refs: ["FR-0001"], exit_criterion: "ok", blocker: null, qa_signoff: { reviewer: "qa-user", approved_at: "2026-01-01", evidence: "run 1" },
        tasks: [task("A1-01", "VERIFIED", {}, { ...goodEvidence, qa_reviewer: "qa-user", qa_signoff_at: "2026-01-01" })] },
      { id: "A2", name: "Depends on blocked gate", depends_on: ["A0"], prd_refs: ["PRD §12"], exit_criterion: "ok", blocker: null, qa_signoff: noSign,
        tasks: [task("A2-01", "PLANNED"), task("A2-02", "QA_REVIEW", {}, goodEvidence)] },
      { id: "A3", name: "Verified without sign-off", depends_on: ["A1"], prd_refs: [], exit_criterion: "ok", blocker: null, qa_signoff: noSign,
        tasks: [task("A3-01", "VERIFIED", {}, { ...goodEvidence, qa_reviewer: "qa-user", qa_signoff_at: "2026-01-02" })] },
      { id: "A4", name: "Fake verified", depends_on: ["A1"], prd_refs: [], exit_criterion: "ok", blocker: null, qa_signoff: noSign,
        tasks: [task("A4-01", "VERIFIED", {}, { commit_sha: "zzzz", test_command: "x", test_result: "FAIL", test_log_or_ci: "y", qa_reviewer: "q", qa_signoff_at: "t" }), task("A4-02", "BLOCKED"), task("A4-03", "REPORTED_UNVERIFIED")] },
      { id: "A5", name: "Reported only", depends_on: ["A1"], prd_refs: [], exit_criterion: "ok", blocker: null, qa_signoff: noSign, tasks: [task("A5-01", "REPORTED_UNVERIFIED")] },
      { id: "A6", name: "Empty", depends_on: ["A5"], prd_refs: [], exit_criterion: "ok", blocker: null, qa_signoff: noSign, tasks: [] },
    ],
  };
}

export type SynthLedger = ReturnType<typeof synthLedger>;

export interface ProjectRoot {
  root: string;
  prdSha256: string;
  cleanup(): void;
}

export function makeProjectRoot(over: { ledger?: (l: SynthLedger) => unknown; ledgerRaw?: string | null; prd?: string | null; notebook?: string | null } = {}): ProjectRoot {
  const root = mkdtempSync(path.join(os.tmpdir(), "jh-project-"));
  const prd = over.prd === undefined ? SYNTH_PRD : over.prd;
  const prdSha256 = createHash("sha256").update(prd ?? "").digest("hex");
  mkdirSync(path.join(root, "docs", "team"), { recursive: true });
  mkdirSync(path.join(root, "docs", "kt"), { recursive: true });
  if (prd !== null) writeFileSync(path.join(root, "docs", "PRD.md"), prd);
  const ledger = synthLedger(prdSha256);
  if (over.ledgerRaw !== null) {
    writeFileSync(path.join(root, "docs", "PROGRESS_LEDGER.json"), over.ledgerRaw ?? JSON.stringify(over.ledger ? over.ledger(ledger) : ledger, null, 2));
  }
  const notebook = over.notebook === undefined ? SYNTH_NOTEBOOK : over.notebook;
  if (notebook !== null) writeFileSync(path.join(root, "docs", "team", "ENGINEERING_NOTEBOOK.md"), notebook);
  writeFileSync(path.join(root, "docs", "kt", "LOCAL_SETUP.md"), "Setup guide. Complete A0-01 first, then A2-02.\n");
  return { root, prdSha256, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

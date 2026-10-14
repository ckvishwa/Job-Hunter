# Engineering notebook

Append-only. Never edit an earlier entry; add a dated correction entry instead. Reference task IDs and commits. Separate observations from hypotheses. No secrets, no candidate data, no claims about tests that were not run.

---

## 2026-10-14 — Engineering Session (M0 baseline)

### People
Developer: repository owner (agent-assisted session)
QA: Hani — not yet onboarded; GitHub username pending

### Branch / Commit
Branch: `chore/m0-collaboration-baseline` (from `careerops-integration` `ba55c90`)
HEAD at entry: see `git log` (commits `2c958b5`, `567ab1e`, then the docs commit)

### Today's Objective
Inventory and safely preserve all work, install governance (PRD, ledger), prepare a push for review, create team/KT material, diagnose Gate A.

### Work Completed
- Read-only inventory (`docs/audit/REPOSITORY_INVENTORY.md`); private snapshot outside the repo.
- Committed previously-uncommitted ML engine and migrations 0006-0011 as a WIP checkpoint; redacted two real names from a test and an evidence file.
- Installed hash-locked PRD, ledger (owner/reviewer roles, new tasks P0-05..P0-10), generated board, agent protocol, ADR-0001/0002.
- Wrote team, KT, QA, ML and architecture documents; PR/issue templates; CODEOWNERS (Hani not added: username unknown).

### Evidence
Tests: `npm run typecheck` clean. Parallel `npx vitest run`: 1617 pass / 10 fail. First serialized run: 2 files failed (dashboard e2e 6 tests, browser-search 1 test). Each of those two files passes alone (dashboard 8/8, browser-search 18/18 three times) and together 26/26. See `docs/qa/GATE_A_REPORT.md` for the second serialized run.
PRs: see below. Logs: `docs/qa/GATE_A_REPORT.md`.

### Architecture Decisions
ADR-0001 (canonical PRD), ADR-0002 (local-first retained).

### Problems Discovered
- Observation: PRD pack README claims PRD copied unchanged from the V1 file; bytes differ (diagram block).
- Observation: earlier AUDIT.md under-reported ResumePlan/PDF preview/form-fill; corrected in AUDIT.md and the inventory.
- Hypothesis (unproven): first serialized-run e2e failures were caused by heavy disk I/O from a concurrent `du` scan on `node_modules` during that run. Tested by rerunning with no concurrent work (GATE_A_REPORT).

### Blockers
Hani's GitHub username; Product Owner confirmation of ADR-0001; branch protection needs repository-admin action (see GATE/security notes).

### Tasks Updated
P0-01 (inventory) to QA_REVIEW pending Hani; others unchanged. Nothing VERIFIED.

### Handoff to Hani
Start with `docs/kt/HANI_ONBOARDING.md`, then P0-09 (independent setup) and P0-07 (pytest runs).

### Handoff to Developer
Resolve Gate A per `GATE_A_REPORT.md`; confirm ADR-0001; provide Hani's username; decide email-exposure remediation.

### Next Session
P0-03/P0-04 once Gate A is reproducibly green.

---

## 2026-10-14 — Engineering Session (team-role clarification, appended)

### People
Technical Lead / Principal Developer / AI/ML Architect / Mentor: ckvishwa
Senior AI/ML & SDET Intern (reports to the Technical Lead): Hani, GitHub username pending

### Branch / Commit
Branch: `chore/m0-collaboration-baseline`, PR #1 (draft). Last pushed commit `96bd9f8`; local commit `891b3e2` (document-type test fix) and the changes below not yet pushed at the time of writing.

### Today's Objective
Record the final reporting structure and align governance documents without repeating cleanup or creating a second tracker.

### Work Completed
- `TEAM_ROLES.md` rewritten: Technical Lead owns architecture, technology, AI/ML model development, full-stack, delegation, integration, production promotion; Hani shadows AI/ML, writes tests and ML evaluation code, reports defects, verifies independently, contributes supporting code under mentorship; no architecture or promotion authority unless delegated in `DECISIONS.md`.
- Ledger `owner_role`/`reviewer_role` reset (ADR-0001 amendment A2): Hani owns P0-07, P0-09, P1-03, P2-04, P5-01, P5-03, P7-03, P8-04, P9-03, P10-02, P10-03; all others Technical Lead with Hani as reviewer. Task IDs, statuses and evidence untouched.
- Hani onboarding and KT plan updated; five-stage growth plan added (guided testing, supervised automation, independent verification, ML evaluation tooling, independently developed automation).
- GitHub issue assignments checked: Technical Lead tasks are assigned to `ckvishwa`; Hani-owned issues (#8 P0-07, #10 P0-09) stay unassigned because her username was not provided. No change needed.

### Evidence
`python scripts/sync_progress.py --check` → OK after the update. No tests were rerun for this documentation change.

### Architecture Decisions
ADR-0001 amendment A1 (earlier today) moved AI/ML implementation to Hani; **A2 supersedes the ownership part of A1**. Local-first (ADR-0002) unchanged. Public-email decision (A1): no history rewrite; noreply switch for future commits remains an open owner choice. PRD canonical choice (ADR-0001) still awaits Product Owner confirmation.

### Problems Discovered
- Correction to the earlier entry: it said the notebook would hold the Gate A result of the second serialized run. That run's result: 3 failed tests in 2 files (my own redaction of reference-document names broke a local-only test; one Postgres loopback connect timeout that passes alone). Fixed/classified in `docs/qa/GATE_A_REPORT.md`.
- Observation: in the second serialized run the dashboard and browser-search e2e files passed, unlike the first run; cause of the first-run failures remains unproven.

### Blockers
Hani's GitHub username; PRD confirmation; PR #1 CI results.

### Tasks Updated
None changed status. Ownership fields only.

### Handoff to Hani
Stage 1 of the growth plan: P0-09 and reproduction of the Gate A failures.

### Handoff to Technical Lead
Review/merge conditions for PR #1 (draft): CI green, two clean serialized Gate A runs recorded, independent review.

### Next Session
Record Gate A run 3 and write `GATE_A_REPORT.md`; check PR #1 CI.

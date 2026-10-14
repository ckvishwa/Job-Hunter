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

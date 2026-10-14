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

---

## 2026-10-14 — Engineering Session (final owner decisions)

### People
Technical Lead, AI/ML Architect, Principal Developer and Mentor: `ckvishwa`
Senior AI/ML & SDET Intern: `Hani456` (collaborator invitation sent, acceptance pending)

### Branch / Commit
Branch: `chore/m0-collaboration-baseline`, PR #1 (draft). Commits from this entry onward use the owner's GitHub no-reply address.

### Today's Objective
Apply the owner's final decisions without repeating cleanup or recreating tasks.

### Work Completed
- ADR-0001 approved (ADR-0001 amendment A3): `docs/PRD.md` canonical; alternate diagram PRD stays in `docs/archive/`.
- History and past author emails preserved; no rewrite, no force-push. Future commits use `54135438+ckvishwa@users.noreply.github.com` via repository-local Git config (the id came from the GitHub API for the authenticated account; Settings > Emails could not be read from here because the CLI token lacks the `user` scope, so the owner should confirm it there). Global config and past commits untouched.
- Collaborator invitation (write) sent to `Hani456` (account exists, id 69955146). Not yet accepted, so Issues #8 and #10 are not yet assigned to her; assign after acceptance. Issues for her other ledger tasks (P1-03, P2-04, P5-01, P5-03, P7-03, P8-04, P9-03, P10-02, P10-03) will be created when those tasks start.
- `TEAM_ROLES.md`, onboarding, KT plan, ledger role text and `CODEOWNERS` now carry her exact username. Task IDs, owners, reviewers and evidence unchanged.
- Reviewed PR #12 (CI tiers); see Problems Discovered.

### Evidence
`python scripts/sync_progress.py --check` → OK. Gate A runs are in `docs/qa/GATE_A_REPORT.md` (run 4 in progress at the time of writing).

### Architecture Decisions
A3 as above. Local-first and PR #1 draft restrictions unchanged.

### Problems Discovered
PR #12 review (observations): (1) the tiered gate is sound — drafts run fast checks and skip headed Linux/Windows; ready PRs, pushes and manual dispatch require both headed jobs; (2) the draft "CI gate" is green without headed E2E, so a green draft check is **not** Gate A evidence; (3) PR #12's base is the M0 branch, so its own workflow change has not run in Actions yet; (4) to prove a full pass while PR #1 stays a draft, run the workflow manually (`workflow_dispatch`) on the branch SHA.

### Blockers
Hani456 accepting the invitation; Gate A run 4 and a second clean run; independent review.

### Tasks Updated
None changed status.

### Handoff to Hani456
Accept the invitation, then follow `docs/kt/HANI_ONBOARDING.md`; Stage 1 tasks P0-09 and P0-07.

### Handoff to Technical Lead
Confirm the no-reply address in GitHub Settings; decide when to merge PR #12 into the M0 branch.

### Next Session
Record run 4; integrate PR #12 after its fast suite is run locally; assign #8 and #10 after acceptance.

---

## 2026-10-14 — Engineering Session (Gate A run 4, tiered CI, access check)

### People
Technical Lead / SDET Lead: `ckvishwa`. Senior AI/ML & SDET Intern: `Hani456` (invitation still pending; `gh api .../collaborators` lists only `ckvishwa`).

### Branch / Commit
Branch `chore/m0-collaboration-baseline`, PR #1 (draft). HEAD `00d86e9` pushed, ahead of the Gate A tested code state `ae5cf95` by documentation/CI-config changes only (verified with `git diff --name-only ae5cf95 HEAD`; the only non-doc changes before the merge were none, after the merge `.github/workflows/ci.yml`, `package.json` script, `tests/ci`).

### Today's Objective
Finish Gate A run 4, integrate PR #12 safely, prove the tiered CI on GitHub, record evidence.

### Work Completed
- Run 4 inspected from its log: commit `ae5cf95`, 7 min 44 s, 1636 pass / 1 fail (s1-ui sign-in panel not visible within 15 s). Browser-search and dashboard passed. s1-ui passed alone 2/2 afterwards.
- No further full local suite was started (diagnose-first rule). Host had 5.2 GB free of 31.7 GB after the run; classification environment/resource contention is **suspected, unproven**.
- Browser-search fixture reviewed: telemetry now chained and retried; exact-sequence assertion unchanged; one full passing run so far.
- PR #12 reviewed (clean merge state, diff limited to ci.yml, package.json, docs, tests/ci), `npm run typecheck` exit 0 and `npm run test:fast` 24 files / 378 tests in 3.6 s with no Chrome (grep confirms none of the fast directories launch a browser). Merged into the M0 branch with a merge commit (`bbe4df8`, no force-push).
- Review finding fixed in `00d86e9`: the original gate trusted the event payload's draft flag, so re-running an old draft-time run after the PR became ready could pass without headed Chrome. The gate now reads the live PR draft state and fails closed.
- GitHub Actions proof (details in `docs/sdlc/CI-TIERS.md`): draft = fast-only; manual full run green; ready_for_review full run green on a throwaway probe PR #13 (closed unmerged, branch deleted); stale draft re-run correctly failed.
- Agent test-running rules added to `AGENT_PROTOCOL.md` and `TEST_STRATEGY.md`.
- Ledger: evidence notes and IN_PROGRESS for P0-01/03/04/05/06/07/08/10; no task is QA_REVIEW or VERIFIED. Issues #2-#11 map one-to-one to P0-01..P0-10 (unchanged).

### Evidence
Run logs: Gate A run 4 log kept in the session job directory; summary in `docs/qa/GATE_A_REPORT.md`. Actions run IDs above. `python scripts/sync_progress.py --check` → OK.

### Architecture Decisions
None new. Local-first unchanged. Full headed suite remains mandatory at review/release gates.

### Problems Discovered
- Observation: in every serialized local run exactly one headed-Chrome test fails with a 15 s visibility wait (dashboard, browser-search, s1-ui in different runs); each passes alone. Hypothesis: resource contention on this machine. The hosted full runs pass on both Linux and Windows.
- Observation: a re-run of an old workflow run cancels the newer run in the same concurrency group.

### Blockers
Hani456 has not accepted the invitation, so issues #8 and #10 are not assigned; Gate A needs two clean serialized runs and independent reproduction; noreply address awaits owner confirmation in GitHub Settings.

### Tasks Updated
Ledger status IN_PROGRESS for P0-01, P0-03, P0-04, P0-05, P0-06, P0-07, P0-08, P0-10 (evidence notes only).

### Handoff to Hani456
Accept the invitation, then P0-09 (setup from `docs/kt/LOCAL_SETUP.md`), P0-07 (pytest), run the dashboard, browser-search and s1-ui files alone with `JH_UI_DIAG=1` on her machine, and report whether any fail.

### Handoff to Technical Lead
Add a failure-time diagnostic (Chrome start time, page-load timing, free memory) to the headed e2e helpers before authorizing another full local run; then run twice on an idle machine.

### Next Session
Assign #8/#10 after acceptance; first QA review record; P0-05/P0-06 diagnostics.

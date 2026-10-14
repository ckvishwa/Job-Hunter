# Hani onboarding

Welcome. You own **independent QA and ML evaluation**. You also may write code (tests, fixtures, evaluation scripts) on reviewed branches. Read in this order:

1. `docs/PRD.md` (what we build) and `docs/AGENT_PROTOCOL.md` (how work is claimed and verified).
2. `docs/PROGRESS_LEDGER.json` via `python scripts/sync_progress.py --next` (what is next). Your tasks have `reviewer_role` or `owner_role` = `HANI`.
3. `docs/kt/PROJECT_WALKTHROUGH.md`, then `docs/kt/LOCAL_SETUP.md`.
4. `docs/qa/TEST_STRATEGY.md`, `docs/qa/GATE_A_REPORT.md`, `docs/KNOWN_FLAKES.md`.
5. `docs/team/TEAM_WORKFLOW.md` and the latest entries of `docs/team/ENGINEERING_NOTEBOOK.md`.

## Git and GitHub in five habits
- `git fetch origin` then `git switch -c qa/<topic> origin/careerops-integration`.
- Small commits, conventional messages (`test:`, `fix:`, `docs:`). Never force-push; never commit `.env`, dumps, résumés, screenshots with personal data or anything under `private-runtime/`.
- `git push -u origin qa/<topic>`; open a PR into `careerops-integration` using the template; request review from the Developer.
- Reading CI: GitHub, Actions tab, the failing job, expand the failing step; copy the shortest decisive error line into your PR comment.
- Conflicts: `git fetch`, `git merge origin/careerops-integration` into your branch, resolve, rerun the tests you touched.

## Your first week
See `docs/kt/HANI_KT_PLAN.md`. Success is *demonstrated*, not attended: you run the stack, reproduce a defect, add a test, open a PR, review a Developer PR, and write sign-off evidence.

## Skills to build (in order of use)
Git/GitHub PR flow; TypeScript test reading (Vitest); Playwright (headed Chrome, locators, network interception); pytest; SQL basics (PostgreSQL inspection); precision/recall/F1 and confusion matrices; reading a JD requirement tree; document parsing (PDF text layers).

## Rules that never bend
No weakening or skipping tests to get green; no inventing evidence; ML labels in a frozen set are never edited; you do not approve your own changes; real candidate data stays out of Git and CI.

# Team workflow

`PRD → Task → Branch → Implementation → Tests → PR → Review → QA → VERIFIED`

## Branches
- `main`: release baseline. No direct pushes. Currently far behind; it will receive `careerops-integration` only after M1 (Gate A green, security checks green, QA sign-off, merge plan approved).
- `careerops-integration`: verified existing development branch.
- Short-lived branches off it: `feature/<topic>`, `fix/<topic>`, `qa/<topic>`, `ml/<topic>`, `docs/<topic>`. Examples: `fix/gate-a-dashboard`, `qa/gate-a-regression`, `ml/relevance-evaluation`, `docs/hani-onboarding`.
- One writer per branch. Check `git worktree list` and open PRs first so work is not duplicated.
- Never force-push. Never rewrite published history without a recorded decision.

## Each session
Start: read `docs/PRD.md`, `docs/PROGRESS_LEDGER.json` (`python scripts/sync_progress.py --check` then `--next`), `git status`, HEAD, last notebook entry. Pick one eligible task and say its ID.
End: run the relevant tests; update the task's evidence block; run `python scripts/sync_progress.py --write` and `--check`; append to `docs/team/ENGINEERING_NOTEBOOK.md`; record the handoff (`HANDOFF_TEMPLATE.md`).

## Pull request must state
PRD requirement(s) · task ID · objective · changed files · exact test commands and results · risk · screenshots/logs if useful · security considerations (no secrets, no candidate data) · reviewer · completion conditions · ADR link for architectural change.
PR template: `.github/pull_request_template.md`.

## Green rule
A task is VERIFIED only when: implementation/evidence exists; PRD acceptance met; required tests pass; evidence names the exact commit SHA; an independent reviewer approved; no unresolved blocker; ledger check passes. Not sufficient on their own: "done", a successful build, a test file existing, an open PR, a green dashboard.

## Traceability
PRD requirement → task ID → GitHub issue → branch → PR → commit SHA → CI/test evidence → QA approval → VERIFIED. The ledger is the only verified-state record; `PROGRESS.md` is generated (never hand-edit); GitHub Projects (if used) is a view only.

## Test layers and where heavy suites run
Typecheck, Vitest unit/integration and `sync_progress.py --check` run in CI on synthetic fixtures. PostgreSQL-backed and headed-Chrome E2E need local Docker/Chrome: they run in a documented **local QA gate** (`docs/qa/TEST_STRATEGY.md`). CI never has access to local Ollama, private PostgreSQL or Windows browser state.

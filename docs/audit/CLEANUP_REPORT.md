# Cleanup report — 2026-10-14

Principle: preserve everything valuable, delete nothing, make small reviewable commits.

| Action | Detail | Commit |
|---|---|---|
| Safety snapshot | git bundle of all refs + tars of dirty/untracked/private files at `F:\Jobs\Job_Search\_safety\jh-snapshot-20261014\` (outside the repo, not committed, SHA256SUMS included) | n/a |
| Preserved uncommitted ML work | migrations 0006-0011 (+down), `src/ml`, `services/ml`, `tests/ml`, `tests/db`, ML docs, 16 modified files | `2c958b5` |
| Redaction | real people's names in résumé filenames replaced with generic names in `tests/candidate/document-type.test.ts` and `docs/evidence/orbital-v2-run-2026-10-13.md`; history search shows the names were never published | `2c958b5` |
| `.gitignore` | added `**/__pycache__/`, `*.pyc`, `docs/evidence/orbital-screens/` | `2c958b5` |
| Governance | pack installed; old tracked `docs/PRD.md` moved with `git mv` to `docs/archive/PRD-v0-job-scanner.md`; second V1 PRD archived; `.gitattributes` protects PRD checksum | `567ab1e` |
| Collaboration files | `.github/pull_request_template.md`, issue templates, `CODEOWNERS`, team/KT/QA/ML/architecture/audit docs | next commit |

Intentionally **not** done (needs a decision or is risky):
- No file deleted. `dist/`, `tmp/`, `node_modules/` are git-ignored build/runtime output; `private-runtime/` (~2.5 GB, candidate data, DB dumps, model artifacts) is never touched.
- `main` checkout untracked documents (SaaS PRD/architecture, ARDs, `skills/`, `orbital-landing/`, `company-boards.json`) are not pushed; classification in `REPOSITORY_INVENTORY.md` section 3.
- Overlapping status documents (`docs/STATUS.md`, `NEXT_TASKS.md`, `WORKFLOW.md`, ...) left as-is; consolidation deferred so completion claims are not silently rewritten.
- Worktree `universal-job-discovery` and branches `linkedin-discovery`, `worktree-universal-job-discovery` kept.
- Commit-author email exposure not rewritten (needs approval).
- The two overlapping ~2.5 GB snapshot tars can be pruned by the owner once M1 passes.

## AIM and task
- AIM / feature ID (docs/ACTIVE-FEATURE.md) and runbook task ID (docs/aim/JH-REPO-001.md):
- Task ID (docs/PROGRESS_LEDGER.json):
- PRD requirement(s):
- ADR (if architectural; required when this changes scope, architecture, a data or API contract, privacy, or storage):

## Objective

## Changed files / areas

## Gates run (exact commands, results and counts; do not claim unrun tests)
- [ ] `npm run typecheck`
- [ ] `npm run test:fast` / `npx vitest run <files>`: counts:
- [ ] `npm run test:full` (serialized) or CI full tier: counts:
- [ ] `node scripts/check-markdown-links.mjs`
- [ ] `python scripts/sync_progress.py --check`
- [ ] `npm run ci:private-tree` (and the pre-commit hook was active)
- Other:

## Privacy check
- [ ] Result of the private-path guard and history scan for this branch (paths and counts only):
- [ ] No secrets, `.env`, dumps, résumés, candidate data, model weights or unredacted screenshots; no file over 5 MB

## Live gates still pending (not claimed by this PR)
- e.g. headed UI check on a real profile, owner acceptance, anything marked PENDING:

## Risk and security
- [ ] No weakened/skipped tests; any raised timeout is explained here with its cause
- [ ] Nothing submits an application

## Commit convention
Commits use `type(scope): summary` (feat, fix, docs, test, refactor, build, ci, chore) with the task ID in the body.

## Reviewer (must not be the author) and completion conditions
Status label: VERIFIED | EXISTS-UNVERIFIED | PARTIAL | BROKEN
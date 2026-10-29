# Job Hunter repository consolidation plan — 2026-10-29

**Status: review draft. No integration branch, merge, commit, push, Docker start, or PR was created.** The six existing checkouts remain the source of their own working changes. This document is a new, untracked repository file with a separate review copy in a local folder outside every checkout.

## Goal and boundary

Keep `main` (`2d0790658a7422e9dda978c70a3cd06596eafe7a`) as the current root baseline. Reconcile the cumulative M2 → M3 → M4 → M5.1 development line with the separate project-command-center/governance line in a temporary integration worktree only after a verified preservation snapshot and owner approval. Make the integrated feature reviewable through a PR; do not claim matching acceptance from the October 29 report.

The companion [preservation manifest](JOB-HUNTER-PRESERVATION-MANIFEST-2026-10-29.md) and [362-row file inventory](preservation-file-inventory-2026-10-29.csv) record the local state **before these three new recovery files were placed in the root checkout**. These are inventories, **not backups**. A fresh inventory is required immediately before any approved integration because local changes may continue.

## Findings that determine integration order

- Live Git reports six worktrees and eleven local branches. All listed local development branch tips descend from `main`, but they diverge after it. `main` is not the integrated application baseline.
- M5.1 already contains M2, M3, and M4 as ancestors. Its six post-M4 commits add discovery work. Treat it as one cumulative line, not four independent merges.
- The project-command-center branch and M5.1 share base `ba55c903e947c67b1336314eed12bd335bd0c32d`. Against that base, M5.1 changes 124 paths and project-command-center changes 150. Ten paths overlap: `package.json`, `src/api/server.ts`, `src/db/candidate-repo.ts`, `src/jobs/runner.ts`, `src/match/decide.ts`, `src/match/rules-provider.ts`, `src/testing/fingerprint.ts`, `tests/api/s3-api.test.ts`, `tests/match/extract-and-decide.test.ts`, and `tests/testing/engine.test.ts`. Review each semantically; a clean text merge would still need behavior review.
- The folder `.claude/worktrees/universal-job-discovery` is attached to `feature/project-command-center`. Its folder name is not its branch identity. The report counted 42 dirty entries; live status now counts **43** (8 modified, 35 untracked). Use live status for preservation.
- The two M3 checkouts are at the same HEAD, but their 32 staged screenshot files are not identical. Of the 32 paths, 14 have the same SHA-256 across M3 branch, M3 detached, and M5.1; 18 M3 branch images differ from M3 detached, and 15 of those also differ from M5.1. Do not collapse these trees as duplicates.

## Approved-action sequence to propose

1. **Freeze and preserve.** Recheck all six statuses, record HEADs and hashes, and make separate, verified, access-controlled backups of every checkout's staged, modified, untracked, and relevant ignored work. Preserve the Git index for staged screenshots. Verify backup counts and hashes before touching integration. Keep private candidate files and model/runtime artifacts outside Git and outside the PR package. Do not move or delete the existing checkouts.
2. **Establish a clean candidate.** With explicit approval, create a new temporary worktree and `recovery/jh-integrated-baseline` from current `main`. Do not develop in the dirty root checkout or import its 208 untracked files wholesale.
3. **Reconcile histories by change.** Compare M5.1 and project-command-center commits and the ten overlapping paths against their shared base. Port the cumulative M5.1 behavior, then the project API/UI, governance, CI, migrations, and tests deliberately. Preserve intent in both histories, resolve schema and API contracts, and reject unrelated or superseded work only with a recorded reason. Review `chore/m0-collaboration-baseline`'s local-only `54a9d76` separately. Keep the on-hold LinkedIn branch out of this candidate unless its policy review is approved.
4. **Classify dirty work.** For each manifest row, decide `include`, `later`, `private/exclude`, or `duplicate after hash and visual review`. Handle the project-command-center resume pipeline, M5.1 live-print code, root documentation/ML material, and all screenshot variants explicitly. Do not use `git add -A` in root or copy `.claude/` wholesale.
5. **Run the integrated gates.** Check Git diff and staged-file privacy; run typecheck, relevant frontend/backend/AI tests, matching tests, docs link/progress checks, static isolation, build, and independent code/security review on the exact integration diff. Run PostgreSQL-backed API tests, migrations and a real positive-evidence API/browser E2E with fictional candidate/JD only after separate approval to start the required services. Record exact commands, versions, SHA, outcomes, and any blocked gates. Re-run affected checks if the candidate changes.
6. **Prepare PR for owner review.** Only when preservation is verified and checks on the integrated candidate are independently complete, present the exact diff, decisions for the ten overlapping paths, risks, test evidence, and a proposed PR title/body. Commit, push, and open a PR only on explicit approval. Do not merge the PR without separate authorization.

## Matching acceptance gates from the October 29 report

The uploaded report (SHA-256 `9BD566D30755D6117A5DADC2D07919E91BC6E9B856891D3CC97062A9AF00CC5B`) concluded **`PARTIAL_PASS`**. It reported 14/14 independently set matching expectations met, 36 matching tests passing, matching page rendered in Chrome, and 82 Markdown files with zero broken links. These are evidence to retain, not an end-to-end acceptance decision. It reported PostgreSQL unavailable, full browser E2E unproven, and no test of the complete approved fact → stored match → API → visible `SUPPORTED` card path.

Acceptance requires all of the following on the integration candidate:

- A fictional candidate and JD with at least five independently expected atomic requirements covering supported, partial, unsupported/no evidence, and a hard constraint or OR alternative.
- Only an explicitly `APPROVED` synthetic fact can produce positive support; pending/rejected facts cannot. The UI must show exact JD and candidate evidence, provenance, and an honest unknown/unsupported distinction.
- A real PostgreSQL-backed production API flow, including stored match retrieval, followed by browser proof that a `SUPPORTED` card appears for the approved fact. Exercise candidate/JD selection plus loading, empty, error, and review states. No mocked-only result may close the feature.
- Resolve or explicitly accept the UX observation that one JD sentence may render as separate cards with opposing verdicts; inspect the existing `itemRollups` path. Add the missing `docs/INDEX.md` link to the gold-case path if still needed.
- Relevant tests, typecheck, build, privacy checks, documentation/ledger checks, independent review, and owner acceptance pass at the final PR head. Keep JH-MATCH-001 `IN_PROGRESS` until these gates and the authorized PR workflow are complete.

## Checks independently run during this read-only pass

On `feature/project-command-center` at `5889221`: `npx --no-install vitest run tests/match` passed 36/36; `npm run typecheck` passed; `node scripts/check-markdown-links.mjs` found 82 files, 0 broken and 0 unlinked core references; `python scripts/sync_progress.py --check` passed; `npm run ci:isolation -- static` reported 0 violations.

On `feature/m5.1-universal-discovery-intelligence` at `a5f96da`: matching tests passed 44/44; `npm run typecheck` passed; `git diff --check` and `git diff --cached --check` passed. These were separate branch checks, not integration verification. No PostgreSQL, Docker, browser E2E, full suite, CI, or independent reviewer result was produced in this pass.

## Proposed PR summary, pending the gates above

**Title:** `recovery: reconcile M5.1 and project command center into verified baseline`

**Body outline:** preservation snapshot and exclusions; cumulative M2–M5.1 and project-command-center decisions; ten overlapping path resolutions; matching acceptance evidence with `PARTIAL_PASS` carried forward until DB/browser proof; exact test results at PR head; privacy and rollback notes. Do not describe this draft as a reviewed or opened PR.

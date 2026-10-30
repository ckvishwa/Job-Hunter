# Job Hunter preservation manifest — 2026-10-29

**Read-only inventory, not a recovery backup.** Source: live `git worktree list --porcelain`, `git branch -vv`, expanded `git status --porcelain=v1 --untracked-files=all`, and SHA-256 of each dirty file. The [CSV inventory](preservation-file-inventory-2026-10-29.csv) has all 362 dirty path entries and their worktree file hashes **at inspection, before these three recovery files were added to the root checkout**. It does not inventory ignored files or copy file contents. Re-run it before approved integration.

## Six registered worktrees

| Checkout | Branch / HEAD | Dirty state and preservation decision |
|---|---|---|
| `F:\Jobs\Job_Search\job-hunter` | `main` / `2d07906` | 209 entries: 1 modified `.gitignore`, 208 untracked files. Preserve root documents, `.agents/`, `.claude/` configuration, `docs/`, `ml/`, `orbital-landing/`, and other untracked work separately. Do not stage root wholesale; `.claude/` also contains another registered worktree. |
| `F:\Jobs\Job_Search\job-hunter\.claude\worktrees\universal-job-discovery` | `feature/project-command-center` / `5889221` | 43 entries: 8 modified (`.gitignore`, `CLAUDE.md`, `docs/DECISIONS.md`, `package.json`, `services/ai/app/extract_text.py`, `src/candidate/cli.ts`, `src/candidate/resume-import.ts`, `tests/candidate/resume-import.test.ts`); 35 untracked. The untracked set includes active handoff/index/privacy docs, link checker/hook, resume AI/intake code and tests, private-path checks. Preserve all before selecting any for integration. |
| `F:\Jobs\Job_Search\job-hunter-m4` | `feature/m3-resume-e2e-acceptance` / `46a20d0` | 32 staged `docs/evidence/orbital-screens/*.png` additions; no other dirty entries. Preserve working files **and index state**. |
| `F:\Jobs\Job_Search\job-hunter-m5.1` | `feature/m5.1-universal-discovery-intelligence` / `a5f96da` | 46 entries: 3 modified (`package.json`, `src/db/migrate.ts`, `src/testing/exec.ts`) and 43 untracked: 32 screenshot files plus `config/live-boards.json`, `scripts/live-jobs.ts`, live-print modules and tests. Preserve as its own state. |
| `F:\Jobs\Job_Search\job-hunter-resume-benchmark` | `feature/m2-resume-intelligence` / `a4178a0` | Clean at inspection. Preserve branch ref and HEAD. |
| `F:\Jobs\Job_Search\job-hunter-resume-m3` | detached / `46a20d0` | 32 staged screenshots at the same paths as the M3 branch checkout. Some image bytes differ; preserve this checkout and index independently. |

The expanded CSV intentionally includes path names and hashes, not private file contents. Hashes are a way to verify a later backup; they are not themselves a backup. The uploaded matching report's **42** dirty entries were accurate for its earlier observation; the live project-command-center count is **43**.

## Eleven local branches

| Branch | HEAD | Disposition for review |
|---|---|---|
| `main` | `2d07906` | Current root baseline; keep unchanged pending approval. |
| `careerops-integration` | `ba55c90` | Historical shared base, tracks origin; retain. |
| `benchmark/resume-extractors` | `ba55c90` | Same commit as careerops-integration; retain ref until owner cleanup decision. |
| `chore/m0-collaboration-baseline` | `54a9d76` | One local commit ahead of its remote; evaluate separately, preserve. |
| `feature/m2-resume-intelligence` | `a4178a0` | Ancestor of M3/M4/M5.1; retain during recovery. |
| `feature/m3-resume-e2e-acceptance` | `46a20d0` | Ancestor of M4/M5.1; attached checkout has distinct staged screenshots. |
| `feature/m4-job-matching-intelligence` | `f77b4f2` | Ancestor of M5.1. |
| `feature/m5.1-universal-discovery-intelligence` | `a5f96da` | Cumulative resume/matching/discovery line; 46 dirty entries in attached checkout. |
| `feature/project-command-center` | `5889221` | Separate governance/project API/UI line; 43 dirty entries in attached checkout; tracks origin. |
| `linkedin-discovery` | `e7f38bf` | On hold pending access-policy review; retain outside recovery candidate. |
| `worktree-universal-job-discovery` | `b510655` | Historical branch ref; retain until commit reachability and purpose review. |

Remote refs observed: `origin/main`, `origin/careerops-integration`, `origin/chore/m0-collaboration-baseline`, `origin/ci/tiered-fast-draft-full-review`, and `origin/feature/project-command-center` (plus symbolic `origin/HEAD`). No fetch was performed, so remote currency is unverified.

## Private-data and unique-work controls

- Keep `JobHunterPrivate` and other private runtime data outside Git. Root `.gitignore` has an uncommitted addition for `data/Resumes/`, `ml/**/private-runtime/`, `ml/**/.venv/`, `ml/**/models/*`, and `HIGH_CONFIDENT/`; the project-command-center checkout has its own modified ignore rules. These are working changes, not a proof that every private path is protected. Verify staged-file privacy and tracked-file isolation before any approved commit.
- Do not add raw resumes, candidate facts, credentials, database dumps, browser profiles, model weights, or private screenshots to an integration branch or PR. Existing backup directories under `F:\Jobs\Job_Search\job-hunter-backups`, `job-hunter-checkpoints`, and `_safety` were seen but not validated as current recovery copies.
- The 32 staged screenshots occur in M3 branch and detached checkouts, and 32 same-path untracked files occur in M5.1. Hash comparison: 14 paths identical in all three; 18 M3 branch paths differ from M3 detached; among those, 3 match M5.1 and 15 differ from M5.1 too. Preserve all three variants until visual and provenance review selects one.
- For any approved backup, use a new destination, separate subdirectory per worktree, and a manifest that records HEAD, branch/detached state, index entries, dirty file hashes, ignored/private exclusions, and copy verification. Never overwrite an existing backup. Restrict private backups to an owner-approved local location; do not attach private content to the PR.

## Acceptance state attached to this manifest

The October 29 matching-verification report is `PARTIAL_PASS` (source SHA-256 `9BD566D30755D6117A5DADC2D07919E91BC6E9B856891D3CC97062A9AF00CC5B`). Preserve its 14/14 expectation result, 36 passing matching tests, rendered UI observation, and 82-file link result as prior evidence. PostgreSQL integration, the complete approved-fact API/browser path, and full E2E remain pending. See the [consolidation plan](JOB-HUNTER-CONSOLIDATION-PLAN-2026-10-29.md) for the gates that must pass before any feature acceptance or reviewed integration PR.

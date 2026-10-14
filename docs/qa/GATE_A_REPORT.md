# Gate A report (ledger tasks P0-03, P0-05, P0-06, P0-07, P0-04)

Environment: Windows 11, Node v24.13.1, Python 3.12.10, PostgreSQL 17 in Docker (`jobhunter-s1-pg`, healthy), headed Chrome, branch `chore/m0-collaboration-baseline` (from `careerops-integration` `ba55c90`). Serialized command (all runs):

`npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`

Nothing is VERIFIED. Gate A stays **red** until two clean serialized runs are recorded below and an independent reviewer reproduces them (P0-04 acceptance).

## Runs

| # | Commit | Result | Failures | Notes |
|---|---|---|---|---|
| 0 | `ba55c90` + uncommitted work (parallel `npx vitest run`) | 149 files: 140 pass, 9 fail; 1617 tests pass, 10 fail, 10 skipped | s1-api upload x5, s2-api history, packet/build, llm-db, review-db, orbital-s3 e2e x3, dashboard/matches-ui/s1-ui e2e files | Typecheck clean. Four failing files rerun alone: 93/93 pass. |
| 1 | `ba55c90` + uncommitted work | 2 files fail, 147 pass; 8 tests failed | browser-search (1: render sequence `['', 's', 'sd', 'sdet']`, expected `'sde'` too); dashboard.e2e (6: sign-in page not visible within 15 s) | A concurrent `du` disk scan of `node_modules` ran during this run. |
| 2 | `567ab1e` | 2 files fail, 147 pass; 1629 pass / 3 fail / 1632 | `tests/ml/final-eval-claim` (suite aborted: `connect ETIMEDOUT 127.0.0.1:55440`); `tests/candidate/document-type` x3 | dashboard and browser-search passed. 7 min 46 s. |
| 3 | `891b3e2` | 1 file fails, 148 pass; **1636 pass / 1 fail / 1637** | browser-search render sequence again lost `sde` | 7 min 8 s. |
| 4 | see below | see below | | after the browser-search fixture change |

## Root-cause classification

| Failure | Class | Evidence | Status |
|---|---|---|---|
| document-type x3 (run 2) | **Defect I introduced** (test) | My redaction renamed reference files that exist locally under real names; `ENOENT ... reference_resume_a.pdf` | Fixed in `891b3e2`: names come from git-ignored `private-runtime/reference-docs/manifest.json`; 15/15 pass; run 3 shows no failure |
| final-eval-claim (run 2) | Environment (known) | `ETIMEDOUT` on loopback PostgreSQL at collection; passes alone 5/5; matches the loopback stall in `docs/KNOWN_FLAKES.md` | Not recurring in run 3; no code change |
| Dashboard e2e x6 (run 1) | Unproven; likely environment (resource contention) | Passes alone 8/8 (`JH_UI_DIAG=1`), together with browser-search 26/26, and in runs 2 and 3 | Not reproduced since; **cause unknown**; keep watching |
| Browser-search render sequence (runs 1 and 3) | Test-fixture defect (hypothesis, unproven) | The product typed the full query (`typedValue: "sdet"`); the fixture's fire-and-forget `fetch("/__render")` lost one middle record. Passes alone 18/18 on 6 of 6 attempts | Fixture now chains sends in order with up to 3 retries (assertion unchanged, not weakened). Effectiveness is judged by run 4 and later runs |
| s1-api, s2-api, packet, llm-db (run 0) | Load (parallel workers) | Pass alone and in serialized runs | Use the serialized gate |

Python (P0-07, run by the Technical Lead's agent session; **independent rerun by Hani pending**):
- `cd services/ai && .venv/Scripts/python -m pytest -q` → 61 passed, 1 warning (httpx/starlette deprecation).
- `cd services/ml && python -m pytest -q` → 4 passed.

Typecheck: `npm run typecheck` → clean (after the test edits).

## Reproduction
```
JH_UI_DIAG=1 npx vitest run tests/e2e/offline/dashboard.e2e.test.ts
npx vitest run tests/e2e/offline/browser-search.e2e.test.ts
npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism
```
Keep the machine otherwise idle during the serialized run.

## Outstanding
- Run 4 result (below) and a second consecutive clean run before Gate A can be called green.
- Hani's independent reproduction on her machine (P0-09) and review (P0-04).
- GitHub CI on PR #1: all seven checks passed on `96bd9f8`; the later pushes rerun them.
- Possible follow-up if browser-search fails again: capture in-page render log versus server log to prove or disprove the dropped-request hypothesis.

## Run 4
_pending at the time of writing_

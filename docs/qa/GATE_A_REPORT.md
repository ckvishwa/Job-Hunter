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
| 4 | `ae5cf95` (code identical to later HEADs; later commits are docs/.github only) | 1 file fails, 148 pass; **1636 pass / 1 fail / 1637**, 7 min 44 s | `tests/e2e/offline/s1-ui.e2e.test.ts`: `#signin-panel` not visible within 15 s at the first `page.goto(/dashboard)` (line 111) | browser-search and dashboard passed; s1-ui passed alone 2/2 (`JH_UI_DIAG=1`) |

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

## Run 4 findings
- Browser-search passed in the full serialized run and alone (3/3 earlier). That is **one** clean full run with the telemetry fixture, not proof; the fixture chains sends in order with up to 3 retries and does not change the assertion (the exact sequence `['', 's', 'sd', 'sde', 'sdet']` is still required, so duplicates or gaps would fail it). The server-side recording appends each record once per request; a retry after a request that actually reached the server could in principle duplicate a record, which the exact-sequence assertion would expose. Real browser errors are not hidden: the fixture only retries the telemetry POST, and the test still records page console errors.
- The failing test moved: run 1 dashboard + browser-search, run 3 browser-search, run 4 s1-ui. In every serialized run exactly one headed-Chrome test fails with a 15 s "element not visible" wait on first page load, and each passes alone. After run 4 the host had 5.2 GB free of 31.7 GB with about 6.7 GB in Chrome processes (the owner's own browser plus test browsers); no automation-launched Chrome was left running. **Classification: environment/resource contention suspected, unproven.** No code change is justified by this evidence, and no further full local run is authorized until a specific diagnostic is added (e.g. capture of Chrome start time and page load timing on failure, or a run on an otherwise idle machine).
- Clean-machine evidence available instead: GitHub Actions ran the full headed suites on Linux and Windows for PR #1 at `96bd9f8` and all seven checks passed. A manual full run on `00d86e9` succeeded (run 38641035560: Linux headed 131 s, Windows headed 225 s, full CI gate passed), and a Ready-for-review run on a probe PR also passed both headed platforms. This shows the full suite is green on clean hosted machines; it is **not** a substitute for the two clean local serialized runs, which Gate A still requires.

## Gate A status
**RED.** Needs two consecutive clean serialized runs on an identical code/test state, Hani456's independent reproduction and review, and the ledger evidence for P0-03/P0-04. Run 5 is not scheduled until the diagnostic above exists.

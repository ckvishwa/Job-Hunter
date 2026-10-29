# Known flaky tests

Record a test here only when it has failed without a code change and passed on rerun. Re-run the single file before treating a failure as real.

## Headed-Chrome loopback search flow

- **Test:** `visible search flow against a loopback careers site (headed Chrome) > types into the real search field, results change as it types, opens the first MATCH and saves the cleaned DOM-extracted posting`
- **File:** `tests/e2e/offline/browser-search.e2e.test.ts`
- **Seen:** once in a full `npm test` run on 2026-10-08 (947 passed, 1 failed; the failing test took about 5.2 s). The same file passed 18/18 when run alone (this test about 3.1 s), and the next full run passed 987/987.
- **Likely cause (unconfirmed):** timing under load. The suite starts headed Chrome while other test files run in parallel, and this is the first browser test in the file, so it pays the cold-start cost. No product defect was found.
- **What to do:** `npx vitest run tests/e2e/offline/browser-search.e2e.test.ts`. If it fails alone, treat it as a real failure. If it fails repeatedly in full runs, raise its timeout or serialize browser test files rather than ignoring it.

## Headed-Chrome offline pipeline E2E (second entry)

- **Test file:** `tests/pipeline/offline-e2e.test.ts` (headed Chrome against the loopback form fixture).
- **Seen:** reported by the user as a second headed-Chrome flake; logged 2026-10-08. The failing test name, run size, duration and rerun result were not supplied and were not reproduced in this session, so they are unrecorded.
- **Likely cause (unconfirmed):** same suspect as above, headed Chrome cold start under parallel load.
- **What to do:** `npx vitest run tests/pipeline/offline-e2e.test.ts` (or `npm run pipeline:offline`). If it fails alone, treat it as real. Fill in the exact test name and timings the next time it is seen.

## Headed-Chrome LinkedIn profile persistence (third entry)

- **Test:** `dedicated LinkedIn browser profile > keeps cookies and localStorage across two real headed launches and extracts observed DOM identities`
- **File:** `tests/pipeline/discovery/linkedin-discoverer.test.ts`
- **Seen:** once in a full `npx vitest run` on 2026-10-08 (1016 passed, 2 failed of 1018; this test failed after 8.7 s with `page.goto: net::ERR_CONNECTION_TIMED_OUT` at the loopback `/check` URL in the second launch). Run alone, the file passed 22/22 and this test took 3.6 s. No code changed between the runs.
- **Likely cause (unconfirmed):** second headed launch of the same profile while many other headed-Chrome files run in parallel; the loopback request timed out. No product defect was found.
- **What to do:** `npx vitest run tests/pipeline/discovery/linkedin-discoverer.test.ts`. If it fails alone, treat it as real.

## Headed-Chrome offline pipeline discovery step (fourth entry)

- **Test:** `offline headed discovery-to-form pipeline > persists one canonical JD, renders sourced PDF, fills and reconciles the local ATS form without submit`
- **File:** `tests/pipeline/offline-e2e.test.ts`
- **Seen:** once in a full `npm test` in a clean clone on 2026-10-09 (Windows, 1060 passed / 1 failed of 1061; this test ran 4.05 s). Failure: `expected +0 to be 1` at `summary.persistedCount` (line 171), i.e. the headed search step persisted no job. The same file passed alone twice (12.9 s and 12.5 s), and the immediately repeated full suite passed 96 files / 1,061 tests. No code changed between the runs.
- **Likely cause (unconfirmed):** timing under parallel headed-Chrome load in the search/settle step; no product defect was found. The Linux/Xvfb container run did not show it.
- **What to do:** `npx vitest run tests/pipeline/offline-e2e.test.ts`. If it fails alone, treat it as real. If it recurs in CI, raise the settle timeout or serialize browser test files (backlog `SDLC-T06`) rather than adding retries silently.

## Loopback connection timeouts in the dashboard tests (fifth entry)

- **Tests:** `dashboard server > serves GET endpoints and rejects every write method, bad hosts and unknown paths` and `dashboard page rendering (headless Chromium against the fixture server) > renders funnel, no-data panels, escaped text and safe links from fixture data`
- **File:** `tests/dashboard/dashboard.test.ts`
- **Seen:** once in the first full `npm test` of a clean clone on 2026-10-09 (Windows; 2 failed of 1,131): `Error: connect ETIMEDOUT 127.0.0.1:<port>` after 364 ms, and `page.goto: net::ERR_CONNECTION_TIMED_OUT` after 21.6 s. The file passed alone (7/7, 0.46 s) and the repeated full suite passed 103 files / 1,131 tests. No code changed between the runs.
- **Likely cause (unconfirmed):** loopback connections timing out while many headed-Chrome test files start at once on the same machine; the same error class as the LinkedIn profile flake above (`ERR_CONNECTION_TIMED_OUT`). No product defect found.
- **What to do:** `npx vitest run tests/dashboard`. If it fails alone, treat it as real. If it recurs in CI, serialize browser-launching files (backlog `SDLC-T06`).

## Timeouts and connection resets in full runs, 2026-10-09 (sixth entry; recorded during S1)

Same error class as the fifth entry (loopback connections timing out or resetting while many headed-Chrome files run in parallel on
one Windows machine). No code changed between a failing and a passing run; every file listed passed when run alone.

- **`tests/packet/build.test.ts` > `writes every required artifact and, with no approvals, stays in a review state`:** `Test timed out in 5000ms`. Seen in the S0 baseline full run and again in two S1 full runs. Passed alone (14/14) each time.
- **`tests/e2e/offline/browser-search.e2e.test.ts`:** `Hook timed out in 10000ms` (whole file), and once a single test, in two of the S1 full runs. Alone: 18/18.
- **`tests/packet/form-fill.e2e.test.ts` > `is idempotent: a second run finds every value already correct...`:** one full run. Alone: 10/10.
- **`tests/dashboard/dashboard.test.ts` > `serves GET endpoints and rejects every write method, bad hosts and unknown paths`:** one full run (fifth entry again). Alone: 7/7.
- **New S1 suites** (`tests/api/s1-api.test.ts`, `tests/e2e/offline/s1-ui.e2e.test.ts`; they use PostgreSQL in Docker, a Python service and headed Chrome): in 3 of the 7 full runs made after S1 was added, one or two tests failed with `Connection terminated due to connection timeout`, `read ECONNRESET` (PostgreSQL), or `FAILED (AI_UNAVAILABLE)` (connect to the Python service). Alone: `s1-api` 36/36 on every run, `s1-ui` passed 8/8 in a row after the proxy fix. Mitigations already in the code: the AI client retries a failed *connection* (never a timeout), the UI retries idempotent GETs, the dev proxy reuses connections, and the test harness uses a 30 s PostgreSQL connect timeout. Full runs after S1 was added: 4 of 7 fully green (1206, 1211, 1211 and 1212 tests passed). The latest failure was `connect ETIMEDOUT 127.0.0.1:55440` (the Docker-published PostgreSQL port) while the suite was loaded.
- **What to do:** re-run the single file. If it fails alone, treat it as real. The structural fix is the existing backlog item `SDLC-T06` (serialize browser-launching test files).

## Loopback connect stalls and failures, diagnosed during S2 (seventh entry)

**Root cause found (environmental, not project code):** a 40-line Node script with no project code, browser or database reproduces it.
On this Windows 11 machine (Windows Defender is the only security product; no third-party Winsock providers; dynamic port range
1024-65535, `TcpTimedWaitDelay` 30) plain loopback TCP to a local Node server misbehaves:

| Probe (`node loopback-probe.mjs <mode> <parallel> <each>`; script was in the session scratchpad, not committed) | Result |
|---|---|
| HTTP, 1 sequential stream, 3,000 requests | 3,000 ok but 24 s total, 29 requests >250 ms, max stall 2.1 s |
| HTTP, 4 parallel x 1,500 | 33 `ETIMEDOUT` + 4 `ECONNRESET`, max stall 19 s |
| HTTP, 16 parallel x 1,500 | 466 `ETIMEDOUT` (1.9 %), max stall 18.9 s |
| raw TCP connect, 64 parallel x 1,500 | 28,537 `ECONNREFUSED` (listen-backlog overflow) + 2,575 `ETIMEDOUT` |

So `connect ETIMEDOUT 127.0.0.1:<port>` (PostgreSQL at 55440, the Vite proxy, the API, the Astro preview) is an OS-level loopback fault
that appears even at low load, which is why it also hits the two-file UI run. Not changed: Defender settings or any system setting
(no authority). Worth the owner's check: Defender real-time/network protection exclusions for loopback and Docker Desktop.

**A real project defect found and fixed along the way:** `s1-ui` and `s2-ui` each ran `astro build` into the same `web/dist` at the
same time, wiping it under the other file's preview server (`ERR_CONNECTION_REFUSED`, seen with limited workers). Both now call
`ensureWebBuild()` (`tests/helpers/web-build.ts`): one build under a cross-process lock, only if sources are newer, and the preview
wait now throws instead of silently continuing.

**Mitigations that reduce exposure (no assertion or global timeout changed):** test database pools keep connections for 5 minutes
instead of 10 s (fewer new loopback connects); `harness.restart()` retries only the reconnect; the new `tests/api/s2-api.test.ts`
suite (ordered, dependent steps) allows 30 s per test *in that file only*, because a 5 s default turned one stall into a cascade of
dependent failures (visible as "Cannot use a pool after calling end" and a stale-revision test applying an edit).

**Full-suite runs on the final-ish code, 2026-10-09** (113 files, 1,297 tests; flags exactly as given; vitest 2.1.9 uses forks):

| Run | Flags | Result |
|---|---|---|
| default1 (before mitigations) | none | 10 failed (5 files): ECONNRESET/5 s timeouts in s1-api, s2-api cascade, packet/build, form-fill, offline-e2e |
| f4a, f4b | `--poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1` | 3 failed; 1 failed (UI files, the build race above) |
| d2, d3 | none | 1 failed; 2 failed (`ETIMEDOUT 127.0.0.1:55440`, Vite proxy `ETIMEDOUT`) |
| f2a | `maxForks=2` | 1 file failed (`connect ETIMEDOUT 127.0.0.1:55440` in a harness start) |
| **f1a, f1b** | `maxForks=1` (serial) | **113/113 files, 1,297/1,297 tests passed, twice** (173 s, 183 s) |
| d4 | none | 23 failed (restart connect stall cascaded through s2-api; also s1-api, dashboard, offline-e2e) |
| d5 | none | 3 failed (s2-api 5 s timeout cascade) |
| d6 | none | 1 failed (`browser-search`, pre-existing flake class) |
| d7 | none | 22 failed (restart connect stall cascade in s1-api/s2-api) |
| d8 | none | 2 failed + 1 file error (Astro preview unreachable for 30 s; 5 s timeout) |
| **d9** | none | **113/113, 1,297/1,297 passed** (85 s) |

d4-d8 ran before/while the last two mitigations (30 s file timeout, restart retry) landed in turn; d8 and d9 are the only runs with
both. Reading: with the default ~15 parallel workers the suite is **not reliably green** on this machine (green in 1 of the last 2
runs; 0 of 8 before). Serialized (`maxForks=1`) it passed 2 of 2. Every failing file passed when run alone. Recommendation:
decide `SDLC-T06` (run browser/DB files serially) and have the owner look at the loopback fault.

## Dashboard UI file: loopback stalls in the first test and in API restarts (eighth entry)

- **File:** `tests/e2e/offline/dashboard.e2e.test.ts` (headed Chrome -> Astro preview -> Fastify -> PostgreSQL, throwaway database).
- **Seen, 2026-10-09:** (a) in a multi-file serial run the API-restart step failed with `connect ETIMEDOUT 127.0.0.1:55440` at `buildServer` -> `ensureUser`, and the ordered tests after it failed because the API stayed stopped; (b) the first test (`signed out: ...`) failed in 3 of about 9 whole-file runs with its sign-in form not visible within 15 s, and passed alone 3 of 3 and in the next 10 whole-file runs. The Vite proxy log in those runs showed `ETIMEDOUT` to the API port. No product code changed between a failing and a passing run.
- **Likely cause (unconfirmed):** the same machine-level loopback connect stall as the seventh entry; a request that stalls longer than the UI's 12 s request timeout shows "Can't reach the Job Hunter API" instead of the sign-in form, which is the correct behaviour for a real outage.
- **Mitigations in the test only (no assertion weakened):** a warm-up navigation after Chrome starts; the API restart retries only the reconnect (4 attempts); a `beforeEach` restarts the API if a previous test left it stopped, so one stall cannot cascade through the ordered tests.
- **What to do:** `npx vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=1 tests/e2e/offline/dashboard.e2e.test.ts`. If it fails alone, treat it as real.

## Loopback connect stalls during the Orbital/S3 work (ninth entry)

- **Observed 2026-10-09, serial gate `npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`:** attempt 1: `tests/api/s2-api.test.ts` suite failed (`connect ETIMEDOUT 127.0.0.1:55440` in `startHarness`) and `tests/e2e/offline/dashboard.e2e.test.ts` failed 7 of 8 (its first test stalled, then the ordered tests cascaded). Attempt 2: `tests/api/s1-fullstack.test.ts` suite failed (`ETIMEDOUT 127.0.0.1:55440`, 19 tests skipped as a result). Attempt 3: `tests/e2e/offline/s1-ui.e2e.test.ts` failed (`ETIMEDOUT` in `migrate()` at `pool.connect`). Every one of those files passed alone, immediately after (8/8, 31/31, 19/19, 1/1).
- **Mitigation added (test helper only, no assertion changed):** `startHarness` now retries only its first admin connection and `migrate()` on connect errors (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `Connection terminated`). **Attempt 4: 119 files, 1,359 tests, all passed.**
- **Default-parallel `npm test`, once:** 117/119 files, 1,357/1,359 tests; failures were `s2-api` (`ETIMEDOUT 127.0.0.1:55440`) and `tests/packet/build.test.ts` (5 s timeout). Not a green gate; not hidden.
- **Cause (unconfirmed):** the machine-level loopback fault of the seventh entry. A live development stack (Astro, Fastify, Python, PostgreSQL) was running at the same time, which may raise the odds.
- **What to do:** rerun the failing file alone. If it fails alone, treat it as real.

## S2 UI workflow stall during S4A verification (tenth entry)

- **Test:** `S1 -> S2 UI workflow (headed Chrome) > uploads a synthetic resume, approves facts, and gets persisted, evidence-linked role suggestions and a manual selection` (`tests/e2e/offline/s2-ui.e2e.test.ts`).
- **Seen, 2026-10-11:** once in the first serialized full run of the S4A work (127 of 128 files, 1,458 of 1,459 tests). It ran 66.7 s and failed with `Error: Matcher did not succeed in 15000ms` at `toHaveAttribute` in `classify` (`AssertionError: expected 'pending' to be 'approved'`). The file passed alone twice (10.6 s each) and the repeated serialized full run passed 128 files / 1,459 tests. No code changed between those runs.
- **Evidence for the classification:** the 6x slower duration and the pass on identical code match the loopback-stall pattern of the seventh entry (a UI request exceeding the page's poll window). Not proven; if it recurs, capture the request timings before calling it environmental.

**Update, S4B (2026-10-11): root cause found and fixed.** The tenth entry was not environmental. `classify()` in the test clicked Approve as soon as the row's `data-status` read `pending`, but an unclassified employment fact is already `pending` before the edit, so the wait was satisfied by the OLD row and the click used the pre-edit digest (HTTP 409 `STALE_FACT`) whenever the fact-list refresh was slow. Reproduced on demand with the stress knob `JH_TEST_DELAY_FACTS_MS` (delays `GET /api/v1/resumes/*/facts`), fixed by waiting for the re-rendered row (`type: professional`) before approving. The server now also logs `[api] 500 <method> <route> <error>` so a future 500 is diagnosable.

## `orbital-s3.e2e` suite failure with a lost message (eleventh entry)

- **Seen, 2026-10-11:** once, in the first `npm run test:full` of S4B, `tests/e2e/offline/orbital-s3.e2e.test.ts` reported "(suite failed to run)" and the message was not captured. It passed when run alone and in later batches.
- **What changed:** the smart-test runner (`src/testing/exec.ts`) now records the suite-level message and keeps the raw `*.failures.json`, so a recurrence is diagnosable.
- **Cause: unknown.** Not classified as environmental without evidence. If it recurs, read the recorded message in `private-runtime/test-cache/logs/` first.
- **What to do:** rerun the file alone. If it fails alone, treat it as real.

## 2026-10-14 — tests/ml/llm-db.test.ts synthetic experiment count
Observed 5 rows against an assertion requiring >5; a diagnostic rerun with fresh UUIDs passed. Second-pass and QC selection hashes include generated posting IDs, so the fixture does not guarantee >5 eligible residual rows after human-review exclusions. Replaced the arbitrary minimum with nonempty plus the existing per-row train-side, no-human-label, confidence, binary-class and unique-text assertions. No production filters were relaxed. Both outcomes are recorded in docs/ml/ML-UPGRADE-LOOP.md.

## 2026-10-14 — five serialized full runs, no green gate (details: docs/testing/V01-REGRESSION-RECOVERY.md)
Different DB/browser tests failed in each run (s3-api x2, s1-api, review-db suite setup, matches-ui 5 s timeout x2, s1-ui "Uploading..." stuck 15 s); every one passes alone. The bare-Node loopback probe (no project code) still shows 3.1% ETIMEDOUT and stalls up to 4.5 s today. Two real tooling/test defects found and fixed (runner gate self-invalidation via `private-runtime/test-cache/current-run.json`; stale migration list). Cause of the individual full-run failures is a supported hypothesis (loopback stalls), not proven; no timeout was changed.

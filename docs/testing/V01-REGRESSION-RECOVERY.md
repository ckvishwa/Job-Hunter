# V0.1 regression recovery (Slice R1)

Date: 2026-10-14 (local). Branch `careerops-integration`, HEAD `ba55c90` plus uncommitted work. Environment: Windows 11, Docker Postgres `jobhunter-s1-pg` on 127.0.0.1:55440, vitest 2.1.9, serialized runner (`npm run test:full` = batches of 12 files, `--maxWorkers=1 --no-file-parallelism`).

## Gate A: FAIL (no clean full run recorded)

Five serialized full runs were made after the ML work. None recorded a green gate.

| Run | Executed | Failed | Failures (all passed when rerun alone) |
|---|---|---|---|
| 1 | 1621 | 1 | `s3-api` migration-list test: stale expectation (product/test defect, FIXED) |
| 2 | 1616 | 3 | `s1-api` concurrent upload (`expected 2 to be 1`), `matches-ui.e2e` (5 s timeout), `review-db` (suite failed to run in `beforeAll`) |
| 3 | 1621 | 0 | none, but the gate still wrote `fail` (runner defect, FIXED, see below) |
| 4 | 1622 | 1 | `s3-api` "exactly one run in progress": `[202, 500]` instead of `[202, 409]` |
| 5 | 1622 | 2 | `matches-ui.e2e` (5 s timeout), `s1-ui.e2e` (browser-problem assertion) |

Run 3 is the only run with zero failing tests, and it did not produce a green gate. Do not read it as a pass.

## Defects found and fixed

1. **Gate could never pass (runner defect).** `src/testing/fingerprint.ts` `dataRefs` treated `private-runtime/test-cache/current-run.json`, a string literal in the runner's own test, as a data dependency. The runner rewrites that file every run, so `tests/testing/engine.test.ts` always had a receipt hash different from the current fingerprint, and the full gate wrote `fail` with 0 failing tests. Evidence: per-unit predicate script showed exactly that one unit with `receipt.hash !== fingerprint.hash`, `DIFF component data`; the mutable file was the only data reference touched during the run. Fix: ignore anything under `private-runtime/` as a data reference. Regression test: `tests/testing/engine.test.ts` "runtime state under private-runtime is not a data dependency" (red before, green after; file 16/16).
2. **Stale migration list** in `tests/api/s3-api.test.ts` (expected 0001-0010). Updated to include 0011.
3. **Test diagnosability** (no assertion weakened): `s1-api` concurrent-upload test now asserts all six status codes are 202 before comparing resume ids; `s3-api` run-conflict test prints both response bodies on failure. A failed request has no `resumeId`, so `Set(ids).size === 2` can mean a transport error rather than a duplicate resume.
4. **Test DB setup resilience**: `tests/helpers/ml-fixtures.ts` retries connect-phase failures only (pool connect, query, and the admin `CREATE DATABASE`).

## Not fixed: loopback stalls (environmental, evidence-backed)

- Bare Node probe with no project code (`private-runtime/ml/scratch/probe.mjs`: one HTTP server, 16 parallel clients x 300 requests on 127.0.0.1): 4,800 requests, **150 ETIMEDOUT (3.1%)**, 97 requests slower than 250 ms, max stall 4.5 s (run 2026-10-14). The same fault is recorded in `docs/KNOWN_FLAKES.md` (seventh entry).
- Reproduced a product-test failure in a two-file run: `s1-ui` + `matches-ui`, 1 of 6 runs failed; the failing run took 65 s versus about 25 s for the other five. Diagnostics: browser stuck on "Uploading..." for the full 15 s matcher timeout, only a 401 console error, no external requests. A stall, not a duplicate-upload defect.
- `s1-api` concurrent upload: 25/25 alone; `s3-api` file: 15/15 alone; `s3-api` and `s1-api` failures in full runs are consistent with a connection error mapped to 500, but the original responses were not captured. **Cause for runs 2 and 4 is therefore a supported hypothesis, not proven.**
- `matches-ui` 5 s default timeout failed in 2 of 4 full runs after the fix; alone it passes in about 3 s. A timeout increase was NOT made (no evidence it is the right layer).

## Needed to turn the gate green

1. Machine-level: owner to review Windows Defender real-time/network protection and Docker Desktop loopback handling (as already flagged in KNOWN_FLAKES). Re-run the probe; it should show 0 errors.
2. Or run `npm run test:full` on a machine/CI without the fault (Linux/Xvfb container runs did not show it per KNOWN_FLAKES).
3. Next reproducible step: after (1) or (2), run `npm run test:full` twice consecutively; accept Gate A only if both record `pass`.

Leftover: one throwaway database `jh_test_*` remains in the dev Postgres from an aborted run; not dropped (needs owner OK to delete).

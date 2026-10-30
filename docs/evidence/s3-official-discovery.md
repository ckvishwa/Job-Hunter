# S3: official job discovery

Selection-driven discovery of **official** Greenhouse/Lever postings into PostgreSQL, with a `/jobs` page. Dated 2026-10-09. Nothing was committed or pushed. S4 (eligibility, semantic scoring) and S5 (forms, submit) were **not** started: no listing is called eligible, matched or scored, and no application is opened.

## 1. KEEP / ADAPT / CREATE

| Existing code (kept as-is, behaviour frozen by its existing tests) | Use in S3 |
|---|---|
| `src/pipeline/discovery/board-discoverer.ts`: `fetchBoardPostings`, `boardApiUrl`, `BoardError`, `titleMatches`, `loadBoardList` | **KEEP** the official board reader and list schema. Only two helpers were exported (`registryEntryFor`, `toPosting`; the `export` keyword was added, no logic changed). |
| `src/domain/canonical-job.ts`: `stampResolution`, `evaluatePersistable`, `verifyOfficialPosting`, `computeJdContentHash`, `buildJobFailure` | **KEEP** official-employer verification, JD completeness gate, content hash, typed failures. |
| `src/pipeline/discovery/location.ts`, `jd-flags.ts` | **KEEP/reuse** location verdict and "N+ years" quote reader. |
| `src/pipeline/discovery/board-discoverer.ts::runBoardDiscovery` (+ JSONL `data/*.jsonl`) | **KEEP untouched.** The legacy JSONL history is not read, written or migrated. |
| Playwright discovery (`src/discovery/*`, `src/pipeline/discovery/linkedin*`) | **Not used.** The official board APIs need no browser; no site is scraped. |

| New (CREATE) | Purpose |
|---|---|
| `db/migrations/0003_s3_discovery.sql` (+ `down/`) | runs, per-board status, jobs, JD revisions, observations, failures |
| `src/jobs/planner.ts` | pure plan from the persisted selection; title/location/seniority/band rules |
| `src/jobs/runner.ts` | single-worker runner over the kept reader + verification; recovery; cancel |
| `src/db/jobs-repo.ts` | all S3 SQL; atomic per-board writes; user-scoped reads |
| `src/api/jobs-routes.ts` | the endpoints below |
| `src/jobs/pilot-cli.ts` (`npm run s3:pilot`) | bounded real-source pilot in a throwaway database |
| `web/src/pages/jobs.astro` | the Orbital `/jobs` page |

## 2. Planner (`src/jobs/planner.ts`)

Input: the persisted S2 selection (`search_preferences` head) and the role catalog. Output: a frozen plan stored on the run (`discovery_runs.snapshot`).

- Phrases = each **selected** role's title + catalog aliases, whole-phrase, case-insensitive. Unselected suggestions contribute nothing and can never match (tested).
- `STALE_SELECTION` if the page's `expectedSelectionRevision` is not the current head; `STALE_CATALOG` if the catalog changed after the selection was saved; `NO_SELECTION`, `EMPTY_SELECTION`, `INACTIVE_ROLE` otherwise. All are refused **before** any employer is contacted (asserted: zero fetches).
- Location: `MATCH` / `UNKNOWN` (kept and flagged) / `UNSPECIFIED` (no preference) / `NO_MATCH` (counted, not stored).
- Seniority: a title is dropped only when it is explicitly senior-level **and** the person did not select "senior". It is a label read from the title, never proof of required experience.
- Years band: the JD's own stated minimum years (verbatim quote) is `WITHIN` / `OUTSIDE` / `UNSTATED`. `OUTSIDE` postings are **kept and flagged**, not dropped. The 0-5 window is a discovery heuristic, not a claim about the candidate.
- `PARTIAL` role support is accepted as a human selection; it is never promoted to `SUPPORTED` or "eligible".

## 3. Migration `0003_s3_discovery` (backup first)

Pre-migration backup: `private-runtime/backups/pre-s3-20261009-175936.dump` (pg_dump -Fc, gitignored; counts before: 5 résumés, 50 facts, 1 selection; the same counts after).

| Table | Key points |
|---|---|
| `discovery_runs` | per-user; status `QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED/CANCELLED/INTERRUPTED`; frozen `snapshot`, `limits`; counters; **partial unique index: at most one active run per user** |
| `discovery_run_boards` | one row per board per run; `PENDING/RUNNING/OK/FAILED/SKIPPED`; counters; typed failure; `blocked`, `retryable` |
| `jobs` | one row per official requisition: **`ats_identity` UNIQUE** (e.g. `greenhouse:acmesec:1001`); points to `current_revision_id` |
| `job_revisions` | `UNIQUE(job_id, jd_sha256)`; **immutable** (update/delete trigger); stores the JD text exactly as published |
| `job_observations` | one per (run, job): official URLs, verification, matched roles/phrases, location/band status, stated-years quote, observed time; `UNIQUE(run_id, job_id)` |
| `discovery_failures` | stage, typed code, category, retryable, blocked, detail (<= 400 chars) |

Identity vs content: a changed JD is a **new revision of the same job**; the old text is preserved. A user can only read jobs observed in **their** runs (ownership via `job_observations -> discovery_runs.user_id`); another user's job is indistinguishable from an unknown id (404).

Rollback (development only): back up, then run `db/migrations/down/0003_s3_discovery.down.sql`. Proven on a disposable database: apply -> roll back -> S3 tables gone, S1/S2 tables and rows intact, `schema_migrations` back to 2 rows -> re-apply works.

## 4. API (all need a session; writes need trusted Origin + CSRF)

| Method and path | Result |
|---|---|
| `GET /api/v1/discovery/overview` | disclaimer, whether boards are configured, board list, limits, the plan that *would* run (or `planError`), latest run |
| `POST /api/v1/discovery-runs` `{expectedSelectionRevision, boardKeys?}` | `202 {runId, status:"QUEUED", boards, truncatedBoards}`; `409 STALE_SELECTION/STALE_CATALOG/RUN_IN_PROGRESS(+runId)`; `422 NO_SELECTION/EMPTY_SELECTION/NO_BOARDS/UNKNOWN_BOARD` |
| `GET /api/v1/discovery-runs`, `/:id` | status, counters, per-board rows, typed failures, frozen snapshot |
| `POST /api/v1/discovery-runs/:id/cancel` | `CANCELLED`; pending boards `SKIPPED`; late data is refused (each board write re-checks `RUNNING` under a row lock) |
| `GET /api/v1/jobs?role&company&location&q&runId&locationStatus&bandStatus&limit&offset` | verified listings (latest observation per job, user-scoped) |
| `GET /api/v1/jobs/:id` | job, full JD of the current revision, revision list, observations |

No response contains an eligibility, score, percentage, salary or apply field (asserted by key scan). The start request returns immediately; work happens in a single in-process worker that reads one board at a time with a delay (default 400 ms). Limits (env): `JH_DISCOVERY_MAX_BOARDS` 25, `JH_DISCOVERY_MAX_CANDIDATES` 50, `JH_DISCOVERY_MAX_PER_BOARD` 50, `JH_DISCOVERY_DELAY_MS` 400. Board list: `JH_BOARDS_FILE` or `config/company-boards.json` (see `config/company-boards.example.json`; gitignored).

Restart recovery: on API start, runs left `QUEUED/RUNNING` are re-enqueued; boards already `OK` are kept, pending ones continue (proven: a run interrupted on its second board resumed to `COMPLETED` with no duplicate observation).

## 5. Failure handling (typed, visible, never silent)

`BOARD_NOT_FOUND` (404), `BOARD_FETCH_FAILED` (retryable; HTTP 401/403/429 also set `blocked`), `BOARD_RESPONSE_INVALID`, `BOARD_CONFIG_MISSING`, `UNOFFICIAL_HOST`, `UNVERIFIED_EMPLOYER`, `JOB_ID_MISSING`, `EMPTY_DESCRIPTION`, `DESCRIPTION_TOO_SHORT`, `PLACEHOLDER_DESCRIPTION`, `STORAGE_FAILED` (run). A failed board never stops the others; a run with both failures and successes is `PARTIAL`; all failed is `FAILED`. Duplicates (same requisition twice in one payload) are stored once and counted.

## 6. Test evidence (synthetic official boards; real PostgreSQL)

| Suite | Result |
|---|---|
| `tests/jobs/planner.test.ts` | 9 passed |
| `tests/api/s3-api.test.ts` (auth/CSRF, selection planning, full run with hand-derived counts, GET-only safety, filters, no eligibility fields, rerun idempotence, changed-JD revision + immutability, duplicate requisition, one-active-run + cancel, stale selection, ownership, restart recovery, migration + rollback) | 20 passed |
| `tests/web/*` (view model incl. S3 states, error classifier) | 18 passed |
| `tests/e2e/offline/orbital-s3.e2e.test.ts` (headed Chrome) | 7 passed |
| Hand-derived run: 5 boards -> read 9, title-matched 6, seniority-excluded 1, **verified 5**, new 5, boards failed 2 (`BOARD_FETCH_FAILED` 403 blocked + retryable; `BOARD_NOT_FOUND`); rerun -> unchanged 5, 0 new jobs/revisions; changed JD -> 1 new revision, same job | asserted exactly |

Full serial gate: `npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism` -> **119 files, 1,359 passed, 0 failed** (4th attempt; see the flake table in `docs/KNOWN_FLAKES.md`, ninth entry, for attempts 1-3). Default-parallel `npm test` once: 117/119 files, 1,357/1,359 tests (two known-class failures: an `ETIMEDOUT 127.0.0.1:55440` and a 5 s timeout in `tests/packet/build.test.ts`). `npm run pipeline:offline` 1/1. Python 30/30. `npm audit --omit=dev`: 0.

## 7. Real-source pilot (read-only; synthetic selection; NOT owner acceptance)

`npm run s3:pilot` runs in a throwaway database with a **synthetic** selection (never the owner's data), plain GET requests to public `boards-api.greenhouse.io`, 750 ms between boards, stop at 50 candidates. Board tokens came from the owner's draft `company-boards.json` (its own note says they are unverified best guesses). Raw summaries: `private-runtime/pilot/` (gitignored).

| | Pilot A (US + remote, entry/junior/mid) | Pilot B (open place and level filters) |
|---|---|---|
| Boards attempted / ok / failed / blocked | 12 / 9 / 3 / 0 | 20 / 16 / 4 / 0 |
| Postings read | 1,834 | 3,586 |
| Title-matched | 6 | 18 |
| Excluded by place / by senior title (counted, not stored) | 5 / 1 | 0 / 0 |
| **Verified official, stored (unique)** | **0** | **9** |
| Rejected by verification | 0 | 9, all `UNOFFICIAL_HOST` |
| Duplicates | 0 | 0 |
| Failed boards | `BOARD_NOT_FOUND`: arcticwolf, reliaquest, redcanary | the same three plus snyk |

Reading it honestly:
- Pilot A stored nothing because the owner-style filters (US/remote, no senior titles) excluded all 6 title matches; that is the filter working, not a bug.
- Pilot B's 9 rejections are employers (Abnormal, Wiz, SentinelOne, Elastic, Okta, Stripe) whose Greenhouse listing URLs live on **their own domain**. The existing verification accepts such a host only when the board entry declares `corporateDomain`; the draft list has none. Add `corporateDomain` per employer to verify them. This is the verification refusing to guess, as designed.
- Four draft tokens do not exist on Greenhouse (404). Fix or drop them.
- Zero submission actions, zero form opens, zero non-GET requests.

## 8. Owner-validation gates

- `OWNER_REAL_RESUME_VALIDATION_PENDING`: the owner must run 1-2 real résumés through S1 -> S2, select at least one role, run discovery on a verified board list, and confirm the listings are sensible. Not done here.
- The owner's real `company-boards.json` has to be converted to this schema (`board` not `boardToken`; `corporateDomain` where needed) and verified live.
- The same machine-level loopback `ETIMEDOUT` that affects the test suite can also stall a run's board request (the 20 s board timeout then reports `BOARD_FETCH_FAILED`, retryable).

## 9. Safety proof

- Only `GET https://boards-api.greenhouse.io/...` and `GET https://api.lever.co/...` were made (asserted on every recorded call in the API and browser tests; none contains `apply` or `submit`).
- The apply URL is not stored or returned; the page links only to the official posting.
- No S1/S2 row was written by S3; the pre-migration counts equal the post-migration counts.
- The existing offline headed pipeline regression (form fill without submit) is unchanged and green; S3 never invokes it.

# S2 evidence: role catalog, grounded experience, role recommendations, human role selection

Version/slice: Master ARD S2. Branch `careerops-integration`, base HEAD `1efb931`, **uncommitted** (S1 and S2 are both in the working tree). Date: 2026-10-09. Environment: Windows 11, Node 24.13.1, PostgreSQL 17.6 (Docker `jobhunter-s1-pg`, loopback 55440), Python 3.12 venv, headed Chrome via the production launcher.
No real candidate data was used: every resume, employer and fact in tests and in the live smoke is synthetic. Nothing was submitted, committed, pushed or deployed.

## What now exists

| Piece | Where |
|---|---|
| Versioned, editable role catalog (families, roles, aliases, evidence requirements) in PostgreSQL, idempotent seed, revisioned edits | `db/migrations/0002_s2_roles.sql`, `src/roles/catalog.ts`, `src/roles/seed.ts`, `src/db/roles-repo.ts` |
| Pure experience calculation (month precision, union of ranges, separate buckets, issues) | `src/roles/experience.ts` |
| Pure, deterministic role assessment from approved facts only (no model, no JSONL) | `src/roles/recommend.ts` |
| Persistence: `candidate_role_recommendations`, `candidate_role_decisions`, `search_preferences` (append-only revisions) | `0002_s2_roles.sql`, `src/db/roles-repo.ts` |
| API: `GET /api/v1/roles/catalog`, `PUT /api/v1/roles/catalog/:roleSlug`, `GET /api/v1/roles/recommendations`, `POST /api/v1/roles/recommendations/decisions`, `GET`/`POST /api/v1/roles/selections` | `src/api/roles-routes.ts`, wired in `src/api/server.ts` |
| UI: `/roles` (experience, suggestion cards with evidence links, gaps, approve/dismiss/clear, selection and preferences); review page deep-links (`?fact=`) and edits detail/dates | `web/src/pages/roles.astro`, `web/src/pages/review.astro`, `web/src/layouts/Base.astro` |

## Rules that matter (read these)

**Experience calculation** (`src/roles/experience.ts`, header comment is the contract)
- Only APPROVED, usable facts count (pending, rejected, expired, "lacks" facts never do). An approved employment fact counts only toward the bucket a person classified it into (`employmentType`: professional, internship, academic, volunteer). The resume parser never sets `professional`; a person does, in the review edit form. Unclassified approved employment is **not counted** and forces status `REVIEW`.
- Month precision. Lower bound = months in `[start, end)` (end month not counted); upper bound = `[start, end]` inclusive. The truth lies between, so every figure is a range. Overlapping or touching ranges are merged; concurrent jobs count once. A gap is reported only when at least one whole month is definitely uncovered (computed from the upper bound), so "ends 2020-06, next starts 2020-07" is not a gap.
- A current job needs an explicit `endDate: null` and ends at the month of the fixed `asOf`. A **missing** end date is unknown, never "until today": reported (`MISSING_END_DATE`) and not counted. Reversed range, start after `asOf`: reported for review, not counted. End after `asOf`: clamped to `asOf`, warning.
- Internship/co-op, academic employment, volunteer work, degree study (education facts with dates), projects, certifications and skill mentions are reported separately. Projects, certifications and skill mentions are **counts only**; none becomes months or years.
- Same employer, overlapping professional entries: counted once, warning `OVERLAP_SAME_EMPLOYER` (possible duplicate).
- Known gaps: part-time vs full-time is not distinguished (the model has no such attribute); education/project dates only exist if a person adds them in the edit form.

**Role assessment** (`src/roles/recommend.ts`)
- A requirement is met only by an approved, usable, non-sensitive fact whose text contains one of the requirement's terms as a whole word/phrase (`SIEM` ≠ `siemens`). Matches carry the fact id, the matched term and how the fact evidences it (`employment`, `project`, `certification` = demonstrated; `education`, `skill_mention` = not demonstrated).
- `SUPPORTED`: at least `minCoreMatches` core requirements met **and** at least one core requirement met by a demonstrated fact. `PARTIAL`: at least one core met. `NO_MATCH`: none; never stored as a recommendation, returned with its gaps. A job title that resembles an alias is shown as a "title signal" and never raises the level by itself.
- Gaps are explicit (`UNMET_CORE`, `UNMET_SUPPORTING`, `NO_DEMONSTRATED_EVIDENCE`, `BELOW_MIN_CORE`, `EXPLICIT_LACK`). Pending facts that mention an unmet requirement are shown as hints, never counted. Experience notes (`advisoryProfessionalMonths`) are advice computed at read time, never a gate.
- Sensitive facts (citizenship, clearance, work authorization, sponsorship, name, email, phone) are excluded from matching entirely and appear nowhere in the output. S2 makes no job-level knockout decision.
- The suggested search band (`0–5` by default, shorter for little approved experience) is advice for S3 and its text says it is not a claim of years.

**Persistence and invalidation**
- One *current* recommendation per (user, role) (partial unique index). Its `input_digest` hashes the role definition, the support level, the source facts and their content digests, the matched terms and the gap codes. Same inputs: nothing changes (idempotent). Changed inputs: the old row is superseded (kept as history) and a fresh `PROPOSED` row replaces it, so an old approval is **never** carried onto different evidence; it is shown as a "stale decision". Approving an unrelated fact does not churn other roles.
- A decision (`approve`/`dismiss`/`reset`) must quote the `input_digest` it saw; an unknown id is 404, a superseded or mismatched digest is 409 `STALE_RECOMMENDATION`. Decisions are recorded in an append-only table.
- A selection is an append-only revision of `search_preferences`. Saving needs the current `expectedRevision` (409 `STALE_SELECTION`) and the current catalog version (409 `STALE_CATALOG`); unknown roles or families are 400. A person may select a role with no supporting evidence; suggestions never change a selection.
- Catalog edits need `expectedRevision` (409 `STALE_ROLE`), are validated by the same schema as the seed (400), create a revision row and a new catalog version, and mark the role `origin='user'` so the seed never overwrites it.

## Requirements and evidence

| ID | Requirement | Evidence | Result |
|---|---|---|---|
| S2-1 | Versioned catalog, aliases and evidence requirements as data; seed idempotent; safe rerun | `tests/api/s2-api.test.ts` "role catalog" (12 roles/8 families, 3 concurrent seeds create a new role once, rerun changes nothing, edited role never overwritten) | pass |
| S2-2 | Cybersecurity primary; QA/SDET, cloud, network secondary | `tests/roles/recommend.test.ts` seed checks; API catalog test; UI test (first card is a primary-family role) | pass |
| S2-3 | Experience only from approved, classified, dated facts; union of ranges; fixed `asOf`; month precision | `tests/roles/experience.test.ts` (23 tests, hand-computed ranges) | pass |
| S2-4 | Overlap counted once, adjacent merge, gap stays a gap, ongoing uses `asOf`, reversed/ambiguous not silently counted | same file | pass |
| S2-5 | Internship, master's, projects, skill mentions never add professional time | same file + API test + UI test | pass |
| S2-6 | Rejected/pending facts cannot support a role; editing/rejecting an approved fact invalidates stale proposals | `recommend.test.ts` authority tests; `s2-api` "changed evidence invalidates…" (3 tests); UI test | pass |
| S2-7 | Recommendations idempotent, reproducible, no duplicates on rerun/parallel reads | `s2-api` idempotence + 6 parallel reads; `recommend.test.ts` order-independence | pass |
| S2-8 | Unsupported role stays a proposal or no-match with clear gaps | oracle cases r02, r05, r10, r12, r14; API `noMatch` list | pass |
| S2-9 | Hand-reviewed fixtures across SOC, DFIR, IAM, vulnerability, QA, cloud, network, GRC, positive and negative | `tests/roles/fixtures/role_cases.json` (14 cases, expected values reasoned from the seed requirements, not generated) | pass |
| S2-10 | Stale selection/decision/role revision/catalog version return 409 and do not clobber | `s2-api` (decisions, selection incl. two simultaneous saves, catalog edits, STALE_CATALOG); UI test shows a stale save refused | pass |
| S2-11 | Ownership isolation, transactions, reload | `s2-api`: second user sees nothing and cannot decide; refused selection leaves no row; restart keeps decisions, selection, 12 roles | pass |
| S2-12 | Authenticated, CSRF- and Origin-protected writes | `s2-api` protection tests (every roles route 401; every write BAD_CSRF/BAD_ORIGIN) | pass |
| S2-13 | Sensitive facts never inferred, matched or shown | `recommend.test.ts` (sensitive text ignored; output free of citizen/clearance/sponsor); `s2-api` attests four sensitive facts and recommendations are unchanged | pass |
| S2-14 | Astro→Fastify→Postgres smoke: cards, evidence links, selection, reload, dismissal | `tests/e2e/offline/s2-ui.e2e.test.ts` (headed Chrome, real Python extractor, zero external requests) | pass |
| S2-15 | S1 upload/review still works | `s1-api`, `s1-fullstack`, `s1-ui`, fact-lifecycle, client, queue tests unchanged and passing | pass |
| S2-16 | Existing typecheck + offline pipeline regression | `npm run typecheck`; `npm run pipeline:offline` | pass |

## Commands and results

All run from the worktree root on 2026-10-09 against the final code.

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npx vitest run tests/roles` | 2 files, 53 tests passed |
| `npx vitest run tests/api/s2-api.test.ts` | 31 passed (real PostgreSQL, throwaway database) |
| `npx vitest run tests/e2e/offline/s2-ui.e2e.test.ts` | 1 passed (headed Chrome) |
| S1 focused: `tests/candidate/fact-lifecycle.test.ts tests/api tests/ai tests/e2e/offline/s1-ui.e2e.test.ts` (before S2 edits) | 80 passed |
| `services/ai`: `.venv/Scripts/python -m pytest -q` | 30 passed |
| `npm run pipeline:offline` | 1 passed |
| `npx tsx src/ci/private-isolation.ts static`; `npm run ci:audit` | 0 violations; 0 failures (6 accepted, 5 warnings, all dev tooling) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `web` `astro build` | 4 pages built |
| Mutation checks (change code, expect a test to fail, restore) | 7 of 7 killed: SUPPORTED without demonstrated evidence; overlap double-counted; stale digest not checked; pending facts treated as usable; missing end date treated as current; old decision kept on changed evidence; stale selection revision ignored |

Live local S1→S2 proof against the **dev** stack (real Python service, `npm run api` process, dev database after backup `pre-s2-*.dump` and `npm run db:migrate`): login → upload synthetic `c14-tab-separated-iam-docx` → extraction produced 12 facts, all `pending` → approve skills/certification, classify and approve the two jobs → `GET /api/v1/roles/recommendations` returned `iam-analyst` PARTIAL with approved evidence only, professional experience a month-precision range, `noMatch` for the unsupported roles → approve the top recommendation → save selection revision 1 → **kill and restart the API** → identical recommendations, decision and selection; unauthenticated request 401. A second run of the same script on a fresh upload showed the approval of `iam-analyst` return to `PROPOSED` because the approved evidence changed (stale decision, correct). The dev database now also holds these synthetic uploads (gitignored storage); it is safe to delete.

### Full suite and flake diagnostics (not "green" except where stated)

See the table in `docs/KNOWN_FLAKES.md` (seventh entry) for every run with its flags. Summary:

- Serialized (`--poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`): **113 files / 1,297 tests passed, twice** (173 s, 183 s).
- Default parallelism (about 15 workers): **not reliably green.** 1 of the last 2 runs fully green (d9, 1,297/1,297); the 7 other default runs had 1 to 23 failures, all `connect ETIMEDOUT 127.0.0.1:<port>` / 5 s-timeout / unreachable-preview class (often a restart-connect stall cascading through a file), plus the pre-existing `browser-search`, `dashboard`, `offline-e2e` and `packet` flakes. Each failing file passed alone.
- Root cause for the loopback class was reproduced **without any project code** (plain Node loopback shows `ETIMEDOUT` and 19 s connect stalls on this machine); one real project defect was found and fixed (two UI test files building the same `web/dist` concurrently). Details and the run table: `docs/KNOWN_FLAKES.md`, seventh entry.
- Residual nondeterminism: loopback connects under parallel load. Not fixed; logged.

## Decision notes

**D1. Rules and data, not a model, for role evidence.** Problem: map approved facts to roles with provenance. Alternatives: reuse `proposeLane` (embedding similarity over a *job*, wrong direction and not evidence), an LLM, or deterministic whole-word matching against editable requirements. Choice: deterministic matching; each match names the fact, the term and whether it demonstrates or merely mentions. Limit: vocabulary-bound (a synonym not in the catalog is not matched; add terms by editing the role). Acceptance: the 14-case oracle; rollback: edit or deactivate a role.
**D2. Recommendations are derived and refreshed on read.** `GET /recommendations` recomputes under an advisory lock and stores the result. Alternative: a separate refresh endpoint. A GET that writes derived data is idempotent and keeps the UI honest after any fact change; it never touches facts, decisions or selections. Reversal: add an explicit refresh and make GET read-only.
**D3. Decisions bind to an evidence digest, not a profile revision number.** A new profile revision for an unrelated fact would otherwise discard every decision. Digest of role definition + sources + matches + gaps changes exactly when the support changes.
**D4. No project/skill years, ever.** Skill mentions and projects are counts only; this is enforced in the pure function and tested.
**D5. Missing end date is unknown.** The S1 parser omits `endDate` when a range has no end and is not "present"; counting it to today would invent time, so it is reported instead.
**D6. Suggested search band is advice.** Derived from the *lower bound* of approved professional months, capped at 5; text states it is not a claim.

## Limitations and risks

- Parser output quality on real resumes is still unmeasured (S1 caveat). The parser sets no `professional` classification and no detail text, so on real resumes most role evidence will be job titles and skill mentions, i.e. mostly PARTIAL, until a person classifies jobs and adds detail. That is the intended conservative behaviour, but it will feel sparse.
- The vocabulary is a first draft written for this task, not validated against real postings. Synonyms outside it are invisible. Terms such as `triage` or `firewall` are broad.
- Part-time vs full-time is not modelled. Duplicate uploads of the same job produce an overlap warning, and approving extra duplicate facts changes a role's evidence and therefore returns its approval to "proposed" (stale decision) even though nothing materially changed.
- The catalog edit API has no UI. Single-user local model: any signed-in session may edit the catalog.
- `semgrep`/`pip-audit` are not installed here; no SAST was run. CI skips the DB/Python/browser suites (no `infra/.env`); the pure S2 suites do run in CI.
- Loopback connect failures on this machine (see flakes) make the DB-backed and browser suites non-deterministic under parallel load.

## Changed files (S2 only; S1 files are listed in `s1-resume-upload-review.md`)

New: `db/migrations/0002_s2_roles.sql`, `db/migrations/down/0002_s2_roles.down.sql`, `src/roles/{catalog,seed,experience,recommend,errors}.ts`, `src/db/roles-repo.ts`, `src/db/roles-seed-cli.ts`, `src/api/roles-routes.ts`, `web/src/pages/roles.astro`, `tests/roles/{experience,recommend}.test.ts`, `tests/roles/helpers.ts`, `tests/roles/fixtures/role_cases.json`, `tests/api/s2-api.test.ts`, `tests/e2e/offline/s2-ui.e2e.test.ts`, `tests/helpers/web-build.ts`, `docs/evidence/s2-role-recommendations.md`.
Modified (S1 files touched again): `src/api/server.ts`, `src/db/candidate-repo.ts` (`pool` made readable), `src/db/pool.ts` (`idleTimeoutMs`), `web/src/pages/review.astro`, `web/src/layouts/Base.astro`, `tests/helpers/s1-harness.ts`, `tests/e2e/offline/s1-ui.e2e.test.ts` (shared, locked web build), `package.json` (`roles:seed`), `.gitignore`, `infra/README.md`, `docs/KNOWN_FLAKES.md`, `docs/STATUS.md`.

## S3 entry criteria and blockers

S3 (discovery) may start when: (1) the owner has run one or two real resumes through the UI and judged the proposed facts and the first role suggestions usable; (2) at least one role is APPROVED or explicitly selected on the real profile (S3 reads the saved selection, not suggestions); (3) the owner decides whether the sparse-evidence behaviour (above) is acceptable or wants detail entry to be easier; (4) the loopback flake policy is decided (serialize browser/DB files, `SDLC-T06`) so S3 tests can be trusted; (5) an exporter decision for feeding approved Postgres facts to the legacy pipeline (carried over from S1). Blockers: none in code; items 1–5 are owner decisions.

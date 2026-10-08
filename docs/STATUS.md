# Status

Last updated: 2026-10-09. Branch `careerops-integration`. Nothing here is merged to `master`.

> Public-repository note: this file records redacted summaries only. Candidate facts, answers, resume content, immigration or eligibility details, target-employer selections, application identifiers and the hashes of private files live under the gitignored `private-runtime/` and are deliberately not described here.

## V1 status summary (2026-10-09)

**V1 is not complete.** No live application form has been filled or uploaded, and no application has been submitted (submit count is zero everywhere). The end-to-end path is proven only against a headed localhost fixture with synthetic facts.

What exists and is covered by tests:

- `npm run pipeline` orchestrates one bounded job: headed search or a saved job, canonical JD persistence, local MiniLM lane proposal (prototype similarity, a ranking signal only), configured semantic extraction (fixture provider or local Ollama adapter), production StructuredJob validation, approved-fact retrieval, deterministic decision, a source-mapped job-specific PDF, and a supported labeled-form inspection/fill path. `npm run pipeline:offline` runs all of it against a headed loopback search/ATS fixture with synthetic approved facts, temporary storage and a real multipart upload endpoint (upload hash, failed-upload recovery, idempotent rerun, one application record, zero submits). It reads no private file.
- The protected employment identity (employer, title, dates) in every job-specific resume is taken from the approved profile's own employment facts and checked against each canonical lane resume; nothing candidate-specific is hard-coded.
- A coverage review authorizes `ELIGIBLE` only when it is bound to the job ID, the exact structured-extraction ID and a digest of the validated extraction, plus the JD hash. Legacy unbound reviews are treated as unreviewed.
- Local extraction: section-aware source inventory and compact annotations with the unchanged production validator. On one saved reference JD, cold runs took 11.7-13.5 s (two requests, zero repairs, 1,138 input / 469 output tokens, Ollama `qwen2.5:3b-instruct-q4_K_M` Q4_K_M, 8,192/2,048 context/output), against a 91.6 s baseline for the earlier revision. Peak sampled GPU memory was 2,339 MiB of 4,096 MiB; the model is unloaded after extraction. These are six-run observations on one JD, not a p95 and not parser admission. Comparisons were authored in-task and are not an independent human attestation.
- `npm run tracker` (xlsx projection, never authoritative; ENTRY_SIGNAL column), `npm run boards:discover` (public Greenhouse/Lever board APIs for a candidate-supplied company list), `npm run dashboard` (read-only loopback page) and an append-only redacted run-event log (`private-runtime/run-events.jsonl`). See `docs/DASHBOARD.md`.

Not achieved: autonomous parser admission (no reviewed dataset or independent evaluation); independent human coverage attestation on any real job; a real candidate decision of `ELIGIBLE`; any live ATS form fill or upload; verification of the sensitive and contact answers a real form requires (they remain pending candidate review and are never inferred).

Verification: see the Verification log section at the end of this summary block (filled in on integration).



## V1 (working vertical slice) progress

| Slice | Scope | State |
|---|---|---|
| 0 | Read-only audit | Done (in conversation; no document) |
| 1 | Real headed discovery proof | **Done for one target (Figma / Greenhouse).** Evidence: `docs/evidence/v1-slice1-discovery-proof.md` |
| 1.1 | Protect authoritative job persistence | **Done.** See section below |
| 3 | Approved candidate facts and evidence-based decision | **Engine and approved profile available; real-job decision pending validated live extraction and independent JD coverage review.** Evidence: `docs/evidence/v1-slice3-decision.md` |
| search demo | Visible-browser search discovery (Stripe) | **Done**, live-verified. Evidence: `docs/evidence/search-demo-stripe.md` |
| 2 | Structured JD contract + provider validation | **Contract, validator, fixture provider and local Ollama adapter implemented; coverage/interpretation and autonomous parser admission remain PENDING.** Evidence: `docs/evidence/v1-slice2-structured-jd.md` |
| 4 | ResumePlan and rendering | **Source-mapped PDF plan/rendering implemented and offline-verified; no real-job plan until extraction and lane review pass.** |
| 5-6 | ATS form path and readiness | **One supported local Greenhouse-style path implemented; offline fill/reconciliation verified. No live application form opened for filling or submitted.** |

V2-V5 are untouched.

## What works now (Slice 1)

`npm run discover -- --source company-careers --company <Name> --registry <registry.json> --profile <p> --limit <n> --data-dir <dir>` launches the owned headed Chrome (dedicated persistent profile), discovers a board, resolves each distinct listing, and persists **only** postings that pass the canonical gate (`src/domain/canonical-job.ts`):

- official employer identity from parsed URLs + the registry's board for that company (a company domain inside a URL is never enough);
- a real JD (not empty, not a placeholder, >= 200 chars / 30 words);
- additive canonical fields: `schemaVersion`, `jdContentHash`, `extractedAt`, `resolutionStatus`, `sourceObservations` (observed URL, final URL, time, `ats-api` or `browser-dom`), `atsIdentity` (`greenhouse:<board>:<jobId>`).

Rejections become typed failures in `<data-dir>/job-failures.jsonl` (`POSTING_UNRESOLVED`, `JD_EXTRACTION_FAILED`; stage, run id, target URL, retryability, short safe detail; never the JD body). Successful resolutions are saved incrementally (fsync + atomic rename). Distinct requisitions never merge; the same job re-seen merges and keeps its first-seen time. The owned Chrome is closed in `finally`, verified live.

## Verification log (2026-10-07)

| Check | Command | Result |
|---|---|---|
| Baseline before changes | `npx vitest run` | 55 files, **530 passed** |
| Baseline types | `npx tsc --noEmit` | clean |
| After Slice 1 | `npx vitest run` | 61 files, **588 passed**, 0 failed |
| After Slice 1.1 | `npx vitest run` | 62 files, **610 passed**, 0 failed (22 new: 18 `job-store`, 4 orchestrator store-failure tests; 1 old test rewritten) |
| After Slice 1.1 | `npx tsc --noEmit` | clean |
| Slice 1.1 live re-run | `discover ... --reset-checkpoint` on `data/slice1-proof` | 0 unresolved, 2 duplicates merged, 2 records, 0 owned Chrome processes after |
| After Slice 2 | `npx vitest run` | 64 files, **704 passed**, 0 failed (94 new: 69 `structured-job`, 25 `parse-job`) |
| After Slice 2 | `npx tsc --noEmit` | clean |
| After search demo | `npx vitest run` | 66 files, **733 passed**, 0 failed (+29: 11 browser E2E, 18 search-input/CLI) |
| After shortlist iteration | `npx vitest run` | 67 files, **760 passed**, 0 failed (+27) |
| After search demo | `npx tsc --noEmit` | clean |
| After Slice 3 | `npx vitest run` | 71 files, **834 passed**, 0 failed (+74: 41 evaluate, 8 decide CLI, 13 profile, 12 resume import) |
| Slice 3 demonstration | `npm run decide ...` on the saved Figma JD | REVIEW (synthetic candidate; real pending facts also REVIEW) |
| Slice 2 demonstration | `npm run parse-jd ...` on the saved Figma JD | ACCEPTED, MANUAL_ANNOTATION / FIXTURE_PROVIDER only |
| Live success + dedupe + failure | see evidence file | pass (Figma / Greenhouse only) |

Intentional change to an existing test: `tests/discovery/orchestrator.test.ts` "is deterministic and idempotent" used to assert `jobsWritten > 0` for a fixture whose only product was an unverifiable placeholder (`Acme @ example.invalid`). That placeholder is now correctly rejected, so the test resolves a verified Greenhouse-shaped posting through the real resolver; its idempotency assertions are unchanged, and a new test pins that the placeholder becomes a typed failure instead. No assertion was weakened.

Test layers used: unit (`tests/domain`, `tests/dedup/deduplicator-identity`), integration with temp real storage and the real resolver (`tests/discovery/orchestrator-canonical`, `tests/resolver/posting-resolver-canonical`), live (manual, not in `npm test`). Substituted boundaries are listed at the top of each file; no offline browser E2E against a loopback server exists yet.

## Slice 1.1 — authoritative job persistence (2026-10-07)

Verified failure mechanism (source, before the change): `loadJobs` (`src/storage/jsonl-store.ts`) caught `JSON.parse` errors, logged "Skipping malformed JSONL line" and dropped the record; `saveJobs` then rewrote the file from that list, so one bad line (or a cut-off final line) was erased on the next save. Every production read-modify-write used a stale baseline with no lock: `runDiscover` (`src/discovery/orchestrator.ts`, incremental + final save), `runHunt` CareerOps branch (`src/hunt/run-hunt.ts`), `runCollect` (`src/runner/source-runner.ts`). A negative control (two real processes, unlocked load+save, 40 appends each) kept 45 of 80 updates.

Now (`src/storage/job-store.ts`, re-exported from `jsonl-store.ts`):

- `loadJobs` is strict: a malformed record throws `JobStoreError` `CORRUPT_RECORD`; an unterminated, unparseable last line throws `INCOMPLETE_TRAILING_RECORD`. Diagnostics are file, 1-based line numbers, counts and byte length only, never record content.
- `saveJobs` / `updateJobs` refuse to replace a store they cannot read, so the original bytes are preserved. Replacement = unique temp file, fsync, rename (bounded retry on Windows EPERM/EBUSY/EACCES); on any failure before the rename the temp file is removed and the old file is untouched (`WRITE_FAILED`).
- `updateJobs(path, fn)` = lock, strict read of the CURRENT file, `fn`, atomic replace, release (also on exceptions). The lock is an exclusive-create `jobs.jsonl.lock` holding `{pid, host, token, acquiredAt}`; acquisition is bounded (default 10 s, `LOCK_TIMEOUT`, store untouched); release verifies the token and never removes another writer's lock (`LOCK_LOST`).
- Abandoned-lock policy: removed only if same host AND owner pid not alive (or the lock body is unreadable and older than 10 s). A live owner, another host, or a young unreadable lock is never removed; the caller times out and the error names the owner pid and age. Removal renames to a token-named file and re-checks the token, restoring the lock if a new owner raced in.
- Orchestration: `runDiscover` strict-reads the store before launching Chrome (a corrupt store blocks the run with the file untouched), every save is a locked `updateJobs` merge over the current file (a concurrent writer's acknowledged update is merged, not overwritten), a storage error rejects the run (Chrome still closed in `finally`, no success counters), and discovery checkpoints are marked `completed` only after the final store write succeeded.

Guarantees on the supported environment (Windows 11 / NTFS, local disk): all-or-nothing file replacement as seen by readers; fsync of the temp file before rename. Not guaranteed: durability of the directory entry after rename (Node cannot fsync a directory on Windows), locking across hosts or network shares, protection from a process that bypasses `job-store.ts`, PID-reuse corner cases (a dead owner whose pid was reused looks alive, which fails safe by waiting and timing out). Leftover `*.tmp` files from a hard kill are not auto-cleaned.

Decision note: existing implementation = none (no lock anywhere; `launcher.ts` lock handling is Chrome-specific). Alternatives: (a) `proper-lockfile` (new dependency, mkdir + mtime heartbeat; staleness by time can steal a slow live writer's lock); (b) SQLite (out of scope, large migration); (c) chosen: ~100 lines, zero dependencies, exclusive-create with owner token and pid-liveness staleness (never time-only). Tradeoff: own code to maintain and no heartbeat, so a live-but-hung writer blocks others until the 10 s timeout fails loudly. Reversal: callers revert to `loadJobs` + `saveJobs`, which still refuse corrupt stores.

Intentional change to an existing test: `tests/storage/jsonl-store.test.ts` "skips malformed lines instead of crashing" asserted the bug; it now asserts `CORRUPT_RECORD`.

## Slice 3: candidate facts and decisions (2026-10-07)

`npm run decide -- --data-dir <dir> --job <id|atsIdentity> --profile <candidate-profile.json> [--review <extraction-review.json>]` turns one saved job + its validated StructuredJob (same JD revision) + approved candidate facts into ELIGIBLE / REJECT / REVIEW with per-criterion JD evidence and fact ids, stored in `<dir>/decisions.jsonl`. Title targeting is not an input; sponsorship statements are recorded, never used to reject; sensitive answers need explicit approved facts; years are overlap-safe and never inferred from a skill mention; ELIGIBLE needs a named reviewer's attestation that the extraction covers the JD. `npm run candidate:import -- --resumes-dir <dir>` writes a reviewable file of PENDING facts from `Resume*.docx` (128 facts from the four real resumes, all pending, in gitignored `private-runtime/`). Template: `config/candidate-profile.template.json`. Evidence, policy, the review steps and one demonstrated decision (SYNTHETIC_CANDIDATE + MANUAL_ANNOTATION -> REVIEW): `docs/evidence/v1-slice3-decision.md`. Verification: 71 files / 834 passed, `tsc` clean.

## Search demo iteration 2: shortlist and clean text (2026-10-07)

Result titles are classified MATCH / REVIEW / NO_MATCH against `config/roles.yml` before anything is opened (`src/discovery/title-targeting.ts`); only MATCH results (REVIEW only with `selection.openReview`) are opened, up to `maxJobs`; a shortlist with the exact rule, reason and opened/extracted/saved flags is printed and written to `<data-dir>/search-shortlist.json`. Page chrome (breadcrumb, nav, facts sidebar, buttons, Apply links, duplicate title heading) is removed from the DOM before the description is read; text, hash and HTML are consistent and `rawMetadata.extractionStrategy` records how. Company-hosted numeric URL ids no longer imply a Greenhouse identity: a configured `listingIdPattern` plus confirmation on the employer's registered board is required. Evidence: `docs/evidence/search-shortlist-stripe.md`. Verification: 67 files / 760 passed (18 headed-Chrome E2E, 15 title-targeting, 23 input/identity), `tsc` clean; live Stripe run and repeat verified.

## Headed-browser search demo (2026-10-07)

`npm run search -- --input config/job-search-inputs.example.json --data-dir data/search-demo --evidence-dir data/search-demo/evidence` opens a visible Chrome on Stripe's official careers search, types each query key by key into the real search field, runs the search through the page's own control, waits for the result list to change (or the page's own empty state), opens a real result and saves the posting extracted from the rendered DOM (`extractionMethod: "browser-dom"`) through the canonical gate and the protected `updateJobs` store. Core: `src/discovery/browser-search.ts` (`runSearchDiscovery`); CLI `src/discovery/search-cli.ts`; input schema `src/config/search-input.ts` (company, https careers URL, queries, maxJobs, optional observed selectors; the careers host must belong to the registry employer or its board). Typed failures (`DISCOVERY_FAILED`: `SEARCH_CONTROL_NOT_FOUND`, `SEARCH_NO_RESPONSE`, `NAVIGATION_FAILED`; plus the existing JD failures) go to `<data-dir>/job-failures.jsonl`.

Verification: 11 offline browser E2E tests (`tests/e2e/offline/browser-search.e2e.test.ts`: real headed Chrome through the production launcher, loopback fixture site, non-loopback requests aborted and counted), 18 unit tests (`tests/config/search-input.test.ts`), full suite 66 files / 733 passed, `tsc` clean. Live run and repeat on Stripe: see the evidence file. Not exercised live: verification pauses, other sites.

## Slice 2 — structured JD contracts (2026-10-07)

`src/domain/structured-job.ts` defines `StructuredJob` and the production validator; `src/semantic/` holds the provider interface, the stored-output fixture provider and `parseCanonicalJob`; accepted results go to `<data-dir>/structured-jobs.jsonl` (same lock/atomic/strict-read protections as `jobs.jsonl`), rejections to `<data-dir>/structured-failures.jsonl` as `SEMANTIC_PARSE_FAILED`.

Entry point: `npm run parse-jd -- --data-dir <dir> --job <job id | atsIdentity> --fixtures <fixture.json>` (reads `jobs.jsonl`, never writes it).

Achieved: strict proposal schema with trusted binding of job id, JD hash, parser version and provider revision; exact UTF-16 evidence validation (no normalization, surrogate-safe); OR groups and mixed AND/OR; required/preferred; role-years vs tool-years; unknown (never false) clearance/sponsorship/citizenship/work authorization; whole-proposal rejection with no partial result and no downstream mutation; safe diagnostics.

NOT achieved (pending gate): any autonomous parser. No model, prompt, labelled set, held-out benchmark or live inference exists. The only real-document result is a hand annotation passed through the fixture provider (`MANUAL_ANNOTATION` / `FIXTURE_PROVIDER`); it proves the contract works on a real saved document, not extraction accuracy. Details and limits: `docs/evidence/v1-slice2-structured-jd.md`.

## Known gaps and risks

- Only one live target. Lever, company-hosted `gh_jid` pages, Workday and the browser-DOM extraction path are fixture-tested only.
- `discovered-jobs.jsonl` is append-only and gets duplicate lines on every re-discovery.
- Verification pause waits on stdin with no timeout (deferred).
- `discovered-jobs.jsonl` and `job-failures.jsonl` are plain appends without lock or corruption checks (deferred; not authoritative).
- `data/checkpoints.json` is still written without a lock.
- `docs/ard/00-SHARED-CONTRACTS.md` is referenced by the ARD pack but absent in both `docs/ard` folders. Failure category names were taken from the V1 ARD.
- `docs/ard/` exists only in the parent checkout (untracked there); it is not copied into this branch.
- `StructuredJob.jdHash` is bound from `JobPosting.jdContentHash` (naming differs from `docs/ard/00-SHARED-CONTRACTS.md`, which uses `jdHash` for the canonical job). Reconcile when the canonical schema is next versioned.
- The structured schema has no slot for conditional preferences ("if the latter, some security experience is preferred") or nested boolean expressions; add behind a schema version when a consumer needs them.
- `docs/ard/00-SHARED-CONTRACTS.md` was present in the parent checkout at Slice 2 time; earlier notes saying it was absent are superseded.
- Dedupe tiers 3-4 (company+title+location, description fingerprint) still join postings that have no `atsIdentity`; they cannot override a conflicting identity.

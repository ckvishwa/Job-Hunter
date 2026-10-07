# Status

Last updated: 2026-10-07. Branch `careerops-integration` (worktree `.claude/worktrees/universal-job-discovery`). Nothing here is pushed or merged to `master`.

## V1 (working vertical slice) progress

| Slice | Scope | State |
|---|---|---|
| 0 | Read-only audit | Done (in conversation; no document) |
| 1 | Real headed discovery proof | **Done for one target (Figma / Greenhouse).** Evidence: `docs/evidence/v1-slice1-discovery-proof.md` |
| 1.1 | Protect authoritative job persistence | **Done.** See section below |
| 2 | Structured JD contract + provider validation | **Contract, validator, fixture-provider wiring done; autonomous parser gate PENDING.** Evidence: `docs/evidence/v1-slice2-structured-jd.md` |
| 3-6 | Candidate facts, ResumePlan, ATS form path, readiness | Not started (Slice 3 next, see `docs/NEXT_TASKS.md`) |

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

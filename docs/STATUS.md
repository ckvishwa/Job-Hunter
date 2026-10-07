# Status

Last updated: 2026-10-07. Branch `careerops-integration` (worktree `.claude/worktrees/universal-job-discovery`). Nothing here is pushed or merged to `master`.

## V1 (working vertical slice) progress

| Slice | Scope | State |
|---|---|---|
| 0 | Read-only audit | Done (in conversation; no document) |
| 1 | Real headed discovery proof | **Done for one target (Figma / Greenhouse).** Evidence: `docs/evidence/v1-slice1-discovery-proof.md` |
| 2 | Structured JD contract + provider validation | Not started — see `docs/NEXT_TASKS.md` |
| 3-6 | Candidate facts, ResumePlan, ATS form path, readiness | Not started |

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
| After changes | `npx vitest run` | 61 files, **588 passed**, 0 failed |
| After changes | `npx tsc --noEmit` | clean |
| Live success + dedupe + failure | see evidence file | pass (Figma / Greenhouse only) |

Intentional change to an existing test: `tests/discovery/orchestrator.test.ts` "is deterministic and idempotent" used to assert `jobsWritten > 0` for a fixture whose only product was an unverifiable placeholder (`Acme @ example.invalid`). That placeholder is now correctly rejected, so the test resolves a verified Greenhouse-shaped posting through the real resolver; its idempotency assertions are unchanged, and a new test pins that the placeholder becomes a typed failure instead. No assertion was weakened.

Test layers used: unit (`tests/domain`, `tests/dedup/deduplicator-identity`), integration with temp real storage and the real resolver (`tests/discovery/orchestrator-canonical`, `tests/resolver/posting-resolver-canonical`), live (manual, not in `npm test`). Substituted boundaries are listed at the top of each file; no offline browser E2E against a loopback server exists yet.

## Known gaps and risks

- Only one live target. Lever, company-hosted `gh_jid` pages, Workday and the browser-DOM extraction path are fixture-tested only.
- `discovered-jobs.jsonl` is append-only and gets duplicate lines on every re-discovery.
- `loadJobs` drops a malformed line on the next save (data loss on mid-file corruption). Unchanged.
- No file lock / single-writer guard; verification pause waits on stdin with no timeout.
- `docs/ard/00-SHARED-CONTRACTS.md` is referenced by the ARD pack but absent in both `docs/ard` folders. Failure category names were taken from the V1 ARD.
- `docs/ard/` exists only in the parent checkout (untracked there); it is not copied into this branch.
- Dedupe tiers 3-4 (company+title+location, description fingerprint) still join postings that have no `atsIdentity`; they cannot override a conflicting identity.

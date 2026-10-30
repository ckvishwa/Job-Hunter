# PRD requirement coverage audit — 2026-10-09 (SDLC-01)

**Scope:** audit of the actual repository against every requirement ID in `docs/product/drafts/PRD-JOB-HUNTER-SAAS.md` (JH-PRD-001 v0.1.0, DRAFT). Read-only inspection of source and tests; no feature was implemented for this audit.
**Checkout:** branch `careerops-integration`, audited at `de07985` (one local commit ahead of `origin/careerops-integration` = `9bc067b`; nothing pushed by this task).
**Automated results at `de07985`:** `npm run typecheck` clean; `npx vitest run` 95 files / 1,049 tests passed, 0 failed (headed-Chrome tests included). These results prove only the exercised behavior at the stated layer.
**Boundaries:** this file records implementation evidence. It does **not** approve the PRD, sign a UAT, or accept any requirement; those remain human decisions (PRD §11, AOS §4). Private candidate data, resumes and `private-runtime/` contents were not opened for this audit.

## Status vocabulary

| Status | Meaning here |
|---|---|
| `EXISTS` | Source exists on the audited SHA **and** automated tests exercise the behavior at the stated layer. Does not mean live-validated, UAT-accepted or released. |
| `PARTIAL` | Some of the requirement's acceptance exists in source/tests; the named gaps remain. |
| `MISSING` | No source, test or process evidence found for the requirement's acceptance. |
| `UNVERIFIED` | Could exist but cannot be confirmed from tracked evidence (needs a human or a private artifact). |

Test layers: **U** unit, **I** integration (real temporary storage), **H** offline headed-Chrome E2E against a loopback fixture. No row below has a live-ATS proof or a human UAT record. "Tests" cite files under `tests/` at the audited SHA. ARD scenario IDs (`V1-E01`…) are **not** used as test names anywhere in the repository, so the mapping is by behavior (see conflict C8 in `2026-10-09-conflicts-and-sdlc-gaps.md`).

## Summary

| | EXISTS | PARTIAL | MISSING | UNVERIFIED | Total |
|---|---|---|---|---|---|
| PRD requirements (`PRD-*`) | 3 | 10 | 8 | 0 | 21 |
| Nonfunctional (`NFR-*`) | 0 | 4 | 3 | 2 | 9 |

By stage: P0 engine (11): 3 EXISTS, 7 PARTIAL, 1 MISSING (`PRD-UAT-001`). P1 hosted alpha (7): 0 EXISTS, 3 PARTIAL (local-only precursors), 4 MISSING. P2/P3 (3): all MISSING (not yet in scope).

## A. P0 — one-candidate V1 engine

| ID | Status | Source evidence | Test evidence (layer) | Remaining gap |
|---|---|---|---|---|
| `PRD-JOB-001` Discover official active jobs | **EXISTS** | `src/domain/canonical-job.ts` (`evaluatePersistable`, `stampResolution`, ATS identity, official-employer check, `JOB_ID_MISSING` for expired/board pages), `src/resolver/posting-resolver.ts`, `src/pipeline/discovery/board-discoverer.ts` (Greenhouse/Lever board APIs), `src/discovery/orchestrator.ts`, `src/discovery/browser-search.ts` | `tests/domain/canonical-job.test.ts` (rejects a different employer's board, a URL that merely contains the domain, an id disagreeing with the ATS) (U); `tests/resolver/posting-resolver-canonical.test.ts` (tracking redirect keeps lineage; wrong board; unregistered board) (I); `tests/discovery/orchestrator-canonical.test.ts` (distinct requisitions; wrong employer; repeat after checkpoint reset dedupes) (I); `tests/e2e/offline/browser-search.e2e.test.ts` (H) | Maps to V1-E03/E04/E05. "Active" is inferred from a resolvable job id and a fetched JD, not an explicit liveness/expiry check. Live proof is historical only (`docs/evidence/v1-slice1-discovery-proof.md`, one target). |
| `PRD-JOB-002` Persist complete versioned JD | **EXISTS** | `src/domain/canonical-job.ts` (`computeJdContentHash`, placeholder/short-JD rejection), `src/storage/job-store.ts` (locked, atomic `jobs.jsonl`), `src/resolver/posting-resolver.ts` (fails closed to `JD_EXTRACTION_FAILED`) | `tests/domain/canonical-job.test.ts` (rejects empty text, resolver placeholder, one-line stub) (U); `tests/resolver/posting-resolver-canonical.test.ts` ("empty/incomplete extraction … never an empty record", "too short") (I); `tests/discovery/orchestrator-canonical.test.ts` (placeholder/empty rejected; JSONL shape) (I); `tests/storage/job-store.test.ts` (U/I) | Maps to V1-E06. A rediscovered DOM-extracted posting now keeps bullet markers (commit `2f58c35`), so its JD hash is a new revision; existing review bindings for it must be re-made. |
| `PRD-JOB-003` Extract grounded requirements | **PARTIAL** | `src/domain/structured-job.ts` (strict schema, exact UTF-16 evidence validation, OR groups, scoped experience, unknown constraints), `src/semantic/` (`parse-job.ts`, `ollama-provider.ts`, `source-coverage.ts`, `compact-annotations.ts`, `source-alternatives.ts`), `src/decision/evaluate.ts` (review bound to job/extraction/digest) | `tests/domain/structured-job.test.ts` (44 tests: OR/AND, fabricated quote, shifted offsets, stale hash, provider-supplied identity rejected) (U); `tests/semantic/*` (9 files) (U/I); `tests/decision/evaluate.test.ts` (legacy/unbound/changed-extraction review rejected) (U) | V1-E07/E09/E15 covered at unit/integration level with fixture or recorded providers. **No autonomous parser is admitted** (no reviewed dataset, no independent evaluation); **no independent human coverage attestation exists for any real JD** (blocks `ELIGIBLE` by design). |
| `PRD-MATCH-001` Deterministic fit/eligibility | **EXISTS** | `src/decision/evaluate.ts` (`evaluateJob`, PASS/FAIL/UNKNOWN rules, no score override, policy/profile digests, staleness) | `tests/decision/evaluate.test.ts` (about 40 tests: pending/expired/conflicting facts, OR groups, role vs tool years, sponsorship recorded but not rejecting, unknown clearance gives REVIEW, preferred gaps never reject, deterministic output); `tests/decision/cli.test.ts` (U/I) | V1-E07/E08 at engine level. Real decisions stay `REVIEW` until approved facts and a coverage review exist (a data gap, not an engine gap). |
| `PRD-FACT-001` Explicit candidate fact approval | **PARTIAL** | `src/domain/candidate-profile.ts` (approval, verification, expiry; sensitive kinds including `legal_name`/`email`/`phone`), `src/candidate/review.ts` + `review-cli.ts` (digest-bound approve/edit/reject, redacted packet), `docs/CANDIDATE-REVIEW.md` | `tests/domain/candidate-profile.test.ts` (U); `tests/candidate/review.test.ts`, `review-cli.test.ts` (approval bound to a digest; an edit invalidates it); `tests/candidate/resume-import.test.ts` | Engine and review CLI exist. Whether the owner has approved the sensitive/contact facts a real form needs is **UNVERIFIED from tracked evidence** and reported elsewhere as pending; nothing may be inferred. |
| `PRD-RESUME-001` Truthful tailored resume | **PARTIAL** | `src/pipeline/resume-plan.ts` (source-mapped plan, rendered PDF, text inspection, plan hash), `src/pipeline/trust.ts` (hash-checked registry/profile; protected employment derived from approved facts) | `tests/pipeline/resume-plan.test.ts`, `tests/pipeline/trust.test.ts` (U); `tests/pipeline/offline-e2e.test.ts` (H: PDF text and hash, protected employment preserved) | V1-E10 rejection of an unapproved bullet is enforced by construction but has no dedicated negative test. **No human approval record for the artifact exists** (PRD requires "human approves it"); no visual-layout assertion beyond text extraction. |
| `PRD-ATS-001` Inspect and safely fill supported ATS | **PARTIAL** | `src/pipeline/application-form.ts` (one labeled Greenhouse-style form: inspect, fill from approved facts, readback, unsupported required control gives `WAITING_FOR_USER`), `src/browser/launcher.ts` (owned headed Chrome, profile-in-use guard) | `tests/pipeline/offline-e2e.test.ts` (H, loopback fixture only); `tests/browser/launcher.test.ts` (U) | **Fixture only; no real ATS form has been inspected and filled.** No Lever form path. Real custom controls and attachment behavior unproven (P0 blocker in `docs/STATUS.md` / `docs/NEXT_TASKS.md`). |
| `PRD-ATS-002` Verify attachment and readiness | **PARTIAL** | `src/pipeline/application-form.ts` (multipart hash echoed by the page, `data-uploaded-sha256` readback, final reconciliation, `WAITING_FOR_USER` on mismatch) | `tests/pipeline/offline-e2e.test.ts` (H: failed upload withheld, healthy upload accepted, upload hash equals artifact hash) | Hash confirmation relies on a fixture page contract; real ATS pages typically expose only a filename (ARD-V1 §7 says record that limitation and require visual confirmation — not implemented). |
| `PRD-SAFE-001` Prevent unapproved external action | **PARTIAL** | `src/pipeline/application-form.ts` (submit and Enter handlers prevented in-page; the adapter never clicks submit; submit-control count reconciled), `src/pipeline/run.ts` (`submitCount: 0`), `src/browser/verification.ts` (pause for human verification, no bypass) | `tests/pipeline/offline-e2e.test.ts` (fixture submit count asserted 0 on all three runs); `tests/verification.test.ts`, `tests/browser/verification.test.ts` (visible challenges still detected; a dormant script is not a challenge) | **No test presses Enter or triggers a generic Next/auto-submit-on-upload** (V1-E13 guard exists in code, unverified by test). No startup policy object (`autoSubmit=false`, empty allowlist, zero cap) — safety is the absence of submit code. Durable pause-and-resume after verification (V1-E12) is not tested. |
| `PRD-RECOVER-001` Recover without duplicates | **PARTIAL** | `src/pipeline/run.ts` (stable `applicationKey`, atomic `saveApplicationRecord`, `readReadyApplicationRecord` reuse), `src/storage/job-store.ts` (lock, atomic write, incomplete-trailing-record handling), `src/discovery/checkpoints.ts`, `src/browser/launcher.ts` | `tests/pipeline/offline-e2e.test.ts` (rerun reuses the record: one application file, no re-upload); `tests/pipeline/application-record.test.ts` (stale READY refused after a profile change); `tests/storage/job-store.test.ts` (incomplete trailing record preserved and reported; lock recovery) | V1-E02 covered. The **V2 interruption matrix (V2-E03…E20)** — kill/restart after save/render/fill, JD changed after artifact, option-label fingerprint changes, locked workbook, lost upload response — has no tests. (PRD labels this `P0/V2`; see conflict C6.) |
| `PRD-UAT-001` Human acceptance of one real application | **MISSING** | none — no UAT template, store, record or sign-off exists in the repository | none | No named reviewer decision exists for any job. `UAT-01`…`UAT-12` are specified in the traceability file only. Must remain `BLOCKED` until a human signs. |

## B. P1 — private hybrid SaaS alpha (new proposals, not in the original ARDs)

| ID | Status | Closest existing artifact | Gap |
|---|---|---|---|
| `PRD-WEB-001` Private account and dashboard | **PARTIAL** | `src/dashboard/` (read-only loopback page: funnel, run events, board counts, job table); `tests/dashboard/dashboard.test.ts` (loopback bind, 405/403, render in headless Chromium) | Local-only precursor. No accounts, authentication, tenant model, protected routes or per-user data; explicitly not deployable as built. |
| `PRD-WORKER-001` Pair/revoke local worker | **MISSING** | — | No pairing, credentials, worker health/version registry, or revocation. |
| `PRD-QUEUE-001` Reliable scoped dispatch | **MISSING** | — | No cloud task intent, leases, task-ID dedupe or typed allowlisted commands. (Local `applicationKey` idempotency is a reusable primitive.) |
| `PRD-SYNC-001` Data-minimizing status sync | **MISSING** | `src/events/run-events.ts` (structural redaction: no free-text field; `tests/events/run-events.test.ts`) | Reusable redaction pattern only; no sync channel, cloud schema contract, or privacy test over a cloud boundary. |
| `PRD-APPROVAL-001` Version-bound approval UI | **PARTIAL** | Local version binding exists: fact approvals bound to a claim digest (`src/candidate/review.ts`), extraction review bound to job/extraction/digest (`src/decision/evaluate.ts`), READY record bound to JD/profile/decision/artifact hashes (`src/pipeline/run.ts`) | No approval UI; no actor identity or timestamp audit beyond a free-text `reviewer`; no user-visible invalidation workflow; no resume-artifact or form-fingerprint approval. |
| `PRD-OPS-001` Operable service and workers | **PARTIAL** | `src/events/run-events.ts` (run/stage events with run and job IDs, durations, typed errors), typed failure log `job-failures.jsonl`, dashboard activity panel | No worker health/version, queue age, backup/restore, or safe stop; only boards, discovery and the pipeline emit events (LinkedIn, search and `boards:verify` do not). |
| `PRD-RELEASE-001` Controlled release lifecycle | **MISSING** | `package.json` `build`/`typecheck`/`test` scripts only | A CI workflow now exists locally (SDLC-T01, `docs/sdlc/CI.md`; unpushed, unrun on GitHub). Still no release manifest, SHA-to-artifact mapping, staging, human promotion or rollback process (see the gap matrix). |

## C. P2 / P3

| ID | Status | Evidence |
|---|---|---|
| `PRD-TENANT-001` Strong multi-user separation | **MISSING** | No tenant model; no isolation tests. Out of current scope per PRD §4. |
| `PRD-PRIVACY-001` Data lifecycle and user rights | **MISSING** | No retention, deletion or export design and no privacy documentation. (`private-runtime/` is gitignored; that is hygiene, not a data lifecycle.) |
| `PRD-COMM-001` Subscription management | **MISSING** | Deferred (P3); correctly absent. |

## D. Nonfunctional requirements

| ID | Status | Evidence / gap |
|---|---|---|
| `NFR-SEC-001` No cross-tenant access | **MISSING** | No multi-tenant surface exists to test. |
| `NFR-SEC-002` Secrets, cookies, answers excluded from logs/repo/CI | **PARTIAL** | `.gitignore` covers `private-runtime/`, Chrome profiles, `data/*.jsonl` and `.agent-runtime/`; run events are structurally redacted and tested against leaking JD text and emails (`tests/events/run-events.test.ts`, `tests/discovery/orchestrator-canonical.test.ts`, `tests/pipeline/offline-e2e.test.ts`); the offline E2E is fully synthetic. **The repository is public.** Update 2026-10-09 (SDLC-T01, local, unpushed): a gitleaks scan with repository rules, a private-data isolation guard and a dependency-advisory gate exist in `.github/workflows/ci.yml`, `.gitleaks.toml` and `src/ci/` (tests: `tests/ci/ci-gates.test.ts`); verified locally only, **not yet run on GitHub**, so the status stays PARTIAL. |
| `NFR-REL-001` Duplicate delivery cannot repeat an action | **PARTIAL** | Local `applicationKey` plus READY-record reuse (`tests/pipeline/offline-e2e.test.ts`, `application-record.test.ts`). No queue, no action-intent ledger before ATS effects, no replay or fault-injection tests. |
| `NFR-REL-002` Cloud outage does not create false readiness | **MISSING** | No cloud component. |
| `NFR-REL-003` Rollback preserves newer ledger events | **MISSING** | No release/rollback mechanism or backup/restore test. |
| `NFR-OPS-001` Runs and deployments traceable by IDs | **PARTIAL** | Run, job and stage IDs in redacted run events; no tenant, application, worker or release IDs; no deployment record. |
| `NFR-PERF-001` Baselines before SLAs | **PARTIAL** | Extraction latency was measured once and recorded in `docs/STATUS.md` (six runs, one JD, not p95); events carry durations, but nothing aggregates p50/p95 for stages, queue or browser. |
| `NFR-COMP-001` Data/site-access review per rollout | **UNVERIFIED** | No tracked review exists. Related: the unmerged `linkedin-discovery` branch (on hold) contains automation-signal suppression that PRD §4 puts out of scope. |
| `NFR-ACC-001` Core approval flows accessible | **UNVERIFIED** | No accessibility audit or test; no approval UI exists yet. |

## E. Method and limits

1. Source and test paths were found by reading `package.json`, the tree under `src/` and `tests/`, and test titles; behavior was not derived from status summaries.
2. Layers differ: a `U`/`I`/`H` pass is not live-ATS proof, and none of it is UAT.
3. No coverage percentage is reported: the repository has no coverage tooling (`@vitest/coverage-v8` is not installed and no coverage script exists), so coverage is **unmeasured**, not low or high.
4. Historical live evidence (`docs/evidence/*`) was not re-run and is not counted toward any status above.

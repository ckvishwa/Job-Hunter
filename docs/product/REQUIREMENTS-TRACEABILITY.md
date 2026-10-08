# Job Hunter — Product-to-Architecture Traceability Matrix

**Version:** 0.1.0 / PROPOSED  
**Date:** 2026-10-08  
**PRD:** [`PRD-JOB-HUNTER-SAAS.md`](PRD-JOB-HUNTER-SAAS.md)  
**SaaS architecture:** [`../architecture/SAAS-SYSTEM-ARCHITECTURE.md`](../architecture/SAAS-SYSTEM-ARCHITECTURE.md)  
**Execution/UAT policy:** [`../AGENT-OPERATING-SYSTEM.md`](../AGENT-OPERATING-SYSTEM.md)

> This is a **planned requirement-to-test mapping**, not an implemented-test inventory. A cited ARD scenario ID describes an expected oracle, **not** a claimed passing test. Agents must replace `UNVERIFIED` with an evidence-backed status and exact code/test/CI/UAT references only after inspecting the real checkout. Reported 1,036 passing tests do not prove any specific row below. Never invent test paths, PRs, reviewers or sign-offs.

## Status protocol

- `PROPOSED` — product scope needs owner approval; used for new cloud/SaaS features.
- `UNVERIFIED` — requirement established in current ARDs, but current implementation/evidence not inspected here.
- `IN_PROGRESS` — actual task/PR and work demonstrated; attach ref.
- `IMPLEMENTED` — code exists at SHA, but mandatory evidence or UAT incomplete.
- `VERIFIED` — required technical test(s) passed at immutable SHA with explicit boundary and evidence.
- `ACCEPTED` — all required technical gates and corresponding **human** UAT/sign-off completed for the exact version/job/scope.
- `BLOCKED` — gate fails or approval/evidence missing; describe reason and owner.
- `RELEASED` — `ACCEPTED` plus approved release manifest and production evidence.

Status must not be inferred from a documentation edit. A proposed cloud endpoint is **not** existing source.

**Audit overlay (2026-10-09, SDLC-01):** section A statuses were updated from the first requirement-by-requirement audit of branch `careerops-integration` at `de07985` (`docs/audit/2026-10-09-prd-coverage.md`; `EXISTS/PARTIAL/MISSING/UNVERIFIED` there map to this protocol as described in each row). Sections B–C are unchanged: no hosted-SaaS capability exists. No row is `ACCEPTED` or `RELEASED`; no human UAT has been recorded.

## A. Engine requirement map (existing V1–V5 contracts)

| PRD requirement | Architecture source / contract | Planned verification / negative oracle | UAT owner/scenario | Status at document creation |
|---|---|---|---|---|
| `PRD-JOB-001` | `ARD-V1` §§3–4, 8; shared §2 `CanonicalJob` | `V1-E03`, `V1-E04`, `V1-E05`: distinct requisition, official redirect, wrong-employer rejection | Human `UAT-01` | `VERIFIED` (offline U/I/H at `de07985`; no live or UAT proof; see audit) |
| `PRD-JOB-002` | `ARD-V1` §§3–4, 8; shared §2 `CanonicalJob` | `V1-E06`: placeholder/incomplete JD rejected; correct hash/source lineage | Human `UAT-01`, `UAT-03` | `VERIFIED` (offline U/I at `de07985`; no UAT) |
| `PRD-JOB-003` | `ARD-V1` §§4,6,8; shared §2 `StructuredJob`; `ARD-V3` §§8–10 | `V1-E07`, `V1-E09`, `V1-E15`: OR group, invalid output, prompt injection; reviewed coverage | Human `UAT-03` | `BLOCKED`: engine `IMPLEMENTED`; independent real-JD coverage not reported; no autonomous parser admitted |
| `PRD-MATCH-001` | Shared §2 `Decision`; `ARD-V1` §§4,6,8 | `V1-E07`, `V1-E08`: rule grouping and unknown sponsorship produce review; no score override | Human `UAT-02`, `UAT-05` | `VERIFIED` (offline U at `de07985`; real decisions `REVIEW` pending facts) |
| `PRD-FACT-001` | Shared §2 `CandidateProfile`; `ARD-V1` §§4,7,8 | `V1-E08`, `V1-E10`: sensitive unknown block, unapproved bullet rejected | Human `UAT-04` | `BLOCKED`: engine and review CLI `IMPLEMENTED`; sensitive/contact approvals pending |
| `PRD-RESUME-001` | Shared §2 `ResumePlan`; `ARD-V1` §§4,7,8 | `V1-E10`: source mapping, artifact/text/visual inspection, no invented facts | Human `UAT-06` | `IMPLEMENTED`: no human artifact-approval record; no dedicated V1-E10 negative test |
| `PRD-ATS-001` | Shared §2 `Fields and resolved answers`; `ARD-V1` §§4,7–9; `ARD-V2` §5 | `V1-E12`, `V1-E13`, `V2-E20`: unsupported/CAPTCHA blocks and Enter guard; actual readback | Human `UAT-07`, `UAT-08` | `BLOCKED`: fixture-only adapter `IMPLEMENTED`; real ATS form proof not reported |
| `PRD-ATS-002` | Shared §2 `ResumePlan and artifact`, §3; `ARD-V1` §§7–9 | `V1-E01`, `V1-E11`: multipart hash + attachment state; wrong upload blocks readiness | Human `UAT-09`, `UAT-12` | `BLOCKED`: fixture upload readback `IMPLEMENTED`; real upload/readback unproven |
| `PRD-SAFE-001` | Shared §§1,3,4; `ARD-V1` §§4,7–9; `ARD-V4` separate future gate | `V1-E13`, `V1-E15`: fixture zero submit including Enter, injection; live V1–V3 no submission | Human `UAT-11` | `IMPLEMENTED`: zero-submit asserted in offline E2E; Enter/Next/auto-submit guards untested |
| `PRD-RECOVER-001` | Shared §§2–5; `ARD-V1` §8; `ARD-V2` §§3–4,8–9 | `V1-E02`; V2 interruption matrix, canonical identity, 18/20 supported sample | Human `UAT-10` | `IMPLEMENTED`: V1-E02 verified offline; V2 interruption matrix untested |
| `PRD-UAT-001` | `ARD-V1` §§9,12; Agent Operating System §§4,6,7 | Frozen acceptance scenarios, bound hashes, no fake human signature | Human `UAT-01`–`UAT-12` | `BLOCKED`: no human UAT signed (no UAT record exists in the repository) |

## B. Hybrid SaaS extension map (new proposals, not in original ARDs)

| PRD requirement | Architecture section | Required new verification (proposed IDs) | Human acceptance | Status |
|---|---|---|---|---|
| `PRD-WEB-001` | SaaS §§C,D2,E3,G | `API-AUTH-01`: unauthenticated/private route denied; `WEB-UX-01`: stale statuses disclosed | `UAT-S03` + owner dashboard review | `PROPOSED` |
| `PRD-WORKER-001` | SaaS §§D1,D2,E2 | `PAIR-01`: challenge owner-binding/expiry; `PAIR-02`: revoked worker denied | `UAT-S01`, `UAT-S02` | `PROPOSED` |
| `PRD-QUEUE-001` | SaaS §§E2,E3,G | `QUEUE-01`: retry same task without duplicate effect; `QUEUE-02`: expired lease not treated as failure | `UAT-S04` | `PROPOSED` |
| `PRD-SYNC-001` | SaaS §§D3,E2,G | `PRIV-01`: forbid sensitive payload/log; `SYNC-01`: gapped/repeated events correctly reconciled | `UAT-S06` | `PROPOSED` |
| `PRD-APPROVAL-001` | SaaS §§D2,E4,G | `APPROVAL-01`: mismatched JD/fact/form hash denied; `APPROVAL-02`: unauthorized actor denied | `UAT-S05` | `PROPOSED` |
| `PRD-OPS-001` | SaaS §§F,G,J | `OPS-01`: worker offline/cancel; `OPS-02`: backup/recovery without implicit action | `UAT-S04`, `UAT-S07` | `PROPOSED` |
| `PRD-RELEASE-001` | SaaS §F; Agent Operating System G0–G9 | `RELEASE-01`: failed CI blocks promotion; `RELEASE-02`: restore preserves newer ledger events | `UAT-S07`, `UAT-S08` | `PROPOSED` |
| `PRD-TENANT-001` | SaaS §§D1–D3,G | `TENANT-01`: IDOR, API, queue, DB and object access denied cross-tenant; independent threat review | Beta security/UAT sign-off | `PROPOSED` |
| `PRD-PRIVACY-001` | SaaS §§D3,F,G | `PRIV-02`: deletion/export/retention test; authorized incident access | Beta owner/privacy reviewer | `PROPOSED` |
| `PRD-COMM-001` | P3 scope only, no committed ARD | Payment-provider sandbox and access tests **after** new business PRD/ARD | Commercial approval | `PROPOSED` |

## C. Nonfunctional requirement map

| NFR | Planned evidence | Status |
|---|---|---|
| `NFR-SEC-001` | `TENANT-01`, negative auth/IDOR tests; independent security assessment before external beta | `PROPOSED` |
| `NFR-SEC-002` | `PRIV-01`, secret scan, no real profile/credentials in CI, private log audit | `PROPOSED` |
| `NFR-REL-001` | `QUEUE-01`, `V1-E02`, recovery fixture with before/after local action ledger | `PROPOSED` |
| `NFR-REL-002` | `SYNC-01`, `UAT-S04`, offline test proves blocked/stale state visible | `PROPOSED` |
| `NFR-REL-003` | `RELEASE-02`, `UAT-S07`, durable event preserved on rollback | `PROPOSED` |
| `NFR-OPS-001` | `OPS-01`, trace IDs/shas, redacted operational monitoring | `PROPOSED` |
| `NFR-PERF-001` | Baseline p50/p95 per stage, queue age, memory, model and browser time; thresholds TBD | `PROPOSED` |
| `NFR-COMP-001` | Approved data-flow/retention and source-access review before beta | `PROPOSED` |
| `NFR-ACC-001` | Core approval-flow accessibility tests and human review | `PROPOSED` |

## D. UAT scenarios and safe acceptance oracles

| UAT ID | User-observed pass condition | Evidence and sign-off |
|---|---|---|
| `UAT-01` | Official active listing, correct employer and complete source JD | Reviewer, official URL, raw JD hash/date |
| `UAT-02` | Seniority/location constraints are classified correctly | Extracted clause, review decision |
| `UAT-03` | Required, preferred, OR groups and mandatory restrictions covered | Independent JD coverage attestation bound to JD hash |
| `UAT-04` | Real candidate facts and sensitive answers explicitly approved | Private reviewer decision IDs; never raw secret text in tracked report |
| `UAT-05` | Eligibility matches source-backed evidence and unknowns block | Decision and fact/review version IDs |
| `UAT-06` | Tailored resume correct, readable and truthful | Plan/fact mapping, artifact hash, human content approval |
| `UAT-07` | Real supported ATS control identification is complete | Headed read-only inspection, form fingerprint and blockers |
| `UAT-08` | Authorized fields correctly filled/read back | Redacted evidence, supported control map, user approval |
| `UAT-09` | Correct resume attachment is observed | Artifact hash and visible attachment verification |
| `UAT-10` | Recovery does not create duplicate work or lose critical state | Run/task/application IDs and ledger comparison |
| `UAT-11` | No application submitted; verification/unsupported controls safely pause | Zero external submit; inspect state and exception |
| `UAT-12` | Human accepts the exact prepared application | Named human, timestamp, job/JD/fact/plan/resume/form/release refs |
| `UAT-S01` | Worker pairing requires applicant consent | Account, worker ID, challenge expiry proof |
| `UAT-S02` | Revoked worker cannot receive or execute new cloud tasks | Revocation audit + denied claim |
| `UAT-S03` | Another user cannot view applicant tasks, records or artifacts | Negative cross-tenant evidence (synthetic identities) |
| `UAT-S04` | Cloud/worker outage shows pause, then safe idempotent resume | Reconnect timeline, local action ledger |
| `UAT-S05` | Changed JD/form/fact invalidates affected acceptance | Before/after version and blocked state |
| `UAT-S06` | Routine cloud logs carry no private answers/cookies | Reviewed redacted cloud events and scan results |
| `UAT-S07` | Failed production promotion/rollback preserves newer ledger | Release/rollback manifest and proof |
| `UAT-S08` | Deploy is impossible without recorded human release approval | Staging/release gate negative test |

**Real UAT sign-off format (private evidence store):** `uat_id`, `result=PASS|FAIL|BLOCKED|NOT_RUN`, `user/reviewer_id`, `reviewed_at_utc`, `job_id`, `jd_hash`, `profile_version`, `resume_hash`, `form_fingerprint`, `worker_version`, `release_sha`, `redacted_evidence_refs`, `decision_note`, `approval_scope`. Missing binding fields are allowed only if genuinely inapplicable and explicitly explained; never auto-fill a human decision.

## E. Change impact and enforcement rules

1. New product feature: create `PRD-*` requirement and acceptance first → design/ARD mapping → tests → implementation → actual evidence → human UAT → release.
2. Architecture-only change: identify affected `NFR-*` / PRD requirements and regressions, with ADR, migration/rollback and test evidence.
3. Changed JD/facts/resume/form: invalidate dependent user application approvals per shared contracts; unchanged unrelated reviewed facts need not be discarded.
4. SaaS tenant or data boundary: mark affected security gates `BLOCKED` until independent tests and security review pass, regardless of unrelated unit-test count.
5. Agents update row status **only after verifying** code SHA and exact evidence, and distinguish local CI/E2E/live/UAT proof. A human reviewer alone changes `ACCEPTED` for real applicant/UAT decisions.
6. Release evidence is recorded in tracked redacted release records and restricted private UAT artifacts; do not put real secrets/PII into the PRD, traceability or session handoff.

## F. Evidence ledger template (populate only with real runs)

| Requirement ID | Issue/PR | Verified SHA | Test ID + command | CI link/artifact | UAT decision ref | Owner | Result/date |
|---|---|---|---|---|---|---|---|
| `PRD-JOB-001`, `PRD-JOB-002` | none (no PRs exist) | `de07985` | `npx vitest run` (full suite 95 files / 1,049 tests, all pass); `tests/domain/canonical-job.test.ts`, `tests/resolver/posting-resolver-canonical.test.ts`, `tests/discovery/orchestrator-canonical.test.ts`, `tests/storage/job-store.test.ts` | none (no CI exists) | none | agent audit | `VERIFIED` offline, 2026-10-09 |
| `PRD-MATCH-001` | none | `de07985` | same full run; `tests/decision/evaluate.test.ts`, `tests/decision/cli.test.ts` | none | none | agent audit | `VERIFIED` offline, 2026-10-09 |
| `PRD-RESUME-001`, `PRD-ATS-001`, `PRD-ATS-002`, `PRD-SAFE-001`, `PRD-RECOVER-001` | none | `de07985` | same full run; `tests/pipeline/offline-e2e.test.ts` (headed loopback fixture), `tests/pipeline/trust.test.ts`, `tests/pipeline/application-record.test.ts` | none | none | agent audit | `IMPLEMENTED` (fixture layer only), 2026-10-09 |
| `PRD-UAT-001` | none | — | — | — | **none exists** | human owner | `BLOCKED` |

This table is a placeholder by design. **Do not manufacture implementation evidence from this traceability proposal.**

# V2 Reliable and Recoverable Job Automation

Milestone V2 maps to the earlier V0.2 release. Depends on V1's real readiness proof. Shared contracts remain mandatory. Submission stays disabled.

## 1 What V2 will achieve

Greenhouse and Lever supported variants can run repeatedly, recover from interruptions, pause correctly for unknowns, preserve unique records, and export accurate Excel status. A broken job or company does not end the hunt. The user can see what happened and resume the exact safe checkpoint.

V2 changes operating reliability. It does not claim universal support for every form served by these vendors. The adapter capability registry names the supported controls, page layouts and custom-question patterns.

## 2 Entry gate and scope

Require V1 evidence: one real READY_TO_SUBMIT record, truthful inspected artifact, known candidate facts, duplicate protection, zero submission and audited baseline. If missing, close that V1 gap first.

Required: persistent profile ownership, lifecycle cleanup, bounded retries/timeouts, checkpoint invalidation, typed failures, serialized application ownership, changed-form detection, resume/answer readback, Greenhouse and Lever fixtures, private evidence, deterministic status export and recovery tests. Preserve V1's model/answer/resume boundaries.

Deferred: autonomous submission, Workday hardening, new embedding/reranking infrastructure, training, continuous scheduler, dashboard and outreach.

## 3 Recovery architecture

Use one workflow owner per application key and one Chrome profile owner. The run discovers/resolves jobs into a bounded queue; process browser work at concurrency one initially. Failure isolation records a broken target and moves to the next safe target. Systemic storage/profile failures stop dependent processing.

Checkpoint before/after important stages. Bind the record to JD hash, profile version, policy/parser/template/adapter revisions, artifact hash and form fingerprint. Recovery loads authoritative record, checks versions, opens the current official target, reinspects and resumes the earliest invalid dependent stage.

Do not replay old DOM handles or click sequences. A reopened application may have lost form state, draft or upload. Recover by inspecting and restoring only what is missing. If a user edited a filled value, compare it to approved planned answers and ask for the relevant fact update rather than overwriting silently.

### Recovery table

| Interruption | Resume behavior | What must never happen |
|---|---|---|
| Kill after JD save | Reuse job; continue semantic/decision stage | Rediscover every company unnecessarily |
| Kill after artifact render | Verify hash and plan versions; reuse valid artifact | Regenerate different content without tracking revision |
| Browser crash during fill | Reopen official form and read current controls | Replay stale locators blindly |
| Verification | Pause with target, reason and checkpoint | Retry challenge or bypass verification |
| New candidate fact | Recompute dependent answer/plan validation | Continue with stale sensitive answers |
| Changed JD | Reparse, decide and regenerate dependent plan | Reuse stale fit score and resume |
| Changed custom question | Reinspect/classify and review if uncertain | Reuse same field ID as proof of same meaning |
| Upload response uncertain | Inspect attachment state before another upload | Treat absence of a log as proof the upload failed |
| Storage corrupt/incomplete | Explicit repair path and preserved evidence | Silently skip arbitrary records |

## 4 Storage decision and transactions

First test current JSONL appends, checkpoints, unique keys, partial writes and restart loading. If single-writer durability and uniqueness work, keep it. Add atomic snapshots only when useful. Record durable acknowledgments and clear ordering between event/state update and next browser action.

Choose SQLite if a demonstrated requirement needs transactional application state plus events, uniqueness across competing runs, indexed checkpoint lookup, or migration-safe updates not reliably met by the current mechanism. Do not migrate raw discovery solely for consistency of technology.

A migration must include an idempotent importer, source backups, imported counts, duplicate/conflict report, schema version, independent record comparison and rollback instructions. Do not delete historical JSONL after the first successful import. Avoid dual authoritative writers; identify one source of truth.

## 5 ATS inspection and control mapping

Maintain separate adapter responsibilities for form observation, capability detection, locator resolution, fill/upload action and readiness validation. Do not duplicate candidate answer logic inside adapters. Support actual observed text/email/tel fields, selects, radio groups, checkboxes, upload controls and multi-step forms only when independently verifiable.

Compute a form fingerprint from meaningful questions, required flags, control types, option identities and section ordering. Exclude ephemeral CSS classes, generated IDs and timestamps where they do not identify question meaning. A changed fingerprint triggers fresh classification and planned-answer reconciliation.

Use accessible roles/labels and scoped question containers first. Fuzzy label matching can offer candidate mappings for ordinary text fields, with ambiguity handling. It is not authority for legal, sponsorship, clearance or compensation questions. DOM tree-edit matching is deferred unless stable locator strategies demonstrably fail across recurring variants.

After each fill, read canonical control values. After a step transition, verify expected new section and no unintended submission. For file uploads, confirm intended artifact/filename and available attachment evidence. Unknown mandatory controls produce WAITING_FOR_USER with UNSUPPORTED reason.

## 6 Models and algorithms

Reuse V1's selected structured provider. Add bounded request deadlines, schema versions, recorded errors and extraction cache keyed by exact JD hash/provider/prompt/schema revision. Validate cached outputs again when loading. A cache prevents repeated calls, not current fact review.

No new ML model is necessary to fix a profile lock, corrupted ledger, stale checkpoint or upload error. Deterministic field mappings remain the baseline; semantic fallbacks are collected as proposals for V3 evaluation.

Use typed state-machine transitions, compare-and-update revisions where needed, unique application identity, condition-based waits, bounded read retries and conservative form fingerprints. Proposed read retry budget: at most two retries with short backoff inside a total deadline; values are tunable and must be logged. Do not treat all failures as retryable. In particular, changed questions and verification pause instead of looping.

## 7 Observability and Excel

Every run emits redacted stage events with run/job/application IDs, attempt count, duration, revision and reason. Failure evidence contains safe URL, stage, screenshot/DOM reference and adapter version. Authenticated traces can contain PII or secrets; keep them private and apply explicit retention, rather than committing them as fixtures.

Excel exports derive from authoritative application records. Include discovered/started/applied dates, company/title/location, ATS, URLs, decision/score policy, artifact variant, exact state, last update, failure/review reason, and later outcome fields where present. READY_TO_SUBMIT is not Applied. SUBMISSION_UNKNOWN is not a success.

Write to a temporary workbook and safely replace the export. A locked workbook produces an export failure with preserved previous workbook and intact ledger. A later export rebuilds it. No checkpoint logic depends on Excel cell positions or workbook availability.

## 8 E2E failure injection plan

Extend the shared localhost harness. Use controlled process termination and real temporary storage at known checkpoints. The test controller owns child processes and verifies exit, restart and record state independently. Inject failures at boundaries instead of sleeping until a race happens.

| Test ID | Trigger | Required oracle |
|---|---|---|
| V2-E01 | Supported Greenhouse fixture with custom required questions | Correct readback; readiness; zero submit |
| V2-E02 | Supported Lever fixture with different control conventions | Same canonical answers through adapter-specific controls |
| V2-E03 | Kill after job save; restart | No lost job; no duplicate; correct next stage |
| V2-E04 | Kill after resume render; restart | Same valid artifact hash reused |
| V2-E05 | Kill during form fill; reopen loses draft | Reinspect/rebuild answers; one active record |
| V2-E06 | Browser crashes while waiting for user | Durable reason; restart reconstructs safe checkpoint |
| V2-E07 | Navigation fails twice then succeeds | Bounded attempts; one canonical job; final successful state |
| V2-E08 | Permanent timeout on one company | Categorized failure; next company still processed |
| V2-E09 | Verification appears mid-run | Pause without retries; later resume reinspects |
| V2-E10 | Same profile acquired by second process | PROFILE_IN_USE; no concurrent profile mutation |
| V2-E11 | Two runs claim same application | One owner; unique record; other resumes/skips explicitly |
| V2-E12 | Candidate fact changes after plan | Invalidation and revalidation; stale answer withheld |
| V2-E13 | JD changes after artifact creation | Reparse/decision/plan revisions linked; old artifact not uploaded |
| V2-E14 | Custom option labels/values change | Fingerprint changes; semantic answer re-resolved |
| V2-E15 | Partial trailing JSONL write or interrupted transaction | Explicit recovery; prior acknowledged records preserved |
| V2-E16 | Disk write fails | STORAGE_FAILED; no later consequential browser action |
| V2-E17 | Workbook is locked during export | Existing export/ledger preserved; rebuild later succeeds |
| V2-E18 | Upload succeeds but local response is lost | Attachment inspected; no unbounded retry |
| V2-E19 | User edits an already filled sensitive answer | Conflict surfaced; no silent overwrite/readiness |
| V2-E20 | New page unexpectedly attempts submit | Zero remote action permitted; unsupported variant pause |

Required unit/integration checks include storage migration if added, all legal/illegal transitions, retry categories, fingerprint determinism, profile ownership, export mappings and recovery invalidation. Avoid tests that merely assert helper names or mirror implementation formulas.

## 9 Live operational sample

Use 20 distinct intended, supported eligible attempts across both ATSs, at least five per ATS. Do not submit them automatically. Capture attempts admitted, unknown-fact pauses, verification pauses, unsupported variants, actual errors and readiness separately. Expand the capability registry only after observed controls and fixture evidence justify it.

At least 18 of 20 supported, fact-complete eligible attempts should reach readiness. Report the broader attempt pool and exclusions so this denominator is transparent. All filled sensitive answers must be correct; at least 95 percent of safely resolvable required fields should be correctly auto-filled. Other blocked facts remain visible. Samples are provisional evidence, not proof of universal reliability.

Perform a supervised resume after at least one real pause. Controlled destructive failure injection belongs to local fixtures; do not intentionally corrupt a real user's production store to prove recovery.

## 10 Agent alternatives to evaluate

Compare JSONL with atomic snapshots versus SQLite using actual failures; fixed selectors versus accessible labels/scoped containers; session kept open versus reconstructed drafts; queue isolation versus abort-on-first-error; cached extraction versus redundant model calls; restoring observed page values versus forced re-fill.

Record correctness, code surface, latency and maintenance. Prefer the current reliable path if no measured benefit justifies change. Source evidence can justify replacing a proposed default; it cannot justify removing abstention or duplicate protection.

## 11 Implementation order and release gate

First fix the highest-impact demonstrated V1 failure. Then prove checkpoints/storage, browser/profile ownership, second ATS capability, custom-control readback, structured failures/evidence and Excel export. Implement one bounded task and test its failure modes before proceeding.

Release requires all V1 gates, V2 interruption matrix, unique records, no fabricated answers, no submissions, documented recovery commands, the live sample, accurate Excel status and a successful backup/restore test for authoritative state. Deliver per-ATS capability list, excluded variants, measured field coverage, recovery evidence and next semantic failure to benchmark in V3.

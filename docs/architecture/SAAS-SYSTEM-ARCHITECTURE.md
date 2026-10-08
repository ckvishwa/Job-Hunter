# Job Hunter — Hybrid SaaS System Architecture

**ID:** JH-ARC-001  
**Version:** 0.1.0 / PROPOSED  
**Date:** 2026-10-08  
**Decision:** Hosted modular-monolith control plane + per-user local headed-browser worker.  
**Source of product scope:** [`../product/PRD-JOB-HUNTER-SAAS.md`](../product/PRD-JOB-HUNTER-SAAS.md)  
**Existing technical contracts:** `../ard/00-SHARED-CONTRACTS.md` and V1–V5 ARDs; these retain authority over the application engine.

> This is a **target architecture**. Supplied Job Hunter contracts already describe the single-user discovery/resume/ATS workflow; they do not attest to working SaaS authentication, PostgreSQL, web APIs, tenant isolation or cloud deployment. The named technologies below are recommendations requiring a repository audit, security review and bounded implementation decisions.

## A. Architectural goals and invariants

1. Reuse the existing TypeScript discovery, parser, eligibility, resume, ledger, dashboard and Playwright modules where they pass audit. Avoid replacing working JSONL/Excel with a new database merely because SaaS is planned.
2. One modular backend deployment, one relational database, a durable work queue, one web application and **user-bound local workers**. No Kafka/Kubernetes or independent microservices initially.
3. Never put customer browser cookies, authenticated traces, local legal answers or raw private profile into generic cloud queues/logs. Choose local-first storage for sensitive facts; transmit only what a feature expressly needs and the user permits.
4. Cloud controls scheduling, authorization and user experience; **local deterministic policy guards authorize every actual browser side effect**. A model output, queue payload or Manager Agent cannot bypass a local guard.
5. V1–V3: `autoSubmit=false`, empty allowlist, zero submission cap. No SaaS endpoint can change this. V4 requires a reviewed new policy/authorization system.
6. Application domain `READY_TO_SUBMIT` and deployment `PRODUCTION` are unrelated states. A production release is not a job submission.

## B. Component topology

```text
                       Internet / TLS
+---------------------+        +--------------------------------------+
| User web browser    | <----> | Cloud control plane (modular monolith)|
| dashboard / reviews |        | - Auth + user/tenant authorization    |
+---------------------+        | - Jobs/catalog + status API          |
                               | - Workflow intents / state projection|
                               | - Approval metadata                  |
                               | - Queue/leases + version negotiation |
                               | - Redacted events / metrics          |
                               +--------+-----------------+-----------+
                                        |                 |
                                 +------v-------+  +------v----------+
                                 | PostgreSQL    |  | Private artifact |
                                 | tenant-scoped |  | storage (opt-in) |
                                 +--------------+  +-----------------+
                                        ^
                                     outbound authenticated TLS;
                                     tenant+worker-scoped commands
                                        v
                               +--------------------------------------+
                               | User's LOCAL Job Hunter worker       |
                               | - Pairing and local policy enforcement|
                               | - Exclusive headed Chrome profile    |
                               | - Existing discovery/ATS modules     |
                               | - Local Ollama/other approved models  |
                               | - Private candidate facts + resumes  |
                               | - Durable application action ledger  |
                               | - Idempotent execution + checkpoints |
                               +--------------------------------------+

Separate engineering system: GitHub PR/CI -> release candidate -> staging/UAT
-> human release approval -> controlled SaaS/worker deployment. The Engineering
Manager Agent coordinates *development*, not customer execution.
```

## C. Suggested deployable units and ownership

| Unit | Initial recommended implementation | Owns | Must not own |
|---|---|---|---|
| Web app | Next.js/TypeScript or reuse audited dashboard | Login, jobs, approvals, live-status UX | Chrome sessions, raw sensitive facts by default |
| Control API | TypeScript HTTP service in a modular monolith | Authentication, tenant-scoped job/task API, authorization, event projections | Direct employer-side browser effects |
| Durable store | Managed PostgreSQL | Tenants, users, worker registration, task intents, revisioned approvals and projections | Authoritative local browser action history |
| Queue | Transactional Postgres-backed lease table or proven managed queue | Task IDs, assignment, attempt/deadline and ack/retry | Unchecked free-form agent instructions |
| Local worker | Existing Node.js TypeScript program + controlled worker shell | Browser ownership, facts, trusted decisions, uploads, exact action ledger | Cross-tenant tasks or unapproved submits |
| Model interface | Existing semantic provider, local-first | Interpret text and propose evidence | Eligibility authority or browser command execution |
| Observability | Structured redacted logs/metrics/traces | Detection, service health, troubleshooting | Sensitive answer values/browser state |
| Release system | GitHub Actions + isolated Windows worker test/deploy | CI tests, artifacts, approved environment promotions | Employer application submission |

These are *component boundaries*, not permission to migrate working runtime storage to PostgreSQL in P0. Before introducing a component, create a decision record against existing code and measured need.

## D. Trust boundaries, security and privacy

### D1. Identity and worker pairing

- Applicant authenticates via a vetted identity provider, with server-side route checks. No custom password storage if a managed provider meets requirements.
- User requests **pair worker** in the dashboard and explicitly confirms it on the local machine. Issue a short-lived pairing challenge tied to user, tenant, worker public identity and expiry.
- Exchange pairing challenge for a revocable worker credential with audience and minimal scopes. Encrypt credentials at rest using operating-system-backed secure storage where feasible. Never embed in repo or CI artifacts.
- Local worker establishes outbound TLS connection/poll; cloud should not need an inbound port into the applicant's PC. Revocation terminates future task assignment and is checked by both API and local worker at appropriate boundaries.
- Register worker version, supported capability registry and attested last-seen timestamp. Refuse unsupported schema or policy versions.

### D2. Authorization

- Every web/API/queue lookup is scoped by authenticated `tenant_id`, applicant/user ID and resource ownership. Never trust a tenant ID supplied by the browser without server checks.
- Local worker accepts typed, schema-validated commands from a **small explicit allowlist**. Reject free-form remote command/script execution and unexpected fields.
- Commands carry immutable `task_id`, target candidate/job/JD identity, action class (read or write), approved scope, policy version, expiry and necessary references.
- Consequential ATS operations require a local grant bound to specific job/JD/form/fact/artifact versions, and current visible form reinspection. Default denial on mismatch/expired approval.
- Enforce V1–V3 submit restrictions **in the cloud API, worker task policy, and browser action guards**; defense in depth rather than UI-hidden buttons.

### D3. Data residence and minimization

| Data | Proposed system of record | Cloud handling by default |
|---|---|---|
| Public official job metadata, validated JD and provenance | Cloud catalog after permitted acquisition; existing local raw records remain until migration decision | Allowed with retention/content-rights review |
| User preferences and display name | Cloud tenant database | Minimized and access controlled |
| Approved private employment facts, legal/immigration answers | Local encrypted/private candidate store | Do not sync raw values by default; only status/provenance pointers, or purpose-limited encrypted transfer with consent if genuinely required |
| Browser cookies, authenticated storage, session state | Dedicated local Chrome profile | Never upload |
| Generated resume and private screenshots | Local protected runtime | Only optional explicitly scoped encrypted artifact sharing and time-limited URL with access logs |
| Employer-side action ledger | Local durable append-only events/checkpoints | Send redacted event references/state projection; cloud must not guess missing events |
| Human UAT approval | Human decision recorded against exact hash/version in approval system | Store reviewer identity, timestamp, binding hashes and decision; no agent-signatures |

Beta privacy model requires a formal data-flow inventory, retention/deletion/export design, security incident procedures and user-facing documentation. Do not claim SOC 2, regulatory compliance or end-to-end encryption certifications without independent assessment.

## E. Workflow and synchronization contracts

### E1. Normal happy path (V1 product core)

1. Cloud or local discovery creates verified job observation with employer/ATS identity; persist raw JD and content hash.
2. Local parser proposes requirements with exact evidence. Humans review critical clauses; version review against JD hash.
3. Candidate explicitly approves needed facts locally; deterministic rules decide eligibility.
4. Resume renderer plans from approved fact IDs, writes inspected artifact with SHA-256.
5. Worker acquires unique application key/browser profile lock and records durable intent before opening/writing to supported ATS form.
6. Local worker reobserves controls, resolves only approved answers, fills/uploads if expressly authorized, and reads back.
7. Worker writes authoritative local checkpoint/event, then syncs redacted state and evidence references to cloud.
8. A human performs UAT on the exact job/facts/resume/form. Only valid accepted gates permit `READY_TO_SUBMIT` projection; still zero submit.

### E2. Queue reliability (at-least-once transport, effectively-once effects)

- Cloud enqueues a durable task ID and records tenant, worker/capability, requested operation, source versions and deadline. Unique task identity prevents duplicate task objects.
- Worker claims a lease with expiry and bounded heartbeat; network interruption can redeliver a task. **Assume duplicate delivery**.
- Worker checks the local ledger for `task_id` and unique application key before actions. A completed idempotent read can be replayed; a possibly performed consequential action must be **reconciled**, not blindly retried.
- Store action intent and local revision before any ATS effect, and record observations after. Cloud accepts revisioned events with unique IDs and detects gaps/duplicates; cloud must never manufacture missing local success.
- Conflicting worker sessions or stale leases cause pause/review. One browser profile owner, one authoritative local ledger writer and one active application record owner.
- A task becoming `LEASE_EXPIRED` in cloud does **not** establish that an employer-side action failed. Determine status from local evidence before retry.

### E3. API contracts (illustrative, not existing routes)

| Intent | Example typed endpoint | Required enforcement |
|---|---|---|
| User sees own jobs | `GET /v1/jobs` | Auth + tenant scoping + pagination |
| User reviews required fact status | `GET /v1/reviews/pending` | No secret values unless purpose-required and authorized |
| User approves a review | `POST /v1/reviews/{id}/decision` | Human-authenticated, exact version/hashes, CSRF protections as applicable |
| Enroll/revoke worker | `POST /v1/workers/pair`, `/revoke` | Pairing challenge, expiry, least privilege |
| Worker polls task | `POST /v1/worker/tasks/claim` | Worker scopes, signed identity, supported capability and lease |
| Worker posts redacted events | `POST /v1/worker/events` | Monotonic revisions, schema, ownership, dedupe and bounded payloads |
| Stop requested work | `POST /v1/tasks/{id}/cancel` | Safe cancellation intent; worker acknowledges at controlled boundary |

Exact route names, schemas and technology must be specified in an ADR after auditing existing code. API contracts are versioned; introduce contract tests before separate deployables. Prefer explicit schema/version negotiation for backward compatibility during rolling worker updates.

### E4. Consent and approval invalidation

- Review decision binds to human actor, scope, job ID/JD hash, fact/profile revision and optionally resume artifact hash and ATS form fingerprint.
- New JD content, changed facts, revised resume or changed form triggers **targeted invalidation** of dependent approvals rather than erasing older evidence.
- An approval for one application or legal question never becomes generic authorization for a different employer, question wording or future submission.
- Cloud offline or stale status → show `UNKNOWN`/`PAUSED`; never label `READY_TO_SUBMIT` on a worker heartbeat alone.

## F. SDLC, CI/CD and deployment

**Authoritative workflow:** `docs/AGENT-OPERATING-SYSTEM.md` G0–G9. This addendum only maps gates to the hybrid SaaS units.

| Gate | Control plane | Local worker | Evidence required |
|---|---|---|---|
| G0–G1 Requirements/design | PRD requirement IDs, API/auth/dataflow threat model | Existing V1–V5 contracts, browser/ledger safety | Reviewable design, test strategy, ADR for persistent boundaries |
| G2 Development | Small feature branch/PR, isolated synthetic fixtures | Bounded owned changes; synthetic facts | Diff, local targeted tests |
| G3 CI | Typecheck/lint, API contract tests, auth/tenant negatives, build, dependency/secret checks | Unit/integration + browser safety tests when affected | Green exact-SHA CI evidence |
| G4 E2E | Ephemeral staging API/DB/queue and fixture auth | **Headed** Chrome against localhost ATS fixtures, synthetic profile/ledger | Cross-boundary behavior, zero external ATS traffic and zero submits |
| G5–G6 Staging/UAT | Private authorized staging tenant, release-candidate data | Isolated local staging profile, controlled real-form read-only then permitted preparation | Human acceptance bound to exact release and job artifacts |
| G7 Release approval | Explicit human go/no-go, known defects, rollback | Matching signed/versioned worker package | Approved release manifest |
| G8 Promotion | Controlled API/DB deployment, migration backup | Explicit per-worker update and local backup, no surprise restart mid-form | Smoke, version compatibility, ledger checks |
| G9 Operations | Alerts, incidents, queue age, unauthorized-access audit | Worker health, profile lock, model errors, restart/recovery | Redacted dashboards, recovery and postmortem records |

### Environments and safe CD

- **DEV**: synthetic test users, disposable DB, fixture ATS, private local developer Chrome profile.
- **CI**: synthetic only, isolated ephemeral API/DB and localhost fixtures; never mount real private candidate files or Chrome cookies; browser tests require capable isolated Windows/GUI runner.
- **STAGING/UAT**: isolated cloud tenant + separate local profile/store; authorized real ATS inspection only under written scope, starting read-only; never press submit V1–V3.
- **PROD**: locked-down authenticated API/database plus per-user local worker and protected records; dashboards show observed/reconciled state.
- Pipeline: feature PR → code review + required CI → immutable release candidate artifact/checksums → synthetic staging → authorized UAT → **human approval** → production control plane deploy and explicit worker version rollout → smoke/monitoring.
- Separate version tracks for API/web and local worker, with compatibility matrix. Canary a beta worker release before broad rollout. No silent, forced worker update during an active application session.
- For DB migrations use expand/migrate/contract where necessary; reversible or compatible migration first; never rollback application ledger events over newer employer-side actions.

### Initial deploy platform choices (proposals)

A simple managed web/API host, managed PostgreSQL, cloud HTTPS, and versioned object storage are sufficient at P1; choose vendor by real costs, region, security guarantees and service operation. GitHub Actions can build/test/package. Windows local workers continue to use headed Chrome; do not claim a hosted Linux headless runner meets existing live-browser acceptance. No hardcoded monthly budget without selected provider plans.

## G. Test strategy and explicit UAT

Testing layers are **not interchangeable**:

- **Unit:** policy validators, tenant auth decisions, fact/version/hash guards and typed commands.
- **Integration:** DB transaction/outbox, queue retry/idempotency, approval invalidation, API ↔ worker contract and credential revocation using synthetic data.
- **Offline headed E2E:** real Playwright production entry points against isolated loopback ATS, synthetic documents, external-request denial, recorded upload hash, submit count exactly 0 in V1–V3.
- **Security:** cross-tenant IDOR/permission tests, worker substitution, reused leases, signed/expired command injection, token replay/revocation, private-data logging and accidental external action.
- **Live controlled proof:** official posting and explicitly authorized real ATS variant with privacy-preserving evidence; not an ordinary CI test.
- **Human UAT:** distinct signed decision for real applicant artifacts. Automation may prepare evidence but cannot accept on the user's behalf.

UAT coverage for hybrid alpha adds to the existing 12 V1 scenarios: `UAT-S01` pair legitimate worker, `UAT-S02` deny revoked worker, `UAT-S03` deny other tenant's job, `UAT-S04` offline worker recovery and no duplicate action, `UAT-S05` changed JD invalidates approval, `UAT-S06` no private answers/cookies in cloud logs, `UAT-S07` rollback preserves ledger, `UAT-S08` manual release approval required. See PRD traceability for detailed acceptance links.

**Hard blocker:** If the system cannot safely distinguish a verified browser action from a cloud task acknowledgment, remain blocked; do not fake `READY_TO_SUBMIT`.

## H. Team and operational responsibility

| Function | Initial owner | Distinction |
|---|---|---|
| Product Owner / customer acceptance | Human owner | Only human sets scope and approves facts/UAT |
| Tech lead / architect | Human accountable; architecture agent assists | Accepts code/data boundaries and design decisions |
| Backend/cloud engineering | Developer agent under lead | APIs, auth, persistence, queue, contracts |
| Worker/automation engineering | Developer agent under lead | Chrome/ATS and local safety ledger |
| QA/SDET | Independent reviewer or dedicated test agent | Negative/failure cases, evidence; AI is not human sign-off |
| Security/privacy | Accountable human reviewer, specialist advice | Tenant isolation, data minimization and incident readiness |
| DevOps/SRE | Human operator assisted by release agent | CI, environments, promotion, monitoring and recovery |
| Engineering Manager Agent | Delegation/coordinating function | No customer PII or prod submit permissions |

Do not create eight permanently running agents merely to populate an org chart. Assign exclusive files/resources and explicit evidence-based handoffs.

## I. Architectural decision records to open only when implementing

- **ADR-S01:** Cloud job catalog and status state ownership vs existing local JSONL/Excel; dual-write avoidance.
- **ADR-S02:** Worker pairing/revocation protocol, token lifecycle and secure local storage.
- **ADR-S03:** Minimum data synchronized; consent, retention, encryption and user deletion.
- **ADR-S04:** Queue delivery/leases and local idempotency contract.
- **ADR-S05:** API/web framework and managed database/hosting selection.
- **ADR-S06:** Worker packaging, safe updating, version compatibility, rollback.

Do not pre-approve these details from a speculative architecture diagram. Each decision needs actual source inspection, alternatives, threat model, tests and reversal path.

## J. Implementation slices and go/no-go

| Slice | Goal | Independent acceptance | Advance condition |
|---|---|---|---|
| **S0** | Audit live repo and current V1 blockers | Verified Git, scripts, packages, extant module boundaries and clean tests; no claims from doc names | No hidden privacy exposure or destructive operations |
| **S1** | Establish PRD/architecture authority + CI traceability | PRD review, existing ARD mapping, test matrix, short agent handoff | Human product scope approved |
| **S2** | Finish existing V1 real-job UAT | One truthful verified READY_TO_SUBMIT, no employer submission | Human accepted job/facts/resume/form |
| **S3** | Private alpha cloud API/auth + data model | Tenant/user/workers modeled, protected routes, synthetic authorization and migration tests | No real PII in CI/cloud by default |
| **S4** | Secure worker pairing and durable task protocol | Revocation, duplicate/replay/lease recovery, version negotiation, local deny-by-default | Safety guards verified offline |
| **S5** | Dashboard status and human review UX | Live redacted statuses, stale/offline indication, version-bound approvals | Human UX test + privacy review |
| **S6** | Staging, UAT and production release process | Approved RC, integration/negative/E2E/UAT evidence, rollback with durable ledger | Human go/no-go; no submit |
| **S7** | Invite-only beta hardening (future) | Adversarial tenant isolation, support/privacy incident and deletion/export rehearsals | Separate beta authorization |

**Do not begin S3 production implementation solely because this architecture exists.** The default next executable task is S0/S1 documentation and repository audit, then close S2 V1 trust blockers. Explicitly prioritize current verified P0 risks before broad SaaS infrastructure.

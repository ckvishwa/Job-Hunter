# Job Hunter SaaS — Product Requirements Document (PRD)

**ID:** JH-PRD-001  
**Version:** 0.1.0 — proposed for Product Owner review  
**Date:** 2026-10-08  
**Status:** DRAFT / NOT YET ACCEPTED  
**Product Owner:** Human owner  
**Technical companion:** [`../../architecture/SAAS-SYSTEM-ARCHITECTURE.md`](../../architecture/SAAS-SYSTEM-ARCHITECTURE.md)  
**Execution policy:** [`../AGENT-OPERATING-SYSTEM.md`](../../AGENT-OPERATING-SYSTEM.md)  
**Traceability:** [`REQUIREMENTS-TRACEABILITY.md`](../REQUIREMENTS-TRACEABILITY.md)

> **Source and scope disclosure.** This PRD is an implementation proposal derived from the supplied Job Hunter V1–V5 ARDs, shared contracts, agent operating policy, and the owner's decision to pursue a small hybrid SaaS. The uploaded ARDs primarily specify a **single-candidate** application engine, not a production multi-tenant SaaS. Sections on accounts, pairing, cloud queues, subscriptions, and tenants are **new proposed product requirements**, not features demonstrated in the current repository. Reported baseline (2026-10-08): branch `careerops-integration` pushed through `9bc067b`, 1,036 tests reportedly passed; this document does not verify the live repository.

## 1. Product summary and decisions

**Vision:** A trustworthy job-search companion that finds relevant official listings, explains eligibility, assembles source-backed application materials, and prepares supported ATS applications for the user to inspect—without guessing personal facts or taking unapproved external actions.

**Chosen deployment model:** Web-based SaaS control plane plus an installed **per-user local execution worker** operating authorized headed Chrome and optionally local AI models. The local worker is not an invisible cloud bot. Product workflow orchestration and engineering Manager Agent are separate.

**Rollout stages** (these are not a renaming of the existing V1–V5 ARD milestones):

| Product stage | Users | Purpose | Release prerequisite |
|---|---|---|---|
| P0 — Engine safety | One owner | Finish existing V1: one official real job to human-accepted `READY_TO_SUBMIT`, no submission | All V1 trust, headed-browser and real-form/UAT gates |
| P1 — Private hybrid SaaS alpha | One owner | Hosted dashboard/API, secure worker pairing, reliable status sync, manual release process | P0 safety retained; verified separation of cloud/local trust boundaries |
| P2 — Invite-only multi-user beta | Small approved cohort | Accounts, tenant isolation, user-specific worker enrollment, support and recovery | Independent security review, isolation tests, privacy policy and operational support |
| P3 — Commercial availability | Paying users | Billing, onboarding/support, retention, capacity and service commitments | Beta evidence, legal/privacy review, incident response and reliable delivery |

The product must not skip P0 correctness to build a dashboard or subscriptions. **V1–V3 application submission remains disabled**, even when a cloud account exists. Any V4 submission requires separate explicit product scope, technical gates, scoped human authorization and review.

## 2. Problem statement

Job seekers face fragmented job sources, inconsistent job descriptions, ambiguous experience/eligibility rules, repeated application forms, and the risk of inaccurate resumes or wrong form answers. Existing automation can increase volume while reducing trust. Job Hunter should reduce review effort **without losing the user's control** over facts, applications and sensitive declarations.

### Core jobs to be done

- **Find:** “Show me real, current opportunities that plausibly fit the roles and locations I approve.”
- **Understand:** “Show me why a role matches or does not match, with links to exact requirements.”
- **Approve:** “Ask me to verify employment facts, sensitive answers and uncertain requirements rather than guessing.”
- **Prepare:** “Build a truthful job-specific resume and an inspectable, correctly filled application.”
- **Recover:** “If an agent, browser or computer fails, continue safely without duplicates or unexpected submissions.”
- **Trust:** “Tell me exactly what happened, what remains blocked, and whether anything reached the employer.”

## 3. Customers, actors and responsibilities

| Persona / actor | Goal and privileges | Not permitted |
|---|---|---|
| Applicant (initial and beta) | Own profile, preferences, per-job facts, approval, review and any future explicitly authorized submission | Another applicant's data; implicit approval |
| Human Product Owner / release operator | Product scope, human acceptance and release authorization | Disguise an automated check as a human approval |
| SaaS support operator (beta+) | Restricted operational health and support with auditable authorization | Read private candidate secrets by default; impersonate approval |
| Cloud product orchestrator | Route tenant-scoped work, status and permitted commands | Infer answers, access Chrome cookies or independently submit |
| Local Job Hunter worker | Execute bounded authorized discovery/preparation, store sensitive facts locally, enforce domain safety | Bypass CAPTCHA/detection, submit V1–V3, move data between users |
| Engineering Manager Agent | Coordinate issues, CI, evidence, tasks and releases | Product-customer privileges, UAT signature, release authorization |

## 4. Product scope

### Must-have for the existing V1 engine (P0)

1. Official-source discovery and validated employer/ATS identity, with complete JD and version/hash.
2. Requirements extraction that preserves required/preferred, alternatives, experience scope, clearance, sponsorship, location and uncertainty; human attestation for real JD coverage.
3. Versioned, expressly approved candidate facts; deterministic eligibility and explained `ELIGIBLE` / `REJECT` / `REVIEW` decisions.
4. Truthful source-mapped resume plan and inspected artifact, approved before application use.
5. One proven Greenhouse or Lever headed-browser form variant, observation, authorized filling, resume upload, readback, and safe pause on unsupported controls or verification.
6. A duplicate-safe, checkpointed application ledger with durable `READY_TO_SUBMIT` / `WAITING_FOR_USER` and **zero employer submissions**.
7. Synthetic unit/integration/offline headed-browser tests, controlled live proof, privacy controls and recorded human UAT sign-off.

### Must-have for private hybrid SaaS alpha (P1)

1. Owner login and private web dashboard with job, review and application preparation status.
2. Explicit local worker install/pairing, worker health, revocation, version visibility and offline status.
3. Tenant-scoped cloud API and durable task intent/queue; local worker authenticates over outbound TLS and runs only supported allowlisted commands.
4. Cloud ↔ worker synchronization of **minimum necessary nonsecret metadata**, hashes and redacted events; sensitive local facts/browser state are not copied by default.
5. Human approval UI that binds an approval to a specific user, job/JD version, fact version, resume hash or form revision, as applicable.
6. Reliable behavior when cloud is unavailable, commands repeat or worker restarts; no duplicate ATS actions and no false ready state.
7. Isolated DEV, CI, staging/UAT and production; CI gates, controlled release, audit trails, operational health and safe rollback.
8. Product and security telemetry with retention controls and no secrets or unredacted resumes in routine logs.

### Deferred until invite-only beta (P2)

Public signup, broader tenant onboarding, organization/team accounts, delegated reviewer permissions, support tooling, worker upgrades at scale, customer data export/deletion self-service and audited tenant isolation under realistic adversarial tests.

### Deferred until commercial stage (P3)

Payment processing, subscription plans, customer billing, contractual service levels, public reliability status and support escalation program. Business/price assumptions require separate validation.

### Explicitly out of scope now

Automatic applications or outreach; headless evasion of sites requiring a visible user session; bypassing CAPTCHA or bot defenses; unsupported ATS claims; claiming hiring probabilities from an internal match score; model-generated sensitive facts; storing Chrome session cookies centrally; scraping LinkedIn through evasion code; full Kubernetes/microservice architecture; generic enterprise recruitment ATS functionality.

## 5. Functional requirements and acceptance criteria

Priorities: **P0** required for one-candidate V1, **P1** required for private SaaS alpha, **P2** beta. Every requirement is a product statement; its implementation is independently verified in the traceability matrix. States below are observable acceptance outcomes, not proof of existing code.

| ID | Priority | Requirement | Observable acceptance |
|---|---|---|---|
| PRD-JOB-001 | P0 | Discover official active jobs | Preserve verified official URL, employer, ATS/requisition identity, capture date and content; reject wrong employer/expired destination |
| PRD-JOB-002 | P0 | Persist complete versioned JD | Store raw text and exact JD hash; incomplete JD blocks downstream eligibility |
| PRD-JOB-003 | P0 | Extract grounded requirements | Expose evidence spans, required/preferred, OR groups, scoped experience and critical constraints; flag incomplete coverage |
| PRD-MATCH-001 | P0 | Deterministic fit/eligibility | Show PASS/FAIL/UNKNOWN per hard rule; unknown mandatory fact produces REVIEW, not ELIGIBLE |
| PRD-FACT-001 | P0 | Explicit candidate fact approval | Unapproved, conflicted, stale or sensitive unknown facts cannot populate a resume or required answer |
| PRD-RESUME-001 | P0 | Truthful tailored resume | Every claim maps to an approved fact; render and inspect chosen artifact; human approves it |
| PRD-ATS-001 | P0 | Inspect and safely fill supported ATS | Headed Chrome discovers actual labels/options, resolves facts, fills only supported values and reads fields back |
| PRD-ATS-002 | P0 | Verify attachment and readiness | Expected artifact identity/attachment confirmed where observable; unresolved controls block READY_TO_SUBMIT |
| PRD-SAFE-001 | P0 | Prevent unapproved external action | V1–V3 tests and live run show zero submit; CAPTCHA/unknown controls pause, no evasion |
| PRD-RECOVER-001 | P0/V2 | Recover without duplicates | Same candidate/job identity reuses record; interrupted run resumes after inspecting current state |
| PRD-UAT-001 | P0 | Human acceptance of one real application | Named human reviewer passes job-specific UAT tied to hashes and verified pre-submit state; otherwise BLOCKED |
| PRD-WEB-001 | P1 | Private account and dashboard | User sees only own jobs, approvals, run status, errors and evidence links; protected routes reject unauthenticated access |
| PRD-WORKER-001 | P1 | Pair/revoke local worker | User consents to pairing; cloud cannot operate unpaired/revoked worker; worker reports version/health |
| PRD-QUEUE-001 | P1 | Reliable scoped work dispatch | At-least-once delivery with deduplicated task IDs, leases, authorization checks, safe retries and accurate status |
| PRD-SYNC-001 | P1 | Data-minimizing status sync | Cloud receives only declared fields/redacted events, not local browser cookies or unapproved sensitive facts |
| PRD-APPROVAL-001 | P1 | Version-bound approval UI | Changes to dependent job/fact/resume/form invalidate prior approval as appropriate; approval identity/time auditable |
| PRD-OPS-001 | P1 | Operable service and workers | Health, version, error families, queue age, retries, safe stop, backup/restore and run logs observable |
| PRD-RELEASE-001 | P1 | Controlled release lifecycle | Every deployed build maps to SHA/artifact; tested staging and human UAT precede production approval; rollback protects ledgers |
| PRD-TENANT-001 | P2 | Strong multi-user separation | Cross-tenant API/DB/object storage/queue/worker access fails in automated adversarial tests and independent review |
| PRD-PRIVACY-001 | P2 | Data lifecycle and user rights | Documented collection, retention, deletion/export and incident workflows, reviewed before external beta |
| PRD-COMM-001 | P3 | Account subscription management | Only after validated pricing/business model; payments managed through appropriate provider with bounded privileges |

**Customer-visible failure requirement:** Every attempted run ends in an intelligible state with a reason and safe recovery action; a false `READY_TO_SUBMIT` is a critical defect, never a tolerated partial success.

## 6. User journeys

### Journey A — existing owner, V1

1. Select a target role/search preference; discover official posting.
2. Read original JD and source-mapped requirements; independently attest to critical coverage.
3. Review profile facts and answer sensitive questions explicitly; do not autofill unknowns.
4. See explainable eligibility; when reviewed eligible, approve truthful tailored resume.
5. Initiate headed Chrome pre-submit inspection on an explicitly approved job/form.
6. Review filled controls and attached resume in actual ATS; correct unsupported details manually if needed.
7. Sign UAT only for the verified exact job/JD/fact/resume/form version; persist `READY_TO_SUBMIT` only when technical gates also pass.
8. Application remains **unsubmitted**; the applicant chooses next steps outside V1 automation.

### Journey B — hosted dashboard with local worker, private alpha

1. Sign in; approve pairing a local worker; worker receives revocable, tenant-scoped credentials.
2. Configure allowed tasks and review cloud-issued commands before the local worker permits any consequential action.
3. Worker performs authorized work, preserving local facts/cookies/ledger; cloud shows redacted status and evidence references.
4. If internet, worker, Chrome or API stops, show distinct OFFLINE/PAUSED/REVIEW states; repeat delivery does not repeat external effects.
5. Invalidate affected approvals upon changed source/facts/artifact; preserve history and explain why user must review again.

## 7. UX and accessibility requirements

- Dashboard distinguishes `DISCOVERED`, `REVIEW`, `WAITING_FOR_USER`, `READY_TO_SUBMIT`, `FAILED`, and later-version submission states without conflating them with CI/CD release stages.
- Every eligibility block explains the requirement, source line/quote, missing evidence and next reviewer action.
- Buttons with external effects are explicit and distinct from read-only inspection. V1–V3 have no customer-facing auto-submit command.
- Display worker status, last verified event time and provenance rather than claiming live state on stale data.
- Keyboard and screen-reader operation, clear form labels, visible error/focus states and reduced-motion support are acceptance goals; audit before beta release.
- User can view a human-readable audit timeline with sensitive fields redacted, and find pending approvals without requiring developer tools.

## 8. Nonfunctional requirements (targets, not measured promises)

| ID | Requirement | Proposed test / release gate |
|---|---|---|
| NFR-SEC-001 | No cross-tenant access or privilege escalation | Negative authorization/IDOR tests at each API, DB, queue and artifact boundary before P2 |
| NFR-SEC-002 | Secrets, cookies and sensitive answers excluded from routine cloud logs/repo/CI | Automated secret/privacy checks plus human security review |
| NFR-REL-001 | Duplicate task delivery cannot repeat consequential ATS action | Replay/restart fault-injection tests with local immutable action identity and ledger checks |
| NFR-REL-002 | Cloud outage does not create false readiness or data loss | Disconnect/reconnect tests; durable local checkpoints; eventual reconciliation |
| NFR-REL-003 | Rollback never overwrites newer external-action ledger events | Backup/restore and rollback test against realistic event ordering |
| NFR-OPS-001 | Every run and deployment traceable by IDs/versions | Structured redacted logs with tenant/run/job/application/worker/release references |
| NFR-PERF-001 | Performance targets set from observed alpha baselines | Measure per-stage p50/p95, queue latency, model processing and browser times before setting SLA |
| NFR-COMP-001 | Data processing/retention and site-access rules reviewed per rollout | Privacy, security and terms/compliance review before external beta; legal advice where required |
| NFR-ACC-001 | Core approval flows keyboard accessible | Human and automated accessibility review before P2 |

Availability percentages, concurrency capacity, time/cost budgets and subscription pricing are **TBD** pending instrumentation and customer validation. Do not turn speculative targets into contractual SLOs.

## 9. Product metrics and release criteria

**Safety (release blocking):** fabricated claims = 0; known wrong sensitive answers = 0; unapproved submissions in V1–V3 = 0; duplicate consequential actions = 0; false-ready records = 0; demonstrable cross-tenant leaks = 0.

**Operational (measure baseline before targets):** discovered → resolved → reviewed → eligible → resume approved → form verified → ready conversion; time per preparation; manual review minutes; stale/blocked approvals; requirement coverage defects; field correct-fill coverage; successful upload/readback; interruption recoverability; worker connectivity; open P0/P1 defects.

**Evidence targets from existing ARDs:** V1 one real independently reviewed/accepted ready application with no submission. V2 at least 18/20 intended supported eligible attempts ready, spanning both ATSs with at least five per ATS, at least 95% correct fill of safely resolvable required fields, and 100% correct sensitive answers. V3 quantitative, human-reviewed evaluation and held-out split according to its ARD; do not substitute self-grading.

**P1 SaaS alpha release criteria:** completed P0 gates, paired/revocable worker, versioned API contracts, reliable queue replay, local data minimization proof, authenticated private dashboard, synthetic staging, reviewed real-session UAT, safe rollback and explicit human promotion. P2 requires additionally independently reviewed tenant isolation, onboarding/support/privacy and incident readiness.

## 10. Dependencies, risks and open product decisions

| Issue | Impact | Owner/decision |
|---|---|---|
| Candidate/contact/legal fact approvals incomplete | V1 eligibility and safe form use blocked | Human applicant |
| Real JD coverage unreviewed | Autonomous eligibility not admitted | Human reviewer |
| Real ATS adapter unverified | No credible ready state | Engineering + human UAT |
| Cloud privacy/data boundary | Data exposure and legal/compliance risk | Human Product Owner + security reviewer |
| Worker install/update and OS support | Customer onboarding and support burden | Engineering decision + beta evidence |
| Terms and permitted access by source/provider | Fragile or impermissible automations | Product/legal/technical review; no bypass |
| Billing/subscription model | Commercial risk | Defer; validate only after beta |
| Authority for V4 submission | Potential employer-side irreversible action | New explicit scoped human authorization; not inherited from account signup |

Open decisions requiring product sign-off: initial beta geography and eligibility criteria; which ATS variants supported; cloud versus local residence of resume files; retention periods; user deletion/export scope; pricing; support model; whether applications ever leave local review mode. Record decisions with date/reviewer and update impacted requirements. No default assumption that public multi-user signup is authorized.

## 11. Product definition of done and change control

- Each requirement has an ID, priority, owner, testable acceptance and mapping to an ARD or proposed design section, test evidence and UAT scenario.
- `DRAFT` becomes `APPROVED` only after human Product Owner decision; no agent auto-signature.
- A proposed scope change first updates this PRD, then impacted ARDs/interfaces and traceability, then acceptance/test plans, then implementation.
- Existing V1–V5 safety/trust contracts remain authoritative until explicitly reviewed; adding SaaS users never silently relaxes them.
- A feature is **implemented** only if code exists at a verified SHA; **verified** only if relevant checks actually passed; **accepted** only with appropriate human UAT; **released** only after explicit production promotion.
- Review cadence: at each material scope change and release candidate. Append decisions to issue/ADR rather than expanding this PRD into a daily transcript.

## 12. References and related artifacts

- Existing `docs/ard/00-START-HERE.md`: V1–V5 milestone map; explicitly single-candidate-first.
- Existing `docs/ard/00-SHARED-CONTRACTS.md`: candidate facts, eligibility, JD evidence, application state, browser, storage and failure contracts.
- Existing `docs/ard/ARD-V1-Working-Vertical-Slice.md` through `ARD-V5-Operational-Learning-Agent.md`: detailed incremental acceptance and test scenarios.
- `docs/AGENT-OPERATING-SYSTEM.md`: G0–G9 SDLC gates, CI/CD, UAT, agent management, handoffs.
- Proposed `docs/architecture/SAAS-SYSTEM-ARCHITECTURE.md`: control plane + worker architectural extension; **not** permission to implement all P1/P2 features before V1 readiness.

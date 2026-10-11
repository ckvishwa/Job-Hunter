# JOB HUNTER — MASTER ARD (Architecture Freeze)

**Version:** 1.0 — proposed freeze on 2026-10-09  
**Status:** Architecture decision and implementation contract for the next build; not a claim that migrations have been executed  
**Product outcome:** A candidate uploads a resume, reviews extracted facts, receives suitable role-family and seniority recommendations, and sees verified relevant openings. Resume tailoring and application filling come after this is dependable. Real automatic submission remains disabled.

## 0. Change-control decision

This is **one master architecture**. Do not repeatedly replace the stack in future milestone conversations. Changes require: (1) a concrete observed blocker or metric, (2) comparison with a simpler option, (3) migration and rollback plan, and (4) an explicit decision recorded in an ADR.

This document supersedes the **stack recommendations, sequence, and proposed module placements** in earlier V1–V5 ARDs wherever they conflict. Preserve their valid truthfulness, eligibility, provenance, browser safety, no-submit, deduplication, recovery and offline-E2E requirements. Do not delete or rewrite working code solely because its folder layout differs from this target. Carry out migration in slices with a verified baseline and rollback.

### Locked technology choices

| Boundary | Decision | Owns | Never owns |
|---|---|---|---|
| Browser-facing UI | Astro + TypeScript | Upload, confirmation screens, recommendations, filters, jobs/tracker views | Direct database access or AI authority |
| Main backend | TypeScript (Fastify HTTP API proposed) | Authentication, authorization, validation, business rules, workflow state, job discovery, Playwright ownership | Unsupported resume facts or inferred immigration answers |
| Database | PostgreSQL | Authoritative relational records, uniqueness, approvals, revisions, jobs, match decisions, checkpoints | Unencrypted resume blobs by default or browser session secrets |
| AI worker | Python + FastAPI | PDF/DOCX text extraction, skill/fact proposals, Qwen structured extraction, MiniLM embeddings, candidate role proposals | Browser actions, database approval, final eligibility permission |
| Browser automation | Playwright in TypeScript, headed Chrome | Official sources, observed pages, full JDs, future guarded form actions | Factual or eligibility decisions |
| Model A | Existing pinned Qwen2.5 3B initially | Evidence-grounded structured extraction from resume/JD | Invented skills, experience, authorization |
| Model B | Pinned all-MiniLM-L6-v2 initially | Similarity ranking of approved facts versus role descriptors/JD requirements | Claim verification, hard-rule override |
| Deployment | Local-first, single-machine pilot | Simple process orchestration, isolated stores and logs | Hosted multitenant infrastructure before validated demand |

**API boundary:** Astro talks only to TypeScript. TypeScript talks to PostgreSQL, Python over internal HTTP, and the Playwright browser runner. Python returns typed proposals (JSON); TypeScript checks the schema and authority before persistence. Generate/maintain an OpenAPI contract, runtime-validate in both languages (e.g. Zod + Pydantic), and version messages.

## 1. Canonical user journey (current priority)

1. **Upload resume** (`.pdf` or `.docx`) in Astro. Validate size, MIME/content, hash and ownership; store private file, never in Git.
2. **Text extraction** in Python with page/paragraph offsets and warnings for scanned documents/failed sections; never silently assume extraction complete.
3. **Fact proposals:** extract education, degrees, certifications, employers, titles, date ranges, technical skills, projects and achievements. Every claim has source text/span, extraction revision and proposal status.
4. **Candidate review:** user corrects/approves facts. Imported text is initially **PENDING**. Sensitive facts (citizenship, clearance, current authorization, future sponsorship) require explicit separately captured user answers; never infer them from the resume.
5. **Experience calculation:** compute verified, non-overlapping **professional employment** periods; store internship, academics, projects, volunteering, and skill mentions separately. No automatic conversion of a tool mention to tool-years.
6. **Role taxonomy:** map approved skills, responsibilities and validated experience to role families and title aliases. Propose multiple ranked paths and state the missing evidence. Candidate selects/rejects roles.
7. **Seniority targeting:** classify candidate readiness and classify each job's *stated requirement* independently. Search a provisional 0–5 years-required window including appropriate internship/junior/associate labels; do not assume title labels prove actual experience requirements.
8. **Discover jobs** from official employers/ATS sources or permitted feeds and manual pasted links; resolve official identity and full JD, hash, deduplicate, record source lineage and current availability.
9. **JD extraction:** Python Qwen structures the complete saved JD into evidence-grounded requirements (or flags clear deterministic restrictions for preliminary triage). Validate quotes, meaning and source offsets before making eligibility decisions.
10. **Hard eligibility, then semantic retrieval:** TypeScript evaluates explicit citizenship, clearance, location, enrollment, work authorization/future sponsorship and experience constraints against approved facts. Required unknown ⇒ REVIEW, verified mismatch ⇒ REJECT, otherwise continue to MiniLM retrieval for approved candidate facts. Absence of wording is UNSPECIFIED, not automatically PASS. Embedding similarity is never proof of a skill.
11. **Results in Astro:** separate ELIGIBLE, REVIEW and REJECT with reasons, source links and timestamps. Show ranked opportunities; never call the score an ATS score or a hiring probability.
12. **Later slices:** generate and inspect a sourced resume, fill only supported form controls in headed Chrome, read back results and pause at READY_TO_SUBMIT; no automated submission in this release.

## 2. Role classification: family, readiness and actual posting requirements are separate

### Role catalog (editable data; initial cybersecurity focus)

| Family | Discovery title aliases (examples, not eligibility guarantees) |
|---|---|
| SOC / Blue Team | SOC Analyst I, Junior SOC Analyst, Security Operations Analyst, Security Monitoring Analyst, Junior Cybersecurity Analyst |
| Incident response / DFIR | Junior Incident Response Analyst, Incident Response Associate, Digital Forensics Analyst (Junior) |
| Vulnerability / Security Operations | Vulnerability Management Analyst, Junior Vulnerability Analyst, Security Analyst I |
| Identity / Access | IAM Analyst I, Access Management Analyst, Identity Security Analyst |
| Security governance | Junior GRC Analyst, Security Compliance Analyst (subject to specific compliance evidence) |
| QA / SDET (secondary) | QA Automation Engineer I, Junior SDET, Software Test Engineer |
| Cloud / Network (secondary) | Cloud Support Engineer, Junior Cloud Engineer, Network Operations Analyst, NOC Analyst |

Store `family`, `role_slug`, `title_aliases`, role-description text, reviewed skill evidence, and optional advisory career level in `role_catalog`; don't hardcode a list inside prompts. A resume can map to several families. Give a reason per recommended role and list evidence gaps rather than forcing one winner.

### Seniority bands: *search heuristics*, not universal industry standards

| Search band | Typical job requirement text | Rule |
|---|---|---|
| Internship | Internship / co-op; experience not necessarily required | Check current student/enrollment restrictions explicitly |
| Entry | 0–1 years or equivalent training | Degree/project evidence may help if posting permits |
| Junior | 0–2 years | Use actual JD requirement over title label |
| Associate | 1–3 years | Review minimum required professional years |
| Intermediate | 3–5 years | Include in search, but don't automatically rank highly for a low-experience candidate |
| Advanced | >5 years | Exclude from default search unless candidate preference changes |

A user's 1.5 years of employment is not automatically five years because they have multiple projects or a master's degree. Overlapping jobs must not be counted twice. The `0–5 years` discovery window determines which ads to *inspect*, not what the candidate qualifies for or what the resume may claim.

### Decision model

- **Candidate profile:** approved fact IDs + provenance + true professional experience + preferences + explicit policy answers.
- **Job requirement:** exact source quote/span, scope, required/preferred/unspecified, experience duration, OR clauses and restrictions.
- **Role recommendation:** `role_slug`, matched approved fact IDs, uncovered skills, suggested job requirement bands, `PROPOSED|APPROVED|DISMISSED`.
- **Eligibility:** `ELIGIBLE|REVIEW|REJECT`, per-rule `PASS|FAIL|UNKNOWN` and reason. No model score overrides hard constraints.
- **Ranking:** only among jobs not confirmed rejected; disclose unsupported requirements and distinguish model relevance from factual match.

## 3. System architecture and API

```text
Browser
  └─ Astro UI (upload / confirm / roles / jobs)
       └─ TypeScript API + orchestrator
            ├─ PostgreSQL (source of truth)
            ├─ Python FastAPI (document extraction, Qwen, MiniLM)
            └─ TS Playwright worker → headed Chrome → approved job sources
```

Proposed versioned API (exact paths can be adapted to audited conventions):

- `POST /api/v1/resumes` — upload, return private resume ID and processing state.
- `GET /api/v1/resumes/:id/facts` — list source-anchored proposed facts and extraction warnings.
- `POST /api/v1/resumes/:id/facts/review` — approve/reject/correct facts; create profile revision.
- `GET /api/v1/roles/recommendations` — role-family/title and evidence proposals for approved profile revision.
- `POST /api/v1/roles/selections` — user-selected families, seniority and search preferences.
- `POST /api/v1/discovery-runs` — bounded official-board job search request; unique run ID.
- `GET /api/v1/jobs` — filter by eligible/review/reject, role, employer and location.
- `GET /api/v1/jobs/:id/match` — evidence-backed reasons, requirements and missing facts.
- `POST /internal/v1/ai/extract-resume`, `/extract-jd`, `/embed` — internal Python endpoints, with schema revisions, request limits and timeouts.

Use async jobs/status tracking for potentially slow AI and Playwright operations; UI should show state rather than hold an upload request open throughout inference. Start with one worker; avoid Redis/distributed queues until contention is measured. Prevent duplicate processing by content hash + profile revision + parser version.

## 4. PostgreSQL data ownership

Initial core entities (start with those the first vertical slice needs):

- `users`: authenticated candidate ID and account metadata.
- `resumes`: user owner, private file reference, SHA-256, upload time.
- `resume_versions`: extraction and review status, parser revision, provenance.
- `candidate_facts`: user, resume version, category, value, approved wording, source offset, evidence, `PENDING|APPROVED|REJECTED|EXPIRED`, verifier/version.
- `role_catalog`: stable role family and title aliases, description/version.
- `candidate_role_recommendations`: role, candidate profile revision, supporting fact IDs, gaps, status.
- `search_preferences` and `discovery_runs`: approved role selections, regions, requested bands and run status.
- `jobs`, `job_observations` and `job_requirements`: stable employer/ATS requisition identity, official URL lineage, full raw JD, content hash and source-evidenced requirements.
- `job_matches`: job/profile/parser/policy revisions, rule decisions, rank and review reasons.
- `application_records` and `workflow_events` (later): durable, unique application ownership, checkpoints, typed states and redacted evidence references.

Use migrations, foreign keys, unique stable requisition identities, safe single-writer/transaction boundaries, and per-user authorization on every record. Keep uploaded files, browser profiles and sensitive evidence private; PostgreSQL holds references and necessary metadata. Begin without pgvector: Python can rank a small candidate fact set in memory; add persistent vector indexing only if measurements justify it.

## 5. Reuse before replacing (migration rule)

Known current pieces in the TypeScript worktree include discovery/official-board logic, canonical JD storage, `src/nlu/local-transformer.ts` ONNX MiniLM, `src/semantic/ollama-provider.ts` Qwen, `src/decision/evaluate.ts`, `src/pipeline/run.ts`, resume rendering, form inspection, checkpoint code and an offline headed browser E2E. Recent evidence: MiniLM ran locally; Ollama live extraction validated for one Stripe JD; offline E2E passed 1/1; live Stripe outcome was REVIEW and no form was opened.

**Do not throw these away.** Freeze behavior with tests, then incrementally move AI inference into Python behind typed internal endpoints and migrate authoritative state from JSONL into PostgreSQL with a backup, count/hash reconciliation and rollback. The new Astro UI consumes the same TypeScript backend. Playwright remains TypeScript. Never maintain two authoritative candidate-profile or job stores during migration.

## 6. Release slices / stop rules

| Slice | Deliverable | Acceptance evidence |
|---|---|---|
| S0 (audit/freeze) | Baseline tests, read-only inventory, architecture decision and migration map | Exact source paths, scripts, baseline failures, no changed state |
| S1 | Astro upload → TS API → Python text/fact proposals → PostgreSQL persistence → approval UI | 10 synthetic/reviewed resumes, source spans, no unsupported approved claims, private storage, rerun idempotence |
| S2 | Role taxonomy + experience classification + editable role approvals | Reviewed cases across SOC/QA/cloud/network, valid non-overlapping duration math, internship eligibility separated, negative cases |
| S3 | Reuse official ATS discovery with selected role aliases, locations and job-years window | Pilot 50 candidates, record unique/verified/blocked counts and failure reasons, no unsupported source automation |
| S4 | Evidence-backed JD requirements + Qwen + MiniLM matching + hard constraint screening + Astro dashboard | Reviewed JD test set, no false automatic rejection on unspecified citizenship, zero fabricated facts, reasons for every blocker |
| S5 (later) | One proven ATS resume plan + headed form fill / readback to READY_TO_SUBMIT | Human-inspected actual job/resume/form, same-record restart, 0 automated submit requests |

**First delivery target:** S1 and S2 before expanding discovery or adding a new model. Treat the 7–14-day MVP as a target contingent on migration/testing scope, not a promised delivery date.

## 7. Security and operating boundaries

- Candidate resume is untrusted input. Validate files; protect against parser failures and malicious content; never execute text from a resume or JD as instructions.
- Sensitive current authorization, future sponsorship, citizenship, clearance and demographic answers are user-confirmed, not inferred from names, degrees, visa timing or profile text.
- Do not automatically reject a posting just because a citizenship/sponsorship statement is missing. Require explicit official JD evidence for automated knockout, or mark REVIEW when relevant constraints are unclear.
- Protect private resumes, IDs, access tokens, browser profiles, screenshots and prompt payloads; no raw secrets or PII in Git or ordinary logs.
- Browser always uses owned headed Chrome, dedicated profile and bounded concurrency; no CAPTCHA bypass.
- Auto-submit defaults to `false` and is outside S1–S4. Even S5 stops at human-reviewed `READY_TO_SUBMIT`.
- Retain honest failed/pending states and source timestamps. Do not claim live verification based on mock tests or copied job aggregation results.

## 8. Immediate implementation task for coding agent

> **S0 ONLY.** Work in the actual active Job Hunter worktree. Read this master ARD and original shared safety contracts. Confirm branch/working tree, current package scripts, database/storage code, browser ownership, existing MiniLM and Ollama integrations, resume parser/approval flow and UI status. Run current offline baseline. Return a KEEP / ADAPT / MIGRATE / CREATE matrix with exact paths and the smallest S1 deliverable (Astro resume upload + Python extraction + PostgreSQL staging + source-backed approval). Preserve unrelated work. Do not install new models, rewrite all five ARDs, drop JSONL records, automatically submit, merge or push. Stop after reporting verified architecture gaps and a migration plan.

**Non-negotiable definition of progress:** A user can upload a real resume, inspect exactly what the system extracted, approve/correct it, and see a defensible set of junior-to-5-years-targeted job roles. More discovered ads or additional AI frameworks are not success until this works.

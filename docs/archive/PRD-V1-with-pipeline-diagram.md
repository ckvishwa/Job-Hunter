# JOB HUNTER

## Product Requirements Document (PRD) — V1 Full Pipeline

**Product:** Job Hunter — AI-Assisted Job Discovery, Evidence-Grounded Resume Tailoring, and Application Preparation  
**Version:** PRD 1.0 / Baseline for implementation  
**Date:** October 14, 2026  
**Document status:** Proposed product requirements; NOT a claim of completed implementation  
**Repository:** `F:\Jobs\Job_Search\job-hunter`  
**Primary release goal:** A real, authorized job application reaches independently verified `READY_TO_SUBMIT` without automatic submission  
**Governance:** Candidate owns personal claims and the final submission; AI output never independently establishes truth.

> **Evidence standard.** “Working / reported” below means previously reported in project checkpoints, not independently re-tested against the current repository in this document. “Proposed” means designed but not proven in code. The latest checkpoint explicitly reports a failed full-regression Gate A. An agent must audit the actual worktree, branches, test runs, database migrations, and connected services before claiming current implementation status.

---

# 1. Executive Summary

Job Hunter is a candidate-side job-search assistant that securely ingests a candidate's resume, discovers employer jobs, understands requirements, evaluates eligibility using source-linked evidence, creates a truthful role-specific resume, validates ATS readability, and uses a headed browser to prepare applications for human review and submission. The product must avoid job-application spam, fabricated experience, automated answers to sensitive questions, and invented ATS scores.

**Core value proposition:** Parse once; store defensible candidate facts; discover continuously; match cheaply; generate selectively; validate independently; prepare applications locally; let the human submit.

### 1.1 Four execution frequencies

| Frequency | Trigger | Work | Cost rationale |
|---|---|---|---|
| Per resume version | Resume upload or justified re-extraction | Intake, parsing, role/skill extraction, grounding, persistence | Never repeatedly parse the same document for each JD |
| Per JD version | New or changed official posting | Ingestion, versioning, requirement extraction/coverage checks | JD understanding is reused across candidates |
| Per candidate × job | Candidate matching against indexed postings | Fast filters, ML relevance, semantic retrieval, deterministic eligibility | Avoid invoking a 3B SLM on thousands of jobs |
| Per selected application | Candidate selects a role for application | Tailoring, human authorization, ATS rendering, headed-browser preparation | Expensive work only after job selection |

### 1.2 Product North Star

**One authorized candidate + one verified live JD → a source-grounded, approved tailored resume + an ATS application in `READY_TO_SUBMIT` with complete field/read-back evidence and zero submission actions.**

This is a V1 release criterion, not an already achieved outcome.

# 2. Current Implementation Baseline — Working vs Planned

**Evidence cut-off: October 14, 2026; based on project reports and shared architecture documents, not a live repository audit.** The phrase “working foundation” does not imply release readiness.

| Subsystem | Status | What is evidenced / not evidenced | Next proof required |
|---|---|---|---|
| Astro + TypeScript web UI | WORKING FOUNDATION / scope partial | Job Hunter UI/dashboard exists by prior project reports; candidate confirmation screens unverified | Open local dashboard; identify routes and current tests |
| Node.js + TypeScript orchestration | WORKING FOUNDATION | Existing discovery, workflow, eligibility code and extensive tests reported | Trace one job through the current state machine |
| Official job discovery | WORKING FOUNDATION | Oct 8 snapshot: 25/30 boards accessible, 5,991 postings fetched, 39 tracker entries, 10 shortlisted | Reconcile latest source/board counts and closure detection |
| Complete JD capture and deterministic eligibility | PARTIALLY WORKING | Full JDs and rule checks available; OR/AND and uncertainty extensions are not independently proven end-to-end | JD source-span coverage and eligibility golden cases |
| Qwen2.5:3B / local extraction | WORKING FOUNDATION / quality gaps | Local Qwen extraction reported working, with incomplete/rejected structured outputs | Measure on held-out documents; do not assert accuracy yet |
| MiniLM embedding smoke | REPORTED SMOKE ONLY | Prior isolated 384-dimensional CPU smoke passed; complete retrieval index/ranking unverified | Per-requirement retrieval benchmark |
| PostgreSQL / migrations | WORKING FOUNDATION | Database healthy at last reported checkpoint; migrations through 0011, backed-up data preserved | Recheck migration ledger and records non-destructively |
| Human ML-label data | WORKING FOUNDATION | 216 rows reported: 145 relevance (31 relevant, 51 irrelevant, 62 adjacent, 1 unsure), 60 seniority, 11 false-positive-admission | Independent train/holdout split with class coverage |
| Custom scikit-learn relevance classifier | EXPERIMENTAL / SHADOW | Routing protections implemented; model not independently evaluated, trained/promoted for real acceptance | Held-out labels, calibration, accepted-prediction accuracy/coverage |
| Full serialized regression Gate A | BLOCKED | Five full serial runs, no accepted green; one 1,621-test run had zero test failures but gate failed because of checkpoint fingerprint; fix introduced, intermittent environment-dependent failures remain | Two consecutive clean full runs or approved documented root-cause re-baseline |
| FastAPI resume processing service | PLANNED | Target architecture; no repository-verified implementation | API contract + unit/integration tests |
| Layout-aware PDF/DOCX extraction | PLANNED | Parsers selected; role/source layout validation not proven | Multi-column and real-resume benchmarks |
| GLiNER + role binding + skill graph | PLANNED | Design approved, model selection not benchmarked in project | Role-to-skill-to-date gold evaluation |
| Automatic grounding and Astro exception review | PLANNED | Data contract and trust permissions specified | End-to-end upload and v2 resume diffs |
| Versioned requirement AST and 3-valued eligibility | PLANNED EXTENSION | Current rules are foundation; complete Kleene logic/coverage/disputes not evidenced | Truth-table tests and sample real JDs |
| Deterministic ResumePlan / selective SLM rewrite | NOT DEMONSTRATED | Architecture defined; no validated job-specific artifact yet | Source-backed plan with candidate approval |
| Independent ATS DOCX/PDF validation | PLANNED | Renderer/independent parser acceptance defined | Exact field recovery from both formats |
| Headed Playwright job inspection | WORKING FOUNDATION | Discovery/read-only headed browser flows reported | Preserve existing user session and anti-bot pauses |
| Live form fill, upload, read-back, `READY_TO_SUBMIT` | NOT DEMONSTRATED | No confirmed real completion; zero submissions reported | One authorized supervised E2E, without submission |

**Do not rewrite status labels just because code exists.** `Implemented`, `unit-tested`, `integrated`, `user-accepted`, and `released` are different evidence levels. Every milestone must attach code paths, test commands, environment and run IDs.

### 2.1 Gate A known blocker

Previous reports isolated a self-referential fingerprint dependency on `private-runtime/test-cache/current-run.json` and added a regression test plus exclusion for `private-runtime/`. A separate loopback probe reported 3.1% stalls/errors across 800 requests, with intermittent UI/API/DB tests failing in different serial runs, often passing alone. This is **environment interference evidence**, not proof that Defender or Docker is the root cause. No timeouts were increased; the bounded ML labeling batch was correctly withheld.

# 3. Product Personas and Jobs To Be Done

| Persona | Need | Key workflow |
|---|---|---|
| Individual candidate | Find relevant jobs without repeating resume entry; avoid unsupported claims | Onboard → profile → shortlist → approve resume → prepare application |
| Candidate acting as reviewer | Resolve only material ambiguities, not every extracted word | Targeted fact/skill-duration questions, just-in-time resume approval |
| Authorized operator | Support multiple candidates only with consent and segregation | Scoped access, actor attribution, audit trail; never impersonate candidate approval |
| Product founder/developer | Deliver reliable increments across TypeScript and Python | Typed interfaces, feature flags, traces, measured benchmarks |
| Automation QA engineer | Independently challenge correctness and regressions | Gold cases, offline E2E snapshots, security/negative tests, release report |

# 4. V1 Scope, Boundaries, and Non-Goals

**In scope:** candidate onboarding and consent; secure upload; PDF/DOCX parsing; source spans; skill/role binding; append-only fact history; auto-grounding with exception review; official job ingestion; versioned JD requirements; career-lane relevance classification (guarded); skill/semantic retrieval; three-valued eligibility; deterministic resume planning; selective local SLM rewriting; one tested ATS resume template; DOCX/PDF field recovery; local headed Playwright application preparation; human submission; logging and outcome collection.

**Non-goals:** automatic final submission; bypassing CAPTCHA or platform restrictions; fabricated certifications, experience, salaries, immigration answers or EEO declarations; universal ATS percentage ratings; employer-side ranking or hiring decisions; training models on candidates' resumes without permission; large model orchestration for every job; building pgvector/NLI/SetFit/extra microservices without measured need; replacing existing Astro/TypeScript stack; public SaaS/monetization infrastructure unless separately scoped.

# 5. End-to-End Product Flow and Contracts

```text
CANDIDATE SIDE                              JOB SIDE
Consent + resume upload                   ATS APIs / JSON-LD / HTTP
      |                                           |
[0] Secure document intake              [4A] Ingest/dedupe/version
      |                                           |
[1] Layout-aware PDF/DOCX parse         [4B] JD requirement AST
      |                                           |
[2] Line tagging / role binding         [4C] Custom ML relevance (shadow)
    skill graph + GLiNER                         |
      |                                  Canonical skill & semantic shortlist
[3] Automatic source grounding                   |
    Pydantic → Zod → PostgreSQL                   |
      |                                           |
      +--------------------+----------------------+
                           |
             [4D] Requirement-to-fact evidence
                  + 3-valued eligibility
                           |
                 Ranked shortlist + UNKNOWNs
                           |
                  Candidate selects a JD
                           |
             [5] Deterministic ResumePlan
                  + just-in-time approval
                  + optional SLM rewrite
                  + factual claim gate
                           |
             [6] ATS template DOCX/PDF
                  + independent extraction
                           |
             [7] Local Playwright headed Chrome
                  fill / upload / read-back
                           |
                       READY_TO_SUBMIT
                           |
                   HUMAN SUBMITS ONLY
                           |
             [8] Outcome, correction, ML loops
```

**Trust model:** A source-grounded resume sentence proves only that a candidate's submitted document contains that claim. Candidate confirmation is a self-report, not independent credential verification. Source content, JDs, and pages are untrusted data, never executable instructions.

# 6. Detailed Functional Requirements

## 6.0 Stage 0 — Intake and Consent

**FR-0001.** Astro upload only accepts supported file type/size and a correctly associated candidate identity and consent context.  
**FR-0002.** Node stores file identity, hash, owner, actor, source type, version and processing state; duplicates are idempotent.  
**FR-0003.** Files reside in private controlled storage; original bytes never mutated.  
**FR-0004.** Multi-candidate operators must have explicit authorization; reviewer events record `actor_id` and `actor_role`.  
**FR-0005.** Privacy controls include deletion, retention, access logging and tenant/candidate isolation.

**Acceptance:** Unauthorized cross-candidate reads fail; duplicate upload does not duplicate facts; no processing starts without appropriate consent.

## 6.1 Stage 1 — Document Parsing

**Technologies:** FastAPI/Python; `pdfplumber` for PDF, `python-docx` for DOCX, layout and text-density checks.

**FR-0101.** Recover text, page/section locations, block order and source spans.  
**FR-0102.** Detect multi-column interleaving and preserve role/date/bullet reading order.  
**FR-0103.** Flag scanned PDFs or missing text instead of returning empty success.  
**FR-0104.** Flag invisible/hidden text, suspicious font sizes or colors, content outside page bounds, and instruction-like text.  
**FR-0105.** Apply size, page-count, resource, timeout and sandbox limits; do not execute attachments.  
**FR-0106.** Record parser/extractor versions, source hash and processing trace.

**Output:** `ParsedDocument{document_id, hash, blocks[], source_spans[], warnings[], version}`.

**Acceptance:** Original heading-to-bullet associations and critical text are correct across one-column, multi-column, DOCX table and negative fixtures.

## 6.2 Stage 2 — Resume Structure, Skills, and Temporal Evidence

**Technologies:** Python heuristic line tagger initially; future scikit-learn line classifier; role-block interpreter; contextual skill graph; GLiNER Small on targeted spans; date interval evaluator.

**FR-0201.** Tag each block as section heading, role header, date, bullet, skill list, project, education or unknown.  
**FR-0202.** Group role header, employer, title, dates and bullets before skill attribution.  
**FR-0203.** Normalize technical skills into canonical IDs, aliases and specific-to-general relations; disallow general-to-specific promotion.  
**FR-0204.** Respect contextual ambiguous tokens (`Go`, `R`, `C`, `Spark`, `Swift`) and exact boundaries (`Java` vs `JavaScript`).  
**FR-0205.** GLiNER proposes unknown entities; a found span is not proof of a fact relationship.  
**FR-0206.** Retain skill evidence tier: `ROLE_BOUND`, `PROJECT_OR_ACADEMIC`, `LISTED_ONLY`; handle explicit negation and certification `IN_PROGRESS`.  
**FR-0207.** Date math preserves uncertain year-only dates, overlapping periods, skill-duration [lower, upper] bounds, and stale `Present` as-of questions.  
**FR-0208.** Source reference and provenance mandatory for every source-extracted claim.

**Output:** `ExtractedFacts` with employer ↔ title ↔ date ↔ skill ↔ span binding.

**Acceptance:** Skills in sidebars are not silently attributed to jobs; one bullet in a 19-month role never establishes 19 months of continuous skill use; overlapping roles are not double-counted.

## 6.3 Stage 3 — Automated Grounding and Fact Persistence

**Technologies:** FastAPI/Pydantic → typed API/OpenAPI-derived TS contract → Zod → PostgreSQL; Astro exception review.

**FR-0301.** Store independent dimensions: `origin`, `source_ref`, `review`, `verification`, `grounding`, `evidence_tier`.  
**FR-0302.** `AUTO_GROUNDED` permits only actions defined by the claim-permission matrix; it does not imply identity/competence verification.  
**FR-0303.** Flag unsupported, negated, contradictory, stale or ambiguous material claims for review.  
**FR-0304.** Preserve append-only extraction runs, corrections and review events. Distinguish parser mistake from new candidate assertion.  
**FR-0305.** On resume V2, diff facts; preserve confirmations only for unchanged meaning/scope, return changed facts to review.  
**FR-0306.** Ask candidate only questions material to shortlisted jobs or the final ResumePlan; canonicalize questions to avoid repeats.  
**FR-0307.** Only enabled verification methods may write `INDEPENDENTLY_VERIFIED`; candidate or operator clicks cannot do so.  
**FR-0308.** Cache by content hash + parser/extractor version, with no cross-candidate cache data leaks.

**Action permissions — initial policy:**

| Claim class | Matching/ranking | Resume content | Screening/sensitive answers |
|---|---|---|---|
| `SOURCE_GROUNDED`, review unreviewed | Yes, source-labeled | Existing wording; controlled validated paraphrase only when candidate authorizes plan | Never auto-answer |
| Candidate-confirmed | Yes | Yes, with claim checks | Explicitly permitted non-sensitive answers |
| Candidate-asserted | Yes, assertion-labeled | As authorized; no implied independent evidence | Only explicit candidate-approved answer |
| Unknown/disputed/rejected | Only as uncertainty | No unsupported positive claim | Human decision required |

**Acceptance:** Clear skill facts auto-ground without unnecessary review; ambiguous years cause one targeted question when a selected JD requires it; v2 upload preserves audit trail; application cannot consume unapproved sensitive answers.

## 6.4 Stage 4 — Job Ingestion, ML Relevance, JD AST, and Eligibility

### 4A Official job ingestion

**FR-0401.** Prefer official posting APIs, then JSON-LD, HTML, and only then headed browser inspection.  
**FR-0402.** Persist official identity, employer, job URL, JD content hash/version, observed timestamps and closure status.  
**FR-0403.** Deduplicate, respect site terms/rate limits, and do not infer availability of closed postings.  
**FR-0404.** Retry fetches safely with idempotency and bounded backoff.

### 4B JD requirement tree

**FR-0410.** Parse sections into requirement AST leaves with `required/preferred`, skill/credential, scope, duration, logical AND/OR and source span.  
**FR-0411.** Require sentence-level coverage or explicit ignored reason; otherwise mark JD `PARTIAL` and block a definitive all-clear.  
**FR-0412.** Preserve JD versions; a candidate can dispute a leaf, which becomes `UNKNOWN` pending review.  
**FR-0413.** Apply injection isolation: only bounded source passages as data can reach an isolated extractor; untrusted page/JD text must never become model/system instructions.

### 4C ML relevance classifier and discovery funnel

**FR-0420.** Start with SQL hard filters for closure, duplicates and verified contradictory requirements.  
**FR-0421.** Run custom scikit-learn TF-IDF + Logistic Regression relevance classifier in shadow mode until independently calibrated and promoted.  
**FR-0422.** Predict relevant/adjacent/irrelevant with abstention (uncertain); do not treat relevance prediction as eligibility.  
**FR-0423.** Rank candidates' opportunities by canonical skill coverage, optional semantic similarity and requirement importance. Avoid using RRF rank alone as evidence of support.  
**FR-0424.** Evaluate detailed requirement trees on a bounded shortlist; cache job embeddings and ASTs by version.  
**FR-0425.** Unknown qualifications are ranked/reviewed, not silently removed.  
**FR-0426.** Optional SetFit, role-scope models, pgvector and cross-encoder/NLI require independent benchmark justification.

### 4D Requirement evaluation

**FR-0430.** Preserve one TypeScript three-valued eligibility evaluator: `SATISFIED / UNSATISFIED / UNKNOWN`.  
**FR-0431.** Python computes normalized facts/duration bounds; TypeScript evaluates AST without redoing Python date math or skill inference.  
**FR-0432.** Apply complete Kleene AND/OR truth tables and overlap-safe skill duration rules.  
**FR-0433.** `UNSATISFIED` requires defensible negative evidence or a complete upper bound below the threshold; incompleteness usually stays `UNKNOWN`.  
**FR-0434.** Generate targeted, canonical candidate questions when an unknown could change a shortlisted job verdict.  
**FR-0435.** Separate *eligibility verdict* from *job ranking score* and explain their basis.

**Acceptance:** Full requirement coverage or visibly partial status; correct AND/OR, degree, clearance and experience tests; no ungrounded “eligible”; ML cannot override hard constraints.

## 6.5 Stage 5 — Deterministic Resume Planning and Optional SLM Rewriting

**Technologies:** TypeScript evidence planner; optional local Qwen2.5:3B / Llama 3.2 3B through Ollama; structured response validation; Astro just-in-time approval.

**FR-0501.** First generate a complete factual `ResumePlan` **without** an SLM: select, order, and prioritize approved roles, skills and achievements by job relevance.  
**FR-0502.** Preserve historical employers, dates, degrees, certificates and original roles. A target headline may reflect the target role but may not change historical titles.  
**FR-0503.** Every material output claim and skill carries one or more fact IDs with allowed provenance.  
**FR-0504.** Candidate approves the material selected facts just in time before external use; no bulk approval of ambiguous claims.  
**FR-0505.** Rewriting is optional and bounded (e.g., one bullet, short evidence-only prompt); never invent tools, production scope, metrics, certifications or experience years.  
**FR-0506.** Run deterministic factual novelty/delta checks, status/tense checks and optional directional NLI as a support signal; reject unsupported content.  
**FR-0507.** A rejected rewrite reverts to approved original; at most one retry in validated policy.  
**FR-0508.** Template selection comes from an approved registry, not a model-generated arbitrary document design.  
**FR-0509.** Cache validated rewrites by fact identity, target evidence set and model/prompt versions.

**Output:** `ApprovedResumePlan{job_version, fact_ids, content, template_id, approvals}`.

**Acceptance:** Zero unsupported material claims on mandatory adversarial fixtures; original facts preserved; meaningful JD-specific content selection without an LLM; candidate sign-off logged.

## 6.6 Stage 6 — ATS Document Rendering and Validation

**Technologies:** `python-docx` for DOCX; benchmark/implement Typst for PDF; independent DOCX/PDF field recovery (`pdftotext`, docx2python or similar).

**FR-0601.** Render from one approved ResumePlan into a single-column standard-heading ATS baseline template.  
**FR-0602.** No image-only text, main-content tables, hidden text, sidebars, text boxes or unvalidated layout tricks.  
**FR-0603.** Independently parse rendered DOCX/PDF and compare every critical field against the approved plan.  
**FR-0604.** DOCX and PDF must have equivalent material facts despite different renderers.  
**FR-0605.** Generate separate statuses: `DOCUMENT_PARSEABILITY` and `TARGET_ATS_COMPATIBILITY`.  
**FR-0606.** Never generate a universal “ATS 98%” compatibility or hiring score.  
**FR-0607.** Persist artifact hashes, rendering template/version, independent parser results and source plan ID.

**Acceptance:** 100% recovery in tested output of included name/contact, employers, historical titles, dates, education and included skills; zero mismatched material facts. Actual third-party ATS parsing remains a separate live/read-back test.

## 6.7 Stage 7 — Local Application Preparation and Human Submission

**Technologies:** Existing Node/TypeScript + headed Playwright/Chrome, configured as a local-agent workflow where feasible.

**FR-0701.** Open a supported official application for an authorized candidate in their local browser/session.  
**FR-0702.** Inspect required fields; fill only explicit, authorized data from candidate profile.  
**FR-0703.** Never infer immigration/work authorization, sponsorship, EEO, salary, relocation or similar sensitive answers.  
**FR-0704.** Upload the approved resume in the requested allowed format and read back ATS-populated fields after upload.  
**FR-0705.** Compare submitted-on-page values against the approved answers/ResumePlan, not merely earlier typed values.  
**FR-0706.** Missing required answers produce `WAITING_FOR_USER`; failed verification produces `BLOCKED`.  
**FR-0707.** `READY_TO_SUBMIT` expires on meaningful posting/form/session changes and requires recheck.  
**FR-0708.** Final Submit remains human-controlled. No CAPTCHA bypass or automatic final submission.  
**FR-0709.** Save no unauthorized credentials; respect ATS platform restrictions and safe stop conditions.

**Acceptance:** One supervised offline/E2E then authorized real application shows all fields correct, uploaded artifact matched, complete audit and `READY_TO_SUBMIT` without final submission.

## 6.8 Stage 8 — Quality Feedback and Model Lifecycle

**FR-0801.** Collect independently reviewed parser errors separately from candidate claim changes; training requires opt-in/permission.  
**FR-0802.** Capture unknown skill terms for skill graph review and missing JD leaves for coverage repairs.  
**FR-0803.** Log confirmed interview/rejection outcomes without treating them as causal proof of model quality.  
**FR-0804.** Version, evaluate and roll back custom classifiers separately from extraction models.  
**FR-0805.** Model promotion from shadow mode requires frozen, held-out evaluation, class-wise metrics, coverage and calibration.

# 7. Machine Learning Placement and Promotion Plan

| Model/classifier | Stage | Input → Output | Mode V1 | Promotion evidence |
|---|---|---|---|---|
| Line-type classifier (future sklearn CRF/GBM) | 2 | Text block + layout → role/date/bullet label | Heuristic baseline first | Beats baseline on blind role-binding gold set |
| GLiNER Small encoder Transformer | 2 | Targeted spans → entities | Proposed CPU inference | Entity precision/recall and source-binding tests |
| Skill alias/ontology graph | 2, 4 | Skill mentions → canonical IDs and safe hierarchy | Deterministic planned | Precision on ambiguous tokens, one-way inference tests |
| Context / risk ML | 3 | Evidence features → auto-ground/review suggestion | Not initially deployed | Calibrated precision/coverage, adverse-case checks |
| Required/preferred sentence classifier (SetFit candidate) | 4 | JD leaf → requirement type | Later | Measured gain over AST rules/SLM benchmark |
| **Custom relevance classifier (sklearn)** | **4C** | Job JD + lane features → relevant/adjacent/irrelevant/abstain | **Existing shadow code; unpromoted** | ≥90% accuracy on accepted predictions plus per-class thresholds, recall and adequate coverage |
| Role scope classifier | 4D | Role evidence + requirement scope → relatedness | Later | Agreement with blind human judgments |
| Semantic embedding encoder | 4 | Short evidence & JD chunks → vectors | Candidate model; smoke reported | Recall@k, latency, memory versus baseline |
| Optional NLI encoder | 4–5 | Source fact + requirement/rewrite → entail/neutral/contradict | Benchmark only | Reduced unsupported claims without harmful false rejects |
| Qwen/Llama 3B SLM | 5 | Approved facts + requirement nodes → suggested wording | Existing Qwen integration; tailoring planned | Unsupported claim rate, readability, latency, license/privacy review |

**Do not equate ML confidence with correctness.** For auto-grounded claim release targets, proposed extraction metrics are ≥97% precision, ≥92% recall, ≥95% role-binding correctness and ≥99% *measured* auto-ground precision. These are unachieved V1 targets. Report confidence intervals, per-type counts and diversity; ~300 independent zero-error claims only loosely supports a 99% point at a 95% one-sided bound, and correlated examples weaken that inference.

**Training data split:** Keep a consented blind gold set isolated from model/student training. Candidate corrections are untrusted labels until an adjudicator confirms it was a parser error; never leak held-out examples into prompts or model selection. The existing 216 human-label rows cover multiple tasks; they are not 216 relevance positives and cannot alone prove class coverage.

# 8. Proposed Data Contracts and Storage

| Entity | Minimum fields |
|---|---|
| Candidate | `candidate_id`, scope/tenant, consent references, profile revision |
| SourceDocument | `document_id`, owner, original bytes reference, SHA-256, version, file type, retention state |
| ExtractionRun | `run_id`, source document/version, parser/transformer versions, timestamps, warnings, trace ID |
| FactEvent | `fact_id`, change type, actor, origin, source span, old/new value, reason, event time |
| CandidateFact projection | `fact_id`, normalized value, role/project scope, evidence tier, origin, review, verification, grounding, source span |
| SkillGraph | `skill_id`, aliases, contexts, parent skill IDs, ontology version |
| JobPosting | `job_id`, ATS identity, official link, company, location, status, current content hash |
| JDVersion / RequirementLeaf | content hash, leaf ID, raw span, AST node, requirement scope, required/preferred, coverage/dispute flags |
| MLRun | model ID, version, training/validation data hashes, metrics, calibration, promotion status |
| MatchReport | candidate/profile revision, job JD version, per-leaf evidence, verdict, rank, unknown questions |
| ResumePlan | candidate, job version, template, selected fact IDs, approved wording, approval event |
| RenderedArtifact | format, content hash, plan version, parser validation, target ATS compatibility state |
| Application | candidate, job, form snapshot, current state, field values/hashes, expires_at, audit references |

**Provenance example** (illustrative, not actual database record):

```json
{
  "fact_id": "F-102",
  "kind": "skill_use",
  "skill_id": "python",
  "role_id": "R-7",
  "origin": "EXTRACTED",
  "source_ref": "DOC-3:PAGE-1:SPAN-42",
  "review": "UNREVIEWED",
  "verification": "NONE",
  "grounding": "SUPPORTED_BY_SOURCE",
  "evidence_tier": "ROLE_BOUND",
  "duration_months": {"lower": 0, "upper": 19},
  "extractor_version": "to-be-implemented"
}
```

**Contract ownership:** Author one canonical API/schema definition (Pydantic/OpenAPI or shared JSON Schema) and generate/test downstream TS/Zod types. No manually drifting duplicate definition. Node/TS owns orchestration state and idempotency; Python owns parsing, fact computation and bounded inference.

# 9. User Journeys and UI Acceptance

### Journey A — Upload resume once

Candidate authenticates in Astro, uploads authorized PDF/DOCX, sees processing progress, detected job history and any source warnings. Clear claims are source-grounded automatically. Only material ambiguities create review items. Changed resume versions show a diff; unchanged facts retain valid prior approvals.

### Journey B — Discover and shortlist jobs

Candidate configures target career lanes and preferences. Job Hunter discovers official postings, removes duplicates/closures, and displays ranked listings with **reasoned** `relevant`, `adjacent`, `uncertain`, and eligibility states. The product does not hide unknown eligibility as a rejection.

### Journey C — Prepare selected application

Candidate selects an official, still-open job. Job Hunter displays requirement-tree coverage, candidate evidence with source spans, targeted questions, ResumePlan and original-versus-proposed wording. Candidate approves the facts and resume plan. A validated DOCX/PDF is generated; local Playwright populates the form; candidate submits manually.

### Journey D — Operator supports a third-party candidate

Operator can inspect and correct extraction only with permission. Operator correction events never become `candidate-confirmed` until the actual candidate approves. Sensitive application answers cannot be selected by the operator without appropriate explicit candidate authorization.

# 10. Acceptance Tests, STLC and Quality Gates

| Gate | What must pass | Evidence artifact |
|---|---|---|
| GA — Baseline stability | Two reproducible full CI runs or approved transparent baseline after root-cause review; no assertion weakening | Runner logs, environment and artifact hashes |
| G0 — Intake/privacy | Consent, access control, file limits, candidate isolation, deletion policy | Security negative tests |
| G1 — Parsing | Accurate multi-layout extraction, explicit scan/hidden text warnings | Blind source-to-block tests |
| G2 — Resume facts | Role/title/date/skill bindings and intervals match adjudicated gold data | Field metrics and error cases |
| G3 — Grounding | Claim permissions, negative statements, provenance, append-only audit, v2 diff | DB/integration tests |
| G4 — JD/matching | Sentence coverage, complete AST logic, 3-valued evaluator and uncertainty handling | JD gold set + truth tables |
| G4-ML — Promotion | Held-out accepted-prediction accuracy and calibration; no leakage | Signed model evaluation report |
| G5 — ResumePlan | Material claims map to permitted fact IDs, deterministic selection succeeds | Fact-to-output audit |
| G6 — ATS rendering | Independent parsers recover all required fields from DOCX and PDF | Per-field comparison report |
| G7 — Application | Offline supported form snapshots + one authorized supervised real preparation | Field read-back + READY_TO_SUBMIT log |
| G8 — Release | Full regression, performance, privacy/security, candidate acceptance | Release decision PASS/FAIL/BLOCKED |

**Essential adversarial cases:** missing field versus explicit contradiction; `Java` vs `JavaScript`; `Go` ordinary-language ambiguity; `No AWS experience`; `Server+ in progress`; overlapping roles; year-only dates; stale `Present`; multi-column reading order; same document re-upload; resume V2 conflicts; hidden text; JD injecting instructions; OR/AND changes; ATS autofill overwrites; stale ready state; two workers same task; crashed worker recovery; concurrent requests; cross-candidate leakage; unauthorized operator approval.

**QA ownership:** Founder/developer builds and unit-tests slices; automation QA engineer independently writes acceptance/negative tests, records reproducible evidence, and owns release verification. Both sign off on unresolved risks.

# 11. Reliability, Security, and Non-Functional Requirements

| Area | Requirement | Measurement/gate |
|---|---|---|
| Correctness | Claim provenance required; no unsupported material claims leave Step 5 | Zero on mandatory adversarial gold suite |
| Performance | CPU-first ingestion/matching, lazy-model lifecycle, bounded concurrency | Report p50/p95 latency, CPU, RAM per stage; no unmeasured fixed SLA |
| Throughput | Reuse extraction by document/JD hash; bounded queue and idempotency | Duplicate processing and restart/retry tests |
| Resource cost | 3B SLM only for selected jobs; CPU GLiNER evaluated against rules | Tokens/sec, process RSS, GPU VRAM, queue time |
| Privacy | Candidate/tenant boundaries, encryption, deletion/retention, limited logs | Security review and access-control tests |
| Prompt injection | Uploaded docs, official JDs and application pages untrusted | Injection fixture suite; no data-to-instruction promotion |
| Observability | Trace ID per run; stage durations; source/model/version/hash; failure states | End-to-end replay report |
| Recovery | Bounded retries, deterministic idempotency, recoverable partial states | Crash/replay scenarios |
| Model governance | Shadow-first ML, frozen held-out evaluation, documented promotion/rollback | Evaluation artifact and diff report |
| Site compliance | Respect permissions, terms, CAPTCHAs and human submit boundary | No final submit action in automation harness |

Performance targets should be **measured on the actual Windows host and CI runners** before budgets/SLAs are made contractual. Changing languages/frameworks does not itself guarantee reduced CPU or GPU usage.

# 12. Delivery Roadmap and Exit Criteria

| Phase | Work package | Dependency | Exit criterion |
|---|---|---|---|
| P0 — Audit and recover | Baseline worktree, Gate A, PostgreSQL, job-source/current-state verification | None | Reproducible approved baseline; no data loss |
| P1 — Secure intake/parser | Steps 0–1; layout/injection tests | P0 for merge | Resume text, spans and warnings verified |
| P2 — Fact intelligence | Step 2 line tagger/role grouping/skill graph; GLiNER benchmark | P1 | Correct employer-to-skill-to-date binding |
| P3 — Grounding | Step 3 Pydantic/Zod/DB events, auto-routing, Astro exceptions, v2 diffs | P2 | Traceable facts and minimal human interruption |
| P4 — JD/eligibility | Stage 4 AST, coverage, versioning, 3-value tests, ranking | P3 | Correct evidence-based MatchReport for real JD |
| P5 — ML evidence | Job relevance classifier independent evaluation and guarded promotion | P4 or parallel isolated | Demonstrated accuracy/calibration/coverage or retain shadow |
| P6 — Deterministic tailoring | Stage 5 selection, claim IDs, just-in-time approval | P4 | Approved plan without any LLM |
| P7 — ATS docs | Stage 6 DOCX/PDF, independent recovery | P6 | Key fields verified in both formats |
| P8 — SLM improvement | Selective per-bullet rewrites, validator and comparison tests | P7 | Demonstrated quality gain without material fabrication |
| P9 — Applications | Stage 7 local headed Playwright, offline then authorized real flow | P7, P0 | One application READY_TO_SUBMIT, not submitted |
| P10 — Release hardening | Security, recovery, privacy, performance and full STLC/UAT | P0–P9 | Signed release-ready evidence |

**Parallelism rule:** design and isolated tests can proceed while Gate A is red, but do not merge/release new features on an unverified baseline. Do not run large labeling or model-promotion batches while the agreed gate blocks that work.

# 13. Immediate Next Engineering Actions

1. **Recover baseline:** verify branch/worktree, migration ledger and the full serial test runner, investigate loopback stalls, preserve data and obtain a reproducible Gate A decision.
2. **Inventory reused modules:** existing Astro routes, Node workflow, current JD extraction/eligibility, Qwen/MiniLM integration, DB schemas, discovery adapters and test coverage.
3. **Build blind, consented gold fixtures:** source-only human labels; represent layouts, ambiguity, negative skills, contradictory dates, clearance and claims.
4. **Implement minimum Steps 0–3 vertical slice:** PDF/DOCX → source spans → role/skill binding → auto-grounded PostgreSQL facts + candidate-specific exceptions.
5. **Prove one real JD match:** coverage-checked AST, ranking separate from eligibility, targeted question if needed.
6. **Generate deterministic ResumePlan and a validated DOCX:** do not wait for new SLM training; add optional rewriting only after baseline passes.
7. **Finish local headed application preparation:** one authorized job reaches `READY_TO_SUBMIT`; human submit remains manual.

# 14. Dependencies, Risks, and Open Decisions

| Risk / decision | Why it matters | Resolution policy |
|---|---|---|
| Gate A environment instability | New failures cannot be distinguished from existing flaky behavior | Root-cause isolation, fixed runner, transparent baseline, no blind timeout increases |
| GLiNER extraction may be weaker than heuristics on role/date binding | Entity extraction ≠ relationship extraction | Benchmark end-to-end structure, not model publicity |
| Skill graph ambiguity/hierarchy | False seniority and product-specific matches | Context-sensitive exact IDs; one-way specific-to-general only |
| Source grounding ≠ competence verification | Resume can contain inaccurate claims | Use fact permissions and just-in-time candidate confirmation |
| Application ATS variation | Parser and UI differ across employers | Independent DOCX/PDF parseability plus target ATS read-back; never universal score |
| Custom classifier minority class imbalance | High overall accuracy can hide missed relevant jobs | Class-wise results, confidence calibration, abstention, independent holdout |
| PDF production route | python-docx and Typst may differ | Benchmark and independent recovery of both; validate licensing and deployment |
| Computer/browser deployment | Local vs future hosted complexity | Keep headed Playwright local in V1; preserve existing automation adapters |
| Commercial model licensing | Qwen/Llama variants have specific rights | License review before hosted commercial deployment |
| Candidate questions at scale | Thousands of unknowns can spam users | Ask once per skill/scope only for shortlisted application decisions |
| Operator versus candidate review | Audit accuracy | Actor IDs/roles and separate approvals |

**Remaining product decisions needing explicit sign-off:** final launch environment (personal local pilot vs hosted multiuser), first supported ATS application family, first supported resume DOCX/PDF combination, consent/retention defaults, career-lane priority for first UAT, and quantitative latency/cost budgets after benchmarking. These are not reasons to stop the initial offline test slice.

# 15. Release Sign-off Template

| Evidence | Owner | Status |
|---|---|---|
| Actual repo audit and dependency map | Engineering | PENDING |
| Gate A full regression and recovery report | Engineering + QA | BLOCKED at last report |
| Consent/security tests | QA | PENDING |
| Gold-set extraction and grounding metrics | ML + QA | PENDING |
| JD AST and eligibility golden cases | Engineering + QA | PENDING |
| ML held-out promotion review | ML + QA | SHADOW / not promoted |
| Fact-grounded tailored ResumePlan | Engineering + candidate | PENDING |
| Independent ATS document recovery | QA | PENDING |
| Authorized READY_TO_SUBMIT offline/live evidence | Engineering + QA | PENDING |
| Final V1 go/no-go | Product owner | NOT READY |

**Definition of Done:** One authorized candidate and a genuinely open JD produce a correct, provenance-backed application-ready resume; the target ATS form is filled and independently read back with approved answers; all hard gates and release tests pass; the automation does not submit the application.

---

# 16. Basis and Change-Control Notes

This PRD synthesizes the user's October 2026 Job Hunter implementation checkpoints and the uploaded **“Job Hunter V1 — Architecture Review & Final End-to-End Design” (October 14, 2026, eight pages)**, plus the agreed subsequent design refinements. The architecture review establishes the four execution frequencies, stage gates, resume claim permission tiers, privacy/security policies, actor attribution, separate DOCX/PDF recovery, local Playwright, and build order. Specific performance and implementation-status claims must be validated against the live repository before treating this document as code evidence.

**Change governance:** Any removal of a mandatory safety or eligibility control must be recorded as an explicit decision with rationale, tests and approver. The PRD is the intended behavior; the implementation audit and test reports are the evidence of what actually exists.

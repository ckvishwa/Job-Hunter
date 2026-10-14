# Job Hunter — Live Delivery Dashboard

**Canonical PRD:** [`PRD.md`](PRD.md) (locked requirements baseline)  
**Source of truth:** [`PROGRESS_LEDGER.json`](PROGRESS_LEDGER.json) (edit here, NOT in this dashboard)  
**Agent contract:** [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md)  
**Status:** 0/49 tasks independently verified; 0/11 phases green.  
**Evidence cut-off:** Reported as of Oct 14 2026; not a live code audit

> 🚦 **Never turn a row green from an agent assertion.** Green is computed only from recorded commit-specific passing tests, independent QA approval, cleared blockers and completed dependencies. This checker validates evidence fields but **cannot establish that the cited tests/logs are genuine**.

## Legend

- ⬜ PLANNED · 🔵 REPORTED_UNVERIFIED · 🟡 IN_PROGRESS · 🟠 QA_REVIEW · 🔴 BLOCKED · ✅ VERIFIED (green)

## Phase overview

| Phase | Workstream | Status | Tasks verified | Dependencies |
|---|---|---|---:|---|
| P0 | Audit, stabilize and recover | 🔴 BLOCKED | 0/10 | — |
| P1 | Secure intake and parser | ⬜ PLANNED | 0/3 | P0 |
| P2 | Resume fact intelligence | ⬜ PLANNED | 0/4 | P1 |
| P3 | Auto-grounding and fact persistence | ⬜ PLANNED | 0/4 | P2 |
| P4 | JD AST, matching and eligibility | ⬜ PLANNED | 0/4 | P3 |
| P5 | Custom ML classifier evaluation | ⬜ PLANNED | 0/4 | P0 |
| P6 | Deterministic ResumePlan | ⬜ PLANNED | 0/4 | P4 |
| P7 | ATS DOCX/PDF and independent recovery | ⬜ PLANNED | 0/4 | P6 |
| P8 | Selective SLM rewriting | ⬜ PLANNED | 0/4 | P7 |
| P9 | Local Playwright application preparation | ⬜ PLANNED | 0/4 | P7 |
| P10 | Release and pilot hardening | ⬜ PLANNED | 0/4 | P0, P1, P2, P3, P4, P5, P6, P7, P8, P9 |

## Next task

**P0-01: Inventory branch/worktree, existing modules, dirty files and unpushed commits** (phase P0).

## Historical foundations (NOT independently confirmed today)

| Component | Earlier report | Current audit |
|---|---|---|
| Astro UI and Node/TypeScript orchestration | WORKING FOUNDATION | 🔵 UNVERIFIED |
| Job discovery (25/30 boards; 5991 jobs at Oct 8 snapshot) | WORKING FOUNDATION | 🔵 UNVERIFIED |
| PostgreSQL and migrations through 0011 | WORKING FOUNDATION | 🔵 UNVERIFIED |
| Qwen2.5:3B local JD extraction integration | WORKING FOUNDATION / QUALITY GAPS | 🔵 UNVERIFIED |
| Relevance ML code and labels | SHADOW / NOT PROMOTED | 🔵 UNVERIFIED |
| ATS final READY_TO_SUBMIT | NOT DEMONSTRATED | 🔵 UNVERIFIED |

## Phase task checklist

### P0 — Audit, stabilize and recover [🔴 BLOCKED]

**PRD references:** PRD §2, PRD §12 P0, G8  
**Exit criterion:** Approved current repo baseline, non-destructive DB check, reproducible accepted Gate A (two clean serial runs or formal rebaseline).  
**Depends on:** None  
**Blocker:** Latest reported full regression Gate A is BLOCKED; current branch/CI must be audited before marking any work complete.  

- [ ] 🟡 **P0-01** — Inventory branch/worktree, existing modules, dirty files and unpushed commits — `IN_PROGRESS`
- [ ] ⬜ **P0-02** — Verify PostgreSQL backup, migrations, data counts, and source board coverage — `PLANNED`
- [ ] 🟡 **P0-03** — Diagnose CI/full-suite Gate A without weakening tests — `IN_PROGRESS`
- [ ] 🟡 **P0-04** — Capture accepted complete regression evidence and baseline commit SHA — `IN_PROGRESS`
- [ ] 🟡 **P0-05** — Dashboard e2e sign-in regression: reproduce, root-cause, fix (6 failing tests in serialized run) — `IN_PROGRESS`
- [ ] 🟡 **P0-06** — Browser-search e2e typing-sequence race: classify test vs product defect and fix without weakening — `IN_PROGRESS`
- [ ] 🟡 **P0-07** — Run services/ai and services/ml pytest suites independently and record results — `IN_PROGRESS`
- [ ] 🟡 **P0-08** — GitHub security baseline: secret/PII scan in CI, branch protection, PR/issue templates, CODEOWNERS — `IN_PROGRESS`
- [ ] ⬜ **P0-09** — Independent local setup and smoke run by QA on a second machine from docs/kt/LOCAL_SETUP.md — `PLANNED`
- [ ] 🟡 **P0-10** — M0 collaboration baseline: governance, notebook, KT package, draft PR — `IN_PROGRESS`

### P1 — Secure intake and parser [⬜ PLANNED]

**PRD references:** FR-0001–0005, FR-0101–0106, G0, G1  
**Exit criterion:** Resume PDF/DOCX upload with consent, isolation, source spans, layout/security checks, passing negative tests.  
**Depends on:** P0  

- [ ] ⬜ **P1-01** — Candidate consent, actor identity, file isolation and upload idempotency — `PLANNED`
- [ ] ⬜ **P1-02** — Build source-span PDF/DOCX parsing contract and FastAPI endpoint — `PLANNED`
- [ ] ⬜ **P1-03** — Test multi-column/DOCX ordering, hidden text, scans and untrusted input — `PLANNED`

### P2 — Resume fact intelligence [⬜ PLANNED]

**PRD references:** FR-0201–0208, G2  
**Exit criterion:** Employment/skill/date associations prove correct against independent gold cases; no invented skill duration.  
**Depends on:** P1  

- [ ] ⬜ **P2-01** — Heuristic line type baseline and role/header/date grouping — `PLANNED`
- [ ] ⬜ **P2-02** — Skill graph aliases, negation, evidence tier and bounded duration — `PLANNED`
- [ ] ⬜ **P2-03** — Benchmark GLiNER Small CPU and selectively integrate only where it helps — `PLANNED`
- [ ] ⬜ **P2-04** — Independent skill/role-binding gold evaluation and edge-case suite — `PLANNED`

### P3 — Auto-grounding and fact persistence [⬜ PLANNED]

**PRD references:** FR-0301–0308, G3  
**Exit criterion:** Source-linked facts, permission-aware routing, append-only events, targeted reviews and safe resume re-upload.  
**Depends on:** P2  

- [ ] ⬜ **P3-01** — Canonical Python schema, generated TS/Zod API validation — `PLANNED`
- [ ] ⬜ **P3-02** — PostgreSQL provenance, fact events, separate claim/review statuses — `PLANNED`
- [ ] ⬜ **P3-03** — AUTO/REVIEW/BLOCK routing with calibrated quality measurement — `PLANNED`
- [ ] ⬜ **P3-04** — Astro just-in-time exceptions, actor attribution and resume V2 diff tests — `PLANNED`

### P4 — JD AST, matching and eligibility [⬜ PLANNED]

**PRD references:** FR-0401–0413, FR-0420–0426, FR-0430–0435, G4  
**Exit criterion:** Official live JD has source-linked requirement coverage, correct three-valued matching and explainable shortlist.  
**Depends on:** P3  

- [ ] ⬜ **P4-01** — ATS/HTTP discovery versioning, deduplication and closure safety — `PLANNED`
- [ ] ⬜ **P4-02** — JD requirement tree AND/OR, required/preferred, source coverage and disputed leaves — `PLANNED`
- [ ] ⬜ **P4-03** — Canonical skills plus semantic retrieval shortlist with partial-JD uncertainty — `PLANNED`
- [ ] ⬜ **P4-04** — TypeScript Kleene evaluator and experience-bound golden tests — `PLANNED`

### P5 — Custom ML classifier evaluation [⬜ PLANNED]

**PRD references:** PRD §7, FR-0421–0422, G4, G8  
**Exit criterion:** Shadow relevance ML evaluated on independent, class-balanced holdout with calibrated accepted-prediction accuracy and coverage; promote only by separate approval.  
**Depends on:** P0  

- [ ] ⬜ **P5-01** — Audit 216 reported label rows, consent, labeling tasks and leakage controls — `PLANNED`
- [ ] ⬜ **P5-02** — Train TF-IDF + Logistic Regression against deterministic baseline — `PLANNED`
- [ ] ⬜ **P5-03** — Evaluate class-wise precision/recall, calibration, abstention and shadow outcomes — `PLANNED`
- [ ] ⬜ **P5-04** — Write promotion/no-promotion decision; do not replace eligibility rules — `PLANNED`

### P6 — Deterministic ResumePlan [⬜ PLANNED]

**PRD references:** FR-0501–0504, FR-0508, G5  
**Exit criterion:** Candidate-authorized source-backed ResumePlan assembled without an SLM and with zero unsupported material claims in mandatory tests.  
**Depends on:** P4  

- [ ] ⬜ **P6-01** — Rank/select grounded roles, skills and original bullets deterministically — `PLANNED`
- [ ] ⬜ **P6-02** — Preserve career chronology and immutable title/employer/date facts — `PLANNED`
- [ ] ⬜ **P6-03** — Astro material-fact approval and provenance-based claim policy — `PLANNED`
- [ ] ⬜ **P6-04** — Create source-linked ResumePlan and gold validation tests — `PLANNED`

### P7 — ATS DOCX/PDF and independent recovery [⬜ PLANNED]

**PRD references:** FR-0601–0607, G6  
**Exit criterion:** Approved single-column DOCX and PDF recover all critical fields and agree with same ResumePlan; report parseability separately from target ATS behavior.  
**Depends on:** P6  

- [ ] ⬜ **P7-01** — Implement tested single-column ATS template and python-docx renderer — `PLANNED`
- [ ] ⬜ **P7-02** — Benchmark/implement Typst PDF renderer from same ResumePlan — `PLANNED`
- [ ] ⬜ **P7-03** — Independent DOCX/PDF parsers validate exact critical fields and order — `PLANNED`
- [ ] ⬜ **P7-04** — Persist artifact hash, parser results and separate ATS verification statuses — `PLANNED`

### P8 — Selective SLM rewriting [⬜ PLANNED]

**PRD references:** FR-0505–0507, FR-0509, G5  
**Exit criterion:** SLM improves selected writing while all claims remain traceable, with bounded retry and fallback; approved on independent adversarial tests.  
**Depends on:** P7  

- [ ] ⬜ **P8-01** — Benchmark existing Qwen2.5:3B and candidate Llama without switching blindly — `PLANNED`
- [ ] ⬜ **P8-02** — Per-bullet constrained rewrite with evidence-only inputs and caching — `PLANNED`
- [ ] ⬜ **P8-03** — Novelty/tense/unsupported material claim rejection, optional NLI benchmark — `PLANNED`
- [ ] ⬜ **P8-04** — Regression tests and fallback to original on invalid rewrites — `PLANNED`

### P9 — Local Playwright application preparation [⬜ PLANNED]

**PRD references:** FR-0701–0709, G7  
**Exit criterion:** Authorized local headed browser correctly uploads, fills, reads back and stops at unexpired READY_TO_SUBMIT; never submits.  
**Depends on:** P7  

- [ ] ⬜ **P9-01** — Inspect ATS fields in user-local headed Chrome and map authorized facts — `PLANNED`
- [ ] ⬜ **P9-02** — Automate allowed field fill/upload, read-back and failure states — `PLANNED`
- [ ] ⬜ **P9-03** — Test offline ATS snapshots, session expiry, sensitive answers and no submit — `PLANNED`
- [ ] ⬜ **P9-04** — QA-verified supervised application reaches READY_TO_SUBMIT — `PLANNED`

### P10 — Release and pilot hardening [⬜ PLANNED]

**PRD references:** FR-0801–0805, PRD §10–15, G0–G8  
**Exit criterion:** Security, privacy, model governance, QA, operations and pilot acceptance all signed off; release decision documented.  
**Depends on:** P0, P1, P2, P3, P4, P5, P6, P7, P8, P9  

- [ ] ⬜ **P10-01** — Trace IDs, idempotency, bounded retries, resource and failure recovery — `PLANNED`
- [ ] ⬜ **P10-02** — Privacy/tenant isolation, deletion, retention and prompt-injection testing — `PLANNED`
- [ ] ⬜ **P10-03** — Re-run complete CI, E2E and performance/QA signoff on final SHA — `PLANNED`
- [ ] ⬜ **P10-04** — Pilot UAT and explicit human product release approval — `PLANNED`

## Update protocol

1. Read `PRD.md` and `AGENT_PROTOCOL.md`. Verify actual branch, HEAD, tests and baseline.
2. Run `python scripts/sync_progress.py --next` and take only a feasible task.
3. Edit **only** task status/evidence in `PROGRESS_LEDGER.json`; never hand-edit this board.
4. Run `python scripts/sync_progress.py --write` to regenerate the board.
5. QA checks the tests and artifacts, then independently marks a task `VERIFIED`.
6. Phase green is computed after every task is verified, dependencies complete, blocker removed and phase QA sign-off saved.
7. Run `python scripts/sync_progress.py --check` in CI and after each status change.

## Scope changes and drift

Never silently delete a PRD requirement. Log changes and approvals in [`DECISIONS.md`](DECISIONS.md), version the PRD, then deliberately update its SHA-256 in the ledger.

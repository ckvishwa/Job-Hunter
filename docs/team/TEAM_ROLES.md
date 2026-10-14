# Team roles

Two people. Both write code and tests; **the author of a change is never its only approver.**

| Role | Person | Owns |
|---|---|---|
| DEVELOPER (technical lead) | repository owner (GitHub `ckvishwa`) | Architecture and ADRs; Fastify API; Astro UI; PostgreSQL and migrations; Python integration; GLiNER integration; classical ML training; Qwen/Ollama; JD interpretation, matching, eligibility; resume planning and tailoring; ATS document generation; local Playwright automation; integration and technical release readiness. Writes unit and integration tests for what they build. |
| HANI (QA automation and ML evaluation lead) | Hani, GitHub username **pending (not provided; do not guess, do not invite)** | Test strategy; API, Playwright E2E and pytest suites; regression, negative and edge cases; migration verification; ML gold-set guidance; precision/recall/F1, calibration and error analysis; résumé factual-integrity tests; DOCX/PDF parser tests; browser field read-back validation; independent QA sign-off; release-blocker tracking. May contribute code (test tooling, fixtures, evaluation scripts) through reviewed branches. |
| PRODUCT_OWNER | repository owner | Scope and ADR decisions; release approval. Never substitutes for QA evidence. |

Review pairing (also encoded as `owner_role` / `reviewer_role` per task in `docs/PROGRESS_LEDGER.json`):
- Hani changes code or test tooling → Developer reviews.
- Developer changes extraction, matching, résumé or automation logic → Hani independently validates (reproduces, adds negative cases, signs off).
- Only `reviewer_role` moves a task `QA_REVIEW` → `VERIFIED`, with commit SHA, command, result and log/CI link in the ledger.

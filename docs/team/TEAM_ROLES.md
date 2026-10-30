# Team roles and reporting structure (final, 2026-10-14)

Two people. Hani reports to the Technical Lead.

| Role | Person | Responsibilities |
|---|---|---|
| **Technical Lead, Principal Developer, AI/ML Architect and Mentor** (ledger role `DEVELOPER`; also acts as `PRODUCT_OWNER`) | repository owner, GitHub `ckvishwa` | Owns product architecture and technology decisions; AI/ML model development (GLiNER, classifier training, Qwen/Ollama, retrieval); full-stack implementation (Fastify, Astro, PostgreSQL, Python services, resume planning, ATS rendering, Playwright); task delegation and integration; ADRs; **production model promotion decisions**; release approval. Mentors Hani and reviews her work. |
| **Senior AI/ML & SDET Intern** (ledger role `HANI`) | Hani, GitHub `Hani456` (collaborator invitation sent 2026-10-14, write access, acceptance pending); reports to the Technical Lead | Shadows AI/ML implementation and learns the underlying technologies; owns automated testing and independent evaluation (writes tests in Vitest, pytest and Playwright, and ML evaluation code); reports defects with reproducible evidence; performs independent verification of the Technical Lead's work; contributes supporting engineering code (fixtures, test tooling, evaluation scripts, small fixes) under mentorship through reviewed PRs. |

## Authority limits
- Hani does **not** independently own system architecture, technology choices, or production ML model promotion. These stay with the Technical Lead unless explicitly delegated in writing (record delegations in `docs/DECISIONS.md`).
- Delegated tasks are small, scoped and reviewed; the Technical Lead assigns them via the ledger and GitHub Issues.
- The author of a change is never its only approver. Hani's PRs are reviewed by the Technical Lead; Hani independently verifies the Technical Lead's tasks. A task becomes `VERIFIED` only with commit-specific evidence from tests that actually ran, recorded by someone other than the author.
- Hani may stop a task from reaching `VERIFIED` by recording a reproduced failure; she may not be pressured to sign off without evidence.

## Where the ownership lives
Per-task `owner_role` and `reviewer_role` in `docs/PROGRESS_LEDGER.json` are the source of truth. Pattern: Technical Lead owns implementation tasks (reviewer: Hani); Hani owns test/evaluation-code and verification-support tasks (reviewer: Technical Lead). ML models are built by the Technical Lead and evaluated by Hani's evaluation code on the frozen held-out set, so implementer and evaluator differ.

## History
This replaces the earlier "Hani as AI/ML implementation owner" arrangement (ADR-0001 amendment A1) and the first "QA lead" wording. See ADR-0001 amendment A2.

# Target architecture

Defined by `docs/PRD.md` (hash-locked) phases P0-P10 and ADR-0002 (local-first). This file maps the target only; it adds no requirements.

Additions over the current state:
- Pydantic to Zod generated contracts (P3-01); GLiNER benchmark and selective use (P2-03).
- Fact-event provenance and AUTO/REVIEW/BLOCK routing (P3).
- Versioned JD requirement AST with OR groups and required/preferred (P4-02); three-valued (Kleene) evaluator with experience bounds (P4-04).
- Relevance classifier promoted only after held-out, per-lane evaluation (P5).
- Source-linked ResumePlan with immutable chronology (P6); python-docx and Typst renderers with independent parsers (P7).
- Constrained per-bullet SLM rewrite with novelty rejection (P8); supervised local Playwright to `READY_TO_SUBMIT` (P9).
- Trace IDs, retries, privacy and deletion, final regression (P10).

Master-prompt "final fixes" that remain valid but are not yet ledger tasks: closed-world switch per fact category (candidate-attested); plan, rewrite, validate, review order with final-text hash; plan staleness through dependency versions; `ontology_version` on facts, reports and plans; `OPERATOR_REVIEWED` status; per-lane classifier metrics with recall floor and coverage. Propose each as an ADR against P4, P6 or P8 before implementing.

Out of scope: Vercel, Supabase, Railway, cloud database, React rewrite, cloud-hosted runtime. Colab only for optional research on non-sensitive data.

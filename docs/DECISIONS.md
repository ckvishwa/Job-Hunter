# Job Hunter — Architectural Decision Log

The PRD is the **product baseline** and `PROGRESS_LEDGER.json` is the **execution source of truth**. No silent PRD scope changes.

## Decision template (copy for each actual change)

### ADR-XXXX — Decision title
- **Date (UTC):**
- **Proposed by / reviewed by:**
- **PRD requirement IDs affected:**
- **Problem and alternatives:**
- **Decision and rationale:**
- **Security, candidate consent and regression impact:**
- **Approval / reviewer:**
- **Implementation commit / test evidence:**
- **New PRD version and SHA-256 (if altered):**

## Recorded decisions

### ADR-0001 — Canonical PRD is the hash-locked execution-pack PRD
- **Date (UTC):** 2026-10-14
- **Proposed by / reviewed by:** Developer (via agent) / pending Hani and Product Owner confirmation
- **PRD requirement IDs affected:** none (no requirement text changed)
- **Problem and alternatives:** Three PRDs existed. (1) `Job_Hunter_Execution_Pack/docs/PRD.md` (sha256 `f308155c...`, locked in the ledger); (2) `Job_Hunter_V1_Full_Pipeline_PRD.md` (sha256 `7fa94c32...`), which differs from (1) in one hunk only, lines 88-127, where (1) has three prose paragraphs and (2) an ASCII pipeline diagram; (3) the older tracked 49-line `docs/PRD.md` ("universal job scanner, four profiles"), a different and earlier product statement.
- **Decision and rationale:** (1) is installed as `docs/PRD.md` because the ledger hash-locks it. (2) is kept as `docs/archive/PRD-V1-with-pipeline-diagram.md` for its diagram only. (3) was moved with `git mv` to `docs/archive/PRD-v0-job-scanner.md` (history preserved) and is superseded. Note the pack README says its PRD was copied unchanged from the V1 file; that is not byte-true (diagram vs prose).
- **Security, candidate consent and regression impact:** none. `.gitattributes` marks `docs/PRD.md` as `-text` so Windows autocrlf cannot break the checksum.
- **Approval / reviewer:** PENDING - Product Owner must confirm that (1) is the intended text.
- **Implementation commit / test evidence:** `python scripts/sync_progress.py --check` passes.
- **New PRD version and SHA-256 (if altered):** unchanged, `f308155c8dcfdf39e09dd7e38d1d9f9f580d40bac6278d1ef28b7df1cb3c60e7`.

### ADR-0002 — Local-first topology is retained; the SaaS/Supabase/Vercel design is not adopted
- **Date (UTC):** 2026-10-14
- **Proposed by / reviewed by:** Product Owner instruction (2026-10-14: "fully local-first, no Vercel, Supabase, Railway") / pending Hani
- **PRD requirement IDs affected:** none
- **Problem and alternatives:** An earlier "Master Prompt" described Vercel + Supabase + RLS + hosted AI; the repo's ARDs and implementation are local (Fastify, Astro, local PostgreSQL, local Ollama, headed Playwright).
- **Decision and rationale:** Keep local-first. `PRD-JOB-HUNTER-SAAS.md`, `SAAS-SYSTEM-ARCHITECTURE.md` and the related root documents are target-state references only and do not authorize cloud migration. Master-prompt fixes that still apply are tracked as PRD tasks (closed-world switch, plan staleness, ontology versioning, OPERATOR_REVIEWED).
- **Security, candidate consent and regression impact:** none; reduces data-exposure surface.
- **Approval / reviewer:** Product Owner (instruction above); Hani review pending.
- **Implementation commit / test evidence:** documentation only.
- **New PRD version and SHA-256 (if altered):** n/a

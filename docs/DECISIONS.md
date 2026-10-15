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
- **Approval / reviewer:** APPROVED by the Product Owner on 2026-10-14 (see Amendment A3).
- **Implementation commit / test evidence:** `python scripts/sync_progress.py --check` passes.
- **New PRD version and SHA-256 (if altered):** unchanged, `f308155c8dcfdf39e09dd7e38d1d9f9f580d40bac6278d1ef28b7df1cb3c60e7`.

#### Amendment A1 to ADR-0001 (2026-10-14, Product Owner instructions in session)
- **PRD text:** canonical choice (hash-locked prose version) is still **pending Product Owner confirmation**; nothing in this amendment confirms it.
- **AI/ML ownership:** AI/ML implementation (GLiNER P2-03, retrieval P4-03, classifier training P5-02, Qwen benchmark and rewrite safeguards P8-01..03) moves to **Hani**; Developer keeps architecture, backend, frontend, DB, resume planning/ATS rendering, Playwright and integration. Independence rule: nobody evaluates their own model. The Developer owns the frozen held-out evaluation (P2-04, P5-03) and reviews Hani's ML PRs; the promotion decision (P5-04) is owned by the Product Owner, reviewed by the Developer. Hani still independently verifies Developer-owned and non-ML work. Ledger `owner_role`/`reviewer_role` and `docs/team/TEAM_ROLES.md` updated. No PRD requirement text changed.
- **Ledger issue references:** GitHub issues #2-#11 map to P0-01..P0-10; the ledger now carries them (`github_issue`), plus `pull_request: 1` for P0-01, P0-08, P0-10. No task is VERIFIED; no QA sign-off exists.
- **PR #1:** stays **draft** until (a) all required CI checks on the PR are green, (b) Gate A has two clean serialized runs recorded in `docs/qa/GATE_A_REPORT.md`, and (c) an independent reviewer (Hani, once her GitHub username is supplied) approves. The Developer may not self-approve for `VERIFIED`.
- **Public author email:** the owner's personal Gmail address appears in the commit headers of all pre-existing commits of the public repository. **Decision recorded: no history rewrite or force-push.** Existing exposure is accepted as a known privacy finding. Whether to switch future commits to the GitHub noreply address is **still an open owner choice**; until decided, new commits use the configured Git identity. Re-open if the owner wants a rewrite (requires explicit approval and coordination with any clones).

#### Amendment A2 to ADR-0001 (2026-10-14, final team-role clarification; supersedes the ownership part of A1)
- **Reporting structure:** `ckvishwa` is Technical Lead, Principal Developer, AI/ML Architect and Mentor. Hani is Senior AI/ML & SDET Intern, reporting to the Technical Lead.
- **Ownership:** the Technical Lead owns architecture, technology decisions, AI/ML model development, full-stack implementation, delegation, integration and **production model promotion**. Hani shadows AI/ML development, writes automated tests and ML evaluation code, reports defects, independently verifies the Technical Lead's work and contributes supporting code under mentorship. Hani has no architecture or promotion authority unless explicitly delegated in this log.
- **Ledger:** `owner_role` and `reviewer_role` reset: Hani owns P0-07, P0-09, P1-03, P2-04, P5-01, P5-03, P7-03, P8-04, P9-03, P10-02, P10-03 (reviewer: Technical Lead); every other task is owned by the Technical Lead with Hani as reviewer (P10-04 owner `PRODUCT_OWNER`). A1's moves of P2-03, P4-03, P5-02, P8-01..03 to Hani are reverted. Task IDs, statuses and evidence are unchanged; nothing is VERIFIED.
- **Unchanged:** local-first architecture (ADR-0002); PR #1 stays draft under the A1 conditions; the public-email decision in A1 stands; `VERIFIED` requires actually-run, commit-specific test evidence and an independent reviewer.

#### Amendment A3 to ADR-0001 (2026-10-14, final owner decisions)
- **ADR-0001 APPROVED by the Product Owner:** `docs/PRD.md` (sha256 `f308155c8dcfdf39e09dd7e38d1d9f9f580d40bac6278d1ef28b7df1cb3c60e7`) is the canonical hash-locked V1 PRD. `docs/archive/PRD-V1-with-pipeline-diagram.md` is preserved as the alternate diagram version and `docs/archive/PRD-v0-job-scanner.md` as the superseded earlier PRD. The "approval pending" lines in ADR-0001 and A1/A2 are resolved by this amendment.
- **Git history and author emails:** historical commits and their public author emails are preserved. No history rewrite, no force-push.
- **Future commits:** switch to the owner's GitHub no-reply address. Applied as repository-local Git config only (`user.email` = `54135438+ckvishwa@users.noreply.github.com`, the documented `<id>+<login>` form; the numeric id was read from the GitHub API for the authenticated account). The owner should still confirm the address under GitHub Settings > Emails; the CLI token lacks the `user` scope so the Settings page could not be read from here. Global Git config and past commits were not changed. The earlier A1 line "noreply switch still open" is closed.
- **Team accounts:** `ckvishwa` = Technical Lead, AI/ML Architect, Principal Developer and Mentor. `Hani456` = Senior AI/ML & SDET Intern, shadowing AI/ML implementation and owning automated testing and independent evaluation. A collaborator invitation (write permission) was sent to `Hani456`; acceptance is pending. Her ledger tasks keep their IDs and responsibilities (A2 list). Issues #8 and #10 get `Hani456` as assignee once she accepts; issues for her other tasks are created when those tasks start, not before.
- **Unchanged:** local-first (ADR-0002); PR #1 stays draft until independent QA and all required checks pass; nothing is VERIFIED without reproducible evidence and independent approval.

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

### ADR-0003 — Internal read-only Project command center inside the existing app
- **Date (UTC):** 2026-10-14
- **Proposed by / reviewed by:** Product Owner decision in session / Developer (via agent); independent review by Hani456 pending
- **PRD requirement IDs affected:** none. The locked PRD, its checksum and every task status are untouched; the dashboard reads them.
- **Problem and alternatives:** The team needs one place to see real phases, task evidence and review queues. Alternatives: (1) keep reading `docs/PROGRESS.md` (static, no filtering, no PRD navigation); (2) a separate editable tracker or database (rejected: a second source of truth would drift from the ledger); (3) an external tool such as Notion (rejected: not local-first, would copy project records off the machine).
- **Decision and rationale:** Add a read-only authenticated API (`/api/v1/project/*`, fixed source files, no write route) and an Astro page `/project` in the existing app. Phase state and evidence rules are a TypeScript port of `scripts/sync_progress.py`, pinned to it by a parity test that runs the Python script on a synthetic ledger and on the real ledger. Only evidence accepted by those rules counts as verified.
- **Security, candidate consent and regression impact:** Reuses the existing session, loopback host guard and no-store headers; no new credential; no candidate or resume data is read. Markdown is rendered with text nodes only. The only change to shared UI is one navigation link; existing routes still build and respond.
- **Approval / reviewer:** Product Owner (scope); QA review pending (ledger task P0-11). The dashboard is not Gate A evidence and does not change Gate A.
- **Implementation commit / test evidence:** branch `feature/project-command-center`, see P0-11 in the ledger.
- **New PRD version and SHA-256 (if altered):** unchanged.

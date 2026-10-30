# Job Hunter — Phase A audit (read-only)

Date: 2026-10-14. Checkout: `.claude/worktrees/universal-job-discovery`, branch `careerops-integration`, HEAD `ba55c90` plus 44 uncommitted paths (ML work, per `.agent-runtime/HANDOFF.md`). `main` (`2d07906`) is a much smaller early version (20 test files / 113 tests, typecheck clean). No application code was modified. Evidence labels follow Master Prompt rule 6.

## 1. Executive summary

The real implementation is `careerops-integration` (142 commits, ~464 files ahead of `main`), not the stack the Master Prompt assumes. It is a **local, single-candidate** system: Fastify API + Astro "Orbital" UI, local PostgreSQL in Docker (migrations 0001–0011), a Python FastAPI resume-extraction service, local Qwen via Ollama (shadow), MiniLM embeddings, an ML/labeling engine in shadow mode, and a Playwright discovery/packet path. There is **no Supabase, Vercel, RLS, Auth, crypto-shredding, job queue, three-valued closed-world engine, GLiNER, or local-agent bundle protocol**. Master Prompt "Gate A FAILED" is stale: typecheck is clean and the suite is 1617 pass / 10 fail in one parallel run, and all 10 pass when their files are rerun alone (load flakes, not logic bugs). Nothing reaches `READY_TO_SUBMIT` against a live form yet. Blockers to release: (a) a topology/scope conflict between the Master Prompt and the repo's own ARDs/CLAUDE.md (section 6), (b) no real independent labels, so every accuracy metric is `NOT_EVALUATED`, (c) the repo is **public** and the author's personal email is in all 143 commit headers.

## 2. Component status (A2)

| Component | Master Prompt said | Verified status | Evidence |
|---|---|---|---|
| Job discovery (Node/TS) | Working foundation | **VERIFIED** (offline) | `src/discovery`, `src/sources`, `src/resolver`; 1617 tests pass; typecheck clean; `main` also 113/113 |
| TS eligibility engine | Boolean, 3-valued proposed | **PARTIAL** | `src/decision`, `src/match/decide.ts`: PASS/FAIL/UNKNOWN hard rules and ELIGIBLE/REJECT/REVIEW exist (`docs/NEXT_TASKS.md` Slice 3); no closed-world switch/attestation (`grep closed-world` empty) |
| PostgreSQL | Operational | **VERIFIED** | container `jobhunter-s1-pg` healthy; `db/migrations/0001–0011` + `down/` |
| Qwen local | Exists, unproven | **PARTIAL** | `src/semantic/ollama-provider.ts`, `src/ml/llm-ollama.ts`, `services/ai/app/qwen_fallback.py`; shadow challenger, fails closed; no tailoring (no rewrite stage found) |
| sklearn relevance classifier | Experimental, 216 rows | **PARTIAL** | `services/ml/ml_train.py`, `src/ml/*`; shadow router `npm run ml:route`; ML mode OFF, no model trained/promoted; label independence UNVERIFIED |
| FastAPI resume extraction | Proposed | **EXISTS** (exists-unverified live) | `services/ai/app/{main,parse_resume,extract_text}.py`, `services/ai/tests`; pytest not run in this audit |
| GLiNER | Proposed | **MISSING** | no reference in src/services/db |
| Astro exception review UI | Proposed | **PARTIAL** | `web/` (Orbital: S1 upload/review, S2 roles, S3 jobs, matches pages); headed e2e tests exist, 6 failed under parallel load, pass in isolation was not re-run for e2e (see section 3) |
| JD requirement tree + coverage | Proposed | **PARTIAL** | `src/semantic`, `src/pipeline`; extraction-coverage attestation by an independent reviewer still open (NEXT_TASKS gate 2) |
| Grounded resume tailoring | Not demonstrated | **MISSING** | no plan/rewrite/validate/render stage in `src/` (V1 Slice 4 not started) |
| ATS document validation | Planned | **MISSING** | none |
| Playwright `READY_TO_SUBMIT` | Not demonstrated | **PARTIAL** | `src/pipeline/application-form.ts`, `src/packet/readiness.ts`, `src/browser`; not demonstrated live; V1 never submits |
| Gate A full regression | FAILED | **PARTIAL / stale claim** | see section 3 |

## 3. Gate A (A3)

Commands: `npm run typecheck` → clean. `npx vitest run` → 140 files pass / 9 fail, 1617 tests pass / 10 fail / 10 skipped. Rerun `tests/api/s1-api.test.ts tests/packet/build.test.ts tests/api/s2-api.test.ts tests/ml/llm-db.test.ts` → 4 files / 93 tests pass.

| Failure | Class | Proposed fix (not applied) |
|---|---|---|
| s1-api upload ×5 (5 s timeouts) | flaky/load | pass alone; run PG-backed files with `--no-file-parallelism`; raise hook timeouts |
| s2-api history append-only, packet/build clause test | flaky/load | same |
| llm-db, review-db (PG) | flaky/load (llm-db passes alone) | review-db not re-run alone; verify |
| orbital-s3 e2e ×3, dashboard/matches-ui/s1-ui e2e | environment (headed Chrome contention) | **not re-verified alone**; `docs/KNOWN_FLAKES.md` already tracks `s1-ui`; run serially and record |
| Label migration (old Supported/Missing vs SATISFIED/…) | none observed | n/a |

The 2026-10-11 serialized run (134 files / 1500 tests) in `docs/STATUS.md` is consistent. A serialized rerun of the e2e/PG group is the missing evidence before calling Gate A green.

## 4. Security and privacy (A4), by severity

1. **Medium — public repo, author personal email in every commit header** (143 commits, `git log --all --format=%ae`). Not in file contents. Decide: accept, or use the GitHub noreply address going forward (history rewrite only if you want it removed).
2. **Medium — no secret/PII scan in CI** (`docs/STATUS.md` NFR-SEC-002 already says so). Branch protection is an owner action, not confirmed.
3. **Low — no secrets found.** Working tree and all history: no key patterns; `infra/.env.example` holds placeholders only; `pool.ts` password hits are env reads. No `private-runtime`, resume PDFs/DOCX, `.env`, `.dump` or `.xlsx` ever committed (`git log --all --name-only`). `.gitignore` covers private-runtime, tmp, resumes, generated files, `infra/.env`, `config/company-boards.json`. Tracked emails are synthetic (`example.com/.test`); the two `sparksoftcorp.com` addresses are from a public JD fixture.
4. **Gap — untrusted text into models:** JD text → Ollama (`src/semantic`, `src/ml/llm-*`), resume text → Qwen fallback (`services/ai/app/qwen_fallback.py`), MiniLM embeddings (`src/match`, `src/nlu`). All shadow/fail-closed; confirm schema-validated-fields-only per rule 2 in a follow-up (not exhaustively traced here).
5. **Gap — Supabase service-role key rule, RLS, signed URLs:** N/A, no Supabase.

## 5. Gap table vs Master Prompt (A5)

| Item | Status |
|---|---|
| Stages 0–3 intake/parse/extract/ground | PARTIAL (S1 candidate workflow; local, no Auth/consent record; PG facts with review states) |
| 4A ingest | DONE for Greenhouse/Lever/Workday adapters + official-board resolver |
| 4B JD tree | PARTIAL; GLiNER MISSING |
| 4C relevance | PARTIAL, shadow only (matches fix 9) |
| 4D retrieval (BM25/MiniLM/RRF) | DONE offline (`src/match/retrieval.ts`) |
| 4E three-valued eligibility | PARTIAL; Kleene/interval/closed-world MISSING |
| 5 tailor / 6 render / 7 local agent | MISSING / MISSING / PARTIAL |
| Fix 1 closed-world | MISSING |
| Fix 2 plan→rewrite→validate→review | MISSING |
| Fix 3 staleness | PARTIAL (decisions/matches invalidate on JD/profile/lexicon change, 0005; no plan STALE) |
| Fix 4 crypto-shredding | MISSING (private-runtime is local files, gitignored) |
| Fix 5 agent protocol | MISSING (local-only, no server) |
| Fix 6 OPERATOR_REVIEWED | MISSING (single user) |
| Fix 7 career lanes | PARTIAL (`src/nlu/lane-and-retrieval.ts`, `UNKNOWN_REVIEW`); per-lane metrics MISSING |
| Fix 8 ontology versioning | PARTIAL (`src/match/lexicon.ts` versioned in input digest) |
| Fix 9, 10, 11 | Followed in practice (shadow ML; V1 narrow) |
| CI / branch protection | CI workflow EXISTS (`.github/workflows/ci.yml`, SHA-pinned); required-check status UNVERIFIED |
| `docs/decisions/` | MISSING (decisions live in `docs/evidence`, `docs/plans`) |

## 6. Conflicts to resolve before Phase B (human decision needed)

1. **Topology.** Master Prompt targets multi-tenant Vercel + Supabase + RLS + hosted AI. The repo's `CLAUDE.md`, `docs/ard/*` and `docs/architecture/SAAS-SYSTEM-ARCHITECTURE.md` build a local, single-candidate assistant with local Postgres and no submission in V1–V3. Per the Master Prompt's own rule, I stopped rather than choose. Options: (A) keep local-first, adopt only the Master Prompt's truthfulness rules and fixes 1–3, 6, 8; (B) proceed to Phases C/D (Supabase/Vercel) as written.
2. **Roadmap numbering.** Master Prompt phases 1–8 vs repo V1 slices 0–6 and S1–S4B. Mapping is needed.
3. **Instruction files.** Root `CLAUDE.md` is untracked on `main`; the worktree has its own tracked `CLAUDE.md`. Reconcile.
4. **Worktree vs main.** `main` lacks all of the above; a merge plan is required.

## 7. Proposed PR sequence (one sentence each; assumes option A, else replace C/D)

1. docs: reconcile Master Prompt with ARDs; add `docs/decisions/` with the topology decision.
2. test: serialize PG/headed-Chrome files and record Gate A green with receipts.
3. chore: add secret/PII scan to CI and confirm branch protection; switch commits to noreply email.
4. feat(decision): closed-world switch (employment attestation, canonical skill answer) with truth-table tests.
5. feat(match): `ontology_version` on facts, reports and plans; lazy re-evaluation.
6. feat(resume): plan → rewrite → validate → review with final-text hash (V1 Slice 4).
7. feat(resume): STALE dependency versioning on plans and readiness downgrade.
8. feat(render): DOCX/PDF render plus independent-parser readability check.
9. feat(ats): Greenhouse form inspect/fill/readback to `READY_TO_SUBMIT`, offline fixture first.
10. feat(lanes): per-lane classifier metrics, recall floor, minimum coverage, IRRELEVANT audit sample.
11. (if B) infra: Supabase migrations, RLS tests, storage buckets, Vercel preview, worker queue.

Not done in this audit: pytest for `services/ai`, per-file rerun of the e2e failures, full git-history PII scan beyond emails/key patterns, exhaustive model-input trace.

## Correction (2026-10-14, later session)

Section 2 and 5 of this audit under-reported two items: a deterministic `ResumePlan`, Chromium-rendered PDF preview with pdfjs text read-back (`src/pipeline/resume-plan.ts`, `src/packet/pdf-text.ts`) and an offline form-fill to `READY_TO_SUBMIT` path (`src/pipeline/application-form.ts`, `src/packet/readiness.ts`) exist. They are PARTIAL, not MISSING (no DOCX renderer, never run live). Also, the "Gate A" statement that failures were "load flakes" was too strong; see `docs/qa/GATE_A_REPORT.md`. Authoritative inventory: `docs/audit/REPOSITORY_INVENTORY.md`.

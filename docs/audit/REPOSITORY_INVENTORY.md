# Repository inventory (Phase A, read-only) — 2026-10-14

Ledger task: P0-01. Evidence is from commands run on this machine on 2026-10-14. Classes: KEEP, MODIFY, CONSOLIDATE, ARCHIVE, GENERATED, SENSITIVE, REVIEW_REQUIRED.

## 1. Git state (before this baseline work)

| Item | Finding | Evidence |
|---|---|---|
| Remote | `origin` = `https://github.com/ckvishwa/Job-Hunter.git`, **public** | `git remote -v`, `gh repo view` |
| Worktrees | (1) `F:/Jobs/Job_Search/job-hunter` on `main` `2d07906`; (2) `.claude/worktrees/universal-job-discovery` on `careerops-integration` `ba55c90` | `git worktree list` |
| Canonical source | worktree (2). `main` is 118 commits behind `careerops-integration` and holds no S1–S4B, ML, web, services or DB code | `git rev-list --left-right --count origin/main...careerops-integration` → `0 118` |
| Remote sync | `careerops-integration` == `origin/careerops-integration` (`0 0`); `main` == `origin/main` | same |
| Other branches | `linkedin-discovery` `e7f38bf` (ON HOLD, access-policy review), `worktree-universal-job-discovery` `b510655` (older, local only) | `git branch -vv` |
| Open PRs | none (`gh pr list --state all` → `[]`) | gh |
| Dirty at start | 16 modified + 30 untracked top-level paths in the worktree (ML engine, migrations 0006–0011, audits, evidence); 20+ untracked governance/SaaS documents and the Execution Pack in the `main` checkout root | `git status --short` |
| Unpushed commits | none at start; this baseline adds commits on `chore/m0-collaboration-baseline` | — |

Safety snapshot (outside the repo, **never commit**): `F:\Jobs\Job_Search\_safety\jh-snapshot-20261014\` — `repo-all.bundle` (all refs), `dirty-and-untracked.tar` (modified + untracked + `private-runtime`), `private-runtime-ignored.tar`, `main-untracked.tar`, `SHA256SUMS`. The two large tars overlap (both contain `private-runtime`, ~2.5 GB each); keep until M1, then the Developer decides what to prune.

## 2. Top-level classification (worktree)

| Path | Class | Notes |
|---|---|---|
| `src/` (223 tracked files) | KEEP | TypeScript: `adapters/ api/ browser/ candidate/ config/ dashboard/ db/ decision/ dedup/ discovery/ domain/ events/ extraction/ hunt/ jobs/ match/ ml/ nlu/ packet/ pipeline/ resolver/ roles/ runner/ semantic/ sources/ storage/ testing/ tracker/` |
| `tests/` (176) | KEEP | Vitest; `tests/e2e/offline` is headed-Chrome |
| `web/` (28) | KEEP | Astro "Orbital" UI; `web/dist`, `web/.astro` are GENERATED |
| `services/ai/` | KEEP | FastAPI resume extractor (+ optional Qwen fallback) |
| `services/ml/` | KEEP (new, committed in `2c958b5`) | scikit-learn trainers, calibration, clustering; `__pycache__` GENERATED |
| `db/migrations/0001–0011` + `down/` | KEEP | 0006–0011 were untracked before `2c958b5` |
| `infra/` | KEEP | Docker Compose PostgreSQL 17, port 55440 loopback |
| `scripts/` | KEEP | `dev-stack.ps1`, `ai-eval.ps1`, new `sync_progress.py` |
| `.github/workflows/ci.yml` | KEEP | SHA-pinned CI; required-check setting UNVERIFIED |
| `.github/workflows/job-hunter-progress-integrity.yml` | KEEP (new) | ledger/PRD integrity |
| `docs/PRD.md`, `PROGRESS_LEDGER.json`, `PROGRESS.md`, `AGENT_PROTOCOL.md`, `DECISIONS.md` | KEEP (new, canonical) | see ADR-0001 |
| `docs/archive/PRD-v0-job-scanner.md` | ARCHIVE | old tracked PRD, moved with `git mv` |
| `docs/archive/PRD-V1-with-pipeline-diagram.md` | ARCHIVE | differs from canonical PRD only by one diagram block |
| `docs/STATUS.md`, `docs/NEXT_TASKS.md`, `docs/WORKFLOW.md`, `docs/V1-GOLDEN-PATH.md`, `docs/S4A-MATCHING.md`, … | CONSOLIDATE | overlapping status text; ledger is now the only verified-state record. Do not edit completion claims here. |
| `docs/evidence/*`, `docs/audit*/`, `docs/ml/`, `docs/learning/`, `docs/testing/` | KEEP | redacted summaries |
| `docs/evidence/orbital-screens/` (4.3 MB PNG) | SENSITIVE / GENERATED | includes profile and résumé screens; now git-ignored; never push |
| `private-runtime/` | SENSITIVE | candidate facts, résumés, DB dumps, model artifacts, browser profiles; git-ignored; ~2.5 GB |
| `data/*.jsonl`, `data/slice1-*`, `data/search-demo` | SENSITIVE / GENERATED | git-ignored |
| `config/company-boards.json` | SENSITIVE (owner's board list) | git-ignored; example file tracked |
| `dist/`, `node_modules/`, `web/node_modules`, `tmp/`, `output/*` | GENERATED | git-ignored |
| `skills/`, `skills-lock.json`, `.agents/`, `.claude/skills` (main checkout) | REVIEW_REQUIRED | agent tooling, untracked in `main`; not part of the product |

## 3. Untracked in the `main` checkout (not part of the worktree)

| Path | Class | Decision |
|---|---|---|
| `Job_Hunter_Execution_Pack/` | CONSOLIDATE | installed into the worktree; original left in place, unmodified |
| `Job_Hunter_V1_Full_Pipeline_PRD.md` | ARCHIVE | copied to `docs/archive`; original left in place |
| `PRD-JOB-HUNTER-SAAS.md`, `SAAS-SYSTEM-ARCHITECTURE.md`, `REQUIREMENTS-TRACEABILITY.md`, `Job-Hunter-*ARD*.md`, `INTEGRATION-README.md`, `Orbital-UI-…-Brief.md`, `AGENT-OPERATING-SYSTEM*.md`, `Job Hunter Master Plan — Final Fixes.pdf` | REVIEW_REQUIRED | SaaS/cloud-oriented; ADR-0002 keeps local-first. Copies of several already exist in the worktree `docs/`. Not pushed from `main`. |
| `company-boards.json` (root) | SENSITIVE | owner's list; do not push |
| `orbital-landing/` | REVIEW_REQUIRED | landing-page prototype, not audited |
| `CLAUDE.md` (root, untracked) vs worktree `CLAUDE.md` (tracked) | CONSOLIDATE | worktree copy is the tracked one; compare before any change |

## 4. Component audit (corrects `docs/audit/AUDIT.md` — see correction note there)

Status labels: VERIFIED = ran it now; EXISTS-UNVERIFIED; PARTIAL; MISSING.

| Subsystem | Status | Code | Tests |
|---|---|---|---|
| Discovery (Greenhouse/Lever/Workday/generic, official-board resolver, checkpoints) | VERIFIED offline | `src/adapters`, `src/discovery`, `src/resolver`, `src/sources`, `src/hunt` | `tests/adapters`, `tests/discovery`, `tests/resolver`, `tests/sources`, `tests/hunt` |
| Candidate intake / facts / review (S1) | VERIFIED offline (PG-backed) | `src/candidate`, `src/api`, `services/ai`, `web/` | `tests/api/s1-api.test.ts`, `tests/candidate` |
| Roles (S2), Jobs (S3), Matches (S4A/B) | VERIFIED offline | `src/roles`, `src/jobs`, `src/match` | `tests/api/s2-api…`, `s3-api…`, `tests/match` |
| JD structuring + deterministic decision | PARTIAL | `src/semantic`, `src/decision`, `src/domain` | `tests/semantic`, `tests/decision`; independent coverage attestation still open |
| Deterministic ResumePlan + Chromium PDF preview + pdfjs text read-back | PARTIAL (corrects AUDIT: not MISSING) | `src/pipeline/resume-plan.ts`, `src/packet/resume-claims.ts`, `src/packet/pdf-text.ts` | `tests/pipeline`, `tests/packet`; no python-docx/Typst, no DOCX |
| Application form fill → `READY_TO_SUBMIT` (offline fixture) | PARTIAL | `src/pipeline/application-form.ts`, `src/packet/readiness.ts`, `src/packet/form-*.ts` | `tests/pipeline/offline-e2e.test.ts`; never live; V1 never submits |
| ML engine (shadow) | PARTIAL, mode OFF, nothing trained/promoted | `src/ml`, `services/ml`, migrations 0006–0011 | `tests/ml`, `services/ml/test_calibration.py` (pytest not yet rerun) |
| Qwen/Ollama | PARTIAL, shadow, fails closed | `src/semantic/ollama-provider.ts`, `src/ml/llm-ollama.ts`, `services/ai/app/qwen_fallback.py` | `tests/ml/llm-*.test.ts` |
| GLiNER | MISSING | — | — |
| Embeddings / BM25 / RRF retrieval | PARTIAL | `src/match/retrieval.ts`, `src/nlu` (MiniLM via `@huggingface/transformers`) | `tests/match`, `tests/nlu` |
| Closed-world switch, OPERATOR_REVIEWED, plan STALE, crypto-shredding | MISSING | — | — |
| CI | EXISTS-UNVERIFIED on GitHub | `.github/workflows/ci.yml` | no workflow run has been inspected |

## 5. Gate A baseline (this session)

See `docs/qa/GATE_A_REPORT.md`. Summary: typecheck clean; parallel run 1617 pass / 10 fail; the first serialized run failed 8 tests (6 dashboard, 1 browser-search, plus one other); each failing file passes alone.

## 6. Privacy findings

1. Author email the owner's personal Gmail address is in all 143 commit headers of the public repo (`git log --all --format=%ae`). Recorded, **not rewritten** (needs explicit approval). New commits should use the GitHub noreply address if the owner chooses.
2. No credentials, `.env`, dumps, résumé files or `private-runtime` ever entered history (`git log --all --name-only` filter). Working-tree and history key-pattern scans: no hits.
3. Two real people's names appeared in a test and an evidence file as résumé filenames; replaced with generic names in `2c958b5`. `git log --all -S` for those names over all history returns 0 commits, so they were never published.
4. `docs/evidence/orbital-screens/` contains profile/résumé screenshots: ignored, not committed.

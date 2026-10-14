# Job Hunter ML upgrade loop

Updated: 2026-10-14 02:57 UTC  
Checkout: `careerops-integration` at `ba55c903e947c67b1336314eed12bd335bd0c32d`  
Working tree: pre-existing ML implementation and unrelated application changes are present; preserve all of them.

## Checkpoint 1 — audit baseline

### ITERATION

1. **AUDIT — in progress.** Verified the specified checkout, `CLAUDE.md`, operating-system instructions, handoff, package scripts, ML source/tests, migrations, private reports, current process list, Ollama model list, and live `ml:status` output.

### IMPLEMENTED

- The checkout contains TypeScript/PostgreSQL ML orchestration, MiniLM embeddings, Python 3.12/scikit-learn trainer and predictor, human-only labels, grouped dataset versions, a shadow path, provisional Ollama labels, and a terminal human review queue.
- The local Ollama inventory contains `qwen2.5:3b-instruct-q4_K_M` (the installed Qwen 2.5 3B quantized model) and `all-minilm:l6-v2`.
- Migration sources 0006–0008 are present. 0006 creates the ML corpus and human-label tables; 0007 makes labels pair-level and adds chunk embeddings/model registry; 0008 adds separate provisional-label/reject tables and human provenance fields. No migration or rollback was run in this iteration.
- A Qwen labeling process was already active (npm PID 67692; child worker PIDs 39524/62400), launched 02:33 UTC as `ml:llm -- run --active 700 --eval 40 --max-minutes 85`. Its log reached 230/885 at 02:57 UTC. Each accepted pass is inserted immediately into `ml_llm_labels`; no interruption or second labeling run was started.

### TESTS

- `npm run ml:status` completed against the live development database.
- Result: mode `off`; 5,986 corpus postings, 25 employers, 216 current human-label rows, 145 current relevance pairs (31 relevant, 51 irrelevant, 62 adjacent, 1 unsure); latest dataset `ds-0003`; `trainable: false`; no registered models; evaluation `NOT_EVALUATED`.
- Earlier evidence file `docs/evidence/ml-engine-v1-run-2026-10-14.md` reports an older state (zero labels and a prior full-suite failure); it is not current evidence.
- `ml:llm -- report` was started read-only for current agreement, leakage, and gate detail; it was still running at this checkpoint because it featurizes the corpus.
- No tests or typecheck have been run in this iteration yet.

### MODEL METRICS

- No production model exists and no model was trained. Accuracy, calibration, accepted-prediction accuracy, and coverage remain `NOT_EVALUATED`.
- A real shadow run is documented in the prior report, but it measures rules versus MiniLM similarity only, not a trained classifier.

### LABEL COUNTS

- Live status: 216 current human-label records and 145 current job-role relevance pairs. Provisional Qwen outcomes are being added separately as the active process proceeds; they are not human labels.
- Exact current split deficits and independent-label provenance audit are pending the live LLM report.

### TRAINING GATES

- Training is refused by the existing workflow until train has at least 25 relevant and 25 irrelevant labels, held-out has at least 10 of each, and at least 3 held-out employers. The live status says `trainable: false`; exact counts are pending.
- Binary training excludes `adjacent` and `unsure`. Dataset code filters held-out rows before writing the trainer input and restricts held-out dataset labels to the independent eval basis when the employer registry is frozen.

### BLOCKERS / AUDIT FINDINGS

- **P1, `src/ml/llm-label.ts` and `src/ml/llm-ollama.ts`:** complete descriptions are clipped at 7,000 characters and sent with `num_ctx=4096`. `jdTruncated` is recorded, but the current active run can therefore produce provisional labels without seeing the full JD. The run is being left intact; a fix must affect future runs and get a regression test.
- **P2, `db/migrations/0008_llm_labels.sql`, `src/ml/llm-repo.ts`:** label rows have an UPDATE/DELETE append-only trigger; reject rows do not. Rejected retries append duplicate rows, and batch failures are not bounded/idempotent in the reject ledger.
- **P2, `src/ml/llm-label.ts`:** quote verification checks content but stores no source span/offset, despite the requested evidence location field.
- **P2, `src/ml/llm-cli.ts` / `src/ml/llm-ollama.ts`:** `--model` and `JH_LLM_LABEL_MODEL` permit any installed local Ollama model. The active run uses the installed Qwen 2.5 3B model; the allowed-model restriction is not enforced in code.
- **P2, `services/ml/ml_train.py`:** grouped train-only CV and class weighting exist, but a separate probability-calibration step is absent; the OOF-selected threshold is not probability calibration.
- The referenced `Orbital-S5-Python-ML-ScikitLearn-PyTorch-Slice.md` was not found in the checkout or repository file list. Python pipeline requirements are being audited against the explicit user directive and current source.
- Existing repository policy says production matching/ranking stays deterministic. Current ML mode defaults off and `shadow` does not alter ranking. Any future activation remains out of scope without explicit promotion approval.
- Rollback files are manual/destructive. In particular, 0007 down contains a `DELETE` for `work_mode` labels, so it is not data-preserving if such rows exist. No rollback was executed.

### NEXT ACTION

Finish the read-only run report and migration/data audit, confirm current worker persistence and final progress, then select the highest-impact safe source fix. Before any database migration, take and verify a fresh authoritative backup. Preserve all human labels and the active run.

## Checkpoint 2 — 2026-10-14T15:40Z (UTC)

ITERATION: Audit and labeler recovery, continuing.
IMPLEMENTED: Required second-pass resume; transient PostgreSQL retry around provisional ledger reads/writes; append-only idempotent rejection ledger (migration 0009). Complete-JD labeler revision llm-label@2-full-jd rejects inputs beyond its conservative byte/context budget, restricts local Qwen 3B, blocks redirects and incomplete generations. Old @1 rows remain unchanged.
TESTS: Earlier 44 targeted tests and typecheck passed. New complete-JD and provider regressions demonstrated red then green (16 unit tests). Current DB integration: 11 passed / 1 failed on arbitrary synthetic row-count lower bound; investigating before broader regression. No production accuracy claim.
MODEL METRICS: NOT_EVALUATED. No model trained or promoted. Mode OFF.
LABEL COUNTS: Live SQL: 216 human rows, all reviewer local, default human_verified, no proposal links. 566 provisional @1 pass rows, including 198 truncated rows. Historical independence is UNVERIFIED, not established by absent proposal links. Earlier dataset ds-0003 has train 22 relevant / 38 irrelevant, heldout 5 relevant / 10 irrelevant, 7 heldout employers; these heldout counts are not yet certified independent.
TRAINING GATES: BLOCKED (at least 3 additional train relevant and 5 additional heldout relevant, plus historical independence verification; more reviews may be needed because labels cannot be predetermined).
BLOCKERS: Missing independent label provenance and insufficient labels. Referenced S5 specification not found. Remaining implementation/audit work continues independently.
NEXT ACTION: Diagnose integration fixture count; fix stale-hash resume and durable run accounting; finish independent implementation and regression. Do not restart the previous worker: it exited with ETIMEDOUT at 470/885; no labeling worker is active.

Backup before applied migration 0009: private-runtime/ml/backups/jobhunter-pre-0009-20261014-0325.dump; 70,125,804 bytes; SHA256 6D0991F03F55EFA996A4971E5A26ABA62479487CD177B4559C5C36ACC4ACC0FB. PGDMP header and pg_restore --list verified. Archive creation 2026-10-14T14:52:37Z (filename timestamp is not authoritative). Migration applied only 0009; applied-source checksum validation passed. No human labels changed. Earlier checkpoint times labelled UTC were actually local and must not be relied on.

## Checkpoint 3 — 2026-10-14T15:54Z

ITERATION: Complete-JD live smoke, calibrated engine, provenance gate, batch review, evidence integrity.
IMPLEMENTED: Full-JD @2 smoke completed (2 pairs/4 passes, 34.742s, 8.671s average call). @3 now requires exact evidence quotes and persists UTF-16 description offsets; prior revisions preserved. Added protected human ledger, safe rollback refusal before deleting work_mode labels or review provenance. Added hash-aware global duplicate skipping, required-B resume, database ownership lock, bounded CLI arguments, atomic per-pass/failure checkpoint. Pinned isolated Python 3.12.13 environment with hashed requirements; explicit production/synthetic/research artifact metadata; train-group sigmoid calibration; invalid grouped folds refuse rather than invent OOF values. Added current-row/provenance admission check, full-description review, offline batch review export/import, three-way router (not yet wired to shadow CLI). Python ML files now included in regression fingerprints.
TESTS: 30 labeler/DB tests passed before evidence change; 21 evidence/router tests passed; 32 migration/API/LLM DB tests passed after migration 0010; 11 Python/Postgres end-to-end tests passed after calibration; 3 Python calibration tests passed; 2 batch-review tests passed. Typecheck passed before latest evidence edits; final rerun pending. Synthetic tests do not establish real accuracy.
MODEL METRICS: No real model. 90% accepted accuracy and useful coverage NOT_EVALUATED. Qwen smoke confirms persistence, not quality; one pair disagreed across passes.
LABEL COUNTS: 216 human rows unchanged. Before/after migration 0010 canonical row checksum: ead578c0475bdcc9aa42a71dd27edd61 (MD5 comparison, not artifact authentication). @1 has 566 pass rows, 198 truncated; @2 smoke has 4 full-JD passes. Historical independence unknown.
TRAINING GATES: Counts remain train22/38 and heldout5/10, but unverified heldout rows cannot pass the new admission check. No real training/evaluation/promotion performed.
BLOCKERS: Human independence confirmation pending async question. Missing independent gold labels; referenced S5 specification absent. Independent coding and tests continue.
NEXT ACTION: Complete lexical/semantic baselines, shadow integration, browser validation, bounded @3 labeling and training-only benchmark; then full serialized regression and smallest honest human queue.

Backup before migration 0010: private-runtime/ml/backups/jobhunter-pre-0010-20261014-1552Z.dump; SHA256 E2919102CC37707C68635DE48F1045947C955935BEA746C0D13D4D59BEC83BDC; pg_restore --list succeeded. Applied forward migrations were not edited. Only 0010 applied in this checkpoint.

Confirmed test flake: generated posting UUIDs influence second-pass/QC selection, invalidating an arbitrary >5 synthetic experiment row assertion. It failed with 5, then passed on a diagnostic fresh-UUID run. Replaced with nonempty plus per-row isolation checks; documented in docs/KNOWN_FLAKES.md.

## Checkpoint 4 — 2026-10-14 (local, session resumed after interruption)

ITERATION: P0 recovery — frozen final-evaluation reservation, stale-test repair, review-batch evidence guard.
BASELINE (verified live): branch careerops-integration, no ML/labeling worker running (process command lines checked), PG container jobhunter-s1-pg healthy; migrations 0001-0010 applied before this session; 216 human label rows, checksum e95c99c8… unchanged after migration 0011; no ml_models rows, no `evaluate` runs, datasets ds-0001..0003.
FILES CHANGED: db/migrations/0011_ml_final_eval_claims.sql (+down); src/ml/repo.ts (claimFinalEvaluation, completeFinalEvaluation); src/ml/workflows.ts (evaluateDataset purpose param, completion record); src/ml/review-batch.ts (proposalOf guard); tests/ml/final-eval-claim.test.ts (new); tests/ml/candidate-registry.test.ts (new); tests/ml/{engine-db,review-db,llm-db,pure,review-batch}.test.ts; tests/helpers/ml-fixtures.ts (connect retry, purgeHumanLabelsForTest).
DEFECT RESOLUTIONS:
 - claimFinalEvaluation: old version did check-then-insert into ml_model_runs under an advisory lock; no test, no deletion guard, no completion state, no synthetic separation. Now an atomic INSERT … ON CONFLICT on ml_final_eval_claims(scope, split_hash) (PK), trigger permits only RESERVED→COMPLETED and forbids DELETE/TRUNCATE/re-key; a crash leaves RESERVED forever. scope 'synthetic' vs 'real' (evaluateDataset purpose arg; CLI always 'real'). 12-way concurrent claim test grants exactly one. Prior-implementation reservations are carried over by the migration (none existed live).
 - "unknown candidate tfidf": TS, Python and DB-constraint candidate lists are consistent in the current tree (tfidf/minilm were added in 0010 + ml_common.py); the error came from a stale pre-sync invocation. Regression test candidate-registry.test.ts pins all three lists together. engine-db tests had stale 3-candidate expectations; updated to 5.
 - 0010 immutability vs corrections: corrections are plain appends (verified by test); only UPDATE/DELETE are blocked. 0011 also blocks TRUNCATE on ml_labels/ml_llm_labels/ml_llm_rejects. Test cleanup now uses a throwaway-DB-only helper.
 - review batch: blind items carry no proposal/state in the HTML payload (test). Bulk "use proposals" now only applies when both passes agreed AND each carries evidence from an untruncated JD. Duplicate (text,role) pairs are already collapsed by the queue (llm-workflows.ts reviewQueue).
TESTS PASSED: tsc --noEmit exit 0; `vitest run tests/ml tests/db` 13 files / 106 tests passed (exit 0) before the review-batch edit; review-batch 3/3 after.
TESTS FAILED: none in this scope. Environment: intermittent Windows loopback ETIMEDOUT/ECONNRESET to 127.0.0.1:55440 under load (KNOWN_FLAKES); test helper now retries connect-phase failures only.
MIGRATIONS: 0011_ml_final_eval_claims applied to dev DB after pg_dump backup private-runtime/ml/backups/jobhunter-pre-0011-20261014-1216.dump (70,132,913 bytes, SHA256 fb5b4124cecdadffae6d1bcd8cd27da3dff54c682d7c54e411a54d96d92f9cb9, PGDMP header + 263 TOC entries via pg_restore --list).
LLM LABEL COUNTS: @1 A324/B242; @2 A2/B2; @3 A9/B8 (one @3 pair has pass A without required pass B). Rejects 217 (QUOTE_NOT_IN_JD dominates). Provisional ≠ human truth.
HUMAN LABEL COUNTS: 216 rows, 145 current relevance pairs: relevant 31, irrelevant 51, adjacent 62, unsure 1. Independence of ALL historical rows is UNVERIFIED (AI-assisted, some excerpt-based); not retro-marked.
DATASET DEFICITS: train relevant 22/25 (need 3), train irrelevant 38/25 ok, held-out relevant 5/10 (need 5), held-out irrelevant 10/10, held-out employers 7/3. Even when counts are met, held-out must be independently re-verified/eval-stream sampled. Training gates NOT satisfied.
MODEL METRICS: NOT_EVALUATED. No model trained on real data; none promoted. Mode OFF.
KNOWN DEFECTS: router.ts not wired into shadow CLI; planner resume/B-pass and changed-hash paths need an explicit regression pass; ~170 QUOTE_NOT_IN_JD rejects suggest Qwen 3B quote fidelity is the limiter for @3 yield.
NEXT ACTION: (1) audit planner resume cases (A-without-B, changed hash, duplicate text, prompt bump) with tests; (2) wire router ML_ACCEPT/LLM_FALLBACK/REVIEW into shadow mode; (3) only then a bounded live Qwen batch (--active 20), single worker, after confirming no worker via process list.
BLOCKERS: independent human verification of the held-out set and ≥3 train-relevant / ≥5 held-out-relevant labels. Minimal human work: independently review (blind, full JD) ~5 eval-stream held-out relevant candidates + 3 train relevant; or re-verify the 5 existing held-out relevant labels blind.

## Checkpoint 5 — 2026-10-14 (local)

ITERATION: Shadow three-way routing wired; full-suite verification.
BASELINE: checkpoint 4 + migration 0011 applied; 216 human rows, checksum unchanged; no worker running.
FILES CHANGED: src/ml/route-shadow.ts (new), src/ml/cli.ts (`route` command, JH_ML_MODE=shadow required, --limit 1..50), package.json (ml:route), tests/ml/route-shadow-db.test.ts (new), tests/api/s3-api.test.ts (migration list now includes 0011).
ROUTING: ML_ACCEPT only for a model with status 'promoted' (human decision); trained/qualifying candidates are never used for acceptance. Otherwise local Qwen with exact-evidence check (LLM_FALLBACK) else REVIEW. Tampered/missing artifact degrades to Qwen/REVIEW. Writes a report only, nothing to the DB. Live smoke (3 postings, local Qwen): 3 REVIEW (Qwen proposed nonbinary/low confidence), 3.7–10.5 s each.
TESTS PASSED: tsc exit 0; tests/ml + tests/db 14 files / 111 tests exit 0; Python unittest 4/4 (PYTHONPATH=services/ml, venv python); s3-api 20/20 after list fix; route-shadow 4/4.
FULL SUITE (npm run test:full, serialized, ~9 min): run 1: 1 file failed (s3-api stale migration list; FIXED). Run 2 (1616 tests executed): 3 failures — s1-api concurrent upload, matches-ui e2e (headed Chrome), review-db "suite failed to run" — all PASS when rerun alone (41 + 1 tests) and via `npm run test:failed` (3 units / 42 tests, 0 failed). Different tests failed in each full run: consistent with the documented Windows loopback ETIMEDOUT/ECONNRESET under load (docs/KNOWN_FLAKES.md), not a reproduced defect. The regression gate still reads FAILED until a clean full run records; NOT claimed green.
TESTS FAILED: none reproducible.
MIGRATIONS: 0001–0011 applied on dev DB.
LLM LABEL COUNTS / HUMAN LABEL COUNTS / DATASET DEFICITS / MODEL METRICS: unchanged from checkpoint 4 (no labeling batch run this session; no model trained; NOT_EVALUATED).
KNOWN DEFECTS: full-suite load flakes above; ~170 QUOTE_NOT_IN_JD rejections limit @3 label yield; one @3 pair has A without required B (resumable by `ml:llm run`).
NEXT ACTION: (1) one more clean `npm run test:full` to clear the gate (reduce load: nothing else running); (2) single bounded `ml:llm -- run --active 20 --eval 0 --max-minutes 30` after process check; (3) human: blind-review eval-stream pairs.
BLOCKERS: independent human verification (see checkpoint 4). No production promotion requested or performed; mode OFF by default.

## Checkpoint 6 — 2026-10-14 (Slice R1, regression root-cause audit)
PHASE: R1. BASELINE: HEAD ba55c90 + uncommitted; migrations 0001-0011; 216 human rows (checksum unchanged). Label reconciliation: 216 = 145 relevance (31 relevant / 51 irrelevant / 62 adjacent / 1 unsure) + 60 seniority + 11 false_positive_admission; one row per (posting, role, task), no edits.
CHANGES: src/testing/fingerprint.ts (ignore private-runtime in data refs), tests/testing/engine.test.ts (regression), tests/api/s1-api.test.ts and s3-api.test.ts (diagnostics, migration list), tests/helpers/ml-fixtures.ts (admin connect retry), docs/testing/V01-REGRESSION-RECOVERY.md, docs/learning/ENGINEERING-PROGRESS.md.
TESTS: tsc exit 0; engine.test 16/16; s3-api 15/15 alone; five full runs, see recovery doc. GATE A: FAIL. No labeling batch started (Gate A not passed). Gate B (DB/ML safety re-verification beyond what was done in checkpoints 4-5) not yet re-run in full.
NEXT ACTION: owner checks Defender/Docker loopback; rerun probe then `npm run test:full` twice.

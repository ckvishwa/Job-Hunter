# Knowledge-transfer plan

Completion is judged by the demonstrations at the end of each module, with evidence in the notebook and ledger (P0-09 for setup).

| # | Module | Format | Demonstrate |
|---|---|---|---|
| 1 | Purpose and scope | 30 min walkthrough of `PROJECT_WALKTHROUGH.md` sections 1-2 | explain the pipeline and why READY_TO_SUBMIT is the end |
| 2 | Architecture tour | open each path in the table: parser, API, DB, discovery, match, packet | name the owning module and test file for 5 given behaviors |
| 3 | Local setup | Hani follows `LOCAL_SETUP.md` alone on her machine | smoke checks pass; every deviation written to notebook |
| 4 | Git and GitHub | create branch, commit, push, draft PR, review comment | a PR using the template |
| 5 | QA automation | read `TEST_STRATEGY.md`; run one Vitest file, one Playwright E2E, one pytest | reproduce the Gate A failures from `GATE_A_REPORT.md` with the stated commands |
| 6 | AI/ML concepts and testing | `PROJECT_WALKTHROUGH.md` section 6; read `docs/ml/ML_EVALUATION_PLAN.md` | compute precision/recall by hand on a 20-row synthetic confusion example; list leakage risks in the 216-label set (P5-01) |
| 7 | ATS and resume testing | section 7; open `tests/pipeline/offline-e2e.test.ts` | write one negative test (invented metric in a bullet is rejected) |
| 6b | ML shadowing | read `src/ml/`, `services/ml/ml_train.py`, `ml_predict.py`, `docs/ML-ENGINE.md`, `docs/ml/ML-UPGRADE-LOOP.md`; the Technical Lead walks the admission, split and frozen-eval ledger (migration 0011) | run `npm run ml:status`; train a toy TF-IDF+LR on **synthetic** data in a scratch venv; explain why the frozen test set is off limits and why the implementer does not evaluate their own model |
| 8 | Shadow session (synthetic data only) | steps below | PR + notebook entry |

## Module 8 hands-on exercise
1. Clone, `npm ci`, start PostgreSQL, `npm run db:migrate`.
2. Run `npx vitest run tests/discovery tests/adapters` and `python scripts/sync_progress.py --check`.
3. Read `tests/candidate` and one `tests/api/s1-api.test.ts` case end to end.
4. Reproduce a failing or flaky case with `JH_UI_DIAG=1 npx vitest run tests/e2e/offline/dashboard.e2e.test.ts`, then in the serialized gate.
5. Branch `qa/regression-<topic>`, add or sharpen one regression test with an independent expected value.
6. Open a PR into `careerops-integration`; the Developer reviews; you review one Developer PR.
7. Add a notebook entry and update your task's ledger evidence (`QA_REVIEW` to `VERIFIED` only for tasks you did not author).

## Completion criteria (all must be shown)
Runs the services; runs the agreed suites; explains the pipeline; reproduces a reported defect; writes or improves an automated test; opens a valid PR; reviews a Developer change; provides reproducible sign-off evidence.

## Growth plan (practical assignments; the Technical Lead mentors and reviews every PR)
Reporting line: Hani reports to the Technical Lead. Progress is shown by merged, reviewed work and ledger evidence, not attendance.

| Stage | Focus | Assignment (ledger task) | Done when |
|---|---|---|---|
| 1. Guided testing | run, read, reproduce | P0-09 set up from `LOCAL_SETUP.md` on her own machine; reproduce the Gate A failures with the commands in `GATE_A_REPORT.md`; pair on `JH_UI_DIAG=1` diagnostics | smoke checks pass; every deviation in the notebook; one defect issue with a reproduction a second person can follow |
| 2. Supervised automation | write tests with review | P0-07 run both pytest suites and record counts; add 3 negative tests to `services/ai/tests` (instruction-like text, year-only dates, sensitive terms); P1-03 hidden-text and multi-column fixtures (synthetic) | PR merged after Technical Lead review; tests fail when the guarded behavior is broken (show a mutation check) |
| 3. Independent verification | verify the lead's work | take one `QA_REVIEW` task where `reviewer_role` = HANI; rerun its command at the recorded SHA; record the result in `docs/qa/QA_SIGNOFF.md` and the ledger | sign-off cites SHA, command, counts; a failing rerun is recorded as a failure, not softened |
| 4. ML evaluation tooling | learn ML by measuring it | P5-01 audit the 216 historical labels (leakage, independence) with the lead; P5-03 write the evaluation script: per-class precision/recall/F1, RELEVANT recall floor, coverage, calibration, per-lane, p50/p95 latency; P2-04 gold fixtures for skill/role binding (synthetic) | script reproduces the lead's reported numbers on the same inputs and flags a deliberately corrupted label set |
| 5. Independently developed automation | own a tool end to end | P7-03 independent DOCX/PDF field-recovery checker; P9-03 offline ATS snapshot tests including no-submit and wrong-upload cases; P10-02 privacy and prompt-injection tests | tools run in the local gate, are documented and reviewed; defects found are filed as issues |

Rules throughout: synthetic data only in notebooks and Colab; never touch frozen evaluation labels; never commit `private-runtime/` or screenshots with personal data; production model promotion and architecture changes go to the Technical Lead.

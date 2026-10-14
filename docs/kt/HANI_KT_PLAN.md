# Knowledge-transfer plan

Completion is judged by the demonstrations at the end of each module, with evidence in the notebook and ledger (P0-09 for setup).

| # | Module | Format | Demonstrate |
|---|---|---|---|
| 1 | Purpose and scope | 30 min walkthrough of `PROJECT_WALKTHROUGH.md` sections 1-2 | explain the pipeline and why READY_TO_SUBMIT is the end |
| 2 | Architecture tour | open each path in the table: parser, API, DB, discovery, match, packet | name the owning module and test file for 5 given behaviors |
| 3 | Local setup | Hani follows `LOCAL_SETUP.md` alone on her machine | smoke checks pass; every deviation written to notebook |
| 4 | Git and GitHub | create branch, commit, push, draft PR, review comment | a PR using the template |
| 5 | QA automation | read `TEST_STRATEGY.md`; run one Vitest file, one Playwright E2E, one pytest | reproduce the Gate A failures from `GATE_A_REPORT.md` with the stated commands |
| 6 | AI/ML testing | `PROJECT_WALKTHROUGH.md` section 6; read `docs/ml/ML_EVALUATION_PLAN.md` | compute precision/recall by hand on a 20-row synthetic confusion example; list leakage risks in the 216-label set (P5-01) |
| 7 | ATS and resume testing | section 7; open `tests/pipeline/offline-e2e.test.ts` | write one negative test (invented metric in a bullet is rejected) |
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

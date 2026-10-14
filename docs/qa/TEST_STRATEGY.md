# Test strategy

| Layer | Command (from package.json) | Needs | Where |
|---|---|---|---|
| Typecheck | `npm run typecheck` | Node 24.13.1 (`.nvmrc`) | CI and local |
| Unit and integration | `npx vitest run` | Docker PostgreSQL for `*-api` and `ml/*-db` tests | local; CI per `docs/sdlc/CI.md` |
| Serialized full gate (Gate A) | `npx vitest run --maxWorkers=1 --minWorkers=1 --no-file-parallelism` | idle machine, headed Chrome, PostgreSQL, Python | **local QA gate** |
| Smart runner | `npm run test:changed`, `test:failed`, `test:full`, `test:status` | none | local; receipts under `private-runtime/test-cache/` |
| Offline headed E2E | `npx vitest run tests/e2e/offline/<file>` (`JH_UI_DIAG=1` prints console and network diagnostics) | `cd web && npm ci && npm run build` first | local |
| Python | `cd services/ai && python -m pytest`; `cd services/ml && python -m pytest` | venv per `services/ai/README.md` | local (CI candidate) |
| Ledger | `python scripts/sync_progress.py --check` | Python | CI and local |

Rules
- Synthetic fixtures only in CI. Never weaken an assertion or raise a timeout to hide a failure.
- Classify every failure as application, test, or environment defect. Run the failing file alone, then in the serialized gate, then repeat to expose intermittency.
- `docs/KNOWN_FLAKES.md` is for failures that vanished with no code change; add the exact test, command and timings.
- Expected results come from reviewed fixtures or labels, never from the algorithm under test. Never edit frozen evaluation labels to improve a metric.
- Heavy headed-browser suites stay in the local gate; a hosted runner cannot reach local Ollama, private PostgreSQL or Windows browser state.

## Tiers (see `docs/sdlc/CI-TIERS.md`)
| Event | Run |
|---|---|
| Local small change | `npm run typecheck` + related tests / `npm run test:changed` |
| Local Python/ML change | relevant pytest module |
| Browser feature change | targeted Playwright file |
| Draft PR opened or updated | fast tests, static, gitleaks, dependency audit, ledger check (headed Chrome skipped; the `CI gate` message says FAST ONLY) |
| PR marked Ready for review | full headed Linux and Windows |
| Ready PR updated | full on the new SHA |
| Push to `careerops-integration` or `main` | full release CI |
| Manual `workflow_dispatch` | full headed regression |

A green gate on a draft is **not** a Gate A pass. The gate reads the PR's current draft state from the API and fails closed. `npm run test:fast` is an explicit smoke subset (24 files, 378 tests, no Chrome, no database) and never replaces the full suite.

# CI tiers: rapid development, full release verification

This amendment intentionally avoids repeated headed Chrome tests during draft-PR development. The workflow code in `.github/workflows/ci.yml` is authoritative.

| Trigger | Static/security + fast tests | Full headed Linux & Windows | Acceptance |
|---|---|---|---|
| Draft PR opened / synchronized | required | SKIPPED | Fast-only; never Gate A green |
| Draft PR marked Ready for review | required | required | Full CI gate only when all pass |
| Ready PR synchronized | required | required | Full recheck for changed SHA |
| Push to `careerops-integration` or `main` | required | required | Full regression |
| Manual `workflow_dispatch` | required | required | On-demand full regression |

### Commands

- `npm run typecheck`: TypeScript only
- `npm run test:fast`: small deterministic browser-free tests in `tests/ci`, `tests/config`, `tests/dedup`, `tests/domain`, `tests/decision`, `tests/roles` and `tests/ml/pure.test.ts`
- `npm run test:changed`: existing dependency-fingerprinted local testing; previously passing receipts are not new test executions
- `npx vitest run tests/e2e/offline/dashboard.e2e.test.ts`: targeted headed UI debug
- `npm test`: fresh full Vitest suite including headed Chrome
- `npm run test:full`: existing cache-aware local engine; distinct from GitHub's fresh full suite
- Python service pytest suites require their documented environment and must be run as part of Gate A

### Safety and proof

The fast suite is an **explicit smoke subset**, not a claim that all unit/integration tests passed. It should be expanded only with demonstrably browser-free tests. No automatic test exclusions affect the required full suite. Draft PRs cannot be merged; the same required check name `CI gate` remains. The draft check summary says FAST ONLY. Once a PR becomes ready, `ready_for_review` triggers a new run, and the gate fails unless both headed platforms succeed. After further commits, the ready PR reruns full checks. Never mark ledger tasks or Gate A VERIFIED based only on the fast check. First verify real GitHub Actions behavior for both draft and ready cases before considering this change adopted.

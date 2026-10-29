# CI tiers: rapid development, full release verification

This amendment intentionally avoids repeated headed Chrome tests during draft-PR development. The workflow code in `.github/workflows/ci.yml` is authoritative.

| Trigger | Static/security + fast tests | Full headed Linux & Windows | Acceptance |
|---|---|---|---|
| Draft PR opened / synchronized | required | SKIPPED | Fast-only; never Gate A green |
| Draft PR marked Ready for review | required | required | Full CI gate only when all pass |
| Ready PR synchronized | required | required | Full recheck for changed SHA |
| Push to `careerops-integration`, `main` or `recovery/**` | required | required | Full regression |
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

### Fail-closed amendment (Technical Lead review of PR #12)
The `CI gate` job reads the pull request's **current** draft state through the GitHub API instead of trusting the event payload. A re-run of an old draft-time workflow after the PR became ready therefore cannot pass without both headed jobs succeeding (skipped headed jobs on a non-draft PR fail the gate). If the draft state cannot be read, the gate fails. Manual (`workflow_dispatch`) and push runs always require both headed platforms. To prove a full pass while a PR stays a draft, trigger the workflow manually on the branch.

### Verified behaviour on GitHub Actions (2026-10-14)
| Test | Evidence | Result |
|---|---|---|
| A. Draft PR | PR #1 run 38640863205 (SHA `00d86e9`) and probe PR #13 draft run 38641092817 | Fast tests, static/build, gitleaks, dependency audit and ledger integrity ran; both headed jobs `skipped`; gate log: `current PR draft state: true` ... `FAST-ONLY PASS (draft PR): headed Chrome was NOT run. This is NOT a full Gate A pass.` |
| B. Manual full CI | `workflow_dispatch` run 38641035560 on `chore/m0-collaboration-baseline` (SHA `00d86e9`) | success; Linux headed 131 s, Windows headed 225 s; full gate passed |
| C. Ready for review | probe PR #13 (closed unmerged, branch deleted) run 38641659563 after `gh pr ready` | success; Linux headed 137 s, Windows headed 262 s; full gate passed |
| D. Fail closed | probe PR #13: re-ran the old draft-time run 38641092817 after the PR became ready | headed jobs `skipped` (stale payload) but gate read `current PR draft state: false` and **failed**: `CI gate FAILED: required full headed test job did not succeed`. Side effect: the re-run shares the concurrency group and cancelled the in-flight ready run, which is why Test C was repeated. |

Runtime (wall clock, GitHub): before, every PR push ran the full suite: run 38637158898 took 241 s (Linux 137 s, Windows 231 s). After, a draft push takes 52 s (fast 24 s, static 40 s). Ready, push and manual runs are unchanged (about 130-140 s Linux, 225-265 s Windows). The saving applies only to draft pushes; headed suites and dependency installs in the full jobs were not changed or reduced.

The probe PR #13 was a throwaway; nothing from it was merged. A green gate on a draft remains fast-only evidence.

### JH-REPO-001 R6.3 changes (2026-10-29)
- **Fast tier** (every push; also the only tier on draft PRs): in addition to typecheck, build, `ci:isolation -- static`, `ci:private-tree` and `test:fast`, the static job now runs `node scripts/check-markdown-links.mjs` (broken links, core references, and every doc under `docs/` reachable from `docs/INDEX.md`) and `python3 scripts/sync_progress.py --check` (locked PRD checksum and ledger).
- **Full tier** (ready PRs, pushes, manual runs): the Linux job now has a PostgreSQL 17.6 service container with CI-only credentials, writes a gitignored `infra/.env`, applies the migrations to the empty database (`npm run db:migrate`), builds an isolated ML interpreter from `services/ml/requirements.lock` outside the checkout (`JH_ML_PYTHON`), and then runs the whole suite under Xvfb in headed Chrome. The DB-backed suites therefore run in CI instead of skipping. The Windows job has no service containers, so DB suites still skip there.
- **Offline guarantee** is unchanged: the browser tests route every non-loopback request to an abort and count it; the workflow has no secrets.
- **Decision (headed E2E, OWNER MAY VETO):** keep the existing real headed Chrome on both a Linux runner (`xvfb-run`) and Windows, rather than a local-only gate. A headless CI run does not satisfy the headed gate, and neither platform is headless here. `CI gate` stays the single required status check.
- Draft PRs still get the fast tier only; marking ready runs the full tier.

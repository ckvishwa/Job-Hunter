# Continuous integration (SDLC-T01)

> **Updated CI tiers (Oct 2026):** draft PRs now run fast checks only. A Ready-for-review PR or explicit full run runs Linux and Windows headed E2E. A draft's passing `CI gate` is **NOT a full Gate A pass**. See [CI-TIERS.md](CI-TIERS.md). The old full-on-every-PR description below is historical context.

**Status:** implemented and verified **locally**; **UNVERIFIED on GitHub** (no push, no workflow run, no branch protection has been authorized or performed). Policy context: `docs/AGENT-OPERATING-SYSTEM.md` §5, backlog ticket `SDLC-T01` in `docs/audit/2026-10-09-backlog.md`.
**Scope:** CI only. Nothing here deploys, publishes, releases, uploads artifacts or contacts an employer. It does not change any V1–V5 application-safety gate or the DRAFT status of the PRD, and it is not UAT.

## Workflow

`.github/workflows/ci.yml` — triggers: `pull_request` and `push` for `careerops-integration` and `main`, plus manual `workflow_dispatch`. Permissions: `contents: read` only. No job references a repository secret; no job uses `pull_request_target`; every checkout uses `persist-credentials: false`. Actions are pinned to full commit SHAs (`actions/checkout` v4.4.0, `actions/setup-node` v4.4.0). Node is pinned by `.nvmrc` (24.13.1, the version the suite is developed on). Superseded runs of the same ref are cancelled.

| Job | Runner | Commands | Fails when |
|---|---|---|---|
| `static` | ubuntu-latest | `test ! -e private-runtime`; `npm ci`; `git diff --exit-code -- package-lock.json`; `npm run typecheck`; `npm run build`; `npm run ci:isolation -- static` | `private-runtime` exists in the checkout, the lockfile and `package.json` disagree or install mutates the lockfile, a type error, a build error, or a test source that reads private candidate data |
| `test-linux` | ubuntu-latest | `npm ci`; `npm run ci:isolation -- before`; `npx playwright install --with-deps chromium chrome`; install Xvfb; `xvfb-run … npm test`; `npm run ci:isolation -- after` | any test fails, or the run creates `private-runtime` or leaves the checkout dirty |
| `test-windows` | windows-latest | `npm ci`; `npm run ci:isolation -- before`; `npx playwright install chromium chrome`; `npm test`; `npm run ci:isolation -- after` | same as above |
| `secret-scan` | ubuntu-latest | gitleaks 8.30.1 (pinned, sha256-verified) `detect` over full history, then `detect --no-git` over the checked-out tree, both with `.gitleaks.toml`, `--redact`, `--exit-code 1` | any default-ruleset secret, a tracked private-candidate path, an absolute user-home path, or session material |
| `dependency-audit` | ubuntu-latest | `npm ci --ignore-scripts`; `npm run ci:audit` | see the triage policy below |
| `ci-gate` | ubuntu-latest, `if: always()` | passes only if every job above reports `success` (skipped or cancelled counts as failure) | any needed job did not succeed |

`CI gate` is the single check name intended for branch protection (owner action, see "Next action").

## Browser and runner compatibility

The suite launches **real headed Google Chrome** (`channel: "chrome"`) against loopback fixtures, and one test uses Playwright's bundled Chromium (revision pinned by the lockfile's Playwright 1.62.0). It therefore needs a display on Linux. The launcher already has a Linux code path (`ps`-based profile ownership). No test was skipped, excluded or weakened to obtain a green result; `docs/KNOWN_FLAKES.md` lists the four headed-Chrome flakes seen so far (the fourth appeared in the first clean-clone full run on Windows, passed alone twice and passed on the repeated full run).

| Environment | Result | Evidence quality |
|---|---|---|
| Windows 11, Node 24.13.1 (developer machine) | typecheck, build and full suite pass: 96 files / 1,061 tests | Local, real. |
| Ubuntu 24.04.5 container, Node 24.13.1 (checksum-verified), non-root `runner` user with sudo, `npx playwright install --with-deps chromium chrome` (Google Chrome 155.0.8059.39), Xvfb 1920×1080×24 | `npm ci`, lockfile unchanged, typecheck, build, isolation checks and full suite pass under `xvfb-run`: 96 files / 1,061 tests | Local reproduction of the Linux job. Approximation: Docker Desktop container with `seccomp=unconfined` and `--ipc=host`, not the GitHub-hosted image, so Chrome version and sandbox behavior on `ubuntu-latest` can differ. |
| GitHub-hosted `ubuntu-latest` / `windows-latest` | **UNVERIFIED** | No workflow has run. |

If a hosted runner cannot run headed Chrome reliably, the documented fallback (AOS §5) is an isolated self-hosted Windows runner without candidate secrets; do not make the browser jobs required until several consecutive green runs exist.

## Security and privacy protections

- **No secrets, no write token, no privileged PR context**: `permissions: contents: read`, `pull_request`, no `secrets.*`, no `pull_request_target`, no cache restore of private data, no artifact or screenshot upload (a workflow that uploads logs or browser traces could publish data; none does).
- **No private candidate data in CI**: a fresh checkout has none; `ci:isolation before` asserts `private-runtime` is absent, `ci:isolation after` asserts the run created no `private-runtime` and left the tree clean, and `ci:isolation static` fails when any file under `tests/` reads `private-runtime` candidate paths, reviewed profiles or registries, the user's real browser or home state (`APPDATA`, `os.homedir()`), or a real credential variable. Matches are reported by file and line only. The offline end-to-end test builds its profile, registry and résumés synthetically in a temporary directory.
- **Secret scanning**: gitleaks, a maintained tool, at a pinned version with a verified checksum. `.gitleaks.toml` extends the default ruleset and adds three repository rules: tracked paths reserved for private candidate data or browser state, absolute user-home paths, and cookie/session material. Findings are redacted in logs.
- **History**: published history is not rewritten. The scan found one historical finding class (a local Windows account name in a launcher test fixture added in `db2cbce`, 2026-07-28), which is recorded by fingerprint in `.gitleaksignore` with a comment; the current tree now uses a synthetic name. Operators who consider that identifier sensitive should decide separately whether to rewrite history; this task did not.
- **Dependency advisories**: see below. `npm ci --ignore-scripts` is used where install scripts are not needed.

### Dependency advisory triage (policy)

1. **Production dependencies** (`npm audit --omit=dev`): any advisory of moderate or higher **fails**; no allowlist. (Current: 0.)
2. **All dependencies:** a **critical or high** advisory **fails** unless `.github/audit-allowlist.json` lists its advisory id with a reason, an owner, a remediation and an `expires` date. An expired entry fails again; an entry matching no advisory is reported for removal.
3. **Moderate and low** advisories in development tooling are listed in every run (never silent) and do not fail.
4. **Audit unavailable** (registry unreachable, unparseable output) **fails**; it never passes by default.
5. The allowlist is a reviewed exception list, not an acceptance of risk by a coding agent: the owner must review each entry.

Current state (2026-10-09): production 0; development 8 advisories — 3 critical (`vitest` 1139528, `tinypool` 1241260 and 1241261), 3 high (`vite` 1123525, `nanoid` 1139427, `source-map-js` 1241209), 5 moderate (reported). All 6 critical/high advisories are in the test toolchain, are allowlisted until **2026-11-13** with the exposure reasoning in the file, and are scheduled for remediation in ticket `SDLC-T08` (upgrade `vitest` to the next major, which is a breaking change, and apply the non-major `npm audit fix` for `nanoid` and `source-map-js`). The gate is a *drift* gate: a new advisory can turn CI red without any code change.

## Failure-gate evidence (local, controlled, never committed)

Each experiment ran inside a throwaway copy of the repository in the Ubuntu container using exactly the commands the workflow runs, with synthetic faults, then restored. Script: not committed (container-only); results below are verbatim from the run (26 checks, 26 as expected).

| Gate | Injected fault | Observed |
|---|---|---|
| Typecheck | a file with `const x: number = "…"` | `npm run typecheck` exit 2; exit 0 after removal |
| Tests | a test with `expect(1).toBe(2)` | `vitest run` exit 1 |
| Build | `dist` replaced by a file (build-only fault) | `npm run build` exit 2 while typecheck still exit 0; build exit 0 after restore |
| Secret scan — tree | uncommitted file with a randomly generated GitHub-token-shaped string | `gitleaks detect --no-git` exit 1 |
| Secret scan — history | the same string committed | `gitleaks detect` exit 1; clean (exit 0) after reset |
| Private-path rule | `private-runtime/…json` committed | exit 1 (`private-candidate-artifact-path`) |
| Home-path rule | a document containing a Windows user-profile path | exit 1 (rule `local-user-home-path` confirmed in the report) |
| Dependency gate | empty allowlist; allowlist with past expiry | `ci:audit` exit 1 in both; exit 0 restored |
| Isolation guard | test reading a private candidate path; stray file after a run; `private-runtime` present before a run | `ci:isolation` exit 1 in all three |
| `CI gate` job logic | results strings with a failure, a skip, a cancellation | script exit 1 in all three; exit 0 for all `success` |

The gate scripts' decision logic is also unit-tested offline (`tests/ci/ci-gates.test.ts`, 12 tests, in the normal suite). These experiments prove the **commands** return failing exit codes; they do not prove that GitHub marks a workflow run failed or blocks a merge, which requires a real run and branch protection (UNVERIFIED).

## Local reproduction

```sh
npm ci
npm run typecheck && npm run build
npm run ci:isolation -- static
npm test
npm run ci:audit
# secret scan: install gitleaks 8.30.1, then
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner --exit-code 1
```

## Known risks and limits

- Headed-Chrome flakes under load are possible (`docs/KNOWN_FLAKES.md`); there is no automatic retry. Decide a retry/quarantine rule before the browser jobs become required (backlog `SDLC-T06`).
- Google Chrome is installed by Playwright at the then-current stable version; a Chrome upgrade can change behavior without a code change.
- `dependency-audit` depends on the npm advisory database and registry availability.
- No coverage measurement yet (backlog `SDLC-T05`); this workflow does not claim coverage.
- Branch protection, required checks, GitHub secret scanning/push protection and Dependabot are repository settings; none was changed.

## Next action (owner / governance)

After a first real workflow run is authorized and observed green on `careerops-integration`: in repository settings, require the status check **`CI gate`** (and optionally the individual jobs), require pull requests and block force-pushes on `careerops-integration` and `main`, and enable GitHub secret scanning with push protection and Dependabot alerts. Then verify with a deliberately failing pull request that the merge is blocked. These are backlog items `SDLC-T02` and `GOV-01`.

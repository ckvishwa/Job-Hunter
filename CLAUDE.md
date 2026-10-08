# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Playwright-based job search automation. Discovers job postings against official company career pages (Fortune-500-style registry) plus optional generic job portals, filters/dedupes/resolves them to canonical postings, classifies eligibility (seniority/years) and location, scores them deterministically, and produces a ranked daily report. No LLM matching anywhere — every decision (relevance, eligibility, location, score) is a deterministic rule over stored evidence, never fabricated.

## Commands

```bash
npm run typecheck                       # tsc --noEmit
npm test                                # vitest run (whole suite)
npx vitest run tests/hunt/eligibility.test.ts   # single test file
npx vitest run -t "some test name"      # single test by name
npm run build                           # tsc -p tsconfig.json -> dist/

npm run hunt -- --profile sdet --location "United States"   # the daily hunt command (see below)
npm run discover                        # underlying multi-source discovery/resolution pipeline
npm run collect                         # older, single-adapter-per-site pipeline (src/runner)
npm run dev                             # src/index.ts, a minimal Phase-1 wiring demo, not a real entrypoint
```

`npm run hunt` and `npm run discover` both launch a real (non-headless) persistent Chrome profile (`.chrome-profile/`) and can trigger a CAPTCHA/anti-bot pause that blocks on a `readline` stdin prompt until a human presses Enter in the terminal — don't run these unattended/in a background job without accounting for that (see `src/browser/verification.ts`).

Tests mirror `src/` 1:1 under `tests/` (e.g. `src/hunt/eligibility.ts` → `tests/hunt/eligibility.test.ts`). New code should follow that pattern.

## Architecture

There are three generations of pipeline in this repo, still all present:

1. **`src/runner/` + `src/adapters/`** (`npm run collect`) — the original per-site pipeline. `SourceAdapter` implementations (`greenhouse.ts`, `lever.ts`, `workday.ts`, `generic-playwright.ts`) each `discoverJobs()` → `fetchJobDetails()` → `normalize()` into a `JobPosting`, driven by `config/sites.yml`.
2. **`src/discovery/` + `src/resolver/`** (`npm run discover`) — the current multi-source discovery/resolution pipeline, orchestrated by `src/discovery/orchestrator.ts::runDiscover()`. This is the one the hunt command drives.
3. **`src/hunt/`** (`npm run hunt`) — a reporting/decision layer on top of (2): eligibility, location normalization, freshness, scoring, and the ranked HTML/CSV/JSON reports. Never touches discovery/resolution logic itself.

### Discovery pipeline (`src/discovery/orchestrator.ts`)

Per run, for each **source** × **role keyword**:
1. Resolve a `PortalDiscoveryAdapter` via `src/discovery/registry.ts` (`company-careers`, `google-jobs`, `indeed`, `monster`, `linkedin-public`, or a config-driven `generic` portal). All of google-jobs/indeed/monster/linkedin-public ship `enabled: false` in `config/portals.yml` and must stay that way — the only source actually meant to run is `company-careers`.
2. `company-careers` (`src/discovery/adapters/company-careers.ts`) iterates `config/fortune500-registry.json` — a registry of companies with `atsType` (greenhouse/lever/workday/generic) and verified ATS-specific fields. A company is **skipped, never guessed**, if its registry entry lacks the verified fields its ATS type needs (e.g. Workday needs `atsWorkdayHostname`/`atsWorkdaySite`; generic needs verified CSS selectors). Progress is tracked per-company via `checkpoint.completedCompanyKeys` (keyed by `company::corporateDomain`, not array index), so a partial-failure run resumes correctly.
3. Every discovered listing goes through `src/discovery/relevance.ts::evaluateRelevance()` **before** it's written anywhere — matches against `config/roles.yml` keyword phrases (exact substring) or profile-specific domain-qualifier tokens (STRONG: safe alone in title/department; WEAK: title only counts if paired with a real tech role word, to avoid false positives like "Corporate Security Guard" or "Account Executive, Cloud Platform Sales"). Rejected listings leave no trace beyond a counter.
4. Retained listings are resolved (`src/resolver/posting-resolver.ts`) to their canonical/official posting with bounded concurrency + per-job timeout (`src/discovery/resolve-phase.ts`) — one slow job can never stall the whole run; timeouts/errors produce a placeholder JobPosting prefixed with `UNRESOLVED_PLACEHOLDER_PREFIX`, never silently dropped.
5. Resolved jobs are merged into `data/jobs.jsonl` via `src/dedup/deduplicator.ts::mergeJobs()` — matches on canonical URL, then `source::requisitionId`, then `company+title+location`, then a description fingerprint (`src/dedup/fingerprint.ts`), in that priority order. A match preserves the original `discoveredAt` (first-seen) and advances `lastSeenAt`; a non-match is a fresh insert. Checkpoints and incremental saves mean an interrupted run loses at most the one job in flight.

Config: `config/sites.yml` (per-site adapter config for the collect pipeline + generic-portal sites.yml entries), `config/portals.yml` (portal-type discovery adapters, each independently enable-able), `config/roles.yml` (profile → keyword list; profiles are `sdet`/`security`/`cloud`/`network`, fixed in `src/types.ts`), `config/fortune500-registry.json` (+ `.validation.json`, a separate validation-only registry never mixed with production data — used for controlled live-testing of the pipeline itself).

### Hunt layer (`src/hunt/`)

Given `data/jobs.jsonl`, `npm run hunt` runs each job through, in order:
1. `eligibility.ts::classifyEligibility(title, descriptionText)` — seniority-word rejection reads **title only** (never the JD body — a JD mentioning "you'll work with senior engineers" must never cause rejection); numeric years-of-experience rejection (>4 years) reads descriptionText only, and requires the word "experience" near the number to avoid false-triggering on unrelated boilerplate ("Founded 20 years ago...").
2. `location.ts::parseLocation()` — splits into city/state(US 2-letter)/country vs. a separately-tracked remote/hybrid/onsite/unknown work arrangement. These are independent: a remote job with no stated country stays `country: null`, never silently defaulted.
3. `freshness.ts::computeFreshness()` — isNew/isUpdated/isStale/postingAgeDays against `data/hunt-state.json`'s per-profile `lastSuccessfulHuntAt` marker (`hunt-state.ts`).
4. `scoring.ts::scoreJob()` — 0–100 breakdown from only already-stored evidence (matched keywords, eligibility tier, location/remote alignment, JD completeness, freshness, official-link verification), with penalties for unclear requirements or unresolved JDs. Never called "AI scoring" or resume matching.
5. `report-rows.ts::buildReportRows()` — runs the filter pipeline above, ranks (score desc, then posting age, then title, for determinism), applies `--limit`, and tracks per-stage rejection counts.
6. `writers.ts` — emits `output/latest-jobs.{json,csv,html}`. The HTML is a single self-contained file (no CDN/external refs) with client-side search/sort/filter and new/updated/unresolved/stale badges; any URL rendered as an `href` (e.g. `applyUrl`) is scheme-validated (http/https only) since it originates from scraped/resolved third-party data.

`run-hunt.ts::runHunt()` ties it together: calls the existing `runDiscover()` unchanged, reloads `jobs.jsonl`, filters to the requested `--profile`(s), builds report rows, writes reports, prints top 10, and (outside `--dry-run`) advances the per-profile hunt-state marker.

### Data files (gitignored, regenerated by running the pipeline)

- `data/discovered-jobs.jsonl` — every retained (post-relevance) raw discovery, append-only.
- `data/jobs.jsonl` — deduplicated, resolved `JobPosting` records; the hunt layer's input.
- `data/checkpoints.json` — per source/keyword/location (and per-company for `company-careers`) resume state.
- `data/hunt-state.json` — per-profile `lastSuccessfulHuntAt`, the freshness baseline for the next hunt run.
- `output/latest-jobs.{json,csv,html}` — the hunt command's reports.

### Verification/anti-bot handling

`src/browser/verification.ts::detectVerification()` heuristically detects CAPTCHA/anti-bot pages (reCAPTCHA, hCaptcha, Cloudflare, PerimeterX, DataDome, generic "verify you are human" phrasing) — never attempts to solve or bypass anything, only pauses (`pauseForVerification`) and waits for a human to complete it manually in the visible Chrome window before continuing.

### Design docs

`docs/superpowers/plans/` and `docs/superpowers/specs/` hold the original phase-by-phase implementation plans and design specs for the discovery pipeline and phase-2 work — useful background for *why* something is shaped the way it is, not required reading to make a change.

### Verifying a commit in a clean checkout

- **Never** use `git worktree remove --force`, and never use directory junctions or symlinks to share `node_modules`, to verify a commit. On Windows, `git worktree remove --force` follows a junction and deletes the link's target: it emptied a working checkout's `node_modules` once.
- Verify in a **separate clone** that has its own dependencies: `git clone <this repo> <scratch dir>`, check out the commit, run `npm ci` there, then `npm run typecheck`, `npm test` and `npm run build`. Delete the scratch clone with ordinary file deletion afterwards.
- Do not create verification checkouts inside this repository's tree (Node resolves `node_modules` upward, which silently borrows the parent's dependencies and hides missing ones).

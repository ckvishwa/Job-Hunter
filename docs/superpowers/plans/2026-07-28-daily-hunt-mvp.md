# Daily Job Hunter MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run hunt -- --profile sdet --location "United States"` produces a small, ranked, actionable list of new jobs (HTML/CSV/JSON) from the existing official-company discovery pipeline.

**Architecture:** Add a `src/hunt/` layer on top of the existing discovery/resolution/dedup pipeline (unchanged). It: (1) classifies eligibility (seniority + years) from title+JD text only, (2) normalizes location/work-arrangement, (3) computes freshness against a new `data/hunt-state.json` marker, (4) scores eligible jobs deterministically from stored evidence, (5) writes `output/latest-jobs.{html,csv,json}`, (6) prints top 10. No LLM, no new discovery sources, no architecture changes to `src/discovery/*`.

**Tech Stack:** TypeScript, vitest, existing zod/js-yaml/playwright stack. No new dependencies.

## Global Constraints

- Do not enable google-jobs/indeed/monster/linkedin-public in config/portals.yml or config/sites.yml (they already default `enabled: false` — leave as-is).
- Do not modify `src/discovery/orchestrator.ts`'s discovery/relevance/resolution/dedup control flow — only add new fields it already computes but doesn't persist (matchedKeywords/relevanceReason onto JobPosting).
- No LLM calls, no resume-matching. All scoring/eligibility must trace to a stored field; never fabricate.
- No git push. Commit locally only, after tests+typecheck are green.
- Reuse existing patterns: named exports, `.js` extensions in relative imports (NodeNext ESM), small single-responsibility files under a feature directory (mirrors `src/discovery/*`), vitest `describe/it` style matching `tests/discovery/relevance.test.ts`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/adapters/types.ts` (modify) | Add `matchedKeywords: string[]` and `relevanceReason: string` to `JobPosting`. |
| `src/resolver/posting-resolver.ts` (modify) | Copy `job.matchedKeywords` / `job.relevanceReason` (already computed by relevance.ts, already on `DiscoveredJobLite`) onto the returned `JobPosting`. |
| `src/discovery/resolve-phase.ts` (modify) | Same copy in `buildPlaceholder()` so unresolved/timeout placeholders also carry it. |
| `src/hunt/eligibility.ts` (new) | `classifyEligibility(title, descriptionText)` → seniority tier + years range + eligible + reasons. Title-only reject list; title-only accept list; years-based fallback from JD text. |
| `src/hunt/location.ts` (new) | `parseLocation(raw, descriptionText)` → city/state/country/workArrangement/locationKnown. |
| `src/hunt/freshness.ts` (new) | `computeFreshness(job, {now, previousHuntAt, staleDays})` → postingAgeDays/isNew/isUpdated/isStale. |
| `src/hunt/hunt-state.ts` (new) | `loadHuntState(path)` / `saveHuntState(path, state)` for `data/hunt-state.json` (`{ lastSuccessfulHuntAt: string | null }` per profile key). |
| `src/hunt/scoring.ts` (new) | `scoreJob(job, ctx)` → `ScoreBreakdown` (components sum to 100, penalties subtract, clamp 0-100). |
| `src/hunt/report-rows.ts` (new) | `buildReportRows(jobs, options)` → filters (eligibility/location/freshness/CLI flags) + scores + ranks → `ReportRow[]`. |
| `src/hunt/writers.ts` (new) | `writeJsonReport`, `writeCsvReport`, `writeHtmlReport` → `output/latest-jobs.{json,csv,html}`. |
| `src/hunt/run-hunt.ts` (new) | Orchestrates: `runDiscover()` → load `jobs.jsonl` → `buildReportRows()` → write reports → print top 10 → update hunt-state. |
| `src/hunt/cli.ts` (new) | Arg parsing + `main()`, mirrors `src/discovery/cli.ts` style. |
| `package.json` (modify) | Add `"hunt": "tsx src/hunt/cli.ts"`. |

Tests mirror each new file 1:1 under `tests/hunt/`.

---

## Task 1: Persist relevance evidence onto JobPosting

**Files:** Modify `src/adapters/types.ts`, `src/resolver/posting-resolver.ts`, `src/discovery/resolve-phase.ts`. Test: `tests/resolver/posting-resolver.test.ts` (extend), `tests/discovery/resolve-phase.test.ts` (extend).

**Interfaces:**
- Produces: `JobPosting.matchedKeywords: string[]`, `JobPosting.relevanceReason: string` — both already computed by `evaluateRelevance()` in the orchestrator and present on the `DiscoveredJobLite` passed into `PostingResolver.resolve()` / `buildPlaceholder()`. This task only copies them through, never computes new evidence.

- [ ] Add the two fields to `JobPosting` in `src/adapters/types.ts`.
- [ ] In `posting-resolver.ts`'s `resolve()` return object, add `matchedKeywords: job.matchedKeywords, relevanceReason: job.relevanceReason,`.
- [ ] In `resolve-phase.ts`'s `buildPlaceholder()`, add the same two fields from `job`.
- [ ] Update every existing test fixture building a full `JobPosting` literal (`tests/dedup/deduplicator.test.ts`, `tests/dedup/deduplicator-extended.test.ts`, `tests/storage/jsonl-store.test.ts`, any other `makeJob`-style helper) to include the new required fields — grep first.
- [ ] Run `npm run typecheck` and `npm test`, both green.
- [ ] Commit: `feat(hunt): persist matched-keyword evidence onto JobPosting`.

## Task 2: Eligibility module (seniority + required years)

**Files:** Create `src/hunt/eligibility.ts`, `tests/hunt/eligibility.test.ts`.

**Interfaces:**
```ts
export type SeniorityLevel =
  | "internship" | "entry-level" | "junior" | "associate" | "level-1"
  | "mid" | "senior" | "staff" | "principal" | "lead" | "manager"
  | "director" | "architect" | "unknown";

export interface EligibilityResult {
  seniority: SeniorityLevel;
  requiredYearsMin: number | null;
  requiredYearsMax: number | null;
  eligible: boolean;
  reasons: string[];
}

export function classifyEligibility(title: string, descriptionText: string): EligibilityResult;
```

**Rules (in order, first match wins for seniority tier):**
1. Word-boundary regex on `title` only (never `descriptionText`) for reject terms: `senior|sr\.?|staff|principal|lead|manager|director|architect|head of|vp|vice president`. Match → `eligible=false`, `seniority` = normalized term (`sr`→`senior`), reason `` `Title contains senior-level term "${term}"` ``.
2. Else word-boundary regex on `title` for accept terms: `intern(ship)?|entry[- ]level|junior|jr\.?|associate|level\s*(i|1)\b`. Match → `eligible=true`, `seniority` = mapped tier, reason `` `Title contains junior/entry-level term "${term}"` ``.
3. Else extract years from `descriptionText` via `extractExperienceRange()` (new helper in same file, regexes: `X-Y years`, `X+ years`, `X years`):
   - `min > 4` or `max > 4` → `eligible=false`, `seniority="mid"`, reason `` `Description requires ${max ?? min}+ years experience (exceeds 4-year threshold)` ``.
   - `min !== null && min <= 3` (and max is null or ≤4) → `eligible=true`, `seniority="entry-level"`, reason `` `Description requires ${min}-${max ?? min} years experience (within 0-3 year range)` ``.
   - otherwise (no years found, or years in the 4-boundary gap) → `eligible=true`, `seniority="unknown"`, reason `"No explicit seniority or years-of-experience signal found"`.
4. `descriptionText` is NEVER scanned for senior/staff/lead/etc words — only for numeric years. This is what satisfies "do not reject a title merely because the JD mentions working with senior engineers."

- [ ] Write failing tests covering: each reject term in title (incl. "Team Lead", "Solutions Architect", "Engineering Manager"), each accept term in title, JD-only "5+ years" reject, JD "0-3 years" accept, JD mentioning "You'll work with senior engineers" but title="SDET I" → still eligible, no signal at all → eligible+unknown.
- [ ] Implement `classifyEligibility` + `extractExperienceRange`.
- [ ] `npm test -- tests/hunt/eligibility.test.ts` green.
- [ ] Commit: `feat(hunt): add deterministic seniority/eligibility classifier`.

## Task 3: Location + work-arrangement normalization

**Files:** Create `src/hunt/location.ts`, `tests/hunt/location.test.ts`.

**Interfaces:**
```ts
export type WorkArrangement = "remote" | "hybrid" | "onsite" | "unknown";

export interface ParsedLocation {
  raw: string;
  city: string | null;
  state: string | null; // 2-letter US state code
  country: string | null;
  workArrangement: WorkArrangement;
  locationKnown: boolean; // false = city/state/country all null
}

export function parseLocation(raw: string | null, descriptionText?: string | null): ParsedLocation;
```

**Rules:**
- `workArrangement`: check `raw` first for `\bremote\b` / `\bhybrid\b` / `\bonsite\b|\bon-site\b`; if none found, fall back to strict phrases in `descriptionText` (`"fully remote"`, `"100% remote"`, `"remote-first"`, `"remote position"`) for remote only (avoid generic-benefits false positives); else `"unknown"`.
- City/state parsing: `"City, ST"` where `ST` matches a hardcoded set of the 50 US state codes + DC → `city`, `state`, `country="United States"`. `"City, Country"` (second token not a US state code, not empty) → `city`, `state=null`, `country=Country`. Pure `"Remote"` / `"Remote - US"` / `"Remote, USA"` (no comma-separated city) → `city=null`, `state=null`, `country` = `"United States"` only if an explicit `US|USA|United States` token is present in `raw`, else `null`.
- `locationKnown = city !== null || state !== null || country !== null`.
- Never let `workArrangement === "remote"` set `country` — those are independent fields; a remote job with no stated country stays `country: null`.

- [ ] Write failing tests: `"Berlin, Germany"`, `"Austin, TX"`, `"Remote"`, `"Remote - US"`, `"Remote, Germany"` (remote arrangement + country Germany, not unknown), `""`/`null` (unknown), `"New York, NY (Hybrid)"`, description-only remote phrase fallback, benign JD mention of "remote" not treated as arrangement when raw location is a real city with no arrangement marker.
- [ ] Implement `parseLocation`.
- [ ] `npm test -- tests/hunt/location.test.ts` green.
- [ ] Commit: `feat(hunt): add location and work-arrangement normalization`.

## Task 4: Freshness + hunt-state

**Files:** Create `src/hunt/freshness.ts`, `src/hunt/hunt-state.ts`, `tests/hunt/freshness.test.ts`, `tests/hunt/hunt-state.test.ts`.

**Interfaces:**
```ts
// freshness.ts
export interface FreshnessInfo {
  postingAgeDays: number | null;
  isNew: boolean;
  isUpdated: boolean;
  isStale: boolean;
}
export function computeFreshness(
  job: Pick<JobPosting, "discoveredAt" | "lastSeenAt" | "postingDate">,
  opts: { now: string; previousHuntAt: string | null; staleDays: number },
): FreshnessInfo;

// hunt-state.ts
export interface HuntState { lastSuccessfulHuntAt: Record<string, string>; } // keyed by profile id, "*" for no-profile-filter runs
export function loadHuntState(filePath: string): HuntState;
export function saveHuntState(filePath: string, state: HuntState): void;
```

**Rules:**
- `postingAgeDays`: `job.postingDate` present → `floor((now - postingDate) / 86400000)`; else `null`.
- `previousHuntAt === null` → `isNew = true` for everything (bootstrap run).
- Else `isNew = job.discoveredAt > previousHuntAt`.
- `isUpdated = !isNew && job.lastSeenAt > previousHuntAt`.
- `isStale = (now - lastSeenAt) in days > opts.staleDays` (default `staleDays` passed by caller, e.g. 14).
- `hunt-state.ts` follows the exact read/write-tmp-then-rename pattern already used in `src/discovery/checkpoints.ts` (`loadCheckpoints`/`saveCheckpoints`) — reuse that shape, missing file → `{ lastSuccessfulHuntAt: {} }`.

- [ ] Write failing tests for each boolean combination + postingAgeDays null/number + hunt-state load-missing/save-roundtrip.
- [ ] Implement both modules.
- [ ] `npm test -- tests/hunt/freshness.test.ts tests/hunt/hunt-state.test.ts` green.
- [ ] Commit: `feat(hunt): add freshness computation and hunt-state persistence`.

## Task 5: Deterministic scoring

**Files:** Create `src/hunt/scoring.ts`, `tests/hunt/scoring.test.ts`.

**Interfaces:**
```ts
export interface ScoreBreakdown {
  titleRelevance: number;      // 0-20
  seniorityAlignment: number;  // 0-15
  yearsAlignment: number;      // 0-10
  locationAlignment: number;   // 0-15
  remoteAlignment: number;     // 0-10
  jdCompleteness: number;      // 0-10
  freshness: number;           // 0-10
  officialLink: number;        // 0-10
  penalties: number;           // subtracted, >= 0
  total: number;               // clamp(sum - penalties, 0, 100)
}
export interface ScoreContext {
  eligibility: EligibilityResult;
  parsedLocation: ParsedLocation;
  freshnessInfo: FreshnessInfo;
  requestedCountry: string | null;  // from --location
  requestedStates: string[] | null; // from --states
  remoteOnly: boolean;              // from --remote-only
}
export function scoreJob(job: JobPosting, ctx: ScoreContext): ScoreBreakdown;
```

**Component rules (all deterministic, from stored fields only):**
- `titleRelevance = min(20, job.matchedKeywords.length * 7)`.
- `seniorityAlignment`: explicit junior/entry/intern/associate/level-1 tier → 15; `"unknown"` → 6; (mid/senior etc never reach scoring — filtered out upstream by eligibility gate, but if somehow present → 0).
- `yearsAlignment`: `requiredYearsMax !== null || requiredYearsMin !== null` → `min <= 1` → 10; `min <= 3` → 8; else → 5; both null → 3.
- `locationAlignment`: `parsedLocation.country === ctx.requestedCountry` → 15; `ctx.requestedStates?.length && parsedLocation.state && ctx.requestedStates.includes(parsedLocation.state)` → 15; `!parsedLocation.locationKnown` → 7; else → 0.
- `remoteAlignment`: if `ctx.remoteOnly`: remote→10, hybrid→3, else→0. Else: remote→8, hybrid→6, onsite→4, unknown→2.
- `jdCompleteness`: `descriptionText` starts with `UNRESOLVED_PLACEHOLDER_PREFIX` → 0; `length > 500` → 10; `length > 150` → 6; `length > 0` → 2; else 0.
- `freshness`: `isNew` → 10; `isUpdated` → 6; else by `postingAgeDays`: `<=7`→8, `<=30`→5, `null`→3, else→1; `isStale` overrides to 0.
- `officialLink`: `job.sourceType === "company-careers" || job.source.startsWith("company-careers")` → 10; known ATS domain in `canonicalUrl` (greenhouse/lever/workday) → 5; else 0.
- `penalties`: `+5` if `eligibility.seniority === "unknown" && requiredYearsMin === null` (genuinely unclear requirements); `+10` if `descriptionText` starts with `UNRESOLVED_PLACEHOLDER_PREFIX`.
- `total = clamp(titleRelevance+seniorityAlignment+yearsAlignment+locationAlignment+remoteAlignment+jdCompleteness+freshness+officialLink - penalties, 0, 100)`.

- [ ] Write failing tests for each component's boundary values and for `total` clamping at both ends.
- [ ] Implement `scoreJob`.
- [ ] `npm test -- tests/hunt/scoring.test.ts` green.
- [ ] Commit: `feat(hunt): add deterministic 0-100 opportunity scoring`.

## Task 6: Report rows + writers

**Files:** Create `src/hunt/report-rows.ts`, `src/hunt/writers.ts`, `tests/hunt/report-rows.test.ts`, `tests/hunt/writers.test.ts`.

**Interfaces:**
```ts
// report-rows.ts
export interface ReportRow {
  rank: number; score: number; scoreBreakdown: ScoreBreakdown;
  title: string; company: string; location: string;
  city: string | null; state: string | null; country: string | null;
  workArrangement: WorkArrangement; seniority: SeniorityLevel;
  requiredYearsMin: number | null; requiredYearsMax: number | null;
  matchedProfile: string; matchedKeywords: string[];
  postingAgeDays: number | null; applyUrl: string; source: string;
  eligibilityReasons: string[]; firstSeenAt: string; lastSeenAt: string;
  isNew: boolean; isUpdated: boolean; isStale: boolean; unresolved: boolean;
}
export interface ReportRowOptions {
  now: string; previousHuntAt: string | null; staleDays: number;
  requestedCountry: string | null; requestedStates: string[] | null;
  remoteOnly: boolean; excludeOnsite: boolean; includeUnknownLocation: boolean;
  newOnly: boolean; days: number | null; includeSeen: boolean; includeStale: boolean;
  limit: number | null;
}
export function buildReportRows(jobs: JobPosting[], options: ReportRowOptions): {
  rows: ReportRow[];
  counts: { totalDiscovered: number; ineligibleSeniority: number; locationMismatch: number; eligibleRetained: number; newJobs: number };
};
```

**Filter pipeline (per job, in order — each rejection increments the matching `counts` field and drops the job):**
1. `classifyEligibility(job.title, job.descriptionText)` → if `!eligible`, count `ineligibleSeniority`, drop.
2. `parseLocation(job.location, job.descriptionText)` → apply `--remote-only`/`--exclude-onsite`/`--states`/`--location` rules exactly as specified in the plan header (mismatch or unknown-without-`includeUnknownLocation` → count `locationMismatch`, drop).
3. `computeFreshness(...)` → apply freshness flags: default (no flags) → keep only `isNew`; `--new-only` → same; `--days N` → keep `postingAgeDays !== null && postingAgeDays <= N` OR `discoveredAt` within N days of `now`; `--include-seen` → skip the isNew restriction entirely; `--include-stale` → don't drop `isStale` (default drops stale unless this flag or `--include-seen` is set... actually always require `--include-stale` to keep stale regardless of other flags). Track `newJobs` count from `isNew` regardless of filtering.
4. `scoreJob(...)`.
5. Sort by `score` desc, stable tie-break by `postingAgeDays` asc then `title` asc (deterministic ordering for identical scores). Assign `rank` 1..N. Apply `options.limit` after ranking.
6. `unresolved = descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)`.
7. `matchedProfile = job.matchedProfiles[0] ?? ""`.

```ts
// writers.ts
export function writeJsonReport(filePath: string, rows: ReportRow[]): void;
export function writeCsvReport(filePath: string, rows: ReportRow[]): void;
export function writeHtmlReport(filePath: string, rows: ReportRow[]): void;
```
- JSON: `JSON.stringify(rows, null, 2)`.
- CSV: header + one row per job, flatten `scoreBreakdown` into `score_<field>` columns, `eligibilityReasons`/`matchedKeywords` joined with `"; "`, proper quoting for commas/quotes in `title`/`company`/`eligibilityReasons`.
- HTML: single self-contained file (inline `<style>`/`<script>`, no CDN) with: a `<table>` of all rows + `data-*` attributes per row for filtering; a search `<input>` (JS filters visible rows by substring across title/company/location); `<select>` filters for profile/location(country)/seniority/workArrangement (populated from the row data, JS-driven show/hide); an "Apply" `<a>` button per row (`target="_blank" rel="noopener"`) pointing at `applyUrl`; sortable column headers (click toggles asc/desc via JS re-sorting DOM rows, no library); CSS classes `.badge-new`/`.badge-updated`/`.badge-unresolved`/`.badge-stale` visually marking those rows (background tint + label), applied when the corresponding boolean is true.

- [ ] Write failing tests for `buildReportRows`: eligibility drop, location drop (mismatch + unknown default-drop + `--include-unknown-location` keep), remote-only, states filter, new-only default, `--days`, `--include-seen`, `--include-stale`, ranking/tie-break determinism (same input twice → identical row order), `--limit`.
- [ ] Write failing tests for writers: JSON round-trips via `JSON.parse`; CSV has correct header + escapes a title containing a comma; HTML contains one `<tr>`-equivalent per row, contains `badge-new` for an `isNew` row, contains the `applyUrl` in an `href`.
- [ ] Implement `report-rows.ts` then `writers.ts`.
- [ ] `npm test -- tests/hunt/report-rows.test.ts tests/hunt/writers.test.ts` green.
- [ ] Commit: `feat(hunt): add report row filtering/scoring pipeline and HTML/CSV/JSON writers`.

## Task 7: hunt CLI + orchestration

**Files:** Create `src/hunt/run-hunt.ts`, `src/hunt/cli.ts`; modify `package.json`. Test: `tests/hunt/cli.test.ts` (arg parsing only, like `tests/discovery/cli.test.ts`), `tests/hunt/run-hunt.test.ts` (orchestration against fixture `jobs.jsonl`, injected `runDiscover`).

**Interfaces:**
```ts
// run-hunt.ts
export interface HuntFilters {
  profileIds?: string[]; location?: string; remoteOnly?: boolean; excludeOnsite?: boolean;
  states?: string[]; includeUnknownLocation?: boolean; newOnly?: boolean; days?: number;
  includeSeen?: boolean; includeStale?: boolean; limit?: number; dryRun?: boolean;
}
export interface HuntSummary {
  totalDiscovered: number; ineligibleSeniority: number; locationMismatch: number;
  eligibleRetained: number; newJobs: number; top10: ReportRow[];
  resolutionTimeMs: number; reportPaths: { json: string; csv: string; html: string };
}
export async function runHunt(
  paths: { /* same shape runDiscover takes, plus */ huntStatePath: string; outputDir: string },
  filters: HuntFilters,
  runDiscoverFn?: typeof runDiscover,
): Promise<HuntSummary>;
```
- `runHunt` calls `runDiscoverFn(paths, { profileIds: filters.profileIds, location: filters.location, limit: filters.limit, dryRun: filters.dryRun })` (default sources — never pass `--source` for google/indeed/monster/linkedin; the orchestrator's default already only runs enabled sources, which is company-careers-only in this repo).
- Then `loadJobs(paths.jobsStorePath)`, `loadHuntState(paths.huntStatePath)`, builds `ReportRowOptions` from `filters` + hunt-state, calls `buildReportRows`, writes the 3 reports via `writers.ts`, prints top 10 to console, then (unless `dryRun`) saves `hunt-state.json` with `lastSuccessfulHuntAt[profileKey] = now` where `profileKey = filters.profileIds?.length ? filters.profileIds.sort().join(",") : "*"`.
- `cli.ts` mirrors `src/discovery/cli.ts`'s arg-parsing/`isMainModule` pattern; flags: `--profile`, `--location`, `--remote-only`, `--exclude-onsite`, `--states` (comma-split), `--include-unknown-location`, `--new-only`, `--days`, `--include-seen`, `--include-stale`, `--limit`, `--dry-run`. Prints a summary block (counts) then a top-10 table (rank/score/title/company/location/apply link) to stdout, then `process.exitCode = 0` on success, non-zero on thrown error (matching existing cli.ts pattern).

- [ ] Write failing `tests/hunt/cli.test.ts` for arg parsing (mirror `tests/discovery/cli.test.ts` structure).
- [ ] Write failing `tests/hunt/run-hunt.test.ts`: inject a stub `runDiscoverFn`, seed a temp `jobs.jsonl` fixture with a mix of eligible/ineligible/remote/onsite/new/stale jobs, assert `HuntSummary` counts and that report files are written and non-empty, assert re-running with `--new-only` after saving hunt-state returns `newJobs: 0`, `firstSeenAt`/`discoveredAt` unchanged, `lastSeenAt` advances.
- [ ] Implement `run-hunt.ts`, `cli.ts`.
- [ ] Add `"hunt": "tsx src/hunt/cli.ts"` to `package.json` scripts.
- [ ] `npm test -- tests/hunt/cli.test.ts tests/hunt/run-hunt.test.ts` green, then full `npm test` + `npm run typecheck` green.
- [ ] Commit: `feat(hunt): add npm run hunt command tying discovery, eligibility, scoring, and reporting together`.

## Task 8: Acceptance run (all 4 profiles) + independent review + commit

**Files:** none new — this is a verification task against the real `config/fortune500-registry.json` (4 companies) and real browser/Playwright run.

- [ ] For each profile in `sdet, security, cloud, network`: run `npm run hunt -- --profile <profile> --location "United States"`; capture: total discovered, irrelevant rejected (from the underlying discovery summary), senior roles rejected (`ineligibleSeniority`), location mismatches rejected (`locationMismatch`), eligible retained, new jobs, top 10 titles, resolution time, report file paths.
- [ ] Manually read every top-10 title across all 4 runs; flag any obvious false positive (e.g. a sales/account-exec title, an explicitly senior title that slipped through) and fix root cause before proceeding.
- [ ] Re-run the same 4 commands immediately again: confirm `jobs.jsonl` line count unchanged (no duplicate rows added for unchanged postings), `--new-only` returns `newJobs: 0` for all 4 (nothing new since the prior run), `discoveredAt` unchanged for a sampled job, `lastSeenAt` advanced for that same job, and the JSON report is byte-identical given identical input+flags (deterministic ranking).
- [ ] `npm test` and `npm run typecheck`, both green.
- [ ] Independent review: invoke `engineering-skills:adversarial-reviewer` (or `code-reviewer`) against the diff before committing; address any CONFIRMED findings.
- [ ] `git add` the new/modified files (never `data/*.jsonl` test fixtures accidentally, but DO include real `data/jobs.jsonl`, `data/checkpoints.json`, `data/hunt-state.json`, `data/discovered-jobs.jsonl`, and `output/latest-jobs.*` produced by the acceptance run) and commit locally. Do not push.
- [ ] Report back the exact hunt command and the full acceptance results table.

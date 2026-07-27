# job-hunter Phase 2 — Collection, Extraction, Dedup, JSONL Storage

## Purpose

Phase 1 (done): TS scaffold, persistent Chrome launcher, config loading, verification pause, 14 tests.

Phase 2 adds the actual collection pipeline: search configured career sites for configured
role keywords, discover every reachable job listing, open each job and extract the full
description, normalize into one shared model, deduplicate across runs, and append-safe
store to `data/jobs.jsonl`. No LLM calls, no resume matching, no HTML/CSV dashboard, no
auto-apply — those are later phases.

## Data model

`src/adapters/types.ts` (or `src/types.ts`, extended) defines:

```ts
interface JobPosting {
  id: string;                    // stable dedup-derived id
  source: string;                // site id from sites.yml
  sourceType: "greenhouse" | "lever" | "workday" | "generic";
  company: string;
  title: string;
  location: string | null;
  remoteType: string | null;
  employmentType: string | null;
  department: string | null;
  requisitionId: string | null;
  postingDate: string | null;    // ISO date if known
  discoveredAt: string;          // ISO timestamp, first time seen
  lastSeenAt: string;            // ISO timestamp, updated every run
  canonicalUrl: string;
  applyUrl: string;
  descriptionText: string;
  descriptionHtml: string | null;
  requiredYears: number | null;
  salaryText: string | null;
  matchedProfiles: string[];     // profile IDs whose keywords matched this job
  rawMetadata: Record<string, unknown>;
}
```

`firstDiscoveredAt` in the spec prompt maps to `discoveredAt` above (kept from first write,
never overwritten on re-sight); `lastSeenAt` is bumped every run the job is re-observed.

## Adapter contract

`src/adapters/types.ts`:

```ts
interface SourceAdapter {
  sourceType: JobPosting["sourceType"];
  canHandle(site: SiteConfig): boolean;
  discoverJobs(site: SiteConfig, roles: RoleConfig[], settings: CollectSettings): Promise<DiscoveredJob[]>;
  fetchJobDetails(job: DiscoveredJob, site: SiteConfig, settings: CollectSettings): Promise<RawJobDetail>;
  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]): JobPosting;
}
```

`DiscoveredJob` = minimal listing-stage shape (url/title/id as known from the list endpoint).
`RawJobDetail` = adapter-specific raw shape passed to `normalize`.

## Per-adapter approach

- **Greenhouse** (`adapters/greenhouse.ts`): `fetch` against
  `https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`. Board token comes
  from `site.url` (parsed) or an explicit `site.greenhouse.boardToken` override. Single
  response contains the full board (Greenhouse doesn't paginate this endpoint) — still loop
  defensively against `settings.maxJobsPerSource`. Full JD is already in `content` field, no
  second request needed.
- **Lever** (`adapters/lever.ts`): `fetch` against
  `https://api.lever.co/v0/postings/{site}?mode=json`. Same one-shot-list-with-full-content
  shape (Lever includes `descriptionPlain`/`description` inline). `site` slug parsed from
  `site.url` or `site.lever.site` override.
- **Workday** (`adapters/workday.ts`): requires explicit `site.workday: { hostname, tenant,
  site }` block — refuse (throw a typed error, caught per-site by the runner) if absent, per
  "do not guess tenant names silently." Search via `POST https://{hostname}/wday/cxs/{tenant}/{site}/jobs`
  with `{ appliedFacets: {}, limit, offset, searchText }`, looping `offset` by `limit` until
  `jobPostings.length === 0` or `offset >= total` or safety limits hit. Detail via
  `GET https://{hostname}/wday/cxs/{tenant}/{site}/job/{externalPath}`. Only the standard CXS
  shape is handled (per user decision) — a tenant returning an unrecognized shape fails that
  site only, logged in the error summary.
- **Generic Playwright** (`adapters/generic-playwright.ts`): uses `launchPersistentChrome`.
  Requires `site.generic` selector block: `searchInputSelector, searchButtonSelector,
  resultCardSelector, jobLinkSelector, nextButtonSelector?, loadMoreSelector?, titleSelector,
  locationSelector, descriptionSelector, applyLinkSelector?`. Missing a required selector for
  the flow the site needs = validation error naming the missing key (checked in
  `registry.ts` / adapter's `canHandle`, not hardcoded per-company). Flow: goto page → fill
  search input → click search → collect result-card links → click Next or Load More until
  neither exists or limits hit → visit each unique job URL → run `pauseForVerification` →
  extract title/location/description via configured selectors.

All adapters call `pauseForVerification` (from Phase 1's `browser/verification.ts`) at every
navigation point that could plausibly hit an anti-bot check — for the API-based adapters this
means checking the raw HTTP response body/status for the same heuristic signals before
parsing as JSON (a 403 HTML challenge page is not valid JSON anyway, so this is a clean
before-parse check), for the generic adapter it means the existing Playwright `page` check.

## Role/profile matching (Phase 2 scope only)

For each enabled site, run discovery once per **distinct keyword** across all enabled roles
in `roles.yml` (dedup keywords first so a keyword shared by two profiles isn't searched
twice). After discovery, a job is tagged with every profile ID whose keyword search
surfaced it → `matchedProfiles: string[]`. No scoring, no single-profile routing — that's
Phase 3.

## Dedup

`src/dedup/`:
- `canonicalize-url.ts` — strip tracking params (`utm_*`, `gh_src`, `lever-source`, etc.),
  lowercase host, strip trailing slash, drop fragment.
- `fingerprint.ts` — stable hash of normalized `descriptionText` (whitespace-collapsed,
  lowercased) for the JD-fingerprint fallback tier.
- `deduplicator.ts` — given existing store + new `JobPosting[]`, applies priority: (1)
  canonical URL match, (2) `source + requisitionId` match, (3) normalized
  `company+title+location` match, (4) fingerprint match. First tier that matches wins; no
  merge across tiers. On match: keep existing `discoveredAt`, overwrite everything else,
  bump `lastSeenAt`. On no match: insert as new with `discoveredAt = lastSeenAt = now`.

## Storage

`src/storage/jsonl-store.ts`:
- `load(path): JobPosting[]` — read existing JSONL (empty array if file absent), skip
  unparseable lines defensively (log + continue, don't crash a whole run on one bad line).
- `saveAll(path, jobs: JobPosting[])` — atomic rewrite: write to `${path}.tmp`, then
  `renameSync` over the target. Used after dedup merge each run (not naive append, since
  dedup requires rewriting existing lines' `lastSeenAt`).
- One JSON object per line, UTF-8, no trailing commas/pretty-printing (JSONL).

## Runner

`src/runner/source-runner.ts` orchestrates: load configs → filter by `--site`/`--profile`
CLI flags → for each enabled site, look up adapter via `registry.ts` (`canHandle`) → run
discover → fetchDetails per job (respecting `maxJobsPerSource`, `delayBetweenRequestsMs`
between requests) → normalize → tag `matchedProfiles` → collect. One site's adapter throwing
is caught, logged to the error summary, and does not stop remaining sites (acceptance
criterion). After all sites processed: load existing JSONL, dedup-merge, atomic rewrite,
print summary.

`settings` block (new in `sites.yml` or a top-level `config/settings.yml` — going with a
`settings:` key inside `sites.yml` top level, alongside `sites:`, since it's collection-wide
not per-site):

```yaml
settings:
  maxPagesPerSource: 100
  maxJobsPerSource: 5000
  navigationTimeoutMs: 30000
  delayBetweenRequestsMs: 500
sites:
  - id: ...
```

Defaults applied via zod `.default()` if `settings:` key is omitted, so existing Phase 1
`sites.yml` (no `settings:` block) still validates.

## CLI

`npm run collect` → `tsx src/runner/cli.ts` (new entry point; `src/index.ts` stays the
Phase 1 demo, untouched). Flags parsed off `process.argv`: `--site <id>` (repeatable or
comma-list), `--profile <id>` (repeatable or comma-list), `--limit <n>` (caps total jobs
written this run, applied after dedup). No new CLI-parsing dependency — hand-rolled parser,
~20 lines.

## Testing strategy

- Greenhouse/Lever/Workday adapter tests: `vi.stubGlobal("fetch", vi.fn(...))` returning
  canned JSON fixtures (valid page, empty page, malformed/non-JSON body) — assert
  `normalize()` output shape and pagination stopping.
- Generic adapter: fake `PageLike`-style object (extending Phase 1's pattern) rather than a
  real browser — asserts selector-driven flow calls the right sequence and stops on missing
  selectors.
- `canonicalize-url`, `fingerprint`, `deduplicator`: pure unit tests, no I/O.
- `jsonl-store`: temp-dir file tests (same `mkdtempSync` pattern as Phase 1's config-loader
  tests) — write, reload, re-run-merge, assert no duplicate lines and `discoveredAt`
  preserved / `lastSeenAt` bumped.
- No real network or real browser calls anywhere in the test suite.

## Explicitly out of scope (Phase 3+)

Resume matching/scoring, SQLite, HTML/CSV dashboard, automatic application submission.

## Known limitations going in

- Workday: only the standard CXS request/response shape is handled; non-conforming tenants
  fail that site only (visible in the error summary), not silently.
- Greenhouse/Lever board-token/site-slug is parsed from `site.url`; malformed URLs should use
  an explicit override field rather than relying on parsing.
- Generic adapter has no default selectors for any company — every site using it must fully
  configure the selector block in `sites.yml`.

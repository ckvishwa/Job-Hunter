# Universal Job Discovery — Design Spec

**Status:** draft, pending approval. No implementation happens until this + the companion plan are signed off.

## 0. Current state (read before anything else)

This is **not** a green-field feature. An earlier, uncommitted session already wrote most of it directly into `src/discovery/`, `src/resolver/`, and `config/fortune500_registry.json`, skipping the design/plan/approval step. That WIP:

- Passes `npm test` (113 tests, all mocked — no live network/browser).
- Fails `npm run typecheck` with 20 errors.
- Has real behavioral bugs beyond the type errors (below).
- Has no `config/portals.yml`, no dedicated orchestrator/registry/company-careers tests, no live-validation record.

Decision (confirmed with user): **audit and build on this WIP**, not discard it. Everything below is written against the actual code that exists today, file:line accurate as of this audit.

### 0.1 Confirmed reusable primitives (do not reimplement)

| Concern | Symbol | Location |
|---|---|---|
| URL canonicalization | `canonicalizeUrl`, `computeJobId` | `src/dedup/canonicalize-url.ts` |
| Description fingerprint | `fingerprintDescription` | `src/dedup/fingerprint.ts` |
| Cross-tier dedup/merge | `mergeJobs` (already extended with `discoveredFrom` merge + generic-title guard) | `src/dedup/deduplicator.ts` |
| JobPosting JSONL storage | `loadJobs` / `saveJobs` | `src/storage/jsonl-store.ts` |
| Discovery-lite JSONL storage | `loadDiscoveredJobs` / `saveDiscoveredJobs` / `appendDiscoveredJobs` | `src/storage/jsonl-store.ts` (same file, added alongside — correct reuse, not a new module) |
| Persistent visible Chrome | `launchPersistentChrome` | `src/browser/launcher.ts` |
| Verification detection/pause | `detectVerification`, `pauseForVerification` | `src/browser/verification.ts` |
| ATS adapter registry | `resolveAdapter` | `src/adapters/registry.ts` |
| Config load+validate (YAML+Zod) | `parseAndValidate` + `loadSitesConfig`/`loadRolesConfig` | `src/config/loader.ts` |

All of the above are reused correctly by the existing WIP except one seam noted in §6.3 (`loadCompanyRegistry` duplicates `parseAndValidate`'s error-handling shape instead of extending it, because that helper is YAML-only and the registry is JSON — acceptable, not worth generalizing `parseAndValidate` for one JSON consumer).

### 0.2 Confirmed bugs in the existing WIP (fixed in Task 0 of the plan, not designed around)

1. **`tsconfig.json` has no DOM lib** (`lib: ["ES2022"]`) — 10 of the 20 typecheck errors are `window`/`document`/`HTMLAnchorElement` used inside `page.evaluate`/`page.$eval` callbacks in `google-jobs.ts`, `indeed.ts`, `monster.ts`, `linkedin-public.ts`, `configurable-generic-portal.ts`, `posting-resolver.ts`. Fix: add `"DOM"` to `lib`. One line, resolves all 10.
2. **`JobPosting.discoveredFrom` is required but 4 baseline adapters don't set it** (`generic-playwright.ts:171`, `greenhouse.ts:104`, `lever.ts:95`, `workday.ts:146`) — the field was added for the discovery/resolver side without updating the 4 pre-existing `normalize()` functions. Fix: each sets `discoveredFrom: [site.id]`.
3. **`DiscoveredJob` (baseline, `src/adapters/types.ts:8-14`) has no `location`**, but `company-careers.ts:96` reads `job.location` off it and falls back to a **fabricated `"Remote"` string** when absent. This isn't just a type error — it's exactly the kind of "do not fabricate" violation the task brief warns against. Real fix: the company-careers runner must call the full `discoverJobs → fetchJobDetails → normalize` pipeline (which it's supposed to per Task 9) and take `location` from the resulting `JobPosting`, never guess it.
4. **`company-careers.ts:61` fabricates a Workday `site: "careers"` value** when building a synthetic `SiteConfig` for a registry company, because the registry schema only stores one `atsTenantOrBoardId` string but Workday's `SourceAdapter` needs `hostname` + `tenant` + `site` (three independent values). This is a schema gap, not a coding bug — see §3.2.
5. **`company-careers.ts:63-74` fabricates placeholder CSS selectors** (`"input[type='search']"`, `.job-card, li, tr"`, etc.) for any registry company with `atsType: "generic"`. These are guesses, not verified per-company selectors, and will silently return zero (or wrong) results against real sites like Amazon/Apple. See §3.2 for the fix (per-company selector overrides in the registry, populated only when actually verified).
6. **`company-careers.ts:118-123`**: on a per-company failure, the catch block still advances the checkpoint's company index (`onPageProcessed([], i + 1)`), so a company that failed once is **silently skipped forever** on every future resume — never retried, never reported as a standing failure. Task 9 asks for the registry's verification result to be updated separately from source code on failure; currently nothing updates it.
7. **`CompanyRegistryEntry` is imported from `../types.js` in `posting-resolver.ts:9`** but it's actually exported from `src/config/schema.ts:75`. Simple import-path fix.
8. **`posting-resolver.ts` never calls `detectVerification`/`pauseForVerification`** on its own Playwright fallback path (every portal adapter does). Gap, not a type error — must be closed since the whole system's verification-pause contract depends on every live-page touchpoint checking for a challenge.
9. **`orchestrator.ts` has untyped side-channel properties** bolted onto `DiscoveryContext` via `(context as any).profileIds`, `(context as any).siteConfig`, `(context as any).onVerificationPause` instead of being real, typed fields.
10. Two `unknown`→`Record<string, unknown>` narrowing errors in `posting-resolver.ts:178,187` (`Response.json()` result assigned without a cast/guard), and one implicit-`any` in `tests/discovery/adapters.test.ts:259` from an outer `as any` stripping the contextual type.

None of these require a redesign — they're bugs in code whose overall shape is correct. The plan fixes them as Task 0 before any new work.

### 0.3 True gaps — zero code exists yet

- `config/portals.yml` + its Zod schema (portal search/pagination config is currently faked by reusing `SiteConfig.generic` via an `as unknown as` cast in `configurable-generic-portal.ts`).
- `config/fortune500-registry.json` under the hyphenated filename the task brief specifies (only the underscore `fortune500_registry.json` exists).
- Registry support for Workday's 3-field ATS identity and for per-company generic-portal selector overrides (see bugs #4/#5 above).
- Reporting/stats module beyond the console-only `printDiscoverSummary` in `cli.ts:32-52`.
- A shared Playwright discovery runtime — each of the 5 portal adapters independently reimplements its own goto → verify → paginate → scrape loop. Not broken, just duplicated 5×.
- Dedicated tests for `orchestrator.ts`, `discovery/registry.ts`, `company-careers.ts`.
- Any record of a controlled live validation run.

## 1. Architecture

Two pipelines feed one shared storage/dedup layer:

```
                    ┌─────────────────────┐
 config/portals.yml │  Portal Discovery    │
 config/roles.yml   │  (Google/Indeed/     │──┐
                     │  Monster/LinkedIn/   │  │  DiscoveredJobLite[]
                     │  generic-portal)     │  │  (lightweight, per-page,
                     └─────────────────────┘  │   checkpointed)
                                                ├──► data/discovered-jobs.jsonl
 config/fortune500-  ┌─────────────────────┐  │
 registry.json       │  Company-Careers     │  │
                     │  Runner (delegates   │──┘
                     │  to existing ATS     │
                     │  adapters)           │
                     └─────────────────────┘
                                │
                                ▼
                     ┌─────────────────────┐
                     │  Posting Resolver     │   discoveredUrl → canonicalUrl
                     │  (redirect-follow,    │   + full JD via existing ATS
                     │   ATS/employer sniff) │     adapters or generic extraction
                     └─────────────────────┘
                                │
                                ▼  JobPosting[]
                     ┌─────────────────────┐
                     │  mergeJobs (existing, │   4-tier dedup, now cross-source
                     │  extended)            │
                     └─────────────────────┘
                                │
                                ▼
                        data/jobs.jsonl
```

Discovery (lightweight, high-volume, cheap) is architecturally separate from Resolution (heavyweight, one full-JD fetch per unique posting) — this is already how the WIP is split (`DiscoveredJobLite` vs `JobPosting`) and is kept as-is.

## 2. Module boundaries

| Module | Owns | Talks to |
|---|---|---|
| `src/discovery/orchestrator.ts` | Run sequencing, phase transitions, top-level checkpoint/save calls, browser lifecycle | `discovery/registry.ts`, `discovery/checkpoints.ts`, `resolver/posting-resolver.ts`, `dedup/deduplicator.ts`, `storage/jsonl-store.ts`, `browser/launcher.ts` |
| `src/discovery/registry.ts` | Maps a portal-config `type` → `PortalDiscoveryAdapter` | portal adapter modules only |
| `src/discovery/adapters/*.ts` | One portal's search/paginate/scrape logic | `browser/verification.ts`, `config/schema.ts` (portal config type) |
| `src/discovery/adapters/company-careers.ts` | Fortune 500 iteration, synthetic `SiteConfig` construction, delegation | `config/loader.ts` (registry), `adapters/registry.ts` (existing ATS adapters) — **must not** reimplement any ATS extraction itself |
| `src/discovery/checkpoints.ts` | Checkpoint key/read/write/reset | nothing else — pure I/O + key logic |
| `src/resolver/posting-resolver.ts` | discoveredUrl → canonicalUrl resolution, delegate to existing ATS adapter or generic extraction for full JD | `adapters/registry.ts`, `config/schema.ts`, `browser/verification.ts` (currently missing, must be added) |
| `src/dedup/deduplicator.ts` | 4-tier merge, provenance/keyword union, generic-title guard | nothing else — pure function over `JobPosting[]` |
| `src/storage/jsonl-store.ts` | Both `JobPosting` and `DiscoveredJobLite` JSONL read/write, atomic rename | nothing else |
| `src/discovery/cli.ts` | Arg parsing, wiring to orchestrator, summary printing | `discovery/orchestrator.ts` only |

The orchestrator does not contain portal-specific branching (already true — it goes through `discovery/registry.ts`). Company-careers does not duplicate ATS extraction (already true — it calls `resolveAdapter`); it must stop fabricating data when the registry doesn't have what an ATS needs, per §0.2 bugs #3-5.

## 3. Configuration schemas

### 3.1 `config/portals.yml` (new)

One Zod-validated schema, modeled directly on the existing `sitesFileSchema`/`siteSchema` pattern in `src/config/schema.ts` (same `settings` + array-of-entries shape, same `parseAndValidate` loader):

```ts
export const portalConfigSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["google-jobs", "indeed", "monster", "linkedin-public", "generic"]),
  enabled: z.boolean(),
  baseUrl: z.string().url(),
  keywordParam: z.string().min(1).optional(),      // query-param name, e.g. "q"
  locationParam: z.string().min(1).optional(),      // query-param name, e.g. "l"
  searchInputSelector: z.string().min(1).optional(), // only for portals without query-param search
  locationInputSelector: z.string().min(1).optional(),
  resultCardSelector: z.string().min(1),
  jobLinkSelector: z.string().min(1),
  nextPageSelector: z.string().min(1).optional(),
  loadMoreSelector: z.string().min(1).optional(),
  maxPages: z.number().int().positive().default(10),
  maxDiscoveries: z.number().int().positive().default(500),
  navigationTimeoutMs: z.number().int().positive().default(30000),
  delayBetweenActionsMs: z.number().int().nonnegative().default(1000),
  supportedLocations: z.array(z.string().min(1)).optional(),
  postingAgeFilterDays: z.number().int().positive().optional(),
  requiresLogin: z.boolean().default(false),
  onVerification: z.enum(["pause", "skip"]).default("pause"),
});
export const portalsFileSchema = z.object({
  settings: collectSettingsSchema, // reuse existing shared settings shape where fields overlap
  portals: z.array(portalConfigSchema).min(1),
});
```

`configurable-generic-portal.ts` currently reads `site.generic` (the *baseline* `GenericSelectors`, meant for company career pages) via an `as unknown as` cast — this stops once `portals.yml` exists; the `generic` portal type reads `portalConfigSchema` fields directly like every other portal type. No cast needed once the real schema exists.

### 3.2 `config/fortune500-registry.json` (rename + schema fix)

Keep the existing, already-populated data and field names (`fortuneRank`, `atsTenantOrBoardId`, `verificationStatus`, `lastVerifiedDate`) rather than renaming fields to the task brief's literal names (`rank`, `atsTenant`/`atsSite`, `status`, `lastVerifiedAt`) — the data is real and verified today; renaming fields is pure churn. **Flagged for approval**, default is keep-as-is.

Two real schema additions are needed (not cosmetic):

- **Workday needs 3 fields, registry has 1.** Add `atsWorkdaySite: z.string().min(1).nullable()` alongside the existing `atsTenantOrBoardId` (used as `tenant`; `hostname` is already derivable from `careersUrl`). A Workday entry with `atsWorkdaySite: null` is a **hard per-company error at discovery time**, not a guessed `"careers"` fallback — matches "do not fabricate unverified ATS details."
- **Generic ATS needs per-company selectors, registry has none.** Add optional `genericSelectors: genericSelectorsSchema.optional()` (reuse the existing `GenericSelectorsSchema` shape from `src/config/schema.ts`). A registry entry with `atsType: "generic"` and no `genericSelectors` is skipped with a clear "not yet configured" reason — never silently fed placeholder selectors.
- **Uniqueness validation** (ranks unique, company+domain unique) via `.superRefine` on the array schema — currently absent.
- Rename file `config/fortune500_registry.json` → `config/fortune500-registry.json`, update the two hardcoded path references (`company-careers.ts:14`, `posting-resolver.ts:114`).

Filling in real ATS details for the rest of the Fortune 500 is explicitly **not** part of this phase (per the task brief: "do not fabricate unverified career URLs or ATS details" — the registry starts with the 5 already-verified entries; more get added only when independently verified, outside this implementation).

## 4. Discovery vs. Resolution stages

- **Discovery** produces `DiscoveredJobLite` — one record per portal-page result or per company-careers listing, cheap to produce, no full JD. Fields (existing `src/discovery/types.ts`, kept as-is: this is a deliberate name divergence from the task brief's `DiscoveredJob` name — the baseline codebase already has an unrelated `DiscoveredJob` type in `src/adapters/types.ts` with a different shape; naming the new one `DiscoveredJobLite` avoids a collision and is more accurate about what it is. **Flagged for approval**.
- **Resolution** takes a deduplicated set of `DiscoveredJobLite` and produces `JobPosting` (full JD, canonical URL, apply URL) via `PostingResolver`, which either delegates to an existing ATS adapter (when the destination is a known ATS) or falls back to generic Playwright extraction.
- The two stages never share a browser page directly — resolution opens its own page(s) against `discoveredUrl`, discovery closes its page(s) after each portal/keyword/company loop.

## 5. Checkpoint behavior

Already implemented correctly in `src/discovery/checkpoints.ts` (atomic save, keyed by `source::keyword::location`, tested in isolation). Two integration gaps to close:

- Company-careers currently advances the checkpoint index even on a per-company failure (§0.2 bug #6) — must instead record the company as "failed this run" (not completed, not silently skipped) so the reporting layer (Task 15) can surface it, while still moving on to the next company in the same run.
- No test exercises checkpoint behavior *through* the orchestrator (only the checkpoint module in isolation) — added in Task 16.

## 6. Deduplication behavior

`mergeJobs` (existing, already extended) keeps the original 4-tier order — canonical URL → source+requisitionId → company+title+location (guarded against generic titles via `isGenericTitle`) → JD fingerprint — and now also merges `discoveredFrom` (provenance/source list) and unions `matchedProfiles` across merges. This is correct as designed; no further changes needed beyond making sure every `JobPosting` producer actually populates `discoveredFrom` (§0.2 bug #2).

## 7. Browser lifecycle

- One shared `BrowserContext` per `npm run discover` invocation via `launchPersistentChrome`, opened lazily on first actual navigation (not at process start) — matches the "browser launched only when required" constraint.
- Domain-level pacing and retry/backoff are **not yet implemented as shared logic** — each portal adapter has its own ad-hoc delay. This is a real Task 6 gap: introduce a small shared helper (e.g. `withRetry(fn, {retries, backoffMs})` and a per-domain last-request timestamp map) that the 5 portal adapters and the resolver call, rather than 5 separate implementations. Kept intentionally minimal — no queue, no worker pool, just a guard function.
- `pauseForVerification` is already called from every portal adapter; must be added to `posting-resolver.ts`'s Playwright fallback path (§0.2 bug #8).
- Context shutdown: orchestrator must close the shared context once at the very end of the full run (both phases), not mid-run — confirmed already correct in the existing orchestrator structure (`orchestrator.ts:194` region), just needs a dedicated test.

## 8. Failure isolation

Already correct at the portal level (`try/catch` per adapter call in the orchestrator) and mostly correct at the company level (`try/catch` per company in `company-careers.ts`) except for bug #6 (failure silently advances past the company forever instead of being reported). Keyword-level isolation (one keyword's failure doesn't stop other keywords for the same portal) needs a dedicated test — logic appears present but unverified by any test today.

## 9. Testing strategy

No live browser/network calls in any test (already the project-wide rule, already followed by the WIP). Fixtures + mocked `fetch`/mocked `Page` objects only, same pattern as the existing `tests/adapters/*.test.ts`. New/missing test files needed: `tests/discovery/orchestrator.test.ts`, `tests/discovery/registry.test.ts`, `tests/discovery/company-careers.test.ts`, `tests/config/portals-schema.test.ts`, `tests/config/fortune500-registry.test.ts` (uniqueness + Workday/generic validation rules).

## 10. Controlled live validation

Deferred to the plan's final task, per the task brief's explicit scope: one Google search, one Indeed search, one Monster search, one LinkedIn public search, one Greenhouse company, one Lever company, one Workday company, one custom career page — small configured limits, never the full Fortune 500 scan. Not run until the plan is approved and all prior tasks are green.

## 11. Decisions flagged for explicit approval

1. Keep `DiscoveredJobLite` name (not `DiscoveredJob`) — avoids collision with the existing baseline type.
2. Keep existing Fortune 500 registry field names (`fortuneRank`, `atsTenantOrBoardId`, `verificationStatus`, `lastVerifiedDate`) instead of the task brief's literal names — only the filename changes to hyphenated.
3. Add `"DOM"` to `tsconfig.json`'s `lib` array (1-line fix for 10 of the 20 typecheck errors) rather than rewriting 6 call sites to avoid DOM types.
4. Company-careers Workday/generic entries with insufficient registry data are **hard-skipped with a clear reason**, not fabricated — this will reduce effective Fortune 500 coverage until the registry is manually filled in with verified data over time, which is expected and correct per the task brief.

## 12. Open questions

- Should failed companies/portals be retried automatically on the *next* `--resume`, or do they require an explicit `--reset-checkpoint`? Current code effectively answers "never retried" by accident (bug #6) — the plan's fix makes this an explicit, intentional choice instead. Recommend: failed items are retried on next resume (checkpoint marks them "attempted, not completed", so they're revisited), but this needs confirmation.
- `posting-resolver.ts`'s generic-extraction fallback and `configurable-generic-portal.ts`'s generic-portal fallback are two different "generic" concepts (post-hoc JD extraction vs. portal search) — worth double-checking naming doesn't get confused during implementation, but no code change implied here.

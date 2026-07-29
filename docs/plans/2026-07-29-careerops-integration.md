# CareerOps Integration Implementation Plan

**Goal:** Make CareerOps' reverse-ATS scanner (`scan-ats-full.mjs`) an optional, replaceable job-discovery source feeding the existing, unmodified Hunt pipeline (eligibility/location/freshness/scoring/reports), without touching native discovery, without merging git histories, and without copying CareerOps source into this repo.

**Architecture (revised after Phase 0 review — see "Corrections applied" below):** CareerOps runs as an external child process (`node scan-ats-full.mjs --json ...`), its stdout JSON is schema-validated per-record (Zod), mapped to a **preliminary discovery candidate** (`DiscoveredJobLite` — the same intermediate type native discovery already uses, reused rather than inventing a new one), filtered through our own 4-profile classifier (`evaluateRelevance()`, never CareerOps' own `title_filter`), then routed through the **existing** `PostingResolver`/`runResolutionPhase` (`src/resolver/posting-resolver.ts`, `src/discovery/resolve-phase.ts`) to actually attempt fetching the real JD — exactly the same resolution step native discovery already performs on its own discoveries. A CareerOps job that resolves successfully carries real JD text; one that doesn't carries the existing `UNRESOLVED_PLACEHOLDER_PREFIX`-tagged placeholder `descriptionText`, the same convention native discovery already uses for timeouts/failures — never a bare empty string standing alone as if resolution had succeeded with nothing. Resolved/placeholder `JobPosting`s are then merged into `data/jobs.jsonl` via the existing `mergeJobs`/`saveJobs` primitives, same as `orchestrator.ts` Phase 3. Hunt's eligibility/location/freshness/scoring/report layers are untouched.

**Tech Stack:** TypeScript (strict, NodeNext), Zod (already a dependency — no new dependency needed), `node:child_process.spawn` (no shell), Vitest.

## Global Constraints

- No `shell: true`, no string-concatenated child-process args — argv arrays only.
- No live network/browser calls in automated tests — fixture-driven only.
- One malformed CareerOps record must never fail the whole import; counted, not thrown.
- Never fabricate `remoteType`, location, company, or date — only what CareerOps actually returned, mapped honestly (`null`/`""` where absent, matching the existing `DiscoveredJobLite`/native convention for each field).
- Only `http:`/`https:` URLs may reach `applyUrl`/`canonicalUrl` in output (already enforced HTML-side by `writers.ts::safeHref`; the CareerOps schema adds a second gate at ingestion).
- `matchedProfiles` on CareerOps-sourced jobs comes ONLY from our existing `evaluateRelevance()` (src/discovery/relevance.ts) run post-mapping — never from CareerOps' own `title_filter`.
- Default `npm run hunt` behavior (no `--source` flag) must stay byte-for-byte the current native-only behavior — no invisible breaking change.
- All existing 378 tests must stay green; no test weakened/skipped/deleted to make this pass.
- No `npm run hunt` invocation with `--source careerops`/`both` runs automatically — Phase 6 live runs are explicit, manual, one at a time, reported before proceeding.
- CareerOps offers never carry a description (verified empirically — see Phase 0 evidence below). A CareerOps-sourced `JobPosting`'s `descriptionText` must never be a bare `""` standing in for "resolution not attempted." It is either real JD text from the existing resolver, or the existing `UNRESOLVED_PLACEHOLDER_PREFIX` ("`Job posting found on `") -tagged string the resolver already produces on failure/timeout — the same signal `scoring.ts::scoreJdCompleteness`/`computePenalties` and `report-rows.ts`'s `unresolved` field already key off. No new field invented.
- The CareerOps runner never writes into or modifies the CareerOps clone during a Hunt run, beyond CareerOps' own inherent 24h company-list cache under `data/cache/` (a read-through cache internal to how `scan-ats-full.mjs` works regardless of flags — documented, not hidden). The runner always passes `--dry-run` to CareerOps so it never writes its own `data/pipeline.md`/`data/scan-history.tsv` — we own persistence via `jobs.jsonl`, not CareerOps' side files.
- A preflight check runs before every CareerOps process spawn; on failure, no child process is spawned at all.

---

## Phase 0 status (complete, this is the record of it)

**Branch:** `careerops-integration`, created from `worktree-universal-job-discovery` (worktree at `F:\Jobs\Job_Search\job-hunter\.claude\worktrees\universal-job-discovery`) at commit `b510655` — confirmed via `git branch --all --contains b510655` and `git merge-base master worktree-universal-job-discovery` == `2d07906` (master's own tip; no divergence, hunt branch is strictly ahead).

**CareerOps clone:** `F:\Jobs\Job_Search\career-ops`, pinned commit `7bb0460c469642033dd5e90c4ead39940157e4f2` (2026-07-29). Installed with `npm install --ignore-scripts` (skips the heavy `postinstall` Playwright-Chromium download — not needed; `--liveness` is the only CareerOps flag that touches a browser, and we never pass it).

**Baseline:** 378 tests / 42 files, `npm run typecheck` clean, confirmed BEFORE any new file was added.

### CareerOps JSON contract — confirmed empirically, not assumed

Ran three real bounded commands against the live scanner (small `--limit`/`--ats`/`--since`, always `--dry-run` so nothing was persisted to CareerOps' own `data/pipeline.md`):

```powershell
node scan-ats-full.mjs --json --dry-run --ats greenhouse --limit 3 --since 7
node scan-ats-full.mjs --json --dry-run --ats greenhouse,lever --limit 40 --since 14
node scan-ats-full.mjs --json --ats bogus
```

Required precondition (undocumented in the user's draft spec, discovered live): CareerOps refuses to run at all without a `portals.yml` at its `CAREER_OPS_HOME` root (it reuses that file's `title_filter`/`location_filter`). Confirmed exact failure mode:

```
stdout: (empty — not even in --json mode)
stderr: Error: portals.yml not found. Run onboarding first — the reverse scan reuses its title_filter/location_filter.
exit code: 1
```

This means our runner must treat "no portals.yml" as a normal `SourceError`, not a crash, and our docs must tell the operator to provision a `portals.yml` (from CareerOps' own `templates/portals.example.yml`) before `--source careerops` will ever produce results.

**Command shape that actually works:** `node scan-ats-full.mjs --json --since <days> --ats <csv> --limit <n> [--dry-run]`. `--limit` is *per-ATS company cap*, not a total-postings cap — `--ats greenhouse,lever --limit 40` scanned up to 80 companies. `--dry-run` skips writing `data/pipeline.md`/`data/scan-history.tsv` but still makes real network calls (there is no fully-offline mode) — bounding cost is entirely on `--limit`/`--ats`/`--since`.

**Zero-result run** (`--ats greenhouse --limit 3`, 2 of 3 sampled companies unreachable): exit 0, clean single-line JSON, `"postingsKept":0,"offers":[]`, `"unreachableBoards":2`. Unreachable boards are counted, not fatal.

**Unknown-flag run** (`--ats bogus`): stdout empty, stderr `Error: unknown ATS source(s): bogus. Valid: greenhouse, lever, ashby, workday, icims`, exit 1. Valid `--ats` values confirmed as exactly: `greenhouse, lever, ashby, workday, icims` (matches the spec's expected list).

**Real (`--limit 40 --since 14`, 80 companies scanned) top-level JSON shape** — stdout is a single JSON line, ALL human/progress logging goes to stderr in `--json` mode:

```json
{
  "date": "2026-07-29",
  "sources": ["greenhouse", "lever"],
  "resumed": false,
  "sinceDays": 14,
  "companiesAvailable": 12701,
  "companiesScanned": 80,
  "capHit": true,
  "datasetStatus": { "greenhouse": "ok", "lever": "ok" },
  "postingsKept": 31,
  "postingsDroppedNoDate": 0,
  "postingsFilteredBlacklist": 0,
  "postingsAnnotatedBlacklisted": 0,
  "postingsDroppedContent": 0,
  "unreachableBoards": 40,
  "cappedBoards": 0,
  "saved": false,
  "offers": [ /* see below */ ]
}
```

**Per-offer shape** (two real sanitized examples captured live):

```json
{
  "company": "ableserve",
  "title": "Assistant Chief Engineer",
  "url": "https://jobs.lever.co/ableserve/fbe0d138-b0d5-447f-b3ef-0b2effc37107",
  "location": "Seattle, WA",
  "postedAt": "2026-07-28",
  "dateStatus": "dated",
  "blacklisted": false,
  "note": null,
  "source": "lever-full"
}
```
```json
{
  "company": "10alabs",
  "title": "Cybersecurity Engineer",
  "url": "https://job-boards.greenhouse.io/10alabs/jobs/4330885009",
  "location": "Remote · 10a Labs",
  "postedAt": "2026-07-28",
  "dateStatus": "dated",
  "blacklisted": false,
  "note": null,
  "source": "greenhouse-full"
}
```

Confirmed fields, exactly (no more, no less — **no `description` field ever appears**, contradicting the draft spec's example shape; `--json` mode carries no description at all):

| field | type | notes |
|---|---|---|
| `company` | string | required |
| `title` | string | required |
| `url` | string | required; observed only `https://`, but nothing in the source guarantees that — schema must still gate on scheme |
| `location` | string \| null | free text, NOT structured (e.g. `"Remote · 10a Labs"`) — never parse this as a remote flag ourselves, that's `location.ts`'s job downstream |
| `postedAt` | `"YYYY-MM-DD"` string \| null | date only, no time |
| `dateStatus` | string (`"dated"` \| `"unknown"` observed; source also emits other internal date classes) | informational only |
| `blacklisted` | boolean | from CareerOps' own `data/blacklist.md` — always `false` unless `--include-blacklisted` passed (we won't pass it) |
| `note` | string \| null | always `null` in current code paths we exercise |
| `source` | string, e.g. `"greenhouse-full"`, `"lever-full"` | **not** a bare ATS name — always suffixed `-full` for this scanner; provenance mapping must use this exact string, not invent `"careerops-greenhouse"` |

Top-level `sources` confirmed values (from `--ats bogus` error): `greenhouse`, `lever`, `ashby`, `workday`, `icims` — matches spec.

### File classification (files created before this checkpoint)

All five files below are the **generic `JobSource` contract layer only** — they contain no CareerOps-specific assumption, so nothing above changes them. All **KEEP, unmodified**:

| File | Status | Why |
|---|---|---|
| `src/sources/job-source.ts` | KEEP | Pure interface (`JobSource`, `SourceDiscoveryOptions/Result`, `SourceHealth`, `SourceError`) — matches spec's Phase 1 contract exactly, no CareerOps coupling to revise. |
| `src/sources/native-source.ts` | KEEP | Wraps the existing `runDiscover` unchanged; returns `jobs: []` because `runDiscover` already persists internally (documented in-file) — verified against the real `DiscoveryRunSummary` shape (`src/discovery/report.ts`), not assumed. |
| `src/sources/fixture-source.ts` | KEEP | Test-only seam, spec-required (`FixtureSource`), no CareerOps coupling. |
| `tests/sources/native-source.test.ts` | KEEP | Passing, exercises real `NativeSource` behavior via injected fake `runDiscoverFn`. |
| `tests/sources/fixture-source.test.ts` | KEEP | Passing, exercises real `FixtureSource` behavior. |

Git state: these 5 files are already committed on `careerops-integration` as `4c19491 chore(integration): anchor CareerOps external dependency contract` — **this happened before this checkpoint interrupt landed** (the commit tool call had already been dispatched in the same turn as the interrupt). Nothing after that commit is uncommitted; `git status --short` in the worktree shows only the pre-existing untracked `CLAUDE.md` (not mine, left alone). Current test count: **384 passed (44 files)** = 378 baseline + 6 new, `npm run typecheck` clean. Flagging this for review: if you want `4c19491` un-committed (kept as working-tree changes instead), say so and I'll run `git reset --soft HEAD~1` (safe — local-only commit, nothing pushed, no content lost) before continuing.

---

## Corrections applied after Phase 0 review (approved)

Two corrections required before Task 2 could start, both changing the design below (no code existed yet for either affected area — only the generic `JobSource` contract layer from Task 1 was committed, and it needed no change):

**Correction 1 — missing descriptions are unknown evidence, not empty evidence.** The original Task 4/5 design mapped a CareerOps offer straight to a final `JobPosting` with `descriptionText: ""`. Inspected `src/adapters/types.ts` (`JobPosting`, `RawJobDetail`), `src/resolver/posting-resolver.ts` (`PostingResolver.resolve()`), `src/discovery/resolve-phase.ts` (`runResolutionPhase`, `UNRESOLVED_PLACEHOLDER_PREFIX`), and `src/hunt/scoring.ts` (`scoreJdCompleteness`, `computePenalties`) before deciding anything. Finding: the codebase already has a complete, working mechanism for exactly this — every native discovery goes through `PostingResolver` first, and on failure/timeout gets a placeholder `descriptionText` prefixed `UNRESOLVED_PLACEHOLDER_PREFIX = "Job posting found on "`, which `scoring.ts` already treats as zero `jdCompleteness` + a penalty (never a seniority rejection — `classifyEligibility`'s years-extraction only reads real text and requires an "experience" context window, so empty/placeholder text always falls through to `eligible: true, seniority: "unknown"`), and which `report-rows.ts` already surfaces as `ReportRow.unresolved`. No new field was needed — reusing this beats inventing a parallel one. Revised design (Tasks 4/5 below): CareerOps offers map to `DiscoveredJobLite` (the same preliminary-discovery type native code already uses, not `JobPosting` directly), get relevance-classified, then run through the **existing** `PostingResolver`/`runResolutionPhase` to attempt real JD extraction — same as native. This does mean a `--source careerops` run now launches a real browser context (`launchPersistentChrome`, same as native/`orchestrator.ts`) to run the resolver, which it didn't in the original design; documented explicitly since it changes what "CareerOps-only, no browser" would have implied.

**Correction 2 — CareerOps setup must not depend silently on a local artifact.** Phase 0's live contract inspection required manually creating `F:\Jobs\Job_Search\career-ops\portals.yml` (gitignored there). Task 3 (runner) now includes an explicit `preflightCareerOps()` step, run before every process spawn, that checks: CareerOps home directory exists; `scan-ats-full.mjs` exists in it; `portals.yml` exists in it; `process.execPath` (the Node executable we'll re-invoke) exists; the clone's current commit (`git -C <home> rev-parse HEAD` via `execFile`, no shell) is readable; and compares that commit against `config/careerops-version.json`'s pinned value, reporting a mismatch as a clear warning (not a hard failure — the clone may have been legitimately updated). Any hard-failure precondition (missing home/script/portals.yml/node) means **no child process is spawned** — the runner returns a `SourceError` before ever calling `spawn`. The exact minimal `portals.yml` used for Phase 0 validation (no secrets) is recorded in Task 3 below and will be carried into `docs/integrations/careerops.md` (Task 8).

---

## Remaining phases (not yet started — every task below waits for this checkpoint to clear)

### Task 2 — CareerOps fixture + schema

**Files:**
- Create: `tests/fixtures/careerops/scan-ats-full.json` — a full top-level response object (shape above) whose `offers[]` includes: valid Greenhouse job, valid Lever job, valid Workday job (`source: "workday-full"`), a duplicate job appearing under two different `source` suffixes (same canonicalized URL/company+title+location, to exercise dedup later), a job with `location: null`, a job with an unsafe `"javascript:alert(1)"` URL, a job with a non-http(s) but syntactically-parseable URL (e.g. `ftp://...`), one malformed record (missing `title`), one senior-titled role (`"Senior Cloud Security Engineer"`), one junior/entry-compatible role, one multi-profile title (matches e.g. both `sdet` and `cloud` keywords), one irrelevant false-positive title (`"Cloud Sales Executive"` or `"Corporate Security Guard"` — the exact false positives `relevance.ts` already documents guarding against).
- Create: `src/sources/careerops/careerops-types.ts` — raw contract types: `CareerOpsOffer`, `CareerOpsScanResult` (exact fields from the table above, `offers: unknown[]` pre-validation).
- Create: `src/sources/careerops/careerops-schema.ts` — Zod: `careerOpsOfferSchema` (required `company`/`title`/`url` non-empty strings + safe-URL refinement restricted to `http:`/`https:`; optional/nullable `location`/`postedAt`/`note`; `dateStatus` string; `blacklisted` boolean; `source` string), `careerOpsScanResultSchema` (top-level shape, `offers: z.array(...)` validated as a **per-element pass**, not all-or-nothing — a helper `validateOffers(raw: unknown[]): { valid: CareerOpsOffer[]; invalidCount: number }` that `.safeParse`s each element independently).
- Test: `tests/sources/careerops/careerops-schema.test.ts` — valid job accepted; missing optional fields accepted; missing `company`/`title`/`url` each rejected; `javascript:` URL rejected; one malformed record among 3 valid ones still yields the 3 valid + `invalidCount: 1` (never throws on the whole array).

TDD: write `careerops-schema.test.ts` first, watch it fail (module missing), implement minimal Zod schema, green.

### Task 3 — CareerOps preflight + process runner

**Files:**
- Create: `src/sources/careerops/careerops-preflight.ts` — `preflightCareerOps(opts: { careerOpsHome: string; pinnedCommit?: string; execFileFn?: typeof execFile; existsFn?: typeof existsSync }): Promise<PreflightResult>` where `PreflightResult = { ok: boolean; errors: string[]; warnings: string[]; currentCommit: string | null }`. Checks, in order, short-circuiting to `ok:false` on the first hard failure:
  1. `existsFn(careerOpsHome)` — directory exists.
  2. `existsFn(path.join(careerOpsHome, "scan-ats-full.mjs"))` — script exists.
  3. `existsFn(path.join(careerOpsHome, "portals.yml"))` — user config exists (the precondition discovered live in Phase 0).
  4. `existsFn(process.execPath)` — the Node executable we're about to re-invoke is real.
  5. `execFileFn("git", ["-C", careerOpsHome, "rev-parse", "HEAD"], { shell: false })` — reads the clone's actual current commit. A failure here (not a git repo, git not installed) is a hard error, not silently skipped.
  6. If `opts.pinnedCommit` is given and differs from the read commit, push a **warning** (not an error) — `ok` stays true, the mismatch is surfaced to the caller/log, never silently ignored, never a hard stop (the clone may have been legitimately updated since the pin was recorded).
  Every check runs via injected `execFileFn`/`existsFn` (defaults to real `node:child_process.execFile`/`node:fs.existsSync`) — no live filesystem/process access in tests.
- Create: `src/sources/careerops/careerops-runner.ts` — `runCareerOpsScan(opts: { careerOpsHome: string; sinceDays: number; ats?: string[]; limit?: number; timeoutMs?: number; pinnedCommit?: string; spawnFn?: typeof spawn; preflightFn?: typeof preflightCareerOps }): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; preflight: PreflightResult }>`. Calls `preflightFn` first; if `!preflight.ok`, returns immediately with `exitCode: null, stdout: "", stderr: preflight.errors.join("; "), timedOut: false` and **`spawnFn` is never called**. On a passing preflight, spawns `spawn(process.execPath, ["scan-ats-full.mjs", "--json", "--dry-run", "--since", String(opts.sinceDays), ...(opts.ats?.length ? ["--ats", opts.ats.join(",")] : []), ...(opts.limit ? ["--limit", String(opts.limit)] : [])], { cwd: opts.careerOpsHome, shell: false })` — argv array, `--dry-run` always included (never caller-configurable — see Global Constraints), never a template string. Captures stdout/stderr on separate buffers. Enforces `timeoutMs` (default e.g. 120_000) via `setTimeout` + `child.kill()`; sets `timedOut: true` instead of throwing. `spawnFn` defaults to real `child_process.spawn`, injectable for tests. Nothing in this module runs at import time (no top-level call).
- Test: `tests/sources/careerops/careerops-preflight.test.ts` — missing home dir → `ok:false`, error mentions home; missing `scan-ats-full.mjs` → `ok:false`; missing `portals.yml` → `ok:false`; missing node executable (injected `existsFn` returns false for `process.execPath`) → `ok:false`; commit mismatch against `pinnedCommit` → `ok:true` with a warning naming both commits; all checks passing → `ok:true`, `currentCommit` populated, no warnings.
- Test: `tests/sources/careerops/careerops-runner.test.ts` — failing injected `preflightFn` → `spawnFn` is asserted **never called** (`expect(spawnFn).not.toHaveBeenCalled()`), returned result carries the preflight errors; passing preflight → exact executable (`process.execPath`) + argv array asserted (including the always-present `--dry-run`, `--json`, `--since`, and `--ats`/`--limit` only when provided); `shell` option is `false`; `cwd` equals `careerOpsHome`; stdout JSON captured verbatim; stderr captured separately; non-zero exit code surfaced in the return value (not thrown); a stub that never closes triggers `timedOut: true` and the injected kill spy is called; malformed stdout is returned as-is (parsing is the schema's job, not the runner's); importing the module alone (no call) has zero side effects.

**Minimal `portals.yml` used for Phase 0 validation** (no secrets — carried into Task 8 docs as the documented minimum):
```yaml
title_filter:
  positive:
    - "Engineer"
    - "SDET"
    - "Security"
    - "Cloud"
    - "Network"
  negative: []
```

TDD, same red/green cycle, preflight before runner (runner's tests depend on injecting a fake preflight result).

### Task 4 — CareerOps mapper (revised after second review: no `context` parameter, field values corrected against real adapter precedent)

**`--dry-run` semantics, confirmed (not re-run live — reused Phase 0 evidence + source read):** `scan-ats-full.mjs:869` gates only `appendToPipeline`/`appendToScanHistory` (CareerOps' own side-file writes) behind `!opts.dryRun`; the scan/filter/collect logic runs unconditionally either way. Phase 0's captured `--dry-run --ats greenhouse,lever --limit 40 --since 14` run returned `"postingsKept":31` with 31 real offers and `"saved":false` — proof `--dry-run` still performs real discovery and returns real offers, it only suppresses CareerOps' own persistence.

**Files:**
- Create: `src/sources/careerops/careerops-mapper.ts` — `mapCareerOpsOffer(offer: CareerOpsOffer): CareerOpsMapResult` where `CareerOpsMapResult = {ok:true; job: DiscoveredJobLite} | {ok:false; code: "UNSAFE_URL" | "MISSING_REQUIRED_FIELD"; message: string}`. **No `context` parameter** (deviates from the originally-sketched signature) — verified against `src/discovery/adapters/company-careers.ts:178-200`, the real precedent for producing a `DiscoveredJobLite`: every field is either offer-derived, wall-clock (`discoveredAt: new Date().toISOString()`, read directly, no injected override anywhere in the existing codebase), or a fixed neutral placeholder that file's own comment documents as "overwritten [by the orchestrator] before a job is ever written to disk" — nothing legitimate needs external context at this layer. Defensive re-validation (unsafe URL, missing company/title) exists because the type system alone can't guarantee a caller always passes schema-validated input — never trust the caller blindly, even though the documented contract requires it.
  Mapping, matching `company-careers.ts` precedent exactly where it exists: `source: offer.source` (verbatim, e.g. `"lever-full"`, never relabeled — an unrecognized future ATS suffix is preserved as raw provenance, not rejected, since passthrough can't misclassify anything), `searchKeyword: ""` (CareerOps is reverse discovery, no per-keyword search concept — empty is honest, not fabricated), `title: offer.title`, `company: offer.company`, `location: offer.location ?? ""` (matches `company-careers.ts`'s own `raw.location ?? ""`, never `"Remote"`), `resultUrl: offer.url` (raw, uncanonicalized — matches precedent; `canonicalizeUrl` is applied later, downstream, on `JobPosting.canonicalUrl`, never duplicated here), `possibleOfficialUrl: offer.url` (same as `resultUrl` — matches `company-careers.ts`'s `possibleOfficialUrl: job.url`, correcting the earlier draft's `null`), `postingAgeOrDate: offer.postedAt` (verbatim, `string | null`), `sourceJobId: null` (no separate ID), `salarySnippet: null`, `department: null`, `descriptionSnippet: null` (never `""` — CareerOps never supplies one), `discoveredAt: new Date().toISOString()`, and the exact same "neutral placeholder" block `company-careers.ts` uses verbatim: `searchedProfile: null, matchedKeywords: [], matchedFields: [], relevanceReason: "", matchedProfiles: []` — filled in later by Task 5's `evaluateRelevance()` call, never derived from CareerOps' own matching here. Stable identity is NOT computed in this module — `computeJobId(canonicalUrl)` (`src/dedup/canonicalize-url.ts`) still only runs downstream, once, same as every other source; this mapper's only contribution to stability is a deterministic, offer-only-derived `resultUrl`.
- Test: `tests/sources/careerops/careerops-mapper.test.ts` — see Task 4 completion report for the full 20-case list executed.

### Task 5 — CareerOps source: relevance filter + existing resolver + `CAREER_OPS_HOME` resolution (revised)

**Files:**
- Create: `src/sources/careerops/careerops-config.ts` — `resolveCareerOpsHome(cliOption?: string): string`. Order: CLI option, then `process.env.CAREER_OPS_HOME`, then documented sibling default `path.resolve(process.cwd(), "..", "career-ops")`. Throws a clear error only when used (never at import).
- Create: `src/sources/careerops/careerops-source.ts` — `CareerOpsSource implements JobSource` (`id = "careerops"`), constructed with `{ roles: RoleConfig[]; resolver: PostingResolver; context: BrowserContext | undefined; runScanFn?: typeof runCareerOpsScan }` — the `BrowserContext` is **injected by the caller** (`run-hunt.ts`'s `--source careerops`/`both` dispatch launches it via the existing `launchPersistentChrome`, same lifecycle `orchestrator.ts` already owns; `CareerOpsSource` never launches or closes a browser itself, keeping that lifecycle centralized in one place). `discover(options)`:
  1. Calls `runScanFn` (the Task 3 runner, which itself preflights). Preflight/spawn/timeout failure → returns `{ jobs: [], health: {attempted:1,succeeded:0,failed:1}, errors: [{source:"careerops", message}] }` immediately — never throws, one CareerOps failure must not crash `npm run hunt`.
  2. Parses stdout, runs `careerOpsScanResultSchema`/`validateOffers` (Task 2) — invalid records counted, not fatal.
  3. Maps each valid offer via `mapCareerOpsOffer` (Task 4) to a `DiscoveredJobLite`.
  4. Runs `evaluateRelevance()` (imported from `../../discovery/relevance.js`, given `this.roles`) against `{title, department: null, location, descriptionSnippet: null}` per candidate — drops candidates matching zero profiles (or zero of the requested `options.profileIds` when given, same "requested-and-matched" narrowing `orchestrator.ts` already does), mutates `matchedProfiles`/`matchedKeywords`/`matchedFields`/`relevanceReason` in place from OUR evaluation only.
  5. Runs the retained candidates through the **existing** `runResolutionPhase` (`src/discovery/resolve-phase.ts`) with `resolveFn = (job) => this.resolver.resolve(job, this.context)` — same bounded concurrency/per-job-timeout/placeholder-on-failure behavior native discovery already relies on. A candidate whose resolution fails/times out comes back as a `JobPosting` with the existing `UNRESOLVED_PLACEHOLDER_PREFIX`-tagged `descriptionText`, never a bare `""`. One candidate's resolution failure never stops the others (already guaranteed by `runResolutionPhase`, reused unmodified).
  6. Returns `{ jobs: resolvePhaseResult.resolvedJobs, health: {attempted, succeeded, failed: unresolved}, errors: [] }`.
- Create: `src/sources/careerops/index.ts` — barrel re-exporting the public surface (`CareerOpsSource`, config resolver, types) — nothing else outside `src/sources/careerops/` imports the runner/schema/mapper/preflight directly, per the spec's isolation requirement.
- Test: `tests/sources/careerops/careerops-config.test.ts` (CLI > env > sibling-default precedence, each independently).
- Test: `tests/sources/careerops/careerops-source.test.ts` — fixture-driven via injected `runScanFn` + a fake `resolver.resolve` (no real `PostingResolver`, no real browser context in tests):
  - schema-invalid record dropped + counted, malformed stdout doesn't throw;
  - profile classification comes from `evaluateRelevance`, not CareerOps (a fixture offer whose title only matches CareerOps' own filter but none of our 4 profiles' keywords is dropped);
  - **Correction 1, fixture requirement #3:** a fake `resolver.resolve` returning a `JobPosting` with real JD text is passed straight through — the resolved job's `descriptionText` is exactly what the fake resolver returned, not overwritten;
  - **Correction 1, fixture requirement #4:** a fake `resolver.resolve` throwing/timing out yields a `JobPosting` with `descriptionText` starting with `UNRESOLVED_PLACEHOLDER_PREFIX` and a human-readable reason — sourced from `runResolutionPhase`'s own existing placeholder builder, not a new one;
  - one candidate's resolver failure does not stop the batch — assert the other candidates in the same fixture still resolve successfully.

### Task 6 — Hunt CLI / `run-hunt.ts` `--source` selection

**Files:**
- Modify: `src/hunt/cli.ts` — add `--source <careerops|native|both>` (default unset = current native-only behavior, unchanged) and `--careerops-home <path>`.
- Modify: `src/hunt/run-hunt.ts` — `HuntFilters` gains `source?: "careerops" | "native" | "both"`, `careerOpsHome?: string`. Dispatch: `native`/unset → today's exact code path (`runDiscoverFn` call, unchanged, owns its own browser launch/close internally as it always has). `careerops` → **launches a browser context itself** (Correction 1: `CareerOpsSource` needs one to run the existing resolver — reuses `launchPersistentChrome`/`closePersistentChrome` from `src/browser/launcher.ts`, the exact same functions `orchestrator.ts` already uses, in the same try/finally shape, so this is a call-site addition, not new lifecycle code), constructs `CareerOpsSource` with that context + a real `PostingResolver` + loaded `roles`, calls `.discover()`, then `loadJobs`/`mergeJobs`/`saveJobs` against `jobsStorePath` (same primitives `orchestrator.ts` Phase 3 already uses — no new dedup logic). `both` → run native first (persists as today, closes its own context), then run the careerops path on top (its own context launch/close, reads the now-updated `jobs.jsonl` as "existing", matching the spec's "run both and deduplicate before Hunt filtering"). Note this means `--source careerops` inherits the same manual-CAPTCHA-pause behavior `CLAUDE.md` already documents for `--source native`/`npm run discover` — not a new risk, the existing one, now reachable from a second code path; called out explicitly in Task 8 docs.
- Test: `tests/hunt/cli.test.ts` additions (parsing `--source`/`--careerops-home`) and `tests/hunt/run-hunt.test.ts` additions: default (no `--source`) calls `runDiscoverFn` exactly as before (regression guard against the "invisible breaking change" the spec forbids); `--source careerops` never calls `runDiscoverFn` (asserted via the injected fake) — browser-launch itself is exercised via an injected fake `launchFn`/`closeFn` pair (same DI pattern `runDiscover` already uses), never a real Chrome process in tests; `--source both` calls both and the resulting `jobs.jsonl` has merged/deduped entries with `discoveredFrom` containing both sources' provenance.

### Task 7 — End-to-end fixture integration test

**Files:**
- Create: `tests/sources/careerops/integration.test.ts` — drives `tests/fixtures/careerops/scan-ats-full.json` through schema → mapper → `evaluateRelevance` → a **fake resolver** (injected, no real browser/network) → `mergeJobs`/storage → `buildReportRows` (eligibility/location/freshness/scoring) → `writeJsonReport`/`writeCsvReport`/`writeHtmlReport`, all against temp files. Assertions: the two same-job-different-source-suffix fixture entries merge into one row with `discoveredFrom` containing both; the senior-titled fixture job is absent from output; the false-positive-title fixture job is absent (never matched a profile); the `javascript:` URL fixture job never appears in `applyUrl` of any written report; HTML output escapes fixture titles/companies containing `<`/`&`; running the pipeline twice with the same fixture + `--new-only` semantics produces no new "new" jobs the second time (idempotency, matching the existing `run-hunt.test.ts` pattern for this); **Correction 1, fixture requirement #2:** a fixture offer with no `description` and no years-of-experience signal anywhere reaches `buildReportRows` as `eligible: true, seniority: "unknown"` — never falsely rejected for years of experience purely because it has no JD; **Correction 1, fixture requirement #5:** for a fixture offer whose fake resolver call fails, the resulting `ReportRow.unresolved` is `true` and `scoreBreakdown.jdCompleteness` is `0` — missing JD evidence is never represented as a successful complete extraction anywhere in the written report.

### Task 8 — Docs + pin file

**Files:**
- Create: `config/careerops-version.json` — `{"repository":"santifer/career-ops","commit":"7bb0460c469642033dd5e90c4ead39940157e4f2","testedAt":"<ISO timestamp stamped at commit time>"}`.
- Create: `docs/integrations/careerops.md` — why external (replaceable, upstream-maintained, avoids re-implementing 5 ATS scrapers), install (`git clone` sibling + `npm install --ignore-scripts` + why `--ignore-scripts`), `CAREER_OPS_HOME` resolution order, tested commit, `portals.yml` precondition (discovered live, documented above) with a pointer to `templates/portals.example.yml`, supported commands, `--source` selection table, failure behavior (CareerOps failure → `SourceError`, never crashes the run, native fallback still available), upgrade procedure (re-clone/pull, re-run Phase 6 smoke test, update the pin file), rollback (`--source native`, or point `CAREER_OPS_HOME` back at an older pinned commit), security boundaries (`shell:false`, argv arrays, http/https-only URLs, no secrets logged from stderr).

### Task 9 — Full regression + adversarial review

Run `npm test` (all tasks' tests + existing 378, expect 0 regressions), `npm run typecheck`, then an independent adversarial review pass of the full diff (schema bypass attempts, spawn injection attempts, dedup correctness, HTML-escaping of CareerOps-sourced fields specifically since they're new untrusted input reaching the writers). Reproduce every claimed defect before fixing; fix commit separate from feature commits if anything real is found.

### Task 10 — Live smoke test + shadow comparison (Phase 6/7 of the original spec)

Manual, not TDD, not run until Task 9 is green and reviewed. Requires a real `portals.yml` at `CAREER_OPS_HOME` (copy `templates/portals.example.yml`, edit `title_filter.positive` to the 4 profiles' `config/roles.yml` keywords) — will ask before doing this since it changes CareerOps' own (gitignored) user config. Bounded `--dry-run` first, then per-profile live runs with `--limit`, then `--source native` vs `--source careerops` vs `--source both` comparison with a manually-classified Top-20 Precision@20 report. Will report raw/eligible counts and precision per profile before recommending any default-source change; per spec, CareerOps only becomes the recommended default if Precision@20 ≥ 80%, never merely for finding more jobs.

---

## Commit plan (unchanged from spec, restated for reference)

```
chore(integration): anchor CareerOps external dependency contract   [done: 4c19491]
feat(sources): add CareerOps schema and fixture                      [Task 2]
feat(sources): add safe CareerOps process runner                     [Task 3]
feat(sources): map CareerOps jobs to canonical postings              [Task 4]
feat(sources): wire CareerOps source + CAREER_OPS_HOME resolution    [Task 5]
feat(hunt): add CareerOps source selection                           [Task 6]
test(integration): cover CareerOps end-to-end fixture pipeline       [Task 7]
docs(integration): document setup, pinning and rollback              [Task 8]
```

No push at any point unless explicitly requested. No live `npm run hunt --source careerops`/`both` run happens until Task 9 is reviewed and Task 10 is explicitly greenlit.

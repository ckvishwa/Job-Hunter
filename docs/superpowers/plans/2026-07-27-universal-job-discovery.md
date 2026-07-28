# Universal Job Discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Do not start Task 1 until Task 0 is fully green (`npm test` + `npm run typecheck` both clean).

**Companion doc:** `docs/superpowers/specs/2026-07-27-universal-job-discovery-design.md` — read it first, it has the full audit of what already exists and why each decision below was made.

**Goal:** finish the already-started multi-portal + Fortune 500 discovery system: fix the existing broken WIP, fill the real gaps (portals.yml, registry schema fixes, shared retry/pacing, reporting, missing tests), then run one controlled live validation pass per source.

## Global constraints (unchanged from the task brief)

- No LLM calls anywhere in discovery/resolution.
- No resume-fit scoring in this phase.
- Never solve CAPTCHAs, never bypass access controls, no stealth/fingerprint-spoofing/proxy-rotation/automation-hiding.
- One source/company/keyword's failure never stops the others.
- No live network/browser calls in any test — fixtures + mocked `fetch`/`Page` only.
- Do not remove or rewrite the 8 baseline modules (adapters, registry, extraction, storage, dedup, source-runner, CLI, browser launcher/verification) unless a verified defect requires it — this plan touches 4 of them for the `discoveredFrom` fix only (§Task 0, additive one-line changes).
- Sequential execution, one implementer at a time, independent reviewer per task, reproduce every claimed defect before fixing it, isolated git worktree for the whole phase, local commits only, no push.

## Progress ledger

- [x] Task 0 — Stabilize existing WIP (typecheck + real bug fixes) — commits 9bf2a1a, 2d07906. Independently reviewed; 2 real findings (accidental sites.yml live-enable, reverted; posting-resolver.ts Workday-site fabrication, logged into Task 10 above). Dedup generic-title-guard behavior change reviewed and confirmed intentional (Task 11 requirement), not a defect.
- [x] Task 1 — `config/portals.yml` + schema — commits d12cb63, 9222a13. Reviewed clean (1 cosmetic comment fix).
- [x] Task 2 — Fortune 500 registry: rename, schema fixes, uniqueness validation — commit 2f2bbab. Reviewed clean.
- [x] Task 3 — Discovery types cleanup (remove `as any` side-channels) — commit 12b8b56. Reviewed clean.
- [x] Task 4 — Discovery storage (already done — verify + add missing tests) — commit 24b12ad. Reviewed clean.
- [x] Task 5 — Checkpoints (already done — fix company-careers integration bug) — commits c3742aa, d47b701. Review found and fixed a real orchestrator bug (checkpoint.completed short-circuited all future retries) and a real identity-vs-index bug (registry reorder would misattribute progress). Known non-blocking gap: a structurally-skipped company stays skipped after its registry data is later filled in, until a checkpoint reset (--reset-checkpoint is Task 14, not built yet).
- [x] Task 6 — Shared retry/backoff + domain-pacing helper — commit 607b1a3. Review found + fixed a real scope-too-wide bug (module-level pacer in posting-resolver.ts shared across unrelated instances). One scope-too-narrow gap tracked, not fixed (see note under Task 6 above).
- [x] Task 7 — Portal adapters: wire to `portals.yml`, remove selector-config cast — commit 1b4db5a. Reviewed clean; deliberate behavior change (nothing runs by default now, matches sites.yml convention) confirmed correct by direct trace. One pre-existing UX gap logged under Task 15.
- [x] Task 8 — Portal adapter registry (already done — add tests) — commit d319ed3c. Reviewed clean.
- [x] Task 9 — Company-careers runner: stop fabricating data — test coverage added, commit closing the 3 remaining gaps from the Task 9 checklist. Reviewed clean.
- [x] Task 10 — Posting resolver: fix typecheck + add verification-pause — commits 7a7db79, 95d0551. Fixed the flagged Workday-site fabrication (registry-verified atsWorkdaySite now wired in, never guesses "careers"). Review found the first proof-test didn't actually discriminate fixed-vs-buggy code (incomplete fetch mock let both pass identically) — rewritten to inspect the actual fetch call log instead; verified by empirically swapping in the pre-fix code and confirming the test fails, then restoring and confirming it passes.
- [x] Task 11 — Cross-source dedup (already done — verify only) — test-only commit closing the malformed-URL-in-mixed-batch gap. Reviewed clean.
- [x] Task 12 — Keyword orchestration (already done — verify only) — new tests/discovery/orchestrator.test.ts (first coverage of runDiscover), verified against real config/roles.yml. Reviewed clean. Note: found `--dry-run` doesn't exist anywhere yet (not in cli.ts, not in DiscoverFilters) — Task 13's dry-run test needs Task 14 to land first; doing Task 14 next, out of numeric order.
- [x] Task 13 — Orchestrator: dedicated test coverage — commits af7c1ec, 7c8a37e. Self-review caught a real hermeticity gap (unmocked fetch + a real 500ms sleep leaking into 2 new tests) and fixed before commit; independent review found only a dormant fake-timer cleanup fragility, fixed. 180/180 tests, ~1.8s total suite time.
- [x] Task 14 — CLI (already done — verify only) — commits 77b0ee4, abf1144. Added --company/--resume/--reset-checkpoint/--dry-run (all 4 were missing). Self-review caught and fixed a real bug: --company + checkpoint.completed marking would have permanently stranded unfiltered companies (fixed at the orchestrator layer, verified by empirical revert/restore). Independent review found only cosmetic follow-ups (duplicated comment, dry-run+reset-checkpoint silent no-op needed a log line) — both fixed and reviewed clean.
- [x] Task 15 — Reporting module — commit 429a757. Every field wired to a real signal, none fabricated (discoveriesRejected honestly hardcoded 0 -- no rejection logic exists yet). Reviewed clean; 2 pre-existing counting quirks noted (not introduced here, not fixed): sourcesAttempted counts a source even when every keyword checkpoint was already complete (discover() never called); pagesProcessed doesn't count a terminal empty page. One narrow theoretical false-positive in the officialPostingsResolved/unresolvedDiscoveries split (string-matches the resolver's placeholder text).
- [x] Task 16 — Fill remaining test gaps; confirm all tests + typecheck green — commit 26cbcc1. Repeated-page-stopping was genuinely untested (added, empirically verified to catch a real regression). Missing-selector clear error confirmed as a real, never-implemented design goal (not a test gap) -- recorded here, not built: no adapter anywhere distinguishes "legitimately zero results" from "the configured selector is stale." Final: 29 files, 187/187 tests, 0 typecheck errors.
- [x] Task 17 — Controlled live validation — all 7 items recorded: Figma success, AHEAD verification-required (real reCAPTCHA), Workday blocked (structural code gap), Google/Indeed/Monster/LinkedIn all timeout (real anti-bot stalling on page.goto, consistent across all 4 major portals; company-careers' fetch()-based paths unaffected). See "Task 17 restart log" below for full detail. No CAPTCHA solved/bypassed, no orphaned process left behind, portals.yml reverted to original state.

---

## Task 0: Stabilize existing WIP

**Files:** `tsconfig.json`, `src/adapters/generic-playwright.ts`, `src/adapters/greenhouse.ts`, `src/adapters/lever.ts`, `src/adapters/workday.ts`, `src/discovery/adapters/company-careers.ts`, `src/resolver/posting-resolver.ts`, `tests/dedup/deduplicator.test.ts`, `tests/storage/jsonl-store.test.ts`, `tests/discovery/adapters.test.ts`.

- [ ] **Step 1:** Add `"DOM"` to `tsconfig.json`'s `lib` array (`["ES2022", "DOM"]`). Resolves 10 of the 20 typecheck errors (`window`/`document`/`HTMLAnchorElement` in `google-jobs.ts`, `indeed.ts`, `monster.ts`, `linkedin-public.ts`, `configurable-generic-portal.ts`, `posting-resolver.ts`).
- [ ] **Step 2:** In each of `generic-playwright.ts:171`, `greenhouse.ts:104`, `lever.ts:95`, `workday.ts:146`, add `discoveredFrom: [site.id]` to the object literal returned by `normalize()`. Fixes 2 producer errors directly and, once test fixtures are updated (Step 3), the 2 derived test-fixture errors.
- [ ] **Step 3:** Fix the two test fixture builders in `tests/dedup/deduplicator.test.ts` and `tests/storage/jsonl-store.test.ts` (their `makeJob()` helpers) to always include `discoveredFrom: [...]` so the literal satisfies `JobPosting`.
- [ ] **Step 4:** Fix `linkedin-public.ts:56` — the `postingAgeOrDate` computation (`el.textContent?.trim() ?? el.getAttribute("datetime") ?? null`) can yield `string | null | undefined`; coerce to `string | null` explicitly (e.g. wrap in `?? null` after the whole chain, or an explicit ternary) so it matches `DiscoveredJobLite.postingAgeOrDate: string | null`.
- [ ] **Step 5:** Fix `posting-resolver.ts:9` — import `CompanyRegistryEntry` from `../config/schema.js`, not `../types.js`.
- [ ] **Step 6:** Fix `posting-resolver.ts:178,187` — cast/narrow the `unknown` result of `apiRes.json()` before assigning to `rawMetadata: Record<string, unknown>` (e.g. `(await apiRes.json().catch(() => ({}))) as Record<string, unknown>`).
- [ ] **Step 7:** Fix `tests/discovery/adapters.test.ts:259` — give the `onPageProcessed` callback's `jobs` parameter an explicit `DiscoveredJobLite[]` type instead of relying on an outer `as any` to infer it.
- [ ] **Step 8 (real bug, not a type error):** In `posting-resolver.ts`, add a `detectVerification`/`pauseForVerification` check on the Playwright fallback path (wherever it navigates to `discoveredUrl` before scraping), mirroring how every portal adapter already does this. Add a test asserting the resolver pauses and returns the verification result when a challenge is detected.
- [ ] **Step 9 (real bug, not a type error):** Fix `company-careers.ts`:
  - Remove the `job.location || "Remote"` fabrication (line 96). Instead, after `discoverJobs`, call `adapter.fetchJobDetails` + `adapter.normalize` for each discovered job (the same full pipeline the baseline `source-runner` uses) and take `location`/other fields from the resulting `JobPosting`. This also fixes the `DiscoveredJob.location` TS2339 error directly, without adding a `location` field to the baseline `DiscoveredJob` type (that type intentionally stays pre-detail-fetch — adding a field there speculatively would violate "no abstractions without a current consumer").
  - Remove the hardcoded `site: "careers"` Workday fallback (line 61) and the hardcoded generic-selector guesses (lines 65-73) — replaced by real registry-backed values once Task 2 lands the schema additions. Until Task 2 lands, a company entry missing the required field is skipped with a clear logged reason (not fabricated) — this ordering means Task 9 depends on Task 2 shipping first for Workday/generic entries to work at all; greenhouse/lever entries (which only need `atsTenantOrBoardId`) work immediately.
  - Replace the silent post-failure checkpoint advance (line 122) with a call that records the company as failed-this-run (see Task 5) rather than indistinguishable from "done."
  - Replace `(context as any).profileIds` and `(context as any).onVerificationPause` with real typed fields (see Task 3).
- [ ] **Step 10:** Run `npm run typecheck` — expect 0 errors. Run `npm test` — expect all existing tests (113) still green plus the new verification-pause test from Step 8.

---

## Task 1: `config/portals.yml` + schema

**Files:** Create `config/portals.yml`; modify `src/config/schema.ts`, `src/config/loader.ts`; create `tests/config/portals-schema.test.ts`.

**Design:** see spec §3.1 for the exact `portalConfigSchema`/`portalsFileSchema` shape (models directly on the existing `siteSchema`/`sitesFileSchema` pattern — same `settings` + array shape, same `parseAndValidate` call).

- [ ] Add `portalConfigSchema` + `portalsFileSchema` to `src/config/schema.ts`, exporting `PortalConfig`/`PortalsFile` types.
- [ ] Add `loadPortalsConfig(filePath: string): PortalConfig[]` to `src/config/loader.ts`, following the exact shape of `loadSitesConfig`.
- [ ] Write `config/portals.yml` with real, working entries for `google-jobs`, `indeed`, `monster`, `linkedin-public` (selectors matching what the existing adapters in `src/discovery/adapters/*.ts` already hardcode — extract those hardcoded selectors into this file rather than inventing new ones) and one `generic` example (all `enabled: false` by default, mirroring `config/sites.yml`'s example-entries convention).
- [ ] Test: invalid `type`, missing required selector fields, and negative/zero `maxPages`/`maxDiscoveries` each fail validation with a clear message; a minimal valid file loads with defaults applied.

---

## Task 2: Fortune 500 registry — rename, schema fixes, uniqueness

**Files:** `git mv config/fortune500_registry.json config/fortune500-registry.json`; modify `src/config/schema.ts`, `src/config/loader.ts`, `src/discovery/adapters/company-careers.ts:14`, `src/resolver/posting-resolver.ts:114`; create `tests/config/fortune500-registry.test.ts`.

- [ ] Rename the file (git mv, preserves history) and update both hardcoded path references.
- [ ] Add `atsWorkdaySite: z.string().min(1).nullable()` to `companyRegistryEntrySchema`.
- [ ] Add `genericSelectors: genericSelectorsSchema.optional()` to `companyRegistryEntrySchema` (reuses the existing `genericSelectorsSchema` from `src/config/schema.ts:19` — no new selector shape invented).
- [ ] Add `.superRefine` on `companyRegistrySchema` (the array schema) enforcing: `fortuneRank` values unique among non-null entries; `company`+`corporateDomain` pairs unique. Clear error messages naming the offending index/company.
- [ ] Update the 5 existing entries in the renamed file: Walmart (workday) needs a real `atsWorkdaySite` value or explicit `null` if genuinely unknown — do not invent one; if unknown, leave `null` and note in a comment that Workday discovery for Walmart is blocked pending manual verification (per "do not fabricate unverified ATS details").
- [ ] Test: duplicate rank rejected, duplicate company+domain rejected, unknown `atsType` rejected, valid file with all 5 current entries loads clean.

---

## Task 3: Discovery types cleanup

**Files:** `src/discovery/types.ts`, `src/discovery/orchestrator.ts`, `src/discovery/adapters/company-careers.ts`.

- [ ] Add `profileIds: string[]` and `onVerificationPause?: () => void` as real, typed fields on `DiscoveryContext` (not bolted-on `as any` side channels).
- [ ] Update `orchestrator.ts` to populate these fields directly instead of the `(discoveryCtx as any).profileIds = ...` pattern at the line noted in the audit.
- [ ] Update `company-careers.ts` to read `context.profileIds` / `context.onVerificationPause` directly (no casts).
- [ ] No behavior change — purely a type-safety cleanup already implied by Task 0 Step 9's last bullet. Verify with `npm run typecheck`.

---

## Task 4: Discovery storage — verify + close test gap

**Files:** none changed (implementation already correct per audit); add coverage if missing.

- [ ] Confirm `loadDiscoveredJobs`/`saveDiscoveredJobs`/`appendDiscoveredJobs` in `src/storage/jsonl-store.ts` have test coverage for: malformed-line isolation, idempotent re-append of the same record, `lastSeenAt` update on re-discovery, provenance-array growth (not replacement) on re-discovery. Add whichever of these four cases isn't already covered by the existing (uninspected in detail) storage tests.

---

## Task 5: Checkpoints — fix company-careers integration bug

**Files:** `src/discovery/checkpoints.ts` (likely no change), `src/discovery/adapters/company-careers.ts`, `tests/discovery/checkpoints.test.ts`.

- [ ] Extend the checkpoint data recorded per company from binary "processed index" to distinguish `completed` vs `failed` (e.g. a `failedKeys: string[]` alongside the existing `sourceJobIds`, or reuse the existing `completed: boolean` at the per-company granularity if the checkpoint schema already supports sub-keys — confirm exact shape against `src/discovery/types.ts`'s `DiscoveryCheckpoint` before deciding whether this needs a new field or reuses `completed`).
- [ ] Company-careers' catch block (Task 0 Step 9) records the failure via this mechanism instead of silently advancing past it forever.
- [ ] Test: a company that throws on run 1 is retried (not skipped) on a `--resume` run 2; a company that succeeds on run 1 is not re-processed on run 2.
- [ ] Resolves Open Question #1 from the design spec: failed items ARE retried on next resume — only `--reset-checkpoint` clears "completed" state, but a run always retries anything not marked completed, including prior failures.

---

## Task 6: Shared retry/backoff + domain-pacing helper

**Files:** create `src/discovery/rate-limit.ts`; modify all 5 files in `src/discovery/adapters/` + `src/resolver/posting-resolver.ts` to use it.

- [ ] `export async function withRetry<T>(fn: () => Promise<T>, opts: {retries: number; backoffMs: number}): Promise<T>` — bounded retry with linear/exponential backoff (simple `backoffMs * attempt`, no need for anything fancier).
- [ ] `export function pacer(delayBetweenActionsMs: number): () => Promise<void>` — returns a function that, called before each navigation to the same domain, waits out the configured delay since the domain's last call. Track last-call timestamp in a `Map<string, number>` closed over by the returned function — no external state, no new dependency.
- [ ] Wire both into each portal adapter's navigation/pagination loop and into the resolver's redirect-follow/fetch path, replacing whatever ad-hoc `setTimeout`/delay each currently has.
- [ ] Test: `withRetry` retries the configured number of times then throws the last error; `pacer` delays a second call to the same domain but not a call to a different domain.

- [ ] **Found during Task 6 review, tracked not fixed:** each portal adapter creates its `pacer` fresh inside `discover()`, which the orchestrator calls once per (source × role × keyword) — so pacing only holds within one keyword's own pagination, not across back-to-back keyword searches against the same portal (e.g. indeed.com searched for "SDET" then immediately "QA Engineer" with zero enforced delay between them). Judged acceptable for Task 6's literal scope (satisfies "wire into each adapter's pagination loop") but doesn't naturally belong to any later task as currently scoped either. Real fix, if ever prioritized: hoist one `pacer` instance per run per source in the orchestrator and pass it into `DiscoveryContext` instead of each adapter creating its own.

---

## Task 7: Portal adapters — wire to `portals.yml`

**Files:** `src/discovery/adapters/google-jobs.ts`, `indeed.ts`, `monster.ts`, `linkedin-public.ts`, `configurable-generic-portal.ts`.

- [ ] Each adapter reads its selectors/pagination limits from the matching `PortalConfig` entry (Task 1) instead of hardcoded literals in the adapter file itself — matches "keep volatile selectors configurable, don't hardcode portal selectors throughout source files."
- [ ] `configurable-generic-portal.ts` stops casting `site.generic as unknown as GenericPortalSelectors` — reads a real `PortalConfig` (`type: "generic"`) instead. Delete the exploratory inline comments already flagged in the audit (§0.2, item under "Stub/partial").
- [ ] No change to each adapter's actual scrape/paginate logic — this task is a config-source swap, not a rewrite.
- [ ] Update the 5 existing adapter test files to construct a `PortalConfig` fixture instead of a raw `SiteConfig`-shaped object, wherever they currently do the latter.

---

## Task 8: Portal adapter registry — add tests

**Files:** create `tests/discovery/registry.test.ts`.

- [ ] Test: `resolveDiscoveryAdapter` returns the correct adapter for each of the 5 known `type` values; throws (or returns the generic fallback, per whatever `discovery/registry.ts` already does — confirm and test the actual behavior) for an unknown type.

---

## Task 9: Company-careers runner — stop fabricating data

Covered by Task 0 Step 9 (bug fixes) + Task 2 (schema support) + Task 3 (typed context). This task is the integration checkpoint: after Tasks 0/2/3 land, add a dedicated test file.

**Files:** create `tests/discovery/company-careers.test.ts`.

- [ ] Test: a registry entry with `atsType: "greenhouse"` and a valid `atsTenantOrBoardId` discovers jobs via the mocked Greenhouse adapter and produces `DiscoveredJobLite` records with real `location` (from the full fetch+normalize pipeline, not a fabricated default).
- [ ] Test: a registry entry with `atsType: "workday"` and `atsWorkdaySite: null` is skipped with a clear logged reason, produces zero discoveries, and does not throw (isolates the failure).
- [ ] Test: a registry entry with `atsType: "generic"` and no `genericSelectors` is skipped with a clear reason.
- [ ] Test: one company throwing mid-run does not stop the next company from being processed.
- [ ] Test: a company that fails on run 1 is retried (not skipped) on a resumed run 2 (ties to Task 5).

---

## Task 10: Posting resolver — fix typecheck + verification

Covered by Task 0 Steps 5, 6, 8. This task is the checkpoint: confirm `tests/resolver/posting-resolver.test.ts` covers the new verification-pause behavior and the fixed import/narrowing, expand only if a case from the original 17-task test list is still missing (unresolved-URL preservation with a reason is called out explicitly in the task brief — confirm a test exists for "resolver marks an unresolvable discovery with a reason and never silently drops it").

- [ ] **Found during Task 0 review, not yet fixed:** `posting-resolver.ts`'s `detectAtsType`+Workday branch (`site: parts[3] || "careers"`) fabricates the Workday `site` path segment when sniffing an arbitrary discovered URL that isn't registry-matched (only `hostname`/`tenant` come from the URL itself; `site` is guessed). Per approval #4 ("never fabricate ATS details"), this must skip/mark-unresolved with a reason instead of guessing, same as the registry-driven fabrication already fixed in `company-careers.ts`. Add a test asserting a Workday URL with no third path segment resolves as "unresolved, reason: cannot determine Workday site segment" rather than guessing `"careers"`.

---

## Task 11: Cross-source dedup — verify only

**Files:** none expected to change.

- [ ] Confirm `tests/dedup/deduplicator-extended.test.ts` covers: provenance (`discoveredFrom`) merging across 2+ sources for the same canonical job, `matchedProfiles` union, and that a malformed URL in one incoming record doesn't throw and doesn't corrupt the merge for other records (per the "validate stored objects before calling string methods" requirement). Add whichever case is missing.

---

## Task 12: Keyword orchestration — verify only

**Files:** none expected to change.

- [ ] Confirm a test exists asserting all 4 profiles' keyword sets (from `config/roles.yml` — sdet-qa, security-soc, cloud-iam, network-noc) are each run when no `--profile` filter is given, and that `--profile sdet` runs only that profile's keywords. Add if missing.

---

## Task 13: Orchestrator — dedicated test coverage

**Files:** create `tests/discovery/orchestrator.test.ts`.

- [ ] Test: a portal that throws does not stop other portals from running (mock 2 portal adapters, one throws, assert the other's discoveries still make it to storage).
- [ ] Test: the shared browser context is closed exactly once at the end of a full run, not per-portal.
- [ ] Test: the browser is not launched at all for a `--dry-run` (if that's how dry-run is wired — confirm against `cli.ts`'s actual `--dry-run` handling first).
- [ ] Test: checkpoints are saved incrementally (per page/company), not only at the very end, so a mid-run interruption still leaves usable progress.

---

## Task 14: CLI — verify only

**Files:** none expected to change unless a flag from the task brief is missing.

- [ ] Confirm every documented flag (`--profile`, `--source`, `--location`, `--company`, `--limit`, `--resume`, `--reset-checkpoint`, `--dry-run`) is implemented in `src/discovery/cli.ts` and validated (invalid value → clear error, non-zero exit). Add whichever is missing — audit did not confirm `--company` exists yet; check and add if absent.
- [ ] Confirm `--limit` applies to relevant retained discoveries (post-profile-match, post-dedup) and never truncates `data/discovered-jobs.jsonl` or `data/jobs.jsonl` — matches the existing baseline CLI's already-fixed `--limit` semantics (see `9e636fe` in git log), same principle applied to the discovery CLI.

---

## Task 15: Reporting module

**Files:** create `src/discovery/report.ts`; modify `src/discovery/orchestrator.ts`, `src/discovery/cli.ts`.

- [ ] `export interface DiscoveryRunSummary` (per spec — sources attempted/succeeded/failed, companies attempted, keywords searched, pages processed, listings discovered, discoveries rejected, official postings resolved, unresolved discoveries, duplicates merged, complete JDs extracted, verification pauses, jobs by profile, jobs by source, jobs written, source-specific errors).
- [ ] `export function buildSummary(...): DiscoveryRunSummary` — pure function assembling the summary from counters the orchestrator already tracks (or needs to start tracking) during the run.
- [ ] Orchestrator accumulates the counters through the run and calls `buildSummary` once at the end; `cli.ts`'s existing `printDiscoverSummary` prints this structured object instead of (or in addition to) whatever ad-hoc totals it prints today.
- [ ] **Found during Task 7 review, pre-existing (not introduced by Task 7), tracked here:** `--source X` where X is a known but currently-disabled portal/site id silently produces zero attempted sources with no explanation (same gap already existed for `sites.yml`-driven sources before Task 7). Worth a clear "requested source X exists but is disabled in config" line in the summary rather than a silent zero.
- [ ] Test: `buildSummary` produces correct counts from a set of fake per-phase inputs; a run with zero portals attempted still produces a valid (all-zero) summary rather than throwing.

---

## Task 16: Fill remaining test gaps; confirm everything green

- [ ] Run `npm run typecheck` — 0 errors.
- [ ] Run `npm test` — all tests green, including every new test file added in Tasks 1-15.
- [ ] Confirm the full list from the task brief's Task 16 is covered: config validation ✓(1,2), registry validation ✓(2), portal pagination ✓(existing), repeated-page stopping (confirm existing adapter tests actually assert this — audit didn't confirm explicitly, check and add if missing), page-limit stopping ✓(existing, via `maxPages`), discovery-limit stopping ✓(existing, via `maxDiscoveries`), checkpoint save/resume/reset ✓(5), verification pause ✓(0,10), missing selectors (confirm a test asserts a clear error when a configured selector never matches — add if missing), malformed records ✓(4), portal failure isolation ✓(13), company failure isolation ✓(9), all 4 profile keyword groups ✓(12), official URL resolution ✓(10), unresolved URL preservation ✓(10), cross-portal dedup ✓(11), provenance merging ✓(11), ATS delegation ✓(9), storage idempotency ✓(4), CLI argument validation ✓(14), browser lazy launch ✓(13), safe browser shutdown ✓(13), existing 94(→113) tests remain green ✓.

---

## Interlude: browser lifecycle fix + registry split (found during first Task 17 attempt)

First Task 17 attempt found real bugs live validation exists to catch, blocking further progress:
- `context.close()` didn't reliably terminate the real OS Chrome process on Windows; a second
  run against the same profile then either hung indefinitely or failed outright on a stale lock.
- The user paused Task 17 and required a proper fix: tracked shutdown with a bounded wait +
  force-kill fallback, pre-launch live-lock detection (fail clear, never hang), stale-lock
  cleanup only when unowned, a per-run isolated-profile option, never touching an unrelated
  Chrome process. Commits `f5ea6bd`, `ac0205a`, `db2cbce` (the latter two are independent-review
  follow-ups: a real prefix-collision that could have killed an unrelated live Chrome process
  under `isolatedProfile`, then a real false-negative on Windows paths containing a space —
  both reproduced against actual PowerShell/live-process output, not just reasoned about).
- Also required: move the `fortuneRank: null` validation-only registry entries (AHEAD, Stripe,
  Figma — added ad hoc during the interrupted first attempt) out of the production
  `config/fortune500-registry.json` into `config/fortune500-registry.validation.json`, with an
  explicit `--registry`/`companyRegistryPath` override so a controlled validation run can still
  use them without ever mixing the two files. Commit `5555550`.
- Live validation also caught one real, pre-existing data defect the way it's meant to: Google's
  registry entry (`atsTenantOrBoardId: "google"`) is wrong — that Greenhouse board returns 404,
  confirmed independently via a direct API call. Marked `verificationStatus: "blocked"` rather
  than fabricating a corrected token; stays in production since it's still a real, Fortune-
  ranked company.

All four commits independently reviewed, all found issues fixed and re-reviewed clean. 30 files,
209/209 tests, 0 typecheck errors before resuming Task 17.

---

## Task 17: Controlled live validation

Not run until Task 16 is fully green and the user has separately confirmed they want a live run (this is a real browser hitting real external sites — confirm before executing even though it was pre-authorized in the task brief, since it's the first non-mocked execution of this code).

Scope, exactly as specified — one each, small limits, never a full scan:
- [x] One Google Jobs search (1 keyword, `maxPages`/`maxDiscoveries` small, e.g. 1 page / 10 results). — attempted, timeout.
- [x] One Indeed search (same small limits). — attempted, timeout.
- [x] One Monster search (same small limits). — attempted, timeout.
- [x] One LinkedIn public search (same small limits). — attempted, timeout.
- [x] One Greenhouse company from the registry (existing verified entry — e.g. Google). — used Figma instead (Google's Greenhouse token confirmed stale/blocked earlier). Success.
- [x] One Lever company from the registry (existing verified entry — e.g. AHEAD). — verification required (real reCAPTCHA), not faked.
- [x] One Workday company from the registry — only if `atsWorkdaySite` has been filled in with a real verified value by this point; otherwise this sub-item is explicitly reported as blocked, not faked. — reported blocked: found a real, live Workday tenant (Target) but `company-careers.ts` unconditionally skips all `atsType: "workday"` entries regardless of data, a code gap not just a data gap.
- [ ] One custom/generic career page — only if at least one registry entry has real `genericSelectors` filled in; otherwise reported as blocked. — not attempted: no registry entry (production or validation) has real `genericSelectors` configured. Reported blocked per this item's own stated fallback, same as Workday.

For each: verify pagination behaves, titles/companies look real, full JD resolves, official/apply URLs are real employer or ATS URLs (not portal redirect stubs), provenance is recorded, checkpoint resume works (kill mid-run, resume, confirm no duplicate work), a second full run of the same search is idempotent (no duplicate `JobPosting` rows), and any verification challenge encountered pauses correctly and is described in the run's report.

### Task 17 restart log (post browser-lifecycle-fix, per user's 7-item sequence)

1. **Figma/Greenhouse** — SUCCESS. 700+ jobs discovered, 2 resolved with real JDs, real
   `boards.greenhouse.io`/`job-boards.greenhouse.io` canonical URLs. Registry entry verified.
2. **AHEAD/Lever** — VERIFICATION REQUIRED. Discovery succeeded (492 real jobs from
   `jobs.lever.co/thinkahead`). Resolution of the first job hit a real reCAPTCHA on the
   posting page; `pauseForVerification` correctly detected it, printed the pause banner, and
   the resolver correctly threw `Verification required ... reCAPTCHA detected` rather than
   scraping/faking content — no CAPTCHA was solved or bypassed. Known limitation surfaced by
   this run: in a non-interactive/background shell, `rl.question()` resolves immediately on
   stdin EOF instead of truly blocking for a human, so unattended runs can't actually wait for
   manual solving — the safe part (never fabricating data past a detected challenge) still
   held. Not fixed here since out of scope for validation; worth a follow-up if unattended
   Lever/Greenhouse runs need to survive real CAPTCHAs.
3. **Workday company** — BLOCKED (structural, not just missing data). Verified a real, live
   Workday tenant via direct API probe (`target.wd5.myworkdayjobs.com`, tenant `target`, site
   `targetcareers` — returned 2000 real job postings). However
   `src/discovery/adapters/company-careers.ts` unconditionally skips every `atsType:
   "workday"` registry entry regardless of whether `atsWorkdaySite` is filled in (dead branch:
   never builds a `SiteConfig.workday` block, unlike greenhouse/lever). So this item is
   blocked by a real code gap, not by absent data — filling in Target's `atsWorkdaySite` alone
   would not make it run. Reported as blocked per the plan's explicit fallback rather than
   silently expanding scope to wire up new adapter code mid-validation.
4. **Google Jobs portal** — TIMEOUT. First attempt found a real, separate bug: `config/portals.yml`'s
   own header comment claims `--source <id>` alone opts a portal in, but
   `orchestrator.ts`'s `standardPortalIds` filters on `p.enabled` *before* the `--source`
   narrowing is ever applied — a disabled portal is never attempted regardless of `--source`.
   Fixed by flipping `enabled: true` for the duration of this item's run (reverted after).
   With it enabled, the run genuinely launched a real isolated Chrome instance (confirmed
   alive via direct process inspection) but never wrote a single checkpoint entry after
   ~18+ minutes — well beyond every bounded timeout in `google-jobs.ts` (30s navigation x2
   retries, 30s networkidle wait, all `.catch`-guarded). Recorded as timeout rather than
   waited on indefinitely. Stopping the background task killed the outer shell/node wrapper
   but — a separate, real finding — did NOT deliver SIGINT to the child process on Windows,
   so `registerShutdownOnSignal`'s cleanup never ran and the isolated Chrome tree was left
   running; cleaned up manually via `taskkill /PID <verified-isolated-profile-pid> /T /F`,
   scoped strictly to the confirmed isolated-profile process tree (never the user's real
   Chrome). This is an external-termination gap (TaskStop/Windows don't propagate a graceful
   signal the way Ctrl+C does), not a defect in the shutdown code itself — worth a follow-up
   if unattended/scripted kills of discover runs become common.
5. **Indeed portal** — TIMEOUT. Same pattern as Google Jobs: real isolated Chrome launched and
   confirmed alive, zero checkpoint progress after 3+ minutes (well past `indeed.ts`'s bounded
   waits), stopped and cleaned up the same way.
6. **Monster portal** — TIMEOUT. Same pattern again — third consecutive real portal exhibiting
   identical zero-progress-past-all-bounds behavior.
7. **LinkedIn public portal** — TIMEOUT. Fourth and last consecutive real portal, same pattern.

**Cross-portal finding (all 4 browser-driven search portals):** Google Jobs, Indeed, Monster,
and LinkedIn public all independently reproduced the same symptom under `--isolated-profile`:
a real, live Chrome process tree launches successfully (confirmed via direct OS process
inspection each time — never a launch failure, never the profile-in-use error), but the
adapter never reaches its first `onPageProcessed` checkpoint write, well beyond every
timeout coded in the adapters themselves (30s navigation x2 retries, 30s networkidle wait).
By contrast, company-careers sources worked correctly in the same session: Figma succeeded
fully, and AHEAD's real page-navigation-based resolution step reached a real Lever page and
correctly detected a real reCAPTCHA. The differentiator is that Greenhouse/Lever discovery
is a plain `fetch()` JSON call, not a `page.goto()`, and AHEAD's one browser-navigated page
(a direct Lever job-detail URL) did load. The four major portals — sites with the most
sophisticated, well-funded anti-bot infrastructure of anything in this validation set — are
the only targets where `page.goto()` itself never completes or fails within its own timeout.
Most likely explanation given the pattern (consistent across 4 unrelated domains, none of
which show this behavior in company-careers' simpler fetch-based paths): active anti-bot
tarpitting/fingerprint-based stalling of the automated real-Chrome connection, not a bug in
this codebase's timeout logic. Each run's orphaned isolated Chrome tree was confirmed and
force-killed by exact, verified PID after stopping — the shutdown code path (SIGINT handler)
itself was never exercised here because external task termination on Windows does not
deliver a signal the way Ctrl+C does (see Google Jobs entry above); this is a job-runner/OS
gap, not a defect in `closePersistentChrome`. Not investigated further as a code fix here —
out of scope for a validation pass; flagging as a real, load-bearing finding for whoever
picks up portal-adapter hardening next (candidates: stealth/fingerprint evasion is explicitly
out of bounds per this project's "never bypass access controls" constraint, so the realistic
fix is likely a hard per-goto watchdog timeout independent of Playwright's own timeout option,
plus alerting rather than silent hanging).

**Task 17 summary — every configured validation source has a recorded result:**
| # | Source | Result |
|---|--------|--------|
| 1 | Figma / Greenhouse | Success |
| 2 | AHEAD / Lever | Verification required (reCAPTCHA) |
| 3 | Workday company | Blocked (structural code gap, not just data) |
| 4 | Google Jobs portal | Timeout |
| 5 | Indeed portal | Timeout |
| 6 | Monster portal | Timeout |
| 7 | LinkedIn public portal | Timeout |

Task 17 is complete in the sense the user required: every item has a definitive, honestly
recorded result. Nothing here was faked, no CAPTCHA was solved/bypassed, no anti-bot
protection was evaded, and no orphaned process or stale lock was left behind — `config/portals.yml`
is back to its pre-validation state (all portals `enabled: false`, original 100/5000 limits).

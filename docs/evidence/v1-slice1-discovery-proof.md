# V1 Slice 1 — real headed discovery proof

Date: 2026-10-07. Branch: `careerops-integration` (worktree `.claude/worktrees/universal-job-discovery`).
Gate: one company -> official listing -> resolved posting -> full JD -> validated canonical record -> durable save -> clean headed Chrome exit.

Status: **offline gates pass; live success, repeat/dedupe and controlled-failure runs pass for Figma / Greenhouse.** The gate is met for this one target. It is not evidence about other ATS boards, Lever, Workday or generic pages.

## Environment

- Windows 11, Node v24.13.1, Google Chrome 154.0.8037.97 (`channel: "chrome"`, `headless: false`), Playwright `^1.47` via `launchPersistentChrome`.
- Persistent automation profile: `./.chrome-profile` in the worktree (gitignored, dedicated; the user's everyday profile is never attached).
- `docs/ard/00-SHARED-CONTRACTS.md` was named by the task but does not exist in either `docs/ard` folder. This slice used `00-START-HERE.md` and `ARD-V1-Working-Vertical-Slice.md` only; the failure categories `POSTING_UNRESOLVED` and `JD_EXTRACTION_FAILED` come from the V1 ARD's scenario table.

## Target selection (verified, not trusted from registry flags)

| Check | Result |
|---|---|
| Official careers page | `https://www.figma.com/careers/` -> HTTP 200 |
| Careers page links to the board | The page HTML contains `https://boards.greenhouse.io/figma/jobs/<id>?gh_jid=<id>` links (many) |
| Board API | `https://boards-api.greenhouse.io/v1/boards/figma/jobs` -> 156 jobs, `name: "Figma"` |
| Role fit | "Security Engineer" (5829751004), "Security Scientist" (6180172004), "Manager, Security Operations" (6015609004) |
| Registry | `config/fortune500-registry.validation.json` entry `Figma`, greenhouse, board `figma` (used via `--registry`; production registry untouched) |

Avoided: AHEAD (recorded reCAPTCHA stall). Stripe was not used: its jobs sit on `stripe.com/jobs/search?gh_jid=` (company-hosted), which the new identity code supports offline but was not live-tested.

## Commands run (explicit, opt-in; not part of `npm test`)

```
npx tsx src/discovery/cli.ts --source company-careers --company Figma \
  --registry config/fortune500-registry.validation.json --profile security --limit 2 \
  --data-dir data/slice1-proof                      # run 1
... same + --reset-checkpoint                        # run 2 (repeat / dedupe)
npx tsx src/discovery/cli.ts ... --data-dir data/slice1-failure --resolve-job-timeout-ms 1   # controlled failure
```

## Results

### Run 1 — success (`data/slice1-proof/jobs.jsonl`, 2 records)

- Listings 624 evaluated, 8 retained as security-relevant (4 keywords x 2 jobs), **2 distinct listings resolved** (the 8 collapse by employer + ATS job id; before this slice the same job was resolved up to 4 times).
- Both postings: `resolutionStatus: "resolved"`, `schemaVersion: 1`, `extractionMethod: "ats-api"` (public Greenhouse JSON; the headed Chrome session was launched, owned and closed but not needed to read the JD), `atsIdentity` `greenhouse:figma:5829751004` / `greenhouse:figma:6180172004`, 64-hex `jdContentHash`, ISO `extractedAt`, one `sourceObservation` (`observedUrl` boards.greenhouse.io -> `finalUrl` job-boards.greenhouse.io).
- JD length 7,899 and 7,228 characters. No residual HTML entities.
- **Inspection against the official page**, fetched independently (public `job-boards.greenhouse.io` HTML, not the API): title and company present; 58 of 59 and 34 of 35 saved sentences appear verbatim on the page. The one differing sentence in each differs only by a dash glyph: the API content has an em dash in the salary range, the rendered page text shows a hyphen.
- `Unresolved: 0`, verification pauses 0.

### Run 2 — repeat with `--reset-checkpoint`

- Discovery re-ran (628 listings; the checkpoint reset forced it, not a skip).
- `Duplicates merged: 2`, `jobs.jsonl` still **2** records. Per record: same `id`, same `jdContentHash`, `discoveredAt` preserved, `lastSeenAt` advanced, `sourceObservations` still 1 (same sighting not re-added), `extractedAt` refreshed.
- Without the reset, an existing completed checkpoint only skips discovery; that is not dedupe and is not what is claimed here (covered by an offline test).

### Controlled failure — `--resolve-job-timeout-ms 1` (`data/slice1-failure/`)

- Both jobs rejected as typed `POSTING_UNRESOLVED` / `RESOLUTION_TIMEOUT` (`retryable: true`) in `job-failures.jsonl`; **0 jobs persisted**.

### Chrome ownership and cleanup (both live runs)

Sampled `Win32_Process chrome.exe` whose command line contains this worktree's `.chrome-profile` (browser process only, `--type=` excluded) every 300 ms during the run:

| Run | before | max during | after |
|---|---|---|---|
| success (run 2) | 0 | 1 | 0 |
| controlled failure | 0 | 1 | 0 |
| run 1 | 0 | not sampled | 0 |

The machine's other `chrome.exe` processes (the user's browser, 32-37) were untouched. Run 1 was not sampled during the run, so launch for run 1 is shown only by the profile directory's updated files and the successful run, and cleanup by the post-run count of 0.

## Observed problems fixed (Decision Notes, brief)

1. **Placeholder / empty JDs reached `jobs.jsonl`.** Observed: the branch's own store holds placeholder records; `resolve()` returned a placeholder or an adapter result with an empty description and `onJobResolved` saved everything. Alternative considered: make `PostingResolver.resolve` return null. Rejected: existing tests pin "never silently drops"; instead the resolver stamps `resolutionStatus`, and the **only** door to the store is `evaluatePersistable` in the orchestrator. Tradeoff: one extra gate module; reversal: remove the gate call. Proof: 10 orchestrator tests, 19 domain tests.
2. **Employer identity by substring.** Observed: `matchCompany` used `host.includes(domain) || url.includes(domain)`, so a domain anywhere in a query string matched. Replaced with parsed host/slug matching tied to the registry board. Tradeoff: stricter, so an unmatched portal listing is `UNVERIFIED_EMPLOYER` (acceptable: portals are disabled and the registry is the identity authority). Proof: lookalike-host tests.
3. **Distinct requisitions could merge.** Observed: `mergeJobs` joined by company+title+location and description fingerprint. Added a stable ATS identity as the first tier and a hard "different identity never merges" rule. Postings without an identity keep the old tiers (legacy behaviour unchanged). Proof: `tests/dedup/deduplicator-identity.test.ts`.
4. **Entity-escaped Greenhouse content.** Observed live: the single-job API returns `&lt;div ...`; `stripHtml` kept it as literal text, and typographic entities such as `&mdash;` survived. Fixed in `jd-cleaner.ts` and `greenhouse.ts`. Found only because the saved record was inspected against the official page.
5. **Same listing resolved once per keyword.** Observed: company-careers reports the whole board once per role keyword. De-duplicated by employer + job id before `--limit`.
6. **A failed ATS call produced an empty JD.** Greenhouse/Lever API returning nothing now falls through to headed-browser extraction instead of emitting empty title/description; the browser fallback no longer uses `document.body` (navigation text) and no longer fabricates `"Remote/Various"`.
7. **Durability.** `saveJobs` and `saveDiscoveredJobs` fsync the temp file before the rename; failure records fsync on append.

## Offline verification

See `docs/STATUS.md` for the command log and counts.

## Limits (not claimed)

- One company, one ATS, two postings. Lever, Workday, company-hosted `gh_jid` pages and the browser-DOM extraction path are covered by fixtures only.
- `data/discovered-jobs.jsonl` is still append-only: run 2 appended another 8 lines. Harmless for the canonical store, but not deduplicated.
- `loadJobs` still skips a malformed line with a console message and the next `saveJobs` drops it. Not changed in this slice.
- Verification (CAPTCHA) pauses were not triggered live, so the pause path is covered by existing tests only. Stdin-blocking pause has no timeout.
- A forcibly killed process (`taskkill /F`) cannot run cleanup; documented in `launcher.ts`, unchanged.

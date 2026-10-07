# Headed-browser search demo — Stripe

Date: 2026-10-07. Branch `careerops-integration`. Gate: official careers page -> real visible search field -> visible typing -> search through the page's controls -> results -> open a real result -> DOM extraction -> canonical validation -> protected save -> clean Chrome exit.

## Replay

```
npm run search -- --input config/job-search-inputs.example.json --data-dir data/search-demo --evidence-dir data/search-demo/evidence
```

Defaults: 90 ms between typed keys, 1.5 s pause after each visible stage (viewing only, never synchronization). Add `--typing-delay-ms 0 --hold-ms 0` for a fast run. A visible Chrome window opens, uses the dedicated `./.chrome-profile`, and is closed by the tool.

## Target and why

Figma's own careers page (`figma.com/careers`) has no search field (its Greenhouse board redirects to it), so it cannot satisfy the requirement. Stripe was chosen after probing five official Greenhouse-backed pages.

| Check | Result |
|---|---|
| Official page | `https://stripe.com/jobs/search` redirects to `https://stripe.com/careers/search` |
| Search interface | visible `searchbox` named "Search for a role"; results filter as you type and the URL gains `?query=` |
| Listings | `https://stripe.com/careers/listing/<slug>/<Greenhouse job id>` |
| Board relationship | Greenhouse board `stripe` lists the same ids with `absolute_url` on `stripe.com` (`?gh_jid=`). Checked after the run: `boards-api.greenhouse.io/v1/boards/stripe/jobs/8113337` returns "ARG Engineering Manager" with `absolute_url` `https://stripe.com/jobs/search?gh_jid=8113337` |
| Registry | `config/fortune500-registry.validation.json` Stripe entry was `unreachable` (2026-07-27 note). It was re-verified by the checks above and updated to `verified` with a note and provenance `job-hunter-live-check-2026-10-07`. The production registry is untouched |

## What was visibly done (live run, 2026-10-07)

1. Opened `https://stripe.com/careers/search` in visible Chrome.
2. Found the search field "Search for a role", clicked it, confirmed it had focus.
3. Typed `SDET` key by key, pressed Enter: the page's own empty state ("No open roles match your search") appeared. Typed `QA`: same empty state. (Stripe's board has no SDET role; its one "Software Quality Assurance Engineer" listing does not match "QA" on this site's search. The empty states are genuine, not simulated.)
4. Typed `security engineer`: 11 distinct results appeared.
5. Clicked the first result, "ARG Engineering Manager", and waited for its posting page.
6. Extracted from the rendered DOM: title (`h1`), location (the "Office location" / "Remote location" fact values), URL, and the text of `<main>`.
7. Printed the summary, validated through the canonical gate, saved through `updateJobs`, closed Chrome.

Saved record: `data/search-demo/jobs.jsonl` (gitignored): `greenhouse:stripe:8113337`, job id `3b71e65fa6e9ce0e`, title "ARG Engineering Manager", employer Stripe (name also seen on the posting page), location "South San Francisco HQ; Remote in United States", URL `https://stripe.com/careers/listing/arg-engineering-manager/8113337`, 7,349 characters, `sourceObservations[0].extractionMethod = "browser-dom"`, `sourceKind = "browser-search"`, `jdContentHash 59b1599fc79f79e58f3c7f860405065837282a1ffd92c63948bf6402116da630`, `schemaVersion 1`, `resolutionStatus resolved`. `matchedProfiles` is empty: the title does not match any `config/roles.yml` keyword (the site's search is broader than our relevance rules), and it was saved as found rather than forced into a profile.

Screenshots (local only, `data/search-demo/evidence/`, public pages, not committed): `sdet-01-typed`, `sdet-02-empty-state`, `qa-01-typed`, `qa-02-empty-state`, `security-engineer-01-typed` (query in the field, results already filtered), `security-engineer-02-results`, `security-engineer-03-posting`. I viewed the last three: they show the typed query, the filtered list, and the opened posting with title and fact panel.

## Saved JD vs the rendered posting

An independent headless Playwright load of the saved URL, comparing `main.innerText` (whitespace-normalized) with the saved `descriptionText`:

- Identical text: **true** (7,349 chars each); 38 of 38 sentences present; title equal; all 17 page headings present (Who we are, About Stripe, About the team, What you'll do, Who you are, Minimum requirements, Preferred qualifications, Hybrid work, In-office expectations, Working remotely, Pay and benefits, closing paragraph, plus the fact panel headings).
- Noise included (not stripped): the breadcrumb "Roles at Stripe / Role details" at the start, and the fact panel plus the "Apply for this role" button label at the end. The Apply control is never clicked.
- Not extracted as separate fields: compensation range, team, employment type are inside the JD text only.

## Repeat run and cleanup

- Second run (same command): still **1** record, same id, same hash, `discoveredAt` kept, `lastSeenAt` advanced, 1 source observation. This repeats via the persisted store, not a checkpoint skip.
- Chrome ownership (sampled every 300 ms): 0 owned browser processes before, 1 during, 0 after; the user's other `chrome.exe` processes were untouched. A first run that crashed on a script error (below) also left 0 owned processes, which is the failure-path cleanup observed live.
- Offline tests also verify cleanup after success, empty, missing-control, navigation failure, bad JD and a storage failure mid-run.

## Defects found by running it live

1. `tsx` injected an esbuild `__name` helper into functions sent to the page (`ReferenceError: __name is not defined`). Fixed with a one-line init-script shim.
2. Location was empty for postings whose "Office location" label has no value; fixed by pairing a label with the value that follows it in document order, not a sibling.
3. Going back to the result list by reloading its URL loses filter state on sites that don't keep the query in the URL (found by the offline "two distinct requisitions" test). The flow now uses browser Back first and re-finds the result by href.

## Limits (not claimed)

- One site, one ATS family (Greenhouse-backed). The default result-link and empty-state selectors are generic guesses; Stripe needs the explicit selectors in the example input.
- Verification (CAPTCHA) was not triggered, so the pause path was not exercised live; it uses the existing `pauseForVerification`, which waits on stdin without a timeout.
- The first result is taken as-is; no ranking or relevance gate decides which result to open.
- Search relevance of the site is its own: "ARG Engineering Manager" is what Stripe returned first for "security engineer".

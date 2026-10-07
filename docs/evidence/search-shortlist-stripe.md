# Search demo, iteration 2 — title-targeted shortlist and clean descriptions

Date: 2026-10-07. Branch `careerops-integration`. Builds on `docs/evidence/search-demo-stripe.md`.

Slice 2 status check (as asked): `b0f5d3c feat(semantic): evidence-validated StructuredJob contract and fixture-provider wiring (V1 slice 2)` is committed and is the direct parent of the search-demo commit `8c65048`. No other commit intervened. Slice 2 delivered the contract, validator, fixture provider and `parse-jd` entry point only; the autonomous-parser gate is still pending (see `docs/NEXT_TASKS.md`).

## What changed

1. **Title targeting before anything is opened.** `src/discovery/title-targeting.ts` (`classifyResultTitle`) reuses `evaluateRelevance` and `config/roles.yml`. Every result title is classified:
   - `MATCH`: the title matches a configured role keyword, or a documented domain qualifier paired with a role word (`src/discovery/relevance.ts`).
   - `REVIEW`: the title does not match, but the result's team label names a configured profile domain (e.g. team "Security"). Shown, never opened unless `selection.openReview` is true.
   - `NO_MATCH`: neither. A result the site returned for a query is not thereby relevant.
   Each entry records the exact rule (a `config/roles.yml` role id and keyword, or the named qualifier) and a reason. No seniority, sponsorship or location filtering was added; "Security Engineer, New Grad" is a MATCH because no configured rule says otherwise. This is title-based targeting, not candidate eligibility or a hiring probability.
2. **Selection.** MATCH results open in list order up to `maxJobs`; the first result is no longer opened automatically. The shortlist is printed and written to `<data-dir>/search-shortlist.json` with `opened / extracted / saved` per entry and why a result was not opened. Outcome `NO_MATCH` (results existed, nothing matched) is reported honestly and exits 0.
3. **Clean description.** Before the text is read, the page's chrome is hidden in the live DOM and restored afterwards: `nav`, breadcrumb, `aside` (the facts sidebar), `button`, `form`, `footer`, ARIA navigation/complementary regions, the title `<h1>`, and action links (Apply / Save / Share). Location is read from the facts panel first. The saved text, its SHA-256 and `descriptionHtml` all come from the same cleaned DOM. `rawMetadata.extractionStrategy` records the container, per-selector removal counts, action links removed, whether the title heading was removed, and the section headings found; `rawMetadata.titleTargeting` records the classification and rule.
4. **Identity rule tightened.** The generic "6+ digit trailing path segment" rule from the first demo is removed (`extractTrailingNumericId` deleted). A company-hosted URL without `gh_jid` gets an ATS identity only if (a) the input declares its URL shape (`selectors.listingIdPattern`, a regex with exactly one capture group) and (b) the captured id is confirmed against the employer's registered Greenhouse board (`confirmGreenhouseListing`: the id exists there and its listing URL belongs to the employer). Otherwise the posting is rejected as `JOB_ID_MISSING` and not saved. A confirmed id is never applied to a non-Greenhouse registry employer or a look-alike host. The confirmation is the only non-browser request in the flow and supplies no content.
5. **Input.** `config/job-search-inputs.example.json` now also declares `resultTeam`, `resultLocation`, `listingIdPattern` and `selection`.

## Replay

```
npm run search -- --input config/job-search-inputs.example.json --data-dir data/search-demo --evidence-dir data/search-demo/evidence-shortlist
```

## Live run (Stripe, 2026-10-07, headed Chrome)

Typed `SDET` (page's own empty state), `QA` (empty state), `security engineer`: 11 results, **8 MATCH, 3 REVIEW, 0 NO_MATCH**. `maxJobs` is 1, so one MATCH was opened.

| Class | Title | Team | Location (list row) | Opened / extracted / saved |
|---|---|---|---|---|
| MATCH | Client Platform Security Engineer | Security | Remote in United States | yes / yes / **yes** |
| MATCH | Cloud Security Engineer | Security | Remote in United States | no (maxJobs reached) |
| MATCH | Forward Deployed Security Engineer | Security | Dublin HQ | no (maxJobs reached) |
| MATCH | Offensive Security Engineer | Security | Remote in United States | no (maxJobs reached) |
| MATCH | Security Engineer | Security | Remote in United States | no (maxJobs reached) |
| MATCH | Security Engineer, ACE | Security | Dublin HQ | no (maxJobs reached) |
| MATCH | Security Engineer, Bridge | Money Movement and Storage | Remote in United States | no (maxJobs reached) |
| MATCH | Security Engineer, New Grad | University | Dublin HQ | no (maxJobs reached) |
| REVIEW | ARG Engineering Manager | Security | Remote in United States | no (REVIEW is not opened by default) |
| REVIEW | Abuse Research Engineer | Security | Remote in United States | no |
| REVIEW | Backend Engineer, Core Technology | Security | Dublin HQ | no |

URLs, exact rules and reasons for every row are in `data/search-demo/search-shortlist.json` (gitignored). All eight MATCH rows share the rule `domain qualifier "security" (src/discovery/relevance.ts, profile "security"; a title needs a paired role word)`; every REVIEW row's rule is `team label "Security" matches domain qualifier "security" ...; the title matches no configured role`. The earlier run's first result, "ARG Engineering Manager", is now a REVIEW and was not opened.

Saved record: `greenhouse:stripe:7982720`, job id `56c567cff6dda2b7`, "Client Platform Security Engineer", Stripe, location "New York; Remote in United States" (from the posting's facts panel), `https://stripe.com/careers/listing/client-platform-security-engineer/7982720`, 6,978 characters, `matchedProfiles ["security"]`, `sourceObservations[0].extractionMethod "browser-dom"`, `jdContentHash 2900bf3898474457...` (recomputed from the saved text: equal). The id 7982720 was confirmed on Stripe's Greenhouse board before the identity was assigned.

Saved sections (13 headings): Who we are / About Stripe / About the team / What you'll do / Responsibilities / Who you are / Minimum requirements / Preferred qualifications / Hybrid work at Stripe / In-office expectations / Working remotely at Stripe / Pay and benefits / closing paragraph. Compensation survives ("The annual US base salary range for this role is $173,000 - $259,600 ..."). The text starts at "Who we are" and ends with the application-window paragraph.

**Cleaned vs rendered, checked independently** (fresh headless load of the URL, main column text): title equal; 33 of 33 substantive sentences present in the saved text (the only difference is the removed "Apply now" label in front of the California notice sentence); none of "Roles at Stripe", "Role details", "Apply now", "Apply for this role", "Employment type", "Office location", "Remote location" remain. Not in the saved text by design: the sidebar facts panel (company, team, locations, employment type), which is duplicated information (location is stored in its own field, team in `department`).

**History preserved.** The earlier "ARG Engineering Manager" record (`greenhouse:stripe:8113337`, saved by the first demo with breadcrumb and sidebar noise) is byte-identical after the new run (checked by comparing its JSON before and after). It was not re-opened, cleaned or deleted. Store: 1 record before, 2 after.

**Repeat run:** same command again: still 2 records, both with unchanged hash, first-seen time kept, one source observation each.

**Cleanup:** owned Chrome browser processes sampled every 300 ms: 0 before, 1 during, 0 after (both runs).

## Tests

- New `tests/discovery/title-targeting.test.ts` (15): hand-reviewed MATCH/REVIEW/NO_MATCH expectations, IC vs manager, named rules, no case-variant duplicates, `reviewByTeam:false`, known relevance false-positive guards, all-NO_MATCH/REVIEW input.
- `tests/e2e/offline/browser-search.e2e.test.ts` (18, real headed Chrome, loopback fixture, non-loopback requests blocked and counted): added the manager-listed-first vs IC case, `openReview`, every result NO_MATCH/REVIEW (no posting page even requested), row text-line fallback, clean-section extraction with page chrome removed and hash/strategy consistency, unsupported numeric URL (no identity, no lookup), declared-shape id the board does not list, no declared shape, repeat run preserving earlier records. Existing cleanup, navigation-failure, bad-JD, empty-state, missing-control, repeat-run and storage-failure cases kept and passing.
- `tests/config/search-input.test.ts` (23): the identity rule (a bare numeric suffix never yields identity; a caller-confirmed id does only for Greenhouse and the real employer host), `listingIdPattern` validation, selection defaults.
- Intentional change to earlier tests: the two assertions that a company-hosted numeric suffix yields `greenhouse:<board>:<id>` were replaced (that was the behaviour being removed).
- Full suite: **67 files, 760 passed, 0 failed**; `tsc --noEmit` clean. A first full run showed 2 E2E tests timing out under full-suite CPU load (they passed alone); test navigation/settle timeouts were raised to 20 s and the whole suite re-run.

## Limits (not claimed)

- One site. The Stripe example needs explicit selectors; the generic defaults are guesses. Row team/location fall back to row text lines when selectors are absent, which assumes team first and location last.
- REVIEW uses the team label: if a site's team label is missing or unrelated, good titles still need a title match, and a mislabelled team can produce a REVIEW that is not relevant.
- Title targeting uses the repository's existing roles and qualifiers: "Security Engineer, New Grad" and similar entry-level titles are MATCH; the repository has no seniority rule and none was invented.
- `matchedProfiles` on the saved record is the title-match profile; `department` carries the team label.
- Verification (CAPTCHA) pauses were not exercised live.
- The first demo's older record still carries page noise (kept on purpose).

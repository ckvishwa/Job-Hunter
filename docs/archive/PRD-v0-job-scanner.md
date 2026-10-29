# Product Requirements Document — job-hunter

## Product statement

One universal job scanner that attempts all Fortune 500 company career pages, LinkedIn, Indeed, Monster, Greenhouse, Lever, Ashby, Workday, iCIMS and supported generic career pages, collects jobs once, and classifies the same canonical dataset into four precise job profiles.

**Core principle: scan once, classify into four profiles.** Discovery never runs a separate, complete external scan per profile — one shared discovery pass produces one canonical job dataset, which is then evaluated against all four profile definitions.

## The four profiles

`sdet`, `security`, `cloud`, `network` — fixed, defined in `src/types.ts`'s `PROFILES` const and `config/roles.yml`.

## What this product is NOT

- Not a CareerOps rewrite — CareerOps is an external, replaceable, upstream-maintained discovery source (`src/sources/careerops/`), never copied into this repo, never the thing we're rebuilding.
- Not an automatic application bot.
- Not a resume-generation platform during discovery.
- Not a cover-letter system during discovery.
- Not an AI evaluator for every discovered job.
- Not a dashboard project.
- Not a single-profile scanner.
- Not a commercial SaaS platform.

Anything outside the locked goal above is out of scope by default. See the scope gate at the end of this document before adding anything.

## Requirements

1. All Fortune 500 companies must be attempted (subject to per-company skip-not-guess rules when verified ATS data is unavailable — see `config/fortune500-registry.json` and its audit).
2. LinkedIn, Indeed, and Monster must be attempted (as portal-type discovery sources; each independently enable-able in `config/portals.yml`).
3. Greenhouse, Lever, Ashby, Workday, and iCIMS must be supported — natively where a verified adapter exists, and via the CareerOps external source where native support doesn't yet cover a given company or ATS type.
4. Generic company career pages must have a fallback (`src/adapters/generic-playwright.ts`, `SiteConfig.generic` selectors) for companies whose careers page isn't hosted on a supported ATS.
5. Discovery runs once per invocation — one shared pass over all enabled sources produces one canonical dataset (`data/jobs.jsonl`). No source is re-scanned separately per profile.
6. Every canonical job is evaluated against all four profiles (`src/discovery/relevance.ts::evaluateRelevance()`), not just the profile that happened to be requested at discovery time — a job can legitimately match more than one profile.
7. Four separate ranked reports are generated, one per profile (`npm run hunt --profile <sdet|security|cloud|network>` produces `output/latest-jobs.{json,csv,html}` filtered/ranked for that profile from the same underlying dataset).
8. No LLM calls occur during broad discovery. Every discovery-time decision (relevance, eligibility, location, freshness, score) is a deterministic rule over stored evidence — never a model call, never fabricated. AI evaluation is explicitly parked (see "What this product is NOT").
9. One failed company, source, or record never stops the full run — every discovery adapter, the resolver, and the CareerOps schema/mapper all isolate individual failures (skip-and-count, placeholder-and-continue, or typed-failure-and-continue) rather than aborting the run.
10. No CAPTCHA or access-control bypass is permitted. `src/browser/verification.ts::detectVerification()` only pauses for a human to complete verification manually — it never attempts to solve, bypass, or evade anti-bot/access-control mechanisms.
11. Official HTTP/HTTPS application URLs are preferred and enforced: only `http:`/`https:` URLs may ever reach `applyUrl`/`canonicalUrl` in stored data or rendered output (schema-gated at every ingestion point, re-gated again at the HTML-writer edge via `safeHref`).
12. Unknown information must remain unknown and never be fabricated — missing location stays unknown (never guessed "Remote"), missing dates stay `null` (never defaulted to today), missing ATS identifiers stay `null`/`"unknown"` (never guessed), missing descriptions are marked via the existing unresolved-placeholder convention, never represented as a fetched-and-empty description.
13. AI evaluation and resume tailoring happen only after the user selects a specific job from a ranked report — never automatically, never during broad discovery, never for every discovered job.
14. Top-20 relevance must reach at least 80% (Precision@20) for every profile before that profile's discovery configuration is considered tuned/accepted. Manually reviewed, not self-reported.

## Scope gate

Before starting any task, ask:

> **Does this task directly help scan the required sources once and produce four accurate ranked job reports?**

If the answer is no, park the task. Park means: write it down, do not build it now. Examples of tasks that fail this gate today: LinkedIn/Indeed/Monster live integration work beyond enabling the existing portal adapters, per-job AI evaluation, resume/cover-letter generation, automatic applying, a dashboard, contact discovery, salary research, interview prep. These may become real tasks later, through separate explicitly-scoped work — not as a side effect of a discovery-quality or registry task.

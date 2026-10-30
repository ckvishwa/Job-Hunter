# Workflow — job-hunter

Source of truth for how a job moves from "somewhere out there" to "ranked row in a profile report." See `docs/PRD.md` for the requirements this workflow exists to satisfy.

## Pipeline

```
Fortune 500 registry (config/fortune500-registry.json)
+ major portals (LinkedIn, Indeed, Monster — config/portals.yml)
+ ATS platforms (Greenhouse, Lever, Ashby, Workday, iCIMS — native adapters + CareerOps external source)
+ generic career pages (SiteConfig.generic fallback)
        ↓
one shared discovery pass (src/discovery/orchestrator.ts::runDiscover(), or --source careerops)
        ↓
schema validation (per-record; CareerOps: src/sources/careerops/careerops-schema.ts, native: adapter-level normalize())
        ↓
official URL/JD resolution (src/resolver/posting-resolver.ts, bounded concurrency + per-job timeout)
        ↓
canonical storage (data/jobs.jsonl, JobPosting[])
        ↓
cross-source deduplication (src/dedup/deduplicator.ts::mergeJobs() — canonical URL, then source::requisitionId, then company+title+location, then description fingerprint)
        ↓
four-profile classification (src/discovery/relevance.ts::evaluateRelevance() against all 4 profiles, not just the one requested)
        ↓
seniority/location/freshness filters (src/hunt/eligibility.ts, location.ts, freshness.ts)
        ↓
deterministic scoring (src/hunt/scoring.ts — 0-100, evidence-based, no LLM)
        ↓
four profile reports (npm run hunt --profile sdet|security|cloud|network → output/latest-jobs.{json,csv,html})
```

## What "scan once" means concretely

- `runDiscover()`/`--source careerops` populate `data/jobs.jsonl` from every enabled source in a single run, regardless of which profile(s) will later be reported on.
- `evaluateRelevance()` always checks a discovered job against all four profiles' keywords/qualifiers in one pass and records every matching profile in `matchedProfiles` — a job is never re-discovered or re-fetched because a second profile also wants to see it.
- `npm run hunt --profile <name>` is a **read/filter/rank** step over the already-populated canonical dataset, not a new discovery pass. Running it four times (once per profile) reads the same `data/jobs.jsonl` four times; it does not re-scan any source four times.
- `--source native`/`--source careerops` choose *which discovery pass* populates the dataset, independent of profile — never per-profile.

## Failure isolation, by layer

- **Company-level** (`company-careers.ts`): a company with unverified/missing ATS-specific fields, no verified careers URL, or an ATS type with no native adapter is **skipped and counted**, never guessed, never stops the run.
- **Source-level** (`orchestrator.ts`): one source's failure is caught, logged, counted in `errors`, and the run continues to the next source/keyword.
- **Record-level** (CareerOps schema): one malformed offer is isolated via `validateOffers()`'s per-record `safeParse` — counted, never thrown, never blocks the surrounding valid records.
- **Resolution-level** (`resolve-phase.ts`): one job's resolution timeout/error produces an honestly-labeled unresolved placeholder (`UNRESOLVED_PLACEHOLDER_PREFIX`), never a fabricated description, never blocks other jobs' resolution.

## Scope gate

Before starting any task in this workflow's implementation, ask:

> **Does this task directly help scan the required sources once and produce four accurate ranked job reports?**

If no, park it. See `docs/PRD.md`'s scope gate section for the list of things that currently fail this test.

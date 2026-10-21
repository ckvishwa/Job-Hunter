# Job Hunter — Owner Target Employers (68)

This watchlist contains 68 distinct names from the provided six-sector list, **not 70**.

Compared against `config/fortune500-registry.json` on GitHub branch `careerops-integration` (not local M4):

- 30 names map to existing registry entries.
- 38 are not present under the listed names and aliases.
- 19 matching records contain an older careers URL candidate, **not reverified as of today**.
- This artifact does not contain live job listings, verified open positions, or proof of H-1B sponsorship for any specific role.

## Integration rules

1. Preserve `config/fortune500-registry.json`. Do not overwrite or mark an employer `verified` because it appears in this watchlist.
2. Add this file as a separate target-priority registry, or merge via validated code that preserves existing verified values and provenance.
3. Search every employer's official careers and ATS catalog across all titles. Apply candidate matching **after** raw discovery.
4. Resolve official careers URLs and real ATS identifiers. Do not guess board slugs or Workday tenants.
5. Use official APIs or feeds where permitted; headed Playwright where browser navigation is needed. Respect access controls and rate limits.
6. Persist every observed job and its source, official URL, posting date (if known), first/last seen dates, employer, title, location, requisition, JD hash, and search run.
7. Keep `Splunk → Cisco`, `LinkedIn → Microsoft`, `VMware → Broadcom`, and `Discover → Capital One` relationships to avoid duplicate employer/job counts while preserving brand labels.
8. Historical sponsorship data is a research lead, **never an automatic job-level H-1B eligibility decision**.
9. Measure per-employer `totalFetched`, `unique`, `new`, `updated`, `stale`, `verified`, `relevant`, `skipped`, `failed`, and `timeMs`.
10. Export all job records to readable JSON, CSV, and browser HTML for owner labeling and ML evaluation.

## Search cadence (proposed)

Refresh targets daily when the source permits. Prioritize changes/incremental feeds and avoid repeatedly reopening unchanged postings. Implement resume-friendly checkpoints so a failed employer does not restart the entire crawl.

## Critical distinction

The legacy `company-careers` adapter only supports sufficiently verified Greenhouse, Lever, and Workday identities, and skips unknown ATS providers. A registry match alone does not imply searchable coverage.

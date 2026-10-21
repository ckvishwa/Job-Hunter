# M4 job matching and decision intelligence

M4 adds a decision projection beside the S4 evidence report. The S4 report still contains requirement statuses, exact JD quotations and candidate fact references without a numeric score. The M4 projection is persisted in `job_match_reports.decision` by migration `0006_m4_decision_intelligence` and returned with the existing authenticated match API. `GET /api/v1/shortlist` returns only current `SHORTLIST` rows, ordered by ranking score. The API never submits an application.

## Decision rules

- `SHORTLIST`: at least one required qualification is extracted and all applicable required qualifications are supported by approved, authorized evidence. No blocking or unresolved eligibility condition, source warning, or incompatible selected work mode may remain.
- `REVIEW_REQUIRED`: missing, partial or unknown required evidence; unknown sensitive answer; ambiguous or contradictory JD; student-only or other unmodeled eligibility wording; stale or unverified source; incomplete extraction. Missing employment is an evidence gap, never zero years.
- `REJECT`: a cited employer citizenship, clearance or present work-authorization restriction conflicts with an explicit approved candidate attestation. The default policy excludes sponsorship from rejection. A rejection records the JD quotation and offset, candidate fact IDs, and rule `explicit-attestation-conflict`. Contradictory JD text routes to review.

The approved fact boundary, overlap-safe years calculation, profile authorization and fact lifecycle remain in S4A. The `rules-jd-extractor@3` revision retains exact source offsets, marks bare `Qualifications:` as unknown, and preserves an explicit clearance level. The match is keyed by JD hash, approved evidence, explicit eligibility facts, selected roles/locations/work modes, source observation, day, extractor, policy and lexicon. A changed input makes the previous row stale; recomputation creates a new current row. A failed extraction has `REVIEW_REQUIRED`, no shortlist.

## Ranking

The score is an internal ordering heuristic on a 0–100 scale. It is neither a hiring probability nor an eligibility percentage. Hard blocks and review needs are decided before ranking.

| Factor | Weight |
| --- | ---: |
| Required technical skills | 30 |
| Preferred technical skills | 10 |
| Professional experience | 15 |
| Education and certifications | 10 |
| Selected role alignment | 10 |
| Location compatibility | 5 |
| Work mode | 5 |
| Employment arrangement | 5 |
| Posting freshness | 5 |
| Known application constraints | 5 |

Each component is normalized to 0–1. Supported evidence earns 1, partial evidence 0.5, and unsupported evidence 0. Missing or unstated categories are neutral at 0.5. The employment-arrangement component remains neutral until the candidate supplies a reviewed preference. Selection and location affect ranking or review, not hard rejection. Jobs are sorted by score, then stable job ID.

## Local validation

The fictional 60-pair label file is `tests/fixtures/m4-matching-labels.json`. It was frozen before predictions; 12 cases are development and 48 are held out. Labels were scenario-authored, without an independent human reviewer. The real-posting diagnostic reads public Lever posting APIs without candidate data and writes private evidence. Neither dataset demonstrates production accuracy.

```powershell
npx vitest run tests/match/decision-intelligence.test.ts tests/match/extract-and-decide.test.ts tests/api/m4-shortlist.e2e.test.ts
npx tsx scripts/m4-evaluate.ts --heldout
npx tsx scripts/m4-real-diagnostic.ts
npm run test:full
```

Private results are in `private-runtime/m4/`. No current real candidate profile or job applications are used by these tests.

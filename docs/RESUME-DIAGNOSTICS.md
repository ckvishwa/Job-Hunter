# Résumé diagnostics

`npm run resumes:diagnose` is a read-only report built from what is actually in PostgreSQL. It never approves, edits, re-extracts or writes.

```powershell
npm run resumes:diagnose                                            # list résumés
npm run resumes:diagnose -- --resume <id>                           # terminal report (sensitive fields masked)
npm run resumes:diagnose -- --resume <id> --json --out private-runtime/diagnostics/<id>.json
npm run resumes:diagnose -- --resume <id> --redact-values           # no fact values at all: ids, counts, codes, offsets only
npm run resumes:diagnose -- --resume <id> --rerun-parser            # preview what the CURRENT parser would propose (writes nothing)
npm run resumes:diagnose -- --compare [--json]                      # every résumé side by side, fact identities never mixed
```

Other flags: `--reveal` (unmask name/email/phone), `--show-text` (short excerpts of uncovered lines), `--reference <file>` (independent labels, below),
`--prior-profile <file>` / `--no-prior-profile`, `--as-of YYYY-MM-DD`, `--user <handle>`.

## Four questions, never merged

| View | Answers | Where |
| --- | --- | --- |
| Extraction coverage | which sections and fact categories were captured | `evaluationMetrics.extractionCoverage`, `possibleOmissions` |
| Evidence quality | source anchoring, split words, duplicates, conflicts | `evaluationMetrics.evidenceQuality`, `qualityWarnings` |
| Review status | what a person approved, rejected, left pending, edited | `evaluationMetrics.reviewStatus`, `extractionSummary` |
| Career relevance | S2 `SUPPORTED` / `PARTIAL` and the gaps | `roleRecommendations`, `evaluationMetrics.careerRelevance` |

There is no overall score, no ATS score, no hiring probability and no confidence percentage. `evaluationMetrics.accuracy` is the literal string
`NOT_EVALUATED` for precision, recall and F1 unless an **independent** reference is supplied. Review counts are not accuracy.

JSON sections: `resume`, `parser`, `extractionSummary`, `factsByCategory`, `qualityWarnings`, `possibleOmissions`, `approvedExperience`,
`roleRecommendations`, `evaluationMetrics`, `nextActions`, plus `achievementEvidence`.

## Reading it

* **parser**: stored parser revision, whether any fact was model-proposed (`proposedBy`), parser warnings, and where an employment category came from.
* **approvedExperience**: month-precision ranges from *approved, classified* employment only, for this résumé and for the user-wide pool S2 reads.
  `status: DISPUTED` means an approved employment record is in an open conflict; the range uses the record as approved and nothing is confirmed.
* **roleRecommendations**: every supporting fact id with its status, whether it lives on this résumé, and any quality warning on it
  (`dependsOnWeaklyAnchoredFact`, `dependsOnDisputedRecord`). `stored` shows what the database holds for the role (`current: false` = would change on refresh).
* **achievementEvidence**: statements the résumé makes (responsibilities, project accomplishments, summary claims) with exact offsets, the owning
  employment/project fact, and quantities *as written* (`14 custom SPL detection`, `F1 = 0.975 (±0.008)`). They are self-reported text, not facts, are
  never converted to months or years, and project statements are never professional time. `skillContext` separates a skill used inside a described
  activity (`demonstrated_in_context`) from one only listed (`skills_list_only`); it is co-occurrence, not proficiency.
* **qualityWarnings.employmentConflicts**: records that disagree about the same employer. Neither is chosen; see `docs/FACT-REVIEW.md` ("Open employment conflicts").

## Independent reference (optional)

```json
{ "schema": "orbital-extraction-reference/1", "independent": true, "labeledBy": "<person>", "labeledAt": "2026-10-10",
  "textSha256": "<optional hash of the extracted text>",
  "facts": [ { "kind": "skill", "value": "event correlation" },
             { "kind": "employment", "value": "Acme — Analyst", "employer": "Acme", "title": "Analyst", "startDate": "2022-01", "endDate": null } ] }
```

`independent: true` is a statement that a person wrote the labels from the document, not from any parser's output. Without such a file the
metrics stay `NOT_EVALUATED`. A reference whose `textSha256` differs from the stored text is ignored for the same reason.

## Privacy

Name, email, phone and sensitive kinds are masked unless `--reveal`. Reports go to stdout unless `--out` is given; keep outputs under `private-runtime/`
(git-ignored). The report refers to the earlier reviewed profile by file name only.

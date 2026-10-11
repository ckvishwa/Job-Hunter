# S4A: evidence-grounded job matching (first vertical slice)

```
official stored JD -> structured requirements -> authorized candidate facts -> retrieval -> requirement decisions -> explainable report
```

No match score, hiring probability or eligibility percentage exists anywhere. Statuses, quotations, fact ids and missing evidence only. Read-only: it never approves a
fact, edits employment, contacts an employer or applies.

```powershell
npm run match -- --jobs-file <jobs.jsonl> --job "<id|index|title text>"                       # deterministic baseline + MiniLM retrieval
npm run match -- --jobs-file <jobs.jsonl> --job "<...>" --encoder none                         # AI off: still fully functional
npm run match -- --jobs-file <jobs.jsonl> --job "<...>" --extractor qwen                       # shadow challenger; fails closed
npm run match:jd-compare -- --jobs-file <jobs.jsonl>                                           # Qwen vs baseline on the same JDs (agreement, not accuracy)
npm run match:gold -- init --jobs-file <jobs.jsonl>                                            # pool + FROZEN split + labelling sheet
npm run match:gold -- score --jobs-file <jobs.jsonl> --labels <gold.labels.json> --which heldOut
```
Reports are written to `private-runtime/match-reports/` (git-ignored).

## Modules (`src/match/`)
* `rules-provider.ts`: deterministic extractor (baseline and AI-off path). Reuses `source-coverage` (sections, offsets) and `source-alternatives`; output goes through the
  unchanged `validateStructuredProposal`. Years: professional / domain / tool / role scope. Alternatives only from an explicit OR. Four separate conditions: citizenship,
  clearance, present work authorization, future sponsorship; silence stays `unknown`.
* `analyze.ts`: over any validated StructuredJob: example vs listed vs alternative terms, negation (`not required`), whether the wording asks for hands-on use, work arrangement.
* `lexicon.ts` + `config/jd-terms.v1.json`: reviewed spellings; the only "related" notion is category membership (Splunk is a SIEM).
* `evidence.ts`: the corpus matching may see: approved, usable, source-backed, non-sensitive facts of the ACTIVE, authorized profile (`loadScopedEvidence`). Excludes rejected/pending/
  disputed, fixture and unauthorized résumés, source-mismatched facts, contact details, unclassified (unverified) employment, and accomplishment text whose owner is not kept.
* `retrieval.ts`: lexical exact, BM25 (in-house), MiniLM cosine, reciprocal-rank fusion (k=60). Retrieval gives leads; a score never establishes possession.
* `decide.ts`: SUPPORTED / PARTIAL / UNSUPPORTED / UNKNOWN per requirement with fact ids, quotations, missing evidence and explanation; four separate eligibility checks.
* `pipeline.ts`: orchestration and report (JSON + Markdown), version ids (profile id/revision/digest, JD hash, structured id, extractor, lexicon, policy).
* `gold.ts`, `gold-cli.ts`: labelling sheet, frozen split, label validation, scoring. `jd-compare.ts`: label-free shadow comparison.

## Status meanings
SUPPORTED: an approved fact states it at the strength the wording asks for, or computed months from approved professional employment meet the minimum. PARTIAL: real
evidence that does not establish the whole requirement (a skills-list mention where the JD asks for hands-on use; a tool with no linked duration; too few months).
UNSUPPORTED: no approved evidence (an evidence gap, not a proven lack; `explicitLack` only from an approved "lacks" fact). UNKNOWN: not decidable from facts (soft skills, wording
that maps to no reviewed term, domain years with no tagged employment, a requirement the JD says is not needed).
Projects never add professional years; a skill mention never becomes a duration; a confirmed-but-not-ingested employment statement is a reference and fills nothing.

## Fail closed
A provider error, malformed output, or any quotation that is not an exact slice of the stored JD rejects the whole extraction: the report says `EXTRACTION_FAILED` and contains no
decisions. The deterministic baseline is never affected. An unclassified mention of a sensitive condition is reported as an extraction gap, not as silence.

## Evaluation
`match:gold init` freezes a development/held-out split (rule: parity of the first byte of sha256(itemKey)) before anything is compared, and writes a labelling sheet. Accuracy
metrics (requirement P/R/F1, required/preferred accuracy, Recall@5 and MRR per retrieval method, false-support and unsupported-claim rates, eligibility and negation errors) are
computed only from a label file that is `independent: true`, complete for the split, bound to the frozen split hash, and not labelled by a model. Otherwise the output is
`NOT_EVALUATED`. Latency, memory and failure rate are operational and are reported separately; they are not accuracy.

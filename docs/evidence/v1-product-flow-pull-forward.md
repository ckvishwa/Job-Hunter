# V1 product-flow pull-forward: extraction fix, tracker, board discovery (2026-10-08)

Target flow: discovery, JD, selected resume, tracker row, filled form, manual submit. This slice covers the first four stages' inputs; no form fill and no submission happened.

## Decision Note: extraction without model-typed terms
- **Problem.** Live Qwen output for Sparksoft 5259170007 failed twice on source item `s319`: the model re-typed OR terms that were not verbatim source slices (see `v1-sparksoft-provider-failed-diagnosis.md`).
- **Alternatives.** (a) Keep model-typed `logic`, loosen the validator: admits source bleed. (b) Larger model: more cost, same failure class. (c) Model classifies whole items; code derives alternatives from the item text. Chosen.
- **Choice.** Model schema and prompt no longer contain `logic` (prompt `ollama-job-extraction@16`, `source-annotations@9`). `src/semantic/source-alternatives.ts` derives any_of terms: last `such as`/`using`/`e.g.`/`like` list, one short pair after a preposition, or a comma list ending in `or`. Anything ambiguous (extra connectors, `including` elaboration, AND inside the list) stays source-backed unresolved evidence. Whole-item evidence offsets still come from the deterministic inventory. An exact affirmative clearance sentence becomes a `clearance`/`required` constraint; nothing else is promoted to a constraint.
- **Limits.** An open-ended tail ("or similar technologies") is dropped from the group (stricter than the JD); it is recorded in `diagnostics.notes`, not in StructuredJob warnings (validator-owned). The residency clause has no fitting constraint type (`location` would be evaluated against preferences), so it stays unresolved evidence.
- **Acceptance / rollback.** Recorded live response replayed through the production provider path in `tests/semantic/sparksoft-5259170007.regression.test.ts`; unit table in `tests/semantic/source-alternatives.test.ts`. Rollback: restore prompt @15 and the `logic` schema property.

## Live result (one run, local qwen2.5:3b-instruct-q4_K_M, ollama-job-extraction@16)
2 requests, 0 repairs, 1,157 input / 406 output tokens, 12.0 s, both `done_reason: stop`, model unloaded after. Accepted StructuredJob (34 requirements, 7 alternative groups).

| Source set | Items | Extracted | Unresolved |
| --- | --- | --- | --- |
| Required | 14 | 13 | 1 (`s2yd`, mixed "and ... and/or") |
| Preferred | 9 | 6 | 3 (`s4a2`, `s4o0`, `s4ri`) |
| Mandatory clauses | 2 | 1 (Public Trust: clearance/required) | 1 (`s42r`, US residence 3 of 5 years) |

Independent coverage attestation is still absent; this is mechanical coverage, not a reviewed result. A single sample on a 3B model is not an accuracy measurement.

## Tracker
`npm run tracker -- --data-dir <dir> --output-dir <dir>/output --out <file>.xlsx` projects jobs.jsonl and per-run application records (plus resume-plan.json lane and checkpoint decision) into Tracker/About sheets. Rebuilt from scratch each run, replaced atomically, never read back. Workbook read independently with openpyxl 3.1.5 (outside the repo). Real Sparksoft row: decision REVIEW, resume variant sdet, state WAITING_FOR_USER.

## Board discovery
`npm run boards:discover -- --config config/company-boards.json --data-dir <dir>` (example: `config/company-boards.example.json`). One GET per company to `boards-api.greenhouse.io` or `api.lever.co`; title phrase filter required; each posting passes `stampResolution` (official board match) and `evaluatePersistable`, then `mergeJobs` under the job-store lock. Typed failures go to `job-failures.jsonl` (new codes `BOARD_FETCH_FAILED`, `BOARD_NOT_FOUND`, `BOARD_RESPONSE_INVALID`). Live check against the Sparksoft board: 32 postings, 1 title match (`Quality Engineer (Automation Tester)`, 4,814 chars), saved; rerun reported unchanged=1. The target job 5259170007 ("Jr Functional /Automation Tester") did NOT match the example keywords: titleKeywords need tuning.

## Verification
`npm test` 84 files / 938 passed, `npm run typecheck`, `npm run build` clean. Pending: pipeline rerun on the new extraction (would proceed to form stages), independent coverage review, real Excel open test.

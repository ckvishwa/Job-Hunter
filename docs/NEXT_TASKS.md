# Next tasks

## V1 Slice 3 — approved candidate facts and deterministic decision (next, one bounded task)

Goal: prove `StructuredJob` + approved candidate facts -> explained `ELIGIBLE | REJECT | REVIEW` with no guessed sensitive answers. Offline, deterministic, no model. Uses a SYNTHETIC candidate only; the real candidate's facts must be supplied and approved by the user in a later step. Nothing is inferred from a resume, a name or history.

Smallest scope:

1. `src/domain/candidate-profile.ts` (zod): `CandidateProfile` (`candidateId`, `schemaVersion`, `profileVersion`, `updatedAt`, `facts[]`, `applicationAnswers[]`). `CandidateFact`: immutable `factId`, `kind`, `value`, `approvedText?`, `source`, `verifiedBy`, `verifiedAt`, `validUntil?`, `approvalStatus` (`pending | approved | rejected`), `sensitivity`, optional employment/project association. Imported text starts `pending`; only `approved` and unexpired facts are usable. Conflicting facts for one key are `CONFLICT`, expired ones `EXPIRED`; neither is usable.
2. `src/decision/evaluate.ts`: pure function `(StructuredJob, CandidateProfile, policy) -> Decision` with `hardRules[]` (`PASS | FAIL | UNKNOWN`, each citing requirement/constraint ids, evidence offsets and fact ids), `missingFacts[]`, `explanations[]`, `jobVersion = jdHash`, `profileVersion`, `policyVersion`. Rules, in this order:
   - a stated mandatory constraint the candidate fails -> `FAIL` -> `REJECT`;
   - a mandatory constraint that is `unknown` in the JD, or a sensitive one (work authorization, future sponsorship, clearance) with no explicit, current, wording-compatible approved fact -> `UNKNOWN` -> `REVIEW` (never inferred; "authorized now" does not answer future sponsorship);
   - required requirement groups: an `any_of` group passes if one member is covered by an approved fact via a reviewed exact/synonym map (Selenium is not Playwright); role-years are checked against role-scoped facts, tool-years against tool-scoped facts; years are not inferred from skill mentions or summed over overlapping employment;
   - preferred requirements affect only an optional ranking breakdown and never override a failed hard rule.
3. Tests with hand-reviewed expected decisions: a covered job -> ELIGIBLE; a failed stated constraint -> REJECT; unknown sponsorship/clearance (as in the Figma demo, where the JD is silent) -> REVIEW with the missing fact named; expired/pending/conflicting facts unusable; OR group satisfied by one member; role-years vs tool-years; stale `jdHash` or profile version invalidates a stored decision; Unicode/case normalization limited to the reviewed map.
4. Demonstration (label it SYNTHETIC_CANDIDATE): evaluate the stored Figma `StructuredJob` (`MANUAL_ANNOTATION`) against a synthetic profile and inspect the explanation by hand.

Out of scope: real candidate facts, resume planning/rendering, forms, embeddings, any model, ranking weights beyond a recorded placeholder.

## Pending gate: autonomous structured parser (V1 Slice 2 acceptance for the live path)

Slice 2 delivered the contract, validator and fixture-provider wiring only. Still required before the parser is "accepted" for the autonomous path:

1. Select and admit a provider behind `JobSemanticProvider` (check the repository's existing provider first; none exists on this branch). Record model/revision, prompt and schema revision, hardware, latency and cost. No model download or live inference in ordinary tests.
2. Build a reviewed set of JDs (minimum per the ARD: 100 JDs overall, at least 30 held out, split by company/template family, siblings excluded across splits) with human-reviewed requirement labels; model proposals are never gold labels.
3. Measure schema-and-evidence-valid output rate, required-skill precision and recall (reported separately), OR/negation/scope errors and zero critical sensitive errors on the held-out set; compare against the fixture/manual baseline.
4. Inspect live output on real saved JDs. Until then, state "autonomous parsing: PENDING".
5. Have the Figma annotation (`docs/evidence/fixtures/figma-security-engineer.manual-annotation.json`) reviewed by someone other than its author before using it as a labelled example.

## Carry-over fixes worth scheduling (not blocking Slice 3)

- Deduplicate `discovered-jobs.jsonl` appends (key: source + company + sourceJobId); lock and corruption-check the append-only logs and `checkpoints.json`.
- Add a timeout to the verification stdin wait so an unattended run ends in a recorded pause instead of hanging.
- Live-test a Lever board and a company-hosted `gh_jid` page (e.g. a Stripe posting) with the same canonical gate, one at a time.
- Reconcile `StructuredJob.jdHash` vs `JobPosting.jdContentHash` naming with `docs/ard/00-SHARED-CONTRACTS.md` when the canonical schema is next versioned.
- Decide whether to copy `docs/ard/` into this branch (currently untracked in the parent checkout only).

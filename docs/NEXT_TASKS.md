# Next tasks

## V1 Slice 2 — structured JD parsing (next, one bounded task)

Goal: turn a persisted canonical job's `descriptionText` into a validated `StructuredJob` whose every requirement carries evidence that mechanically matches the stored JD. Offline first; a live provider call is a separate, explicit step.

Starting point (already true after Slice 1): `data/slice1-proof/jobs.jsonl` holds two real, inspected Figma JDs with `jdContentHash` and `resolutionStatus: "resolved"`; the extraction version key is the `jdContentHash`.

Scope:

1. `src/domain/structured-job.ts`: zod schema. Requirement = `id`, `kind`, `canonicalValue`, `requirementLevel` (required | preferred | unknown), `alternativeGroupId?`, `minimumYears?`, `scope?`, `evidence[]` = `{ quote, start, end }` offsets into the stored `descriptionText`. Job-level `jobId`, `jdContentHash`, `parserVersion`, `providerMetadata`, `validationStatus`, `warnings[]`.
2. A pure validator: every evidence quote must equal `descriptionText.slice(start, end)`; an OR group ("Selenium or Playwright") must share one `alternativeGroupId` and not become two mandatory skills; absent statements (clearance, sponsorship) are `unknown`, never `false`; duplicate ids and empty evidence are rejected.
3. A narrow provider interface (`parse(jdText) -> unknown`) plus a stored-output fixture provider. Reuse the repository's existing provider if one is found; none exists in this branch (audited), so do not add provider rotation or a model download in this slice.
4. Failure category `SEMANTIC_PARSE_FAILED` with no downstream mutation (ARD scenario V1-E09); a JD containing instructions ("ignore previous instructions") is inert text (V1-E15).
5. Tests: invented evidence, malformed JSON, OR group, required vs preferred, scoped years ("3 years of Python" is not "3 years of software engineering"), hash change invalidates a stored parse.
6. Proof gate: offline tests plus one hand-inspected parse of one of the two Figma JDs. Label any manually authored fixture as manual annotation; do not present it as live model accuracy.

Out of scope: embeddings, candidate facts, eligibility decision, resume, forms, SQLite, Workday.

## Carry-over fixes worth scheduling (not blocking Slice 2)

- Deduplicate `discovered-jobs.jsonl` appends (key: source + company + sourceJobId).
- Make `loadJobs` report mid-file corruption explicitly instead of dropping the line on the next save; add a single-writer guard for the jobs store.
- Add a timeout to the verification stdin wait so an unattended run ends in a recorded pause instead of hanging.
- Live-test a Lever board and a company-hosted `gh_jid` page (e.g. a Stripe posting) with the same gate, one at a time.
- Provide or locate `docs/ard/00-SHARED-CONTRACTS.md`; reconcile failure category names with it.
- Decide whether to copy `docs/ard/` into this branch (currently untracked in the parent checkout only).

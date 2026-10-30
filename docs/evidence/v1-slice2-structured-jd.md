# V1 Slice 2 — evidence-backed structured JD contracts

Date: 2026-10-07. Branch `careerops-integration`. Boundary proven:

saved canonical JD -> provider proposal -> runtime schema -> source-evidence validation -> accepted `StructuredJob` | `SEMANTIC_PARSE_FAILED`.

**Label for everything below: `MANUAL_ANNOTATION` / `FIXTURE_PROVIDER`.** No model is involved. This slice proves the contract, the validator and the production wiring. It does not prove autonomous extraction, live model accuracy, or that any particular interpretation of a JD is right.

## What was built

| Piece | Path |
|---|---|
| Contract + validator (zod, pure) | `src/domain/structured-job.ts`: `structuredProposalSchema`, `structuredJobSchema`, `validateStructuredProposal`, `checkEvidenceSpan`, `buildSemanticFailure` |
| Provider boundary + fixture provider | `src/semantic/provider.ts`: `JobSemanticProvider`, `FixtureJobSemanticProvider`, `FixtureNotFoundError` |
| Production entry | `src/semantic/parse-job.ts`: `parseCanonicalJob`; CLI `src/semantic/cli.ts` (`npm run parse-jd`) |
| Accepted-result artifact | `src/storage/structured-store.ts` -> `<data-dir>/structured-jobs.jsonl` (locked, atomic, strict reads) |
| Failure log | `<data-dir>/structured-failures.jsonl` (append + fsync) |
| Store generalisation | `src/storage/job-store.ts`: `loadRecords`, `updateRecords` (jobs functions now delegate to them) |

`jobs.jsonl` is only read (never written) by this slice; the demonstration verified its SHA-256 prefix was identical before and after.

## Design decisions (brief)

1. **Strict proposal schema; trusted binding.** The proposal schema is `.strict()`, so a provider that supplies `jobId`, `jdHash`, `parserVersion`, `providerRevision`, `validationStatus` or `warnings` is rejected outright instead of being quietly ignored. Alternative: ignore and overwrite such fields. Rejected: silently discarding a provider's claim about its own source hides exactly the confusion this guards against. The only provenance a proposal may echo is `sourceJdHash`, used only to detect stale output (it never sets identity). Cost: fixtures are slightly stricter to write.
2. **Evidence is checked on the exact persisted string, UTF-16, no normalization.** `0 <= start < end <= length`, `slice(start,end) === quote`, non-blank, and spans may not split a surrogate pair. Alternative: normalize whitespace/Unicode before matching. Rejected: it would make offsets unusable for later highlighting and would accept quotes that are not literally in the document. Surrogate-splitting is rejected explicitly because a lone-surrogate quote can still equal the slice and would pass a naive equality check.
3. **OR logic = declared `any_of` groups; AND = everything else.** "Selenium or Playwright" is one group with two members sharing one evidence span; "Python and Java" are two ungrouped requirements. Mixed structures are several groups plus ungrouped items. Alternative: a nested boolean expression tree. Rejected for this slice: more validator surface and no consumer yet; groups cover the observed JD patterns, and the tree can be added later behind the schema version.
4. **Sensitive constraints are always present, defaulting to `unknown`.** The validator appends `unknown` entries (ids reserved with an `auto-` prefix, no evidence, no value) for clearance, sponsorship, citizenship and work authorization when the provider is silent. A provider-supplied `unknown` that carries evidence or a value is rejected. Statuses are a closed enum, so a boolean `false` cannot be expressed.
5. **Role-years vs tool-years are mechanically separated.** `role_experience` cannot be scoped to a tool; years on a tool/language/platform require a tool scope equal to that tool; any `minimumYears` must literally appear in the cited evidence (numeral or word up to twenty). Alternative: leave scope free text. Rejected: that is the "3 years of software engineering counted as 3 years of Python" failure the ARD names.
6. **Interpretation cues are flagged, not decided.** Negation wording, required/preferred wording that contradicts the level, and a normalized value absent from the evidence produce `warnings`; they do not reject. Rejecting on regex heuristics would produce false rejections and a false sense of safety.
7. **Whole-proposal rejection, persist-then-report.** Any issue rejects the entire proposal; nothing partial is returned or stored. The accepted result is stored (locked + atomic) before `parseCanonicalJob` returns `ok`. A storage failure throws `JobStoreError`; it is not mislabelled as a parse failure.
8. **Fixture provider is keyed by exact content hash and cannot fall back.** Unknown input throws `FixtureNotFoundError` -> `PROVIDER_FAILED` (non-retryable). Fixture files must declare `provenance: "MANUAL_ANNOTATION"`; the provider revision is `fixture:MANUAL_ANNOTATION:<12 hex of file sha256>`.
9. **Safe diagnostics.** Issues carry a code, a path and a message built from codes and our own vocabulary. zod's default messages can echo the received value, so they are not used (a test caught a leak: an invalid enum value was echoed). Provider exceptions are logged by class name only.
10. **Record key** = `jobId::jdHash::parserVersion::providerRevision`: a changed JD, parser or provider yields a new record and never overwrites an earlier one; the same key is replaced idempotently.
11. **Naming.** `docs/ard/00-SHARED-CONTRACTS.md` says `jdHash`; the Slice 1 canonical job field is `jdContentHash`. `StructuredJob.jdHash` is bound from `JobPosting.jdContentHash`; the persisted JobPosting field name was not changed in this slice.

## Offline verification (actual)

| Check | Result |
|---|---|
| Baseline at start (`1e7e58b`) | 62 files, 610 passed (reported; not re-run separately before edits, but the post-change total below = 610 + 94 new) |
| `tests/domain/structured-job.test.ts` | 69 tests |
| `tests/semantic/parse-job.test.ts` | 25 tests |
| Full suite | **64 files, 704 passed, 0 failed** |
| `npx tsc --noEmit` | clean |
| Mutation spot-checks | disabling the `slice === quote` check failed 11 tests; disabling the surrogate-split check failed 1 test; both reverted |

Covered: valid requirements with exact evidence; malformed JSON; invalid schema (14 shapes); fabricated quotes; shifted/out-of-range/reversed/empty/whitespace offsets; no trimming or case folding; duplicate ids (cross-collection, reserved prefix); undeclared/singleton/unused/mixed-level groups; mixed AND/OR (two groups + ungrouped); stale echoed hash; stale source; required vs preferred cues; role-years vs tool-years; unknown sponsorship/clearance staying unknown; negated restrictions; CRLF, precomposed vs decomposed Unicode, surrogate pairs (astral offsets, split rejected); JD instructions as inert data; unknown fixture input; provider failure with an error message that must not be logged; invalid proposals leaving `jobs.jsonl` byte-identical and creating no structured artifact; corrupt structured store throwing instead of reporting success; CLI exit codes.

Expected values are hand-reviewed literals: offsets were counted by hand and cross-checked once with `String.indexOf` in a scratch script, never produced by the validator under test. One hand count (91 vs 90) was wrong and was corrected after the test failed, which is the point of the independent oracle.

## One real-document demonstration — `MANUAL_ANNOTATION` / `FIXTURE_PROVIDER`

- Document: Figma "Security Engineer", saved in Slice 1 at `data/slice1-proof/jobs.jsonl` (gitignored).
- Canonical job id `d3d33fcaf016628e`, `atsIdentity` `greenhouse:figma:5829751004`.
- Source hash (`jdContentHash`): `6cda9b85eef7200306748a20395b0fa83f2158e2ef4da9e44c7cf92b583cda54` (7,899 chars).
- Annotation: `docs/evidence/fixtures/figma-security-engineer.manual-annotation.json`. Provenance: quotes hand-selected from the saved text by the coding session; offsets located by exact, unique substring search in a scratch script; not model output; no independent human reviewer has checked it yet.

Command (from the worktree root):

```
npm run parse-jd -- --data-dir data/slice1-proof --job greenhouse:figma:5829751004 \
  --fixtures docs/evidence/fixtures/figma-security-engineer.manual-annotation.json
```

Result (exit 0):

- `ACCEPTED d3d33fcaf016628e::6cda9b85...::structured-job-validator@1::fixture:MANUAL_ANNOTATION:a7512012c5dd`
- requirements 12 (6 required, 6 preferred); alternative groups 3 (role-experience OR, judgment OR, subject-matter-expertise any-of) covering 9 grouped members; responsibilities 3; constraints 6 (location, employment type stated; clearance, sponsorship, citizenship, work authorization `unknown` with no evidence).
- 23 evidence spans, all verified as exact slices by the production validator.
- 9 warnings: 6 `NEGATION_CUE_IN_EVIDENCE` (all caused by the quoted header "While not required, it's an added plus if you also have:", an expected false positive that shows the flag working), 3 `VALUE_NOT_IN_EVIDENCE` (paraphrased normalized values).
- Artifact: `data/slice1-proof/structured-jobs.jsonl` (one record; re-running the command leaves one record). `jobs.jsonl` SHA-256 prefix `5685d628a46b17b7` before and after.
- Control: the second Figma JD (`greenhouse:figma:6180172004`, different hash) has no fixture; the command exits 1 with `SEMANTIC_PARSE_FAILED PROVIDER_FAILED` (`FixtureNotFoundError`) and logs it to `structured-failures.jsonl`; the structured artifact stays at one record. The unrelated fixture was not returned.

### Known omissions and interpretation limits of this annotation

- Only 3 of roughly 20 responsibilities are annotated; AI/Platform/Anti-Abuse bullets, compensation, equity and benefits are omitted by choice (not candidate requirements).
- "We'd love to hear from you if you have:" is read as the required list because the next sentence says "While not required ... an added plus". That is an interpretation, not a stated fact.
- The 5+ years sentence is modelled as role-years with an OR over two roles. The clause "In the case of the latter, some security experience is preferred" is not represented (no schema slot for a conditional preference).
- "and/or" in the subject-matter list is modelled as `any_of` (at least one); it could also mean any combination.
- "Strong security judgment ... and/or strong technical judgment" is an `any_of` pair; the quoted wording allows both.
- "citizenship" appears only inside the equal-opportunity list of protected characteristics. It is deliberately not a constraint; the validator cannot know this, so correct handling here depends on the annotator.

## What validation proves, and what it cannot

Proves: the output has the declared shape and vocabularies; ids are unique; groups are well formed; every evidence span is a literal, non-blank, pair-safe UTF-16 slice of the exact persisted text whose hash matches the recorded one; a stated duration appears in its evidence; sensitive constraints are never fabricated as false or given invented evidence; identity, source hash and revision come from orchestration; a rejected proposal changes nothing.

Cannot prove (needs reviewed fixtures, human review or later measured evaluation): that a quote supports the claimed requirement; required vs preferred when the wording is neutral; whether an "or" is exclusive; whether a negation flips the meaning; that a normalized value is a fair paraphrase; that the requirement set is complete; that the model (when one exists) is accurate. Quote-in-document is provenance, not correctness: a wrong interpretation of a real quote passes (two tests pin this as KNOWN LIMIT).

## Pending gate: autonomous parser admission

Not done and not claimed: a live provider, prompt/schema revision, a labelled development/held-out set, the ARD V3 benchmarks (schema-and-evidence validity, required-skill precision and recall), latency/cost, and zero critical sensitive errors on held-out data. V1 Slice 2 acceptance in the ARD ("inspected live output") remains PENDING for the autonomous path; only the contract, validator and fixture-driven wiring are accepted here.

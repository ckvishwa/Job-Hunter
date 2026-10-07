# V1 Slice 3 — approved candidate facts and evidence-based decisions

Date: 2026-10-07. Branch `careerops-integration`. Contract: `docs/ard/00-SHARED-CONTRACTS.md` (Decision, CandidateProfile) and `ARD-V1-Working-Vertical-Slice.md` section 7.

**The real candidate decision is still pending.** Every real fact imported from the candidate's resumes is `pending`, so none can satisfy a requirement. The one decision shown below uses a clearly labelled SYNTHETIC candidate and a MANUAL_ANNOTATION of the saved JD. It demonstrates the engine, not the candidate's eligibility, and not autonomous parsing.

## What exists

| Piece | Path |
|---|---|
| Candidate profile contract (zod), fact usability, overlap-safe employment months, profile digest | `src/domain/candidate-profile.ts` |
| Deterministic decision engine, extraction-review contract, staleness | `src/decision/evaluate.ts` (`evaluateJob`, `decisionStaleness`) |
| Decision command | `src/decision/cli.ts` (`npm run decide`) |
| Derived decision store (`decisions.jsonl`: locked, atomic, strict reads, separate from `jobs.jsonl`) | `src/storage/decision-store.ts` |
| Resume importer producing PENDING facts | `src/candidate/resume-import.ts`, `src/candidate/cli.ts` (`npm run candidate:import`) |
| Private input template (no real data, nothing approved) | `config/candidate-profile.template.json` |
| Synthetic demo candidate; extraction review for the Figma annotation | `docs/evidence/fixtures/synthetic-candidate.profile.json`, `docs/evidence/fixtures/figma-security-engineer.extraction-review.json` |

## Commands

```
npm run decide -- --data-dir data/slice1-proof --job greenhouse:figma:5829751004 \
  --profile docs/evidence/fixtures/synthetic-candidate.profile.json \
  --review docs/evidence/fixtures/figma-security-engineer.extraction-review.json --as-of 2026-10-07

npm run candidate:import -- --resumes-dir "F:/Jobs/Resumes" --out private-runtime/candidate/pending-facts.json --candidate-id candidate-1
```

`decide` reads the saved job (read-only) and the validated StructuredJob for the SAME JD revision, evaluates, and appends the derived decision to `<data-dir>/decisions.jsonl`. It never writes `jobs.jsonl`, `structured-jobs.jsonl` or the profile. It refuses (exit 2, nothing written) if no structured extraction exists for the job's current JD hash.

## Decision policy (what the rules mean)

Per criterion: **PASS** an approved, verified, unexpired fact satisfies it. **FAIL** facts demonstrate it is not met: an explicit `lacks` fact, or a years shortfall against an employment history the candidate attested complete. **UNKNOWN** a needed fact is missing, pending, rejected, expired, unverified or conflicting. Missing information is never a FAIL.

Outcome: any mandatory FAIL -> **REJECT**. Otherwise any mandatory UNKNOWN, or extraction coverage not attested complete by a named reviewer, or no mandatory criteria at all -> **REVIEW**. Otherwise **ELIGIBLE**. Preferred criteria are reported but can never fail a job. Requirements whose level the JD left `unknown` are not mandatory.

- Title is not an input. `evaluateJob` takes no title and no title-targeting result; a title MATCH cannot establish eligibility.
- Skills match by normalized exact term, a candidate-approved `matchTerms` list, or a tiny reviewed synonym list (js, ts, k8s, postgres, golang). Selenium does not match Playwright; Java does not match JavaScript.
- Years: role-years come only from approved employment facts the candidate tagged (`roleTags`) with that role; tool-years only from the employment facts an approved skill fact links to (`experienceIds`); general "N+ years" from all approved employment. Everything is counted as the overlap-safe union of date ranges (end minus start, end month not counted; a current job runs to the as-of date), so overlapping jobs are not double-counted. A skill mention, a job title, or a personal project never creates professional years.
- Sensitive answers (clearance, work authorization) are decided only by explicit approved facts of those kinds. No such fact -> UNKNOWN -> REVIEW. Nothing is inferred from a name, education, history or a model.
- **Sponsorship** statements in a JD are recorded verbatim under `recordedStatements` and never affect the outcome (the user's stated preference against sponsorship-based filtering). New-grad, junior and internship roles are not filtered either: no seniority rule exists here.
- Location/work mode is evaluated only against an explicitly configured, approved candidate preference (mandatory or preferred). With none configured the JD statement is recorded only. A JD that is silent about something adds no restriction.
- Coverage: an `ExtractionReview` (provenance, partial/complete, reviewer, omissions) must attest complete coverage for ELIGIBLE. A manual annotation or model output is partial until a named reviewer says otherwise; omitted requirements are never assumed to pass.
- Staleness: a decision records job id, JD hash, structured extraction id, profile version AND a content digest of the profile (so an edit without a version bump is caught), policy version and extraction provenance. `decide` reports earlier decisions for the same candidate that no longer apply and appends a new record instead of rewriting.

## Candidate data: what was found and what was done

`F:\Jobs\Resumes` holds four finished per-profile resumes and four cover letters (SDET, Cloud, Network, SOC/DFIR). They are application documents, not a fact store, and still contain template placeholders (`[FULL NAME]`, `[Degree]`, `[Month Year]`). The importer therefore:

- reads `Resume*.docx` only (never cover letters), writes to `private-runtime/candidate/pending-facts.json` (gitignored; refuses to overwrite an existing file, which may hold reviewed approvals, without `--force`);
- imports skills (verbatim, comma-split), employment (employer, title, parsed month dates), project names with their technology lists, and certification names; keeps no contact details, summary text or bullet claims; skips lines with unfilled placeholders and unparseable dates and lists them;
- sets every fact `pending` with null verification, adds no role tags, years, proficiency or sensitive fact.

Run on the real resumes it produced **128 pending facts** (112 skills, 1 employment, 14 projects, 1 certification) and 8 notes (the certification date and education lines are still template placeholders). Duplicates across the four resumes were merged (the single employment fact appears once, noted as appearing in several files). Some skill items are comma-split fragments ("Unit", "integration"); they are flagged in each fact's notes for the reviewer to reject.

**To finish the real decision:** open the file; for each fact you confirm set `approvalStatus` to `approved` and fill `verification.verifiedBy` and `verifiedAt`; add `roleTags` to the employment fact (what it counts as, e.g. "QA automation", "Security Operations"); add `experienceIds` to skills used in that job; add explicit `work_authorization` / `clearance` facts if you want those answered; optionally set `employmentHistoryComplete` and a location preference. Use `config/candidate-profile.template.json` as the shape. Then rerun `decide` with that file.

## One demonstrated decision (SYNTHETIC_CANDIDATE, MANUAL_ANNOTATION)

Job: Figma "Security Engineer", `greenhouse:figma:5829751004`, id `d3d33fcaf016628e`, JD hash `6cda9b85eef7...`; StructuredJob `fixture:MANUAL_ANNOTATION:a7512012c5dd` (Slice 2); extraction review: provenance MANUAL_ANNOTATION, coverage **partial**, no reviewer. Candidate: `synthetic-candidate` v`synthetic.1` with approved facts: Security Engineer job 2017-03 to 2022-09 tagged "Security Engineering" (`e-secops`, 66 months), Software Engineer job 2017-06 to 2019-06 tagged "Software Engineering" (`e-swe`, 24 months, overlapping), skills Python/Java/AWS IAM, and a mandatory location preference "united states". Evaluated as of 2026-10-07.

**Outcome: REVIEW** (mandatory: 2 pass, 0 fail, 4 unknown; preferred: 0 pass, 0 fail, 2 unknown).

| Criterion (level) | Result | Evidence (JD offsets) and facts |
|---|---|---|
| any of Security Engineering OR Software Engineering, 5+ years (required) | **PASS** | "5+ years of proven engineering experience working in either a Security Engineering or a Software Engineering role." [2929-3043]; fact `e-secops`: 5.5 years (Software Engineering: 2.0 years, UNKNOWN, since `e-swe` is only 24 months) |
| location (required, preference) | **PASS** | "This is a full-time role that can be held from one of our US hubs or remotely in the United States." [2789-2888]; the candidate's term "united states" |
| language: at least one general-purpose coding language (required) | UNKNOWN | [3269-3329]; no approved fact has that exact normalized phrase |
| soft skill: communication and cross-functional collaboration (required) | UNKNOWN | [3330-3437]; no matching approved fact |
| any of security judgment OR technical judgment (required) | UNKNOWN | [3110-3268]; no matching approved fact |
| subject-matter expertise group; prioritization decisions (preferred) | UNKNOWN | never mandatory |
| extraction covers the JD and was reviewed (coverage) | UNKNOWN | partial; four known omissions listed in the decision |

Recorded, not used to reject: employment type "full-time"; sponsorship: the JD says nothing (an `unknown` entry), and policy is record-only regardless. Unresolved questions listed in the decision: the five undecidable criteria plus "Who reviewed the extraction, and does it cover every requirement in the JD?".

Why REVIEW and not ELIGIBLE, even though the synthetic candidate passes the criteria it can: (1) four mandatory criteria are annotated as free-text phrases ("at least one general-purpose coding language") that no approved skill fact states, so nothing can be shown; and (2) the annotation is partial and unreviewed. Both are true to the data, and the second alone would block ELIGIBLE.

Second run with the REAL imported facts (all pending): **REVIEW**, mandatory 0 pass / 0 fail / 5 unknown, preferred 2 unknown, location and sponsorship recorded; no pending fact satisfied anything. Stored in `data/slice1-proof/decisions.jsonl` (gitignored) beside the earlier decision, which `decide` reported as stale ("the candidate profile changed") instead of overwriting.

Authoritative data untouched: SHA-256 prefixes of `jobs.jsonl` (`5685d628a46b17b7`) and `structured-jobs.jsonl` (`75dc29b06a34f959`) were identical before and after.

## Verification

- `tests/decision/evaluate.test.ts` (41), `tests/decision/cli.test.ts` (8), `tests/domain/candidate-profile.test.ts` (13), `tests/candidate/resume-import.test.ts` (12). Expected results are reasoned by hand from the policy (overlap arithmetic worked out in comments; e.g. 30 + 30 overlapping months is 42, not the 60 a naive sum would pass).
- Covered: approved vs pending/rejected/expired/unverified; required vs preferred; unclear level; OR groups and (A OR B) AND C; role-years vs tool-years vs general years; overlapping, contained, disjoint and current employment; untagged job title never proving role experience; skill mention and projects never creating years; conflicting facts; mandatory unknown -> REVIEW; demonstrated failures -> REJECT (and still REJECT under partial coverage); complete passing evidence -> ELIGIBLE; partial/absent/mismatched/unnamed-reviewer coverage never ELIGIBLE; no mandatory criteria -> REVIEW; sponsorship recorded and never rejecting (even with an approved "needs sponsorship" fact); silent JD adds nothing; clearance/work authorization only from explicit facts; location preference mandatory/preferred/absent; changed JD, extraction, profile content (same version) or policy -> stale; deterministic output; jobs and structured files byte-identical; title changes irrelevant; pending-only profile never ELIGIBLE; resume import (docx reading incl. `<w:tab>` regression, placeholders, dates, dedupe, no contact/summary/bullets, cover letters never read, no overwrite).
- Mutation spot checks: forcing years shortfalls to FAIL broke 3 tests; treating pending facts as usable broke 4.
- Full suite: **71 files, 834 passed, 0 failed**; `tsc --noEmit` clean.

## Limits and what is not claimed

- Requirement values from the annotation are free text. Matching is exact after normalization, so most real requirements stay UNKNOWN until either the annotation uses curated skill names or facts carry `matchTerms`. This is deliberate: fuzzy matching would manufacture PASS results. The cost is many REVIEW outcomes; a reviewed vocabulary (V3) is the proper fix.
- A years shortfall is only a FAIL when the candidate attests the approved employment history is complete; otherwise UNKNOWN.
- The location preference is a substring match on the JD's stated location text.
- Citizenship requirements are evaluated against `work_authorization` facts only; there is no separate citizenship fact kind.
- No real candidate decision exists: no fact is approved, no role tag set, no work-authorization fact stated. Nothing here is evidence about the candidate's eligibility.
- No autonomous parser exists; the extraction is a manual annotation with partial, unreviewed coverage.

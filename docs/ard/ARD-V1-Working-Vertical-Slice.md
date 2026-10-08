# V1 Working Job Application Vertical Slice

Milestone V1 maps to the earlier V0.1 release. Status: proposed, pending read-only audit. Read both `00-START-HERE.md` and `00-SHARED-CONTRACTS.md` first.

## 1 What V1 will achieve

One real suitable job moves from an official company source to a saved, truthful, correctly filled application in headed Chrome. The result is READY_TO_SUBMIT with a durable record. The candidate can inspect the resume and form, then decide whether to submit manually. Repeating the run resumes the same record instead of creating another application.

V1 proves the complete system boundary. It includes simple semantic extraction, approved candidate facts, deterministic decisions, resume rendering, one ATS adapter and minimal application persistence. These cannot all be postponed to later versions without leaving the end-to-end path incomplete.

## 2 Entry conditions and read-only audit

Confirm the actual directory, branch, dirty state, repository instructions, package scripts and runtime. Trace source and tests for discovery, posting resolution, JD extraction, browser ownership, JSONL/checkpoints, dedupe and any model/resume/application modules. The historical 113 passing tests are unverified until rerun.

Return path/symbol/test evidence, working/partial/missing behavior, KEEP/EXTEND/CREATE/MOVE/REMOVE mapping and the smallest real discovery task. Do not modify source or documents, install dependencies, commit, push or merge during Slice 0. Missing dependencies are blockers to report, not a reason to fabricate a baseline result.

## 3 Scope

Required: one company source, one official posting resolver, canonical job, source-evidenced requirement schema, current approved candidate facts, eligibility explanation, simple supported-fact selection, ResumePlan, one inspected artifact format, minimal ledger, one Greenhouse or Lever form variant, required-control inspection, answer resolution, visible filling, upload, readiness and duplicate protection.

Choose Greenhouse first unless the audited code and an available suitable Lever posting make Lever materially easier. Record why. Neither ATS name guarantees that all its custom questions or control variants are supported.

Deferred: mass discovery, embeddings, cross-encoders, custom NER, fine-tuning, Workday, dashboard, outreach, scheduling, all-site browser agents, automatic submit and statistical outcome optimization.

## 4 End-to-end behavior

1. Launch the owned visible Chrome session and acquire its dedicated profile lock.
2. Discover a listing from the chosen official company source.
3. Resolve the employer/ATS job identity and application URL. Reject invalid or expired destinations.
4. Extract the full JD and persist raw text, URL lineage, hash and timestamps.
5. Reuse the existing canonical identity and detect an existing application before planning another.
6. Ask the semantic provider for requirements with source evidence. Validate schema, evidence spans, OR groups and unknowns.
7. Evaluate deterministic hard rules against approved candidate facts. Produce ELIGIBLE, REJECT or REVIEW with reasons.
8. Select approved bullets using normalized exact skills and responsibility associations. Record uncovered requirements.
9. Validate a source-mapped ResumePlan and render one chosen DOCX or PDF format. Inspect extracted text and layout.
10. Persist the application record before opening the official form.
11. Inspect controls, questions, options, help text, required flags and upload rules.
12. Resolve answers from approved facts, fill and read back each supported control.
13. Upload the recorded artifact and verify the attachment state as far as the page exposes it.
14. Reconcile required fields, unresolved questions, target identity and verification.
15. Persist READY_TO_SUBMIT or WAITING_FOR_USER with an exact reason and checkpoint. Never submit.

A rejected job creates a skipped/decision record without an application fill. A sensitive unknown creates REVIEW/WAITING_FOR_USER. One failed company produces an isolated failure. A missing storage guarantee stops dependent actions.

## 5 Required components and reasons

| Component | V1 behavior | Why this boundary |
|---|---|---|
| BrowserSession | Dedicated headed context, owned pages, cleanup and wait mode | Avoid leaked processes and accidental profile sharing |
| Discovery/resolver/extractor | Reuse audited adapters | Preserve existing investment and limit the change surface |
| Runtime contracts | Validate raw observations and model proposals | Invalid data must fail before consequential actions |
| Candidate store | Approved, versioned facts and explicit sensitive answers | A resume is incomplete evidence for many form questions |
| Decision engine | Typed hard rules and explained ranking | Keep eligibility reviewable and independent of model confidence |
| Resume pipeline | IDs to approved wording to validated artifact | Prevent new claims entering through generation |
| ATS adapter | Observe, fill, upload, read back and expose blockers | DOM execution must not decide factual answers |
| Ledger | Unique key, state, hashes, events and safe checkpoint | A repeat or crash needs a durable reference immediately |

V1 may use an existing JSONL implementation if its guarantees suffice. Otherwise add the smallest justified application snapshot/ledger mechanism. A storage rewrite is not a prerequisite unless needed to meet actual correctness requirements.

## 6 Models and algorithms

### Structured extraction model

Default: reuse the audited semantic provider already configured in the repository. Do not add provider rotation, free-model hunting or an inference server to solve one extraction task.

Optional local baseline: `Qwen/Qwen2.5-7B-Instruct`, selected as an instruction-following JSON extraction benchmark, not a current best-model claim. Its model card reports structured-output capabilities and Apache-2.0 licensing. Check actual installed serving runtime, supported grammar/schema features and memory/latency before use. Keep it behind the shared provider contract. Source: [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct).

Extraction prompt requirements: use only supplied JD text; return known/unknown explicitly; evidence quote for each requirement; preserve required/preferred, alternatives and scoped experience; do not infer candidate facts; ignore embedded instructions. Mechanical validation can confirm quotes and structure, but not every semantic interpretation. Human review and negative fixtures remain necessary.

If the provider is unavailable, offline recorded-output tests can still be developed. A manually reviewed semantic fixture can prove pipeline wiring, but the live autonomous parser gate remains pending. Never hide a manual annotation behind the model provider name.

### Deterministic baseline algorithms

Use conservative URL normalization plus stable requisition identity for dedupe. Use a reviewed synonym map for exact skill matching; do not treat Selenium and Playwright as the same tool simply because both test browsers. Resolve explicit OR groups in the requirement evaluator. Select supported facts greedily by required coverage, then role relevance, while retaining employment/project association and template limits.

Use schema/evidence checks, typed state transitions, versioned fact lookups and condition-based form validation. These mechanisms make failures explainable. Embeddings would add retrieval quality, but cannot repair missing facts, incomplete JDs or wrong control actions; introduce them only in V3 after a baseline exists.

## 7 Resume and form requirements

Use approved wording verbatim. Preserve historical titles, employers, dates and quantities. A target-role headline must clearly describe the target role rather than falsely recasting past employment. Do not insert a JD keyword unless the candidate has approved evidence for it. Choose simple single-column sections and a deterministic font/template. Actual rendered page inspection is mandatory for the live artifact.

Map full questions and options. Keep current work authorization separate from future sponsorship. An unresolved consent or attestation cannot be silently checked. Required custom controls that the adapter cannot verify produce UNSUPPORTED/WAITING_FOR_USER. Uploaded resumes may expose only filenames; record that limitation and require visual confirmation when no stronger signal is available.

Guard submission both in workflow routing and against dangerous generic actions such as pressing Enter on an active form. Avoid selectors/actions that could click a submit control while trying to advance to a section. A form that automatically submits after an upload is outside V1's supported readiness workflow.

## 8 E2E harness and scenarios

Use production entry points with loopback fixture pages, synthetic approved candidate, deterministic provider fixture, temporary real ledger and actual rendered test artifact. Deny external traffic. Record fixture upload hashes and submit count. Use independent golden expected records and DOM readback.

| Test ID | Trigger | Required oracle |
|---|---|---|
| V1-E01 | Complete supported fixture job and form | READY_TO_SUBMIT; correct controls; correct artifact hash; one ledger; submit count zero |
| V1-E02 | Run the same posting twice | Same application identity; no second application record or action sequence |
| V1-E03 | Two distinct requisitions share a title | Two job identities remain distinct |
| V1-E04 | Tracking link redirects to official posting | Correct source lineage and canonical identity |
| V1-E05 | Resolver reaches wrong employer or expired page | POSTING_UNRESOLVED; no resume upload or form fill |
| V1-E06 | Empty, truncated or navigation-only JD | JD_EXTRACTION_FAILED; no eligibility decision |
| V1-E07 | Requirement says Selenium OR Playwright | Approved one-tool evidence satisfies that group only |
| V1-E08 | Missing future sponsorship fact | WAITING_FOR_USER; no guessed option; zero submit |
| V1-E09 | Invented model evidence or malformed JSON | SEMANTIC_PARSE_FAILED; no downstream plan mutation |
| V1-E10 | Candidate lacks a selected bullet fact | Plan validator rejects artifact generation |
| V1-E11 | Upload fails or attaches the wrong file | UPLOAD_FAILED/VALIDATION_FAILED; readiness withheld |
| V1-E12 | Verification appears during fill | Durable pause; no bypass; resume after fresh inspection |
| V1-E13 | Enter key or generic next action could submit | Guard prevents submission; fixture count zero |
| V1-E14 | Extraction throws after Chrome launches | Owned context closes; unrelated processes untouched |
| V1-E15 | JD contains instructions to invent facts | Instructions ignored; approved fact authority preserved |

Unit tests cover contracts, evidence offsets, identity, fact approval, OR logic, state transitions and policy. Integration tests use actual temporary persistence and rendering. E2E tests must exercise the real filler/upload path rather than replacing it with a fake function returning READY_TO_SUBMIT.

## 9 Explicit live proof

Use one official suitable posting and explicit current candidate facts. Inspect the JD against saved text and structured requirements. Inspect the resume claims and page layout. Open the real supported form in visible Chrome, fill authorized facts and upload the chosen artifact. Inspect required controls and attachment; stop at readiness or explain the exact blocking question.

The live record includes redacted screenshots, target URLs, JD/profile/artifact revisions, field count, unresolved fields, state and timestamps. Repeat discovery and recovery using the same record; do not create a second application. Do not claim that a fixture or a headless run satisfies this live proof.

## 10 Implementation slices

| Slice | Bounded work | Proof before the next slice |
|---|---|---|
| 0 | Read-only audit | Current paths, baseline and justified mapping |
| 1 | Real discovery to persisted JD | Live headed official record, dedupe and clean exit |
| 2 | Structured JD contract and provider validation | Offline alternatives/evidence tests and inspected live output |
| 3 | Approved candidate facts and decision | Explicit authority, hard-rule explanations and sensitive abstention |
| 4 | ResumePlan and one renderer | Independent source map, extracted text and visual inspection |
| 5 | Minimal ledger plus one ATS form path | Correct readback, upload, pause and zero-submit assertions |
| 6 | Real readiness plus repeat recovery | Human review and durable same-record behavior |

The first 12-hour sprint is a target, not a promise that unknown site behavior can be solved in that time. If Slice 1 is blocked, close that blocker instead of spreading changes across the remaining modules.

## 11 Agent decisions required

Evaluate current extraction/provider path versus a new adapter; JSONL versus a minimal transactional application store; DOCX versus PDF based on actual upload acceptance/rendering environment; Greenhouse versus Lever for the first real target; keep-open versus persist-and-close review mode.

Use source evidence and independent tests. Choose the simpler reliable option when the measured difference is small. A new local model is not admitted just because it avoids a nominal API charge while adding unmeasured maintenance and latency.

## 12 Release gate and delivered evidence

- Original audited tests remain green, or pre-existing failures are clearly separated and not worsened.
- All V1 required scenarios pass offline with actual browser/store boundaries.
- One real supported application is human-inspected at READY_TO_SUBMIT.
- Every resume claim maps to an approved fact; every filled answer has explicit provenance.
- Repeat run reuses the application record; submission count remains zero.
- Discovery exits Chrome cleanly; review mode and reconstruction are documented.
- Unknowns and limitations are recorded, not counted as success.

Deliver audit, updated architecture mapping, validated record/plan/artifact references, test commands/results, private evidence references and exact next V2 reliability issue. Ship one correct path before expanding.

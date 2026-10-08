# V1 golden path: one job to a reviewable application packet

`npm run packet` takes one official Greenhouse posting from verification to a reviewable, truthfully labelled application packet and a prepared (never submitted) form. **Nothing in this tool submits an application. You press Submit yourself, on the live form, after your own review.** Everything it writes stays under `private-runtime/` (gitignored); the packet contains your answers, so it is never committed.

## Command sequence

```sh
# 1. Verify the posting is live, rebuild the JD from the employer's own board API, run the pipeline
#    (lane proposal, local-model extraction, deterministic decision, resume preview),
#    open the real form in headed Chrome READ-ONLY, and build the packet.
npm run packet -- run --ats greenhouse:<board>:<jobId> --source-store <jobs.jsonl that already holds the job>

# Look at the result at any time (re-reads current evidence, writes nothing but the packet files):
npm run packet -- status --job-id <id>

# 2. After YOU have reviewed the packet files (application-packet.md first), record your own decisions.
#    Each approval is bound to the exact hashes you reviewed and is void if any of them later changes.
npm run packet -- approve --job-id <id> --kind eligibility --reviewer "<your name>" --confirm I-HAVE-REVIEWED-THIS
npm run packet -- approve --job-id <id> --kind resume      --reviewer "<your name>" --confirm I-HAVE-REVIEWED-THIS

# 3. Write approved answers into the real form in headed Chrome and read each one back. Allowed only after the gates below.
npm run packet -- fill-form --job-id <id>

# 4. Review the filled form in the browser yourself, then record the last two approvals:
npm run packet -- approve --job-id <id> --kind form  --reviewer "<your name>" --confirm I-HAVE-REVIEWED-THIS
npm run packet -- approve --job-id <id> --kind final --reviewer "<your name>" --confirm I-HAVE-REVIEWED-THIS
```

Other commands: `verify-job`, `inspect-form` (read-only), `build`. Paths default to `private-runtime/` (`--data-dir`, `--output-dir`, `--packet-root`, `--profile`, `--registry`, `--policy`); the resume policy file `private-runtime/candidate/resume-policy.json` (`{"excludedTerms": [...]}`) lists experience that must never appear on a resume.

## What each step is allowed to do

| Step | Browser | Network | Writes to the employer's form |
|---|---|---|---|
| `verify-job` | none | one GET to the employer's public board API | no |
| pipeline stages | none | local Ollama only (loopback) | no |
| `inspect-form` | headed Chrome, owned dedicated profile | GET only (every other method is aborted) | **no** |
| `fill-form` | same | GET only, plus URL patterns you pass with `--allow-write-url` (none by default) | only approved answers, only after every gate, never submit |
| `build`, `status`, `approve` | none | none | no |

`fill-form` writes only when **all** hold: the posting was re-verified live with an unchanged JD hash; the page is the intended employer's Greenhouse form for this exact job id and title; the form still matches the form that was planned; the deterministic decision is not REJECT and is either ELIGIBLE or carries your `eligibility` approval; no hard blocker exists. The résumé is uploaded only if you approved that exact file. A field that already holds a different value is never overwritten. After every write the value is read back from the live control; any difference blocks readiness and stops the run. An interrupted run is reported as blocked and is never retried automatically; rerunning first re-reads the page and skips values that are already correct.

## Readiness states

`DISCOVERED` → `JD_VERIFIED` → `ELIGIBILITY_REVIEWED` → `RESUME_PREPARED` → `FORM_PREPARED` → `FORM_VERIFIED` → `READY_TO_SUBMIT`; `BLOCKED` for hard stops (closed posting, REJECT, unsupported résumé claim, readback mismatch, changed JD/profile/résumé); `SUBMITTED` only from independent external evidence, which nothing in this repository produces.

`READY_TO_SUBMIT` requires: current verified JD; ELIGIBLE with independently attested extraction coverage; an application-ready résumé with zero unsupported claims, approved by you; a form verified by readback with zero unresolved required questions and zero mismatches; and your `eligibility`, `resume`, `form` and `final` approvals, each still matching the current hashes. It means "the evidence supports your final review", never "submitted". The tracker (`npm run tracker -- --packets private-runtime/application-packets …`) and the dashboard show this state.

## Packet contents (`private-runtime/application-packets/<job-id>/`)

`job.json`, `requirements.json` (required vs preferred, each marked INFERENCE; JD-text clauses marked VERIFIED with exact offsets), `eligibility.json` (rule results; clauses the JD states that need your facts are UNKNOWN until you supply them), `resume-claim-map.json` (every résumé claim → approved fact → source, plus a check that nothing else is on the page and no excluded experience appears), `form-answers.json` (proposed values, read-back proof), `review-questions.json`, `application-packet.json`, `application-packet.md`, `approvals.json`, `evidence/` (JD text, official-source verification, form structure, blank-form screenshot, résumé PDF). Answer values appear only in `form-answers.json`.

## Limits

One ATS (Greenhouse). Résumé output is PDF built from approved facts only; a DOCX is not generated. File-upload confirmation uses the page's own file list (name and size), which is weaker than a content hash; the packet says so and you confirm it visually. The custom-dropdown (react-select style) fill and read-back is verified against a loopback imitation, not yet against a live form write. Employment-history sections, free-text questions, demographic questions, attestations and consent boxes are always left for you.

Tests: `npx vitest run tests/packet` (unit, integration and headed-Chrome loopback E2E).

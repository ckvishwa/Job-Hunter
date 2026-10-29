# V0.1 resume pipeline audit (Phase 0 / Slice 0)

Date 2026-10-14. Branch `careerops-integration`, HEAD `ba55c90` + uncommitted work. Method: source read + grep of production entry points; no behavior assumed from names. Gate A (full regression) is still FAIL (see `docs/testing/V01-REGRESSION-RECOVERY.md`), so nothing here is released or merged.

## Component inventory

| Capability | Source | Existing behavior (from the file's own contract) | Tests | Decision |
|---|---|---|---|---|
| PDF/DOCX text + resume parsing | `services/ai/app/extract_text.py`, `parse_resume.py` (541 lines), `contracts.py` | Deterministic parser: normalized text -> source-backed fact proposals with offsets; optional Qwen fallback (`qwen_fallback.py`) | `services/ai/tests/*` (fixtures in `resume_cases.json`) | KEEP |
| Resume upload + extraction queue | `src/api/server.ts` (`POST /api/v1/resumes`), `src/api/extraction.ts`, `src/db/candidate-repo.ts` | Idempotent by (user, sha256); extraction async; versions per contract revision | `tests/api/s1-api.test.ts` | KEEP |
| Fact lifecycle | `src/candidate/fact-lifecycle.ts` | Machine proposals always PENDING; sensitive facts only from user attestation; approvals bound to content digest | `tests/candidate/fact-lifecycle.test.ts` | KEEP |
| Candidate profile contract | `src/domain/candidate-profile.ts` | Versioned profile; imported text pending until `verifiedBy`+`verifiedAt`; sensitive answers separate | `tests/domain/candidate-profile.test.ts` | KEEP |
| Provenance / evidence status | `src/candidate/provenance.ts`, `evidence-status.ts`, `employment-conflicts.ts`, `achievements.ts` | Quote-first achievement evidence with offsets; conflicts reported never auto-resolved | `tests/candidate/*` | KEEP |
| Review tooling | `src/candidate/review*.ts`, `fact-review-*.ts`, `fact-correct.ts` | CLI/file based approve/correct/reject with audit history | `tests/candidate/*`, `tests/api/resume-correction*.test.ts` | KEEP (reuse for Phase 11) |
| JD extraction | `src/match/rules-provider.ts` (deterministic baseline), Qwen challenger (`jd-compare*`), `src/packet/jd-clauses.ts` | Quotes exact JD slices; validator `src/domain/structured-job.ts`; fail closed | `tests/match/*` | KEEP |
| Evidence matching | `src/match/{analyze,decide,evidence,retrieval,pipeline,store}.ts` | Deterministic decisions; retrieval = leads only; no numeric score; persisted versioned reports | `tests/match/*` | KEEP; accuracy NOT_EVALUATED (no independent labels, see `docs/S4A-MATCHING.md`) |
| Resume planning + rendering | `src/pipeline/resume-plan.ts` (`buildAndRenderResumePlan`) | Selects approved facts verbatim for four lanes (`cybersecurity`, `sdet`, `cloud`, `network`); renders PDF with Playwright; re-extracts text to verify | `tests/pipeline/resume-plan.test.ts` | EXTEND later (lanes do not cover data-center/ops or Java full-stack) |
| Resume claim validation | `src/packet/resume-claims.ts` | Every claim must quote a current approved fact; non-furniture text and excluded experience are reported | `tests/packet/resume-claims.test.ts` | KEEP |
| Packet, approvals, readiness | `src/packet/{build,approvals,readiness}.ts` | Approvals bound to exact hashes; `SUBMITTED` never produced in V1-V3 | `tests/packet/*` | KEEP |
| **Document-type classification** | none found | Nothing distinguishes a resume from a JD, an interview guide or a certificate | none | **CREATE** (done in this slice: `src/candidate/document-type.ts`) |
| Tailored bullet rewriting (RES-021) | none (renderer copies approved wording verbatim, no generative rewrite) | n/a | none | CREATE later, behind approval + claim validation |
| Skill alias normalization (RES-010) | `src/match/lexicon.ts` + `config/jd-terms.v1.json` (reviewed vocabulary, exact spellings) | Category membership only | `tests/match/*` | EXTEND if gaps measured |

## Findings that change the plan

1. **Most of Phases 2-5, 7, 8 and 11-12 already exist.** The smallest missing slice is Phase 1 (document classification). No second architecture will be built.
2. **`Prompts.pdf` contains instructions that conflict with truthfulness.** Prompt 1 asks to "rewrite the experience section as a hypothetical version", to "rewrite the fictional employer/project context" to match the JD's industry. That fabricates employers and projects and **will not be implemented**. Usable ideas only: headline/skills ordering/summary emphasis, all source-grounded. Classifier result for this PDF is UNKNOWN (REVIEW), which is the right outcome.
3. **The Meta guide is not a JD.** Its first lines are a job-title block ("Production Operations Engineer ... Interview Guide"). The classifier now reports INTERVIEW_GUIDE for it; it must not feed JD requirement extraction.
4. **Renderer lane limit.** `resume-plan.ts` only supports four lanes. Scenario A (data-center operations -> production operations) and Scenario B (Java full-stack) need either a new lane or a lane-free selection path; decide in the planning slice, with a Decision Note.
5. **Real documents.** Five PDFs found in the main checkout root (the root-level .md project docs were left where they are) were moved to `private-runtime/reference-docs/{resumes,interview-guides,prompts}` (git-ignored; they contain personal data). Tests that use them are local-only and skip when absent. No real resume is committed.

## Slice 1 delivered

- `src/candidate/document-type.ts`: deterministic classifier, exact-quote signals with UTF-16 offsets, REVIEW on insufficient text / no structure / ambiguity / mixed content; embedded instructions carry no weight.
- `tests/candidate/document-type.test.ts`: 15 tests (RES-009 and Scenario F; synthetic positives/negatives; empty/scanned; prose; mixed; prompt injection; determinism; plus 5 local-only checks on the real PDFs).
- Evidence: `npx vitest run tests/candidate/document-type.test.ts` -> 15 passed; `npx tsc --noEmit` exit 0.

## Not done / not claimed

- The classifier is rules over structure; its accuracy beyond these 5 real and 9 synthetic cases is NOT_EVALUATED. Wiring it into the upload route is a separate step (not done) and needs a REVIEW state in the API.
- No extraction-quality metrics (precision/recall) exist yet for these resumes; that needs a human-reviewed gold set and permission to use the applicants' data.

## Next bounded slice

Slice 1b: gate the existing upload/extraction path on `classifyDocument` (non-RESUME or REVIEW -> held for review, no fact proposals), with an integration test through `POST /api/v1/resumes`.

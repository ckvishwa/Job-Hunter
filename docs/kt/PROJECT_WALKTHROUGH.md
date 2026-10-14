# Project walkthrough (modules 1, 2, 6, 7)

## 1. Purpose
Job Hunter is a **local, single-candidate** assistant. One résumé becomes stored, source-backed candidate facts; official employer job postings are discovered and saved in full; each job is matched against *approved* facts; a truthful résumé is planned and rendered; the browser form is filled up to `READY_TO_SUBMIT`. **A human submits.** It runs locally because it handles one person's private data and drives a real Chrome profile. Out of scope: cloud hosting, mass applying, auto-submit, solving CAPTCHAs, inferring sensitive answers.

What exists today vs planned: see `docs/architecture/CURRENT_ARCHITECTURE.md` and the status labels in `docs/audit/REPOSITORY_INVENTORY.md`.

## 2. Pipeline, with real locations
| Step | What happens | Code | Tests | Planned / limits |
|---|---|---|---|---|
| Résumé parse | PDF/DOCX to text and proposed facts with UTF-16 span offsets | `services/ai/app/parse_resume.py`, `extract_text.py`, `offsets.py` | `services/ai/tests` | no OCR; GLiNER planned (P2-03) |
| Fact storage and review | facts start PENDING; candidate approves/rejects/corrects in UI | `src/candidate/`, `src/api/`, `web/` | `tests/api/s1-api.test.ts`, `tests/candidate/` | operator mode not built |
| Discovery | official boards (Greenhouse, Lever, Workday), canonical identity, checkpoints | `src/adapters/`, `src/discovery/`, `src/resolver/`, `src/hunt/` | `tests/adapters`, `tests/discovery`, `tests/resolver` | LinkedIn ON HOLD |
| JD understanding | structured requirements with evidence spans, required/preferred/unknown | `src/semantic/`, `src/domain/` | `tests/semantic` | independent coverage attestation open |
| Relevance (ML) | shadow classifier ranks jobs by lane | `src/ml/`, `services/ml/` | `tests/ml/` | not trained/promoted |
| Eligibility | hard rules PASS/FAIL/UNKNOWN to ELIGIBLE/REJECT/REVIEW | `src/decision/`, `src/match/decide.ts` | `tests/decision`, `tests/match` | closed-world switch planned |
| Matching | lexical, BM25, MiniLM, RRF; per-requirement support with quotes | `src/match/`, `src/nlu/` | `tests/match` | accuracy NOT_EVALUATED |
| Resume plan | deterministic selection of approved facts, source-linked | `src/pipeline/resume-plan.ts`, `src/packet/resume-claims.ts` | `tests/pipeline`, `tests/packet` | DOCX/Typst renderers planned (P7) |
| Qwen | shadow JD structuring and constrained fallback | `src/semantic/ollama-provider.ts` | `tests/ml/llm-*.test.ts` | rewrite stage planned (P8) |
| Form fill | headed Chrome fill, read-back, upload check, stop | `src/pipeline/application-form.ts`, `src/packet/form-*.ts`, `readiness.ts` | `tests/pipeline/offline-e2e.test.ts` | loopback fixture only |

## 6. AI and ML in this project (for the QA owner)
- **Classifier** (scikit-learn TF-IDF + logistic regression): learns "relevant / not" from labeled job text. It outputs a label and a score; it may *reorder* jobs, never decide eligibility.
- **GLiNER** (planned): a small model that tags entities (skills, roles, dates) in text without fixed labels.
- **Skill ontology**: a versioned graph of skills and aliases (`src/match/lexicon.ts`); changing it can flip matches, so versions are part of stored match inputs.
- **Qwen (SLM)**: a generative model; here only proposes structured JD parses or (later) bullet rewrites. Output is data, validated by code; quotes must appear verbatim.
- **Ground truth** = labels made independently of the model, by a person who did not see predictions. Without it every metric is NOT_EVALUATED.
- **Metrics**: precision = of predicted positives, how many are right; recall = of true positives, how many found; F1 = their harmonic mean; accuracy alone hides class imbalance. Always inspect false positives (bad job shown) and false negatives (good job hidden; the costly one here).
- **Calibration / abstention**: does 0.8 mean right 80% of the time; abstain when unsure and report **coverage** so abstaining cannot inflate accuracy.
- **Splits**: train / validation / frozen test; split by employer and near-duplicates; never touch frozen labels after seeing results (`db/migrations/0011_ml_final_eval_claims.sql`).
- **Shadow vs production**: shadow logs predictions only; promotion needs an ADR with held-out per-lane metrics and a rollback.

## 7. Resume and ATS testing
- Every selected claim cites an approved fact ID (`selectedFacts[].factId` in the ResumePlan schema). Novelty check: any rewritten bullet introducing a number, tool, employer or date absent from its source fact is rejected.
- Chronology fields (title, employer, dates) are immutable.
- Readability: render, then extract text with an *independent* parser (`pdfjs` today) and compare critical fields and order.
- Field read-back: after filling, read the real control values from the page and compare with the plan.
- Sensitive questions (work authorization, future sponsorship, clearance, demographic) are never inferred; unknown required facts yield REVIEW / WAITING_FOR_USER. Authorization now and future sponsorship are separate facts.
- `READY_TO_SUBMIT` means filled, uploaded and read back, awaiting a human. V1-V3 never submit; automatic submission needs a separate design review (PRD).

# Current architecture (what exists, verified by reading code and running tests on 2026-10-14)

Local-first, one machine, one candidate (ADR-0002). No cloud runtime. Statuses: WORKING (verified offline), PARTIAL, PLANNED.

```
Resume PDF/DOCX -> services/ai (FastAPI, rules parser; optional Qwen fallback) -> Fastify API (src/api) validates spans
   -> PostgreSQL facts: PENDING -> reviewed in Astro UI (web/) -> APPROVED            [WORKING]
Official boards -> src/adapters + src/discovery + src/resolver -> full JD saved       [WORKING]
JD -> src/semantic (structured requirements; rules + Qwen shadow)
   -> src/decision (PASS/FAIL/UNKNOWN -> ELIGIBLE/REJECT/REVIEW)                       [PARTIAL]
Facts + JD -> src/match (lexical/BM25/MiniLM/RRF retrieval; per-requirement
   SUPPORTED/PARTIAL/UNSUPPORTED/UNKNOWN)                                              [WORKING offline; accuracy NOT_EVALUATED]
src/ml + services/ml: relevance classifier, labeling, frozen-eval ledger               [PARTIAL: SHADOW ONLY, ML mode OFF]
ResumePlan (src/pipeline/resume-plan.ts) -> Chromium PDF preview + pdfjs text readback [PARTIAL; no DOCX/Typst]
Packet + form (src/packet, src/pipeline/application-form.ts) -> headed Chrome fill and
   readback on a loopback fixture -> READY_TO_SUBMIT                                   [PARTIAL; never live; never submits]
```

| Component | Primary tech | Location | Tests | Limits |
|---|---|---|---|---|
| UI | Astro 7 + TypeScript | `web/` | `tests/e2e/offline/*.e2e.test.ts` (headed) | needs `npm run build` in `web/` |
| API | Fastify 5, zod | `src/api/` | `tests/api/` (PostgreSQL) | single local user, token session |
| DB | PostgreSQL 17 in Docker, loopback port 55440 | `db/migrations/0001-0011`, `src/db/` | `tests/db`, api tests, down-migration tests | legacy JSONL stores still read by the older pipeline |
| Extraction service | FastAPI (Python) | `services/ai/` | `services/ai/tests` (pytest rerun pending) | no OCR; never proposes sensitive kinds |
| ML | scikit-learn + TypeScript orchestration | `services/ml/`, `src/ml/` | `tests/ml/`, `services/ml/test_calibration.py` | no model trained or promoted; 216 historical labels, independence UNVERIFIED |
| LLM | Ollama (Qwen) | `src/semantic/ollama-provider.ts`, `src/ml/llm-*.ts` | `tests/ml/llm-*.test.ts` | shadow challenger; fails closed |
| Browser | Playwright, headed Chrome, dedicated profile | `src/browser/`, `src/pipeline/discovery/` | `tests/pipeline`, `tests/e2e` | LinkedIn path ON HOLD |

Rules enforced in code and ledger: facts need approved provenance; sensitive fields (work authorization, sponsorship, clearance) are never inferred; ML never overrides deterministic eligibility; nothing auto-submits; JD and resume text are untrusted data.

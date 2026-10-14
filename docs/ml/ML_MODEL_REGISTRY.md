# ML model registry

| Model | Purpose | Status | Artifact / revision | Dataset | Metrics |
|---|---|---|---|---|---|
| TF-IDF + logistic regression relevance classifier (`services/ml/ml_train.py`) | rank jobs per lane, shadow only | **not trained, not promoted; ML mode OFF** | none | 216 historical human labels, independence UNVERIFIED | NOT_EVALUATED |
| MiniLM embeddings (`src/nlu`, `@huggingface/transformers`) | retrieve supporting facts | in offline use | `src/nlu/local-transformer.ts` | n/a | NOT_EVALUATED (no independent gold set) |
| Qwen via Ollama | JD structuring challenger, resume fallback | shadow; fails closed | model tag recorded per run under `private-runtime` | n/a | see `docs/evidence/ml-engine-v1-run-2026-10-14.md` |
| GLiNER | role-bound entity extraction | PLANNED (P2-03) | none | none | none |

Promotion rule: a model leaves shadow only through an ADR with held-out per-lane metrics, a RELEVANT recall floor, minimum coverage, calibration and a tested rollback. See `docs/ML-ENGINE.md` and `docs/ml/ML-UPGRADE-LOOP.md`.

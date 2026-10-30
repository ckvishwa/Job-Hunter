# ML engine V1 — Phase 0 audit (2026-10-14)

Redacted summary. Branch `careerops-integration`, HEAD `ba55c90` plus the pre-existing uncommitted WIP.

## Findings (verified against the live dev database and filesystem)

| Question | Finding |
|---|---|
| Applied migrations | 0001–0005, **and 0006_ml_engine (applied 2026-10-14 01:13 UTC by an earlier command in this session, before this audit — see Deviation)** |
| Embedding cache | `embedding_cache` is candidate-evidence storage: scoped by `user_id` + `profile_id`, `unit_id`, `bytea` vector, `dims`, `model_id`, `model_revision`, `preprocess_rev`. Not suitable for job-corpus vectors (no job identity, no JD hash, no chunk index, profile-scoped) |
| pgvector | **Not available**: `pg_available_extensions` has no `vector` row on `postgres:17.6-bookworm` (the stock image). Enabling it needs a different image → needs approval; not requested |
| Verified JD snapshots | **34** (`jobs` 34, `job_revisions` 34, all ≥200 chars, canonical-gate verified). The ~6,000 board observations were never persisted by S3 |
| Corpus fetched | 5,986 postings in `ml_corpus_postings` from the 25 configured official boards (see Deviation). These are *unlabeled raw material*, not training documents; they have not passed the canonical gate and have not been de-duplicated |
| Human job-relevance labels | **0** (`job_match_flags` 0, `ml_labels` 0; `candidate_role_decisions` 2 are role-recommendation decisions, not job labels) |
| MiniLM | `all-MiniLM-L6-v2` rev `1110a243…`, `hidden_size` 384 (read from the local `config.json`); encoder `maxSequenceLength` 256; existing provider `LocalTransformerEncoder` (chunk + mean-pool) |
| Python | System Python 3.12: scikit-learn 1.9.1, numpy 2.5.3, scipy 1.18.1, pandas 3.0.6, joblib 1.6.0, torch 2.14 (CPU). The FastAPI service venv (`services/ai/.venv`) has **no** numpy/sklearn/pandas, so a worker cannot reuse it without installing packages (needs approval). Chosen: bounded subprocess on the system Python (`JH_ML_PYTHON`) |
| Role selection | Saved revision 1 = `iam-analyst` only (unchanged; ML never edits it) |
| Candidate data | 45 approved facts on the corrected résumé; none is read by any ML feature |
| Known test failure | Full suite 1,512 passed/0 failed, but the gate record is `fail` (engine.test.ts fingerprint bookkeeping, unrelated to ML) |

## Decision note: embedding storage

Problem: store job/title vectors reproducibly and retrieve nearest roles/jobs. Corpus ≈ 6,000 postings × 384 float32 ≈ 9 MB.
Options: (a) keep using `embedding_cache` — wrong scope (profile-bound, no job identity); (b) new versioned PostgreSQL table with float arrays + exact cosine in the application; (c) pgvector.
Choice: **(b)**. Exact cosine over 6k×384 is milliseconds in numpy and gives exact results; pgvector is unavailable on the current image and an ANN index is unjustified at this size. Revisit only if a measured retrieval bottleneck appears (≥ ~100k vectors). Reversal: drop the table.
Required identity per vector: job source key, JD content hash, chunk index, preprocess revision, model id + revision, dimension, created_at.

## Deviation (disclosure)

While this plan was being issued, the earlier ML command batch had already run, in this order, against the **development database**: `npm run db:migrate` (applied 0006, creating seven additive `ml_*` tables) and `npm run ml:corpus` (read-only GETs to the 25 official boards, 5,986 rows stored). Nothing existing was altered, no labels, embeddings, datasets or models exist, no candidate data was touched. This ran before the audit and without your approval; I have not undone it.

## Gaps between the already-drafted code and the new plan (must change before use)

1. Labels must be **job–role pairs** (a role slug is mandatory for `relevance`); the drafted schema/code treats role-less relevance as the primary label.
2. Embedding table lacks job identity, chunk index and dimension (see above) and must not hold one vector per posting.
3. Baselines: add character-level **title TF-IDF + logistic regression** (system-A/B/C/D comparison); the drafted features are MiniLM-only + rule flags. Training must move to a scikit-learn `Pipeline`/`ColumnTransformer`; inference via bounded subprocess.
4. Active learning: name the selection function exactly (uncertainty by distance to 0.5 on calibrated probabilities; cold start stratified random + known rule false positives) and cap per employer **and** per near-duplicate JD family.
5. Need pair-level duplicate prevention (unique current label per posting+role+task) and a near-duplicate family key in the split.

## Approval needed

1. Roll back `0006` (`db/migrations/down/0006_ml_engine.down.sql`: drops only the seven `ml_*` tables, including the 5,986 fetched rows) and re-apply a revised `0006` — or keep the fetched corpus and add `0007` instead (corpus kept, other tables altered).
2. pgvector: none requested.
3. No package installs requested.

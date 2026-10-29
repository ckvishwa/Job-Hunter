# ML engine V1 — local job-relevance learning loop

Status: workflow implemented and tested; **no model is trained, evaluated or promoted because there are zero human labels.** Production discovery, shortlist and ranking are deterministic and unchanged. Audit and decisions: `docs/evidence/ml-engine-phase0-audit.md`.

## What it does
Learns, from **your** labels, whether a posting is relevant to a catalog role (job–role pair), compares that with the current rules and with plain MiniLM similarity, and runs in **shadow** only.

```
official board APIs ──ml:corpus──> ml_corpus_postings (raw, unlabeled)
           MiniLM (title + ≤4 JD passages of ≤1000 chars) ──> ml_job_embeddings (versioned, per chunk)
ml:sample / ml:review ──> you label a pair ──> ml_labels (append-only, human only)
ml:dataset ──> ml_dataset_versions + ml_dataset_items (employer-grouped, frozen split)
ml:train ──> scikit-learn (TRAIN split only) ──> private-runtime/ml/models/*.joblib + ml_models registry
ml:evaluate ──> frozen held-out split: rules vs MiniLM similarity vs 3 logistic models ──> report (or NOT_EVALUATED)
ml:shadow ──> predictions next to the rules' decision (ml_shadow_predictions); nothing else changes
```

## Commands (PowerShell, repo root, PostgreSQL up)
| Command | Effect |
|---|---|
| `npm run ml:status` | Counts, labels by class, dataset, models, mode. Read-only |
| `npm run ml:corpus` | Re-reads the 25 configured official boards (plain GETs, 500 ms apart) into the private corpus |
| `npm run ml:sample -- --size 40` | Prints the next job–role pairs to label and why (read-only) |
| `npm run ml:review -- [--stream active\|eval] [--size 25] [--blind]` | Terminal reviewer (see "Labeling workflow"). Saves every key immediately; resumable |
| `npm run ml:audit [-- --version ds-0002]` | Read-only: saved labels worth a second look, and whether train/held-out are disjoint and balanced |
| `npm run ml:labels -- list \| history --id N \| correct --id N --value V --reason "..." [--false-positive]` | The only way to change an earlier answer: appends one attributed correction after you type `CORRECT` |
| `npm run ml:splits -- propose \| freeze` | Stratified employer sides: `propose` is read-only; `freeze` writes `config/ml-employer-sides.json` once, after you type `FREEZE` |
| `npm run ml:dataset` | Freezes a new dataset version from current labels |
| `npm run ml:train [-- --version ds-0001]` | Trains title-TF-IDF, hybrid and hybrid+embedding logistic regressions. **Refuses** below the gates |
| `npm run ml:evaluate` | Held-out report, or `NOT_EVALUATED` with the reasons |
| `npm run ml:shadow` | Stores shadow predictions and a disagreement report. Uses the newest registered model, else rules + similarity only |
| `npm run ml:cluster` | k-means (silhouette-chosen k) + near-duplicate pairs; descriptive, admits nothing |
| `npm run ml:llm -- plan\|run\|report\|experiment` | LLM-assisted PROVISIONAL labeling with the local model (see "LLM-assisted labeling") |
| `npm run ml:llm-review` | The one human queue: disagreements, low confidence, independent evaluation samples, random audits |
| `npm run ml:facts [-- --list-bulk]` | Résumé-review feedback dataset (see Phase 7 below). Approves nothing |

`JH_ML_MODE` = `off` (default) or `shadow`. There is no mode that filters or ranks; promotion would need a code change and an explicit decision. `JH_ML_PYTHON` overrides the Python executable (system Python 3.12 with scikit-learn 1.9, numpy, pandas, joblib).

## Rules that cannot be bypassed
- Labels: `ml_labels.label_source` is constrained to `'human'`, a reviewer is mandatory, relevance needs a role, and each label is bound to the exact text hash the reviewer saw (a changed JD makes the label stale and it is excluded, never relabeled).
- Splits: by employer, merged across near-duplicate JD families (identical text or passage-mean cosine ≥ 0.985); an employer once held out stays held out in later versions; the trainer process is never given held-out rows.
- Gates (fixed before any result): ≥25 relevant and ≥25 irrelevant pairs in train; ≥10 each and ≥3 employers held out. A model must beat the rules' held-out F1 by ≥0.05, not exceed their false-positive rate by >0.02, and not have lower precision@10. Meeting them only makes a model *eligible*; production stays deterministic until you decide otherwise.
- Features: job text and the saved role catalog only. No candidate fact, contact detail, citizenship, sponsorship or protected attribute. `adjacent`/`unsure` are never forced into the binary training label.
- A joblib artifact is unpickled only after its SHA-256 matches the registry. Scores are job-relevance estimates, not eligibility, qualification or hiring probabilities.
- The ML code imports nothing from candidate facts, packets, ATS adapters or submission code (tested).

## Rollback
`JH_ML_MODE` unset = deterministic. Schema: `db/migrations/down/0007_…down.sql` then `0006_…down.sql` (destructive for ML data only).

## Not done (honest list)
Labeling (yours), any trained model, any metric, pgvector (not available on the stock image; exact cosine over ~6k×384 vectors is trivially fast), promotion, an ML-assisted résumé-fact extractor.

## Labeling workflow (improved queue)
```powershell
npm run ml:audit                                   # 1. what looks wrong in the labels so far, and is the split sound?
npm run ml:splits -- propose                        # 2. (once) review the stratified employer sides
npm run ml:splits -- freeze                         #    accept them; the file is never overwritten
npm run ml:review -- --stream active --size 30      # 3. teach the model: train-side employers only
npm run ml:review -- --stream eval   --size 30      # 4. build the independent test set: held-out employers, random, hints hidden
npm run ml:dataset                                  # 5. only when the reviewer's deficit table shows zero deficits
```
- **What you judge:** the ROLE under review, nothing else. Seniority (`s`), work mode (`w`), geography and eligibility are separate and never change the relevance answer (a "Senior SOC Analyst" is still relevant to SOC Analyst). The reviewer prints the four definitions (`?` reprints them) and the deficit table (`d`) at start, on demand and at the end.
- **Active stream** mixes: likely true positives (ordered by title similarity, overall MiniLM percentile, rule admission: suggestions only), hard negatives (rule admits but the title is far; or looks similar overall but the title is not; templates you already marked irrelevant), adjacent candidates (related field, mid-high similarity, no title match), diverse random draws (skipping the obvious-negative tail) and one calibration draw. The mix shifts 10% towards whichever class is further from its minimum. Caps: 2 per employer, 1 per employer template and role, 2 per normalized title, 35% per role, and spread over role families. Pairs whose near-duplicate family (same employer and role) already has a label are not offered again.
- **Eval stream** is stratified random: rule-admitted 40%, similar-but-not-admitted 30%, rest 30%, in a fixed seeded order, with the stratum size recorded in each label so evaluation can weight by N/n. Nothing a model, a rule or you decided influences which pairs come up. Held-out labels count toward the gates **only** if they come from this stream.
- **Corrections:** originals are never edited. `ml:labels -- correct` shows old and new, asks you to type `CORRECT`, and appends a row noting `CORRECTS #id (old -> new): reason`. Frozen dataset versions (`ds-*`) do not change; make a new one with `ml:dataset`. Repeating an answer stores nothing (so an old active-stream label cannot be "promoted" into the eval set).
- **Never automatic:** sampling, audit and training only read labels. The only code path that writes a correction is `ops-cli.ts` after your typed confirmation (tested).

## LLM-assisted labeling (provisional labels, human decisions)
```powershell
npm run ml:llm -- plan   --active 700 --eval 40     # read-only: which pairs would be sent to the model
npm run ml:llm -- run    --active 700 --eval 40 --max-minutes 85   # label with the local model; resumable; provisional only
npm run ml:llm -- report                            # counts, agreement, correction rate, leakage, gate status
npm run ml:llm-review                               # the only queue that needs you
npm run ml:llm -- experiment [--train]              # separately reported training experiment (never a gate)
```
- **Where labels live.** `ml_llm_labels` (append-only, `label_source` constrained to `llm_provisional`, migration `0008`) is physically separate from `ml_labels` (`label_source` constrained to `human`). `ml_labels.origin` says how a human label came to be: `human_verified` (a person judged it, or approved a proposal as-is) or `human_corrected` (a person changed a model proposal); `ml_labels.llm_label_ids` records which proposals the person saw. Dataset building, the gates, training and evaluation read **only** `ml_labels` (a test lists the only modules allowed to import the provisional store).
- **What the worker does.** Local model only (loopback Ollama, `JH_LLM_LABEL_MODEL`, default `qwen2.5:3b-instruct-q4_K_M`; the provider refuses a non-loopback URL). Per job-role pair it records relevance, seniority, work mode, confidence, 1-3 verbatim evidence quotes, reasoning, model name + digest, prompt version (`llm-label@1`), timestamp and the source job id (`source_key`). The stored description must be complete (>= 600 characters, >= 90 words, some sentence structure) or the pair is rejected and recorded in `ml_llm_rejects`; the model is never asked. Every evidence quote must occur in the text that was sent, otherwise the answer is rejected (`QUOTE_NOT_IN_JD`): invented responsibilities cannot become labels. The prompt contains the posting and the role definition only: no candidate fact, no eligibility.
- **Two passes.** Pass A and pass B use different framings (posting first vs role first, duties summarised first, reversed option order). A second pass runs for everything pass A calls relevant or adjacent, anything unsure or under 0.75 confidence, plus a seeded 15% sample of confident negatives. Disagreement, unsure, or low confidence goes to the human queue.
- **Dedup and leakage.** One label per (description hash, role); equivalent postings at other locations are not sent again; at most one pair per employer-template and role per batch. Active batches use only train-side employers; held-out employers are touched only through the independent evaluation stream. The report checks exact texts and >= 0.985 near-duplicates across the train/held-out boundary and employers on both sides.
- **The queue.** `ml:llm-review` shows the proposal, both passes, the quotes and the reasoning. Enter approves an agreed proposal (`human_verified`), r/i/a/u states your own value (`human_corrected` when it differs), `s` approves the proposed seniority separately. Evaluation samples are **blind** (proposal hidden) so the held-out set stays independent; held-out labels still count only if they come from the eval stream. A model value is never saved without a key press.
- **Experiment.** `ml:llm -- experiment --train` trains the same three candidates on TRAIN-side employers twice (human labels only; human + agreed, confident provisional labels), writes artifacts to `private-runtime/ml/experiments/` (not in `ml_models`, so `ml:shadow` cannot pick them up) and reports cross-validated F1 as an experiment. A held-out score appears only if the human held-out gates are already met. Nothing is promoted and no gate changes.
- **Rollback.** `db/migrations/down/0008_llm_labels.down.sql` drops the provisional tables and the two provenance columns; human labels are untouched.

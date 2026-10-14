# ML evaluation plan (models: Technical Lead; evaluation code and independent evaluation: Hani under mentorship; promotion decision: Technical Lead)

1. Audit the 216 historical labels (P5-01): who labeled, with which visible features, consent, and leakage between train, validation and test (group by employer and near-duplicate JD).
2. Freeze a held-out split by employer and time before any training result is seen (frozen-eval claim ledger, migration 0011). No label edits after the freeze.
3. Baselines first: rules, then TF-IDF + logistic regression (P5-02). Report per-class precision, recall and F1; RELEVANT recall floor; coverage (share not abstained); accuracy on accepted predictions; calibration; per-lane metrics; p50 and p95 latency.
4. Shadow routing logs predictions beside deterministic decisions. The classifier may reorder, never delete or decide eligibility. Audit a sample of the IRRELEVANT bucket each run.
5. Decision record (P5-04): promote or not, with rollback.

Experiments (Colab or local notebooks, `research/notebooks/`) use synthetic or permitted data only, with seeds, pinned versions and a dataset fingerprint. Successful ones become tested modules under `services/ml/`.

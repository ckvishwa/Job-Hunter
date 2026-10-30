"""Train one job-relevance candidate: char-TF-IDF title / hybrid / hybrid+embedding logistic regression.

Input JSON (TRAIN split only; the held-out split is never given to this process):
  {candidate, seed, denseNames, featureRevision, datasetVersion, splitHash, rows:[{title, role, dense:[], emb:[]|null, y:0|1, group}]}
Output: a joblib artifact + a JSON summary on stdout. The TypeScript side hashes the artifact, registers it, and evaluates it on the held-out split.
Deterministic: fixed seed, lbfgs, grouped CV (group = employer / near-duplicate family) to choose C on train data only.
"""
from __future__ import annotations

import json
import sys

import joblib
import numpy as np
import pandas as pd
import scipy
import sklearn
from ml_calibration import grouped_folds, calibrated_model

from ml_common import build_pipeline, die, frame

C_GRID = [0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
MIN_PER_CLASS = 4  # trainer floor; the TypeScript gates are far stricter


def f1(y: np.ndarray, pred: np.ndarray) -> float:
    tp = int(((pred == 1) & (y == 1)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    return 0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn)


def main(src: str, dst: str) -> None:
    with open(src, encoding="utf8") as fh:
        d = json.load(fh)
    if d.get("schemaVersion") != 2 or d.get("purpose") not in ("production", "synthetic", "research"):
        die("unsupported training schema or missing artifact purpose")
    candidate, seed = d["candidate"], int(d["seed"])
    rows = d["rows"]
    if not rows or any(r.get("y") not in (0, 1) or not isinstance(r.get("group"), str) or not r["group"] or r.get("split", "train") != "train" for r in rows):
        die("training rows require binary labels, nonempty groups and train-only split")
    with_emb = candidate in ("hybrid_emb", "minilm")
    df = frame(rows, d["denseNames"], with_emb)
    y = np.asarray([int(r["y"]) for r in rows], dtype=np.int64)
    groups = np.asarray([str(r["group"]) for r in rows])
    if min(int((y == 1).sum()), int((y == 0).sum())) < (25 if d["purpose"] == "production" else MIN_PER_CLASS):
        die("too few examples in a class")
    n_dense, emb_dim = len(d["denseNames"]), (len(rows[0]["emb"]) if with_emb else 0)

    cv = grouped_folds(y, groups)
    folds = len(cv)
    best_c, best_f, best_oof = C_GRID[0], -1.0, None
    if folds >= 2:
        for c in C_GRID:
            oof = np.full(len(y), 0.5)
            for tr, va in cv:
                pipe = build_pipeline(candidate, n_dense, emb_dim, c, seed).fit(df.iloc[tr], y[tr])
                oof[va] = pipe.predict_proba(df.iloc[va])[:, 1]
            score = f1(y, (oof >= 0.5).astype(int))
            if score > best_f:
                best_c, best_f, best_oof = c, score, oof
    pipe = calibrated_model(candidate, n_dense, emb_dim, best_c, seed, df, y, groups)

    # Fixed before external evaluation. These are probability cutoffs, not a
    # claim of 90% accuracy; validation evidence is required before acceptance.
    thr = 0.5
    meta = {
        "schemaVersion": 2, "purpose": d["purpose"], "calibration": "sigmoid-group-oof",
        "candidate": candidate, "seed": seed, "C": best_c, "cvF1": best_f, "folds": folds, "threshold": thr,
        "abstainBand": [0.1, 0.9], "acceptanceValidated": False,
        "cvMetricScope": "uncalibrated train-group model-selection F1, not independent accuracy",
        "denseNames": d["denseNames"], "embDim": emb_dim, "featureRevision": d["featureRevision"],
        "datasetVersion": d["datasetVersion"], "splitHash": d["splitHash"],
        "trainCounts": {"positive": int((y == 1).sum()), "negative": int((y == 0).sum()), "groups": len(set(groups.tolist()))},
        "libraries": {"python": sys.version.split()[0], "scikit-learn": sklearn.__version__, "numpy": np.__version__, "scipy": scipy.__version__, "pandas": pd.__version__},
    }
    joblib.dump({"pipeline": pipe, "meta": meta}, dst, compress=3)
    print(json.dumps({"ok": True, "meta": meta}))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        die("usage: ml_train.py <train.json> <artifact.joblib>")
    main(sys.argv[1], sys.argv[2])

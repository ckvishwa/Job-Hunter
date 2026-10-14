"""Shared helpers for the Orbital job-relevance models (scikit-learn 1.x)."""
from __future__ import annotations

import json
import sys
from typing import Any

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

CANDIDATES = ("title_tfidf", "hybrid", "hybrid_emb", "tfidf", "minilm")


def die(msg: str, code: int = 3) -> None:
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(code)


def frame(rows: list[dict[str, Any]], dense_names: list[str], with_emb: bool) -> pd.DataFrame:
    """Rows -> DataFrame with columns title (str), role (str), d0..dn (float), e0..em (float, optional). Validates shapes and finiteness."""
    if not rows:
        die("no rows")
    data: dict[str, list[Any]] = {"title": [], "text": [], "role": []}
    for j in range(len(dense_names)):
        data[f"d{j}"] = []
    emb_dim = len(rows[0]["emb"]) if with_emb else 0
    for k in range(emb_dim):
        data[f"e{k}"] = []
    for r in rows:
        if len(r["dense"]) != len(dense_names):
            die("dense feature dimension mismatch")
        if with_emb and len(r["emb"]) != emb_dim:
            die("embedding dimension mismatch")
        data["title"].append(str(r["title"]))
        data["text"].append(str(r.get("text", r["title"])))
        data["role"].append(str(r["role"]))
        for j, v in enumerate(r["dense"]):
            data[f"d{j}"].append(float(v))
        for k in range(emb_dim):
            data[f"e{k}"].append(float(r["emb"][k]))
    df = pd.DataFrame(data)
    numeric = df.drop(columns=["title", "text", "role"])
    if not np.isfinite(numeric.to_numpy(dtype=float)).all():
        die("non-finite feature value")
    return df


def build_pipeline(candidate: str, n_dense: int, emb_dim: int, c: float, seed: int) -> Pipeline:
    """ColumnTransformer with correctly typed branches: text -> char TF-IDF (sparse), role -> one-hot, dense -> StandardScaler.
    Raw text is never sent to a scaler."""
    if candidate not in CANDIDATES:
        die(f"unknown candidate {candidate}")
    branches: list[tuple[str, Any, Any]] = [
        ("title", TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 5), lowercase=True, sublinear_tf=True, min_df=1, dtype=np.float64), "title"),
        ("role", OneHotEncoder(handle_unknown="ignore"), ["role"]),
    ]
    if candidate == "minilm":
        branches = [branches[1]]
    if candidate in ("tfidf", "hybrid_emb"):
        text_branch = ("text", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, max_features=20000), "text")
        branches = [text_branch, branches[1]] if candidate == "tfidf" else branches + [text_branch]
    if candidate in ("hybrid", "hybrid_emb"):
        branches.append(("dense", StandardScaler(), [f"d{j}" for j in range(n_dense)]))
    if candidate in ("hybrid_emb", "minilm"):
        branches.append(("emb", StandardScaler(), [f"e{k}" for k in range(emb_dim)]))
    return Pipeline([
        ("features", ColumnTransformer(branches, sparse_threshold=0.3)),
        ("clf", LogisticRegression(C=c, class_weight="balanced", max_iter=3000, solver="lbfgs", random_state=seed)),
    ])

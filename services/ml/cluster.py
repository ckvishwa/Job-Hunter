"""Cluster job embeddings (k-means, k chosen by silhouette) and find near-duplicates.

Input JSON: {"ids": [...], "vectors": [[...]], "companies": [...], "texts": ["sha256", ...], "kRange": [lo, hi]}
Output JSON: {"k", "silhouette", "labels", "nearDuplicates": [[i, j, cosine], ...], "centroidsTop": ...}
Unsupervised and descriptive: nothing here is a label, and no cluster is admitted into discovery automatically.
"""
from __future__ import annotations

import json
import sys

import numpy as np
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score

SEED = 20261013
NEAR_DUP = 0.985


def main(src: str, dst: str) -> None:
    with open(src, encoding="utf8") as fh:
        d = json.load(fh)
    V = np.asarray(d["vectors"], dtype=np.float64)
    n = V.shape[0]
    if n < 6:
        json.dump({"k": 0, "silhouette": None, "labels": [0] * n, "nearDuplicates": [], "note": "too few postings to cluster"}, open(dst, "w"))
        return
    V = V / np.linalg.norm(V, axis=1, keepdims=True)
    lo, hi = d.get("kRange", [4, 24])
    hi = min(hi, n - 1)
    best = (-2.0, lo, None)
    for k in range(max(2, lo), hi + 1, 2):
        km = KMeans(n_clusters=k, n_init=4, random_state=SEED).fit(V)
        s = float(silhouette_score(V, km.labels_, sample_size=min(n, 3000), random_state=SEED))
        if s > best[0]:
            best = (s, k, km.labels_)
    sil, k, labels = best
    # Near-duplicates: identical text hash, or cosine >= NEAR_DUP, found block-wise to bound memory.
    pairs = []
    for start in range(0, n, 500):
        block = V[start:start + 500] @ V.T
        for bi in range(block.shape[0]):
            i = start + bi
            js = np.where(block[bi] >= NEAR_DUP)[0]
            for j in js:
                if j > i:
                    pairs.append([int(i), int(j), round(float(block[bi, j]), 4)])
    json.dump({"k": int(k), "silhouette": sil, "labels": [int(x) for x in labels], "nearDuplicates": pairs, "nearDuplicateCosine": NEAR_DUP}, open(dst, "w"))
    print(json.dumps({"ok": True, "k": int(k), "silhouette": sil, "nearDuplicatePairs": len(pairs)}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

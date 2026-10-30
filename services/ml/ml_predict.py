"""Score job-role pairs with a registered artifact.

usage: ml_predict.py <artifact.joblib> <expected-sha256> <rows.json> <out.json>
The artifact is loaded ONLY if its SHA-256 equals the registry value passed in (joblib is pickle-based; this is the tamper check).
"""
from __future__ import annotations

import hashlib
import json
import sys
import time

import joblib


def peak_rss_mb():
    try:
        import psutil  # optional
        return psutil.Process().memory_info().rss / 1e6
    except Exception:
        try:
            import resource  # POSIX only
            return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        except Exception:
            return None


from ml_common import die, frame


def main(artifact: str, expected: str, rows_path: str, out_path: str) -> None:
    with open(artifact, "rb") as fh:
        blob = fh.read()
    if hashlib.sha256(blob).hexdigest() != expected:
        die("artifact hash does not match the registry")
    obj = joblib.load(artifact)
    pipe, meta = obj["pipeline"], obj["meta"]
    with open(rows_path, encoding="utf8") as fh:
        d = json.load(fh)
    if d["featureRevision"] != meta["featureRevision"] or d["denseNames"] != meta["denseNames"]:
        die("feature schema differs from the one the model was trained on")
    with_emb = meta["candidate"] in ("hybrid_emb", "minilm")
    df = frame(d["rows"], meta["denseNames"], with_emb)
    if with_emb and len(d["rows"][0]["emb"]) != meta["embDim"]:
        die("embedding dimension mismatch")
    t0 = time.perf_counter()
    p = pipe.predict_proba(df)[:, 1]
    ms = (time.perf_counter() - t0) * 1000
    with open(out_path, "w", encoding="utf8") as fh:
        json.dump({"scores": [float(x) for x in p], "threshold": meta["threshold"], "abstainBand": meta["abstainBand"], "inferenceMs": ms, "rows": len(p), "peakRssMb": peak_rss_mb()}, fh)
    print(json.dumps({"ok": True, "rows": len(p), "inferenceMs": ms}))


if __name__ == "__main__":
    if len(sys.argv) != 5:
        die("usage: ml_predict.py <artifact> <sha256> <rows.json> <out.json>")
    main(*sys.argv[1:])

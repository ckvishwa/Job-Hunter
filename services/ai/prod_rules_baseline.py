"""Reproduce the PRODUCTION path (app.extract_text.extract_pdf -> app.parse_resume.parse_resume, i.e. resume-rules@N) for the frozen manifest.
Run with the service venv (pdfplumber): services/ai/.venv/Scripts/python.exe services/ai/prod_rules_baseline.py <manifest.json> <input-dir> <out.json>
Its input is pdfplumber text, NOT Marker Markdown, so it is reported separately from the like-for-like comparison."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import tracemalloc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.extract_text import extract_pdf  # noqa: E402
from app.offsets import Utf16Map  # noqa: E402
from app.parse_resume import PARSER_REVISION, parse_resume  # noqa: E402


def main() -> int:
    manifest, indir, outp = sys.argv[1:4]
    docs = json.load(open(manifest, encoding="utf-8"))["selected"]
    out: dict = {"parserRevision": PARSER_REVISION, "documents": {}}
    for e in docs:
        rec: dict = {}
        try:
            data = open(os.path.join(indir, e["filename"]), "rb").read()
            tracemalloc.start()
            t0 = time.perf_counter()
            doc = extract_pdf(data)
            t1 = time.perf_counter()
            parsed = parse_resume(doc.text)
            t2 = time.perf_counter()
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            umap = Utf16Map(doc.text)
            raw = doc.text.encode("utf-16-le")
            valid = sum(1 for f in parsed.facts if raw[2 * f.span.start: 2 * f.span.end].decode("utf-16-le") == f.span.quote)
            rec = {"text": doc.text, "textSha256": hashlib.sha256(doc.text.encode()).hexdigest(), "extractMs": round((t1 - t0) * 1000, 1), "parseMs": round((t2 - t1) * 1000, 1),
                   "peakPythonKiB": round(peak / 1024), "facts": [f.model_dump(mode="json") for f in parsed.facts], "warnings": [w.model_dump(mode="json") for w in parsed.warnings],
                   "evidenceValid": valid, "evidenceChecked": len(parsed.facts), "error": None}
        except Exception as error:  # noqa: BLE001
            rec = {"error": f"{type(error).__name__}: {error}"}
        out["documents"][e["id"]] = rec
    json.dump(out, open(outp, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Local, read-only preview: run the CURRENT rules parser over a stored PDF/DOCX and print the proposals as JSON.
Writes nothing, calls no network, never touches the database. Used by `npm run resumes:diagnose -- --rerun-parser`.

    python -I services/ai/preview.py <file> <pdf|docx>
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.extract_text import ExtractError, extract  # noqa: E402
from app.parse_resume import PARSER_REVISION, parse_resume  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in ("pdf", "docx"):
        print(json.dumps({"error": "usage: preview.py <file> <pdf|docx>"}))
        return 2
    try:
        with open(sys.argv[1], "rb") as handle:
            doc = extract(handle.read(), sys.argv[2])
        parsed = parse_resume(doc.text)
    except ExtractError as error:
        print(json.dumps({"error": error.code}))
        return 1
    print(json.dumps({
        "parserRevision": PARSER_REVISION,
        "textSha256": hashlib.sha256(doc.text.encode("utf-8")).hexdigest(),
        "characterCount": len(doc.text),
        "facts": [f.model_dump(mode="json") for f in parsed.facts],
        "warnings": [w.model_dump(mode="json") for w in parsed.warnings],
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

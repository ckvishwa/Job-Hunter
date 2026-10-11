"""Writes every case in fixtures/resume_cases.json as a real .pdf / .docx into the directory given as argv[1].
Used by the TypeScript full-stack test so both languages are checked against the SAME hand-authored expectations."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from tests.builders import build

if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    cases = json.loads((Path(__file__).parent / "fixtures" / "resume_cases.json").read_text(encoding="utf-8"))
    for case in cases:
        (out / f"{case['id']}.{case['format']}").write_bytes(build(case["format"], case["lines"], blank_pages=case.get("blankPages", 0)))
    print(len(cases))

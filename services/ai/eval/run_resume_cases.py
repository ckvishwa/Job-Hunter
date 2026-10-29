"""Second labeled set: the 14 hand-authored resume_cases.json documents run through the Markdown parser as plain text.
SYNTHETIC and text-only (no PDF/Marker involved): it measures the parser rules on other layouts, not Marker, and not real-world accuracy."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.parse_markdown import parse_markdown  # noqa: E402
from eval.resume_compare import compare  # noqa: E402

CASES = json.loads((Path(__file__).parent.parent / "tests" / "fixtures" / "resume_cases.json").read_text(encoding="utf-8"))
# c09 expects year-only employment to be skipped (legacy policy); the new schema keeps year precision, so its employment labels do not apply.
# c10 has no text layer. Education labels are whole-line strings in this fixture and are not comparable with degree/institution records.
SKIP_EMPLOYMENT = {"c09-year-only-dates-pdf"}
SKIP_ALL = {"c10-scanned-no-text-layer-pdf"}
KINDS = ("name", "email", "phone", "skills", "experience", "certifications", "projects")


def label(case: dict) -> dict:
    doc: dict = {"name": None, "email": None, "phone": None, "skills": [], "experience": [], "education": [], "certifications": [], "projects": []}
    for f in case["expected"]["facts"]:
        k, v, a = f["kind"], f["value"], f.get("attributes", {})
        if k == "legal_name": doc["name"] = v
        elif k == "email": doc["email"] = v
        elif k == "phone": doc["phone"] = v
        elif k == "skill": doc["skills"].append(v)
        elif k == "certification": doc["certifications"].append(v)
        elif k == "project": doc["projects"].append({"name": v})
        elif k == "employment" and case["id"] not in SKIP_EMPLOYMENT and a.get("employer") and a.get("title"):
            doc["experience"].append({"employer": a["employer"], "title": a["title"], "start": a.get("startDate", ""), "end": "present" if a.get("current") else a.get("endDate", "")})
    return doc


def run() -> dict:
    tp = fp = fn = 0
    rows = []
    for case in CASES:
        if case["id"] in SKIP_ALL:
            continue
        text = "\n".join(case["lines"])
        got = parse_markdown(text, source_hash="0" * 64).candidate.model_dump(mode="json")
        exp = label(case)
        got["education"] = []
        if case["id"] in SKIP_EMPLOYMENT:
            got["experience"] = []
        cmp = compare(got, exp, text=text)
        o = cmp["overall"]
        tp, fp, fn = tp + o["tp"], fp + o["fp"], fn + o["fn"]
        rows.append({"id": case["id"], "tp": o["tp"], "fp": o["fp"], "fn": o["fn"], "defects": cmp["defects"], "invented": cmp["incorrectlyInventedFacts"], "critical": cmp["employmentAssociation"]["criticalErrors"]})
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    return {"documents": len(rows), "labeledFacts": tp + fn, "tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r,
            "f1": (2 * p * r / (p + r)) if p and r else None, "rows": rows, "synthetic": True}


if __name__ == "__main__":
    res = run()
    for row in res["rows"]:
        if row["fp"] or row["fn"] or row["invented"] or row["critical"]:
            print(row["id"], "fp", row["fp"], "fn", row["fn"])
            for d in row["defects"]:
                print("   ", d)
    print({k: res[k] for k in ("documents", "labeledFacts", "tp", "fp", "fn", "precision", "recall", "f1")})

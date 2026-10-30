"""Compare a ResumeExtraction candidate with a manually labeled expected file. Pure functions; no I/O.

Identity rules (a correct value attached to the wrong record is NOT rewarded):
- name / email / phone: normalized value equality.
- skill: normalized text equality.
- employment: (employer, title, start, end) must ALL match; same employer with other fields is a critical association error.
- education: (degree, institution) must both match.
- project: normalized name equality.
Normalization (comparison only; source quotations stay verbatim): NFC, casefold, whitespace collapse, trailing punctuation strip.
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Any


def norm(value: str | None) -> str:
    if value is None:
        return ""
    s = unicodedata.normalize("NFC", value).casefold()
    return re.sub(r"\s+", " ", s).strip(" .,;:")


def _date_str(d: Any) -> str:
    if d is None:
        return ""
    if isinstance(d, str):
        return d
    return "present" if d.get("precision") == "present" else (d.get("value") or "")


def _keys(doc: dict) -> dict[str, list[tuple]]:
    out: dict[str, list[tuple]] = {"name": [], "email": [], "phone": [], "skill": [], "employment": [], "education": [], "project": [], "certification": []}
    for k in ("name", "email", "phone"):
        v = doc.get(k)
        if v:
            out[k].append((norm(v["value"] if isinstance(v, dict) else v),))
    for s in doc.get("skills", []):
        out["skill"].append((norm(s["value"] if isinstance(s, dict) else s),))
    for e in doc.get("experience", []):
        out["employment"].append((norm(e["employer"]), norm(e["title"]), _date_str(e["start"]), _date_str(e["end"])))
    for e in doc.get("education", []):
        out["education"].append((norm(e["degree"]), norm(e.get("institution"))))
    for p in doc.get("projects", []):
        out["project"].append((norm(p["name"]),))
    for c in doc.get("certifications", []):
        out["certification"].append((norm(c["name"] if isinstance(c, dict) else c),))
    return out


def _prf(tp: int, fp: int, fn: int) -> dict[str, float | None]:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f = 2 * p * r / (p + r) if p is not None and r is not None and (p + r) > 0 else None
    return {"precision": p, "recall": r, "f1": f}


def compare(predicted: dict, expected: dict, *, text: str | None = None) -> dict:
    """`predicted` is `ResumeExtraction.candidate` as a dict; `expected` is the labeled file."""
    pk, ek = _keys(predicted), _keys(expected)
    per_kind: dict[str, dict] = {}
    defects: list[dict] = []
    tp = fp = fn = 0
    for kind in pk:
        pc, ec = Counter(pk[kind]), Counter(ek[kind])
        k_tp = sum(min(pc[k], ec[k]) for k in ec)
        k_fp = sum((pc - ec).values())
        k_fn = sum((ec - pc).values())
        tp, fp, fn = tp + k_tp, fp + k_fp, fn + k_fn
        per_kind[kind] = {"tp": k_tp, "fp": k_fp, "fn": k_fn, "expected": sum(ec.values()), "predicted": sum(pc.values()), **_prf(k_tp, k_fp, k_fn)}
        for item in (pc - ec).elements():
            defects.append({"type": "FALSE_POSITIVE", "kind": kind, "item": list(item)})
        for item in (ec - pc).elements():
            defects.append({"type": "FALSE_NEGATIVE", "kind": kind, "item": list(item)})

    # Employment association: per expected record, find the predicted record with the same employer.
    assoc_total = len(ek["employment"])
    assoc_ok = 0
    critical: list[dict] = []
    field_total = field_ok = 0
    pred_emp = list(pk["employment"])
    for exp in ek["employment"]:
        # an exact record wins; otherwise the same-employer record that agrees on most fields (an employer may appear twice)
        same = [p for p in pred_emp if p[0] == exp[0]]
        match = exp if exp in same else max(same, key=lambda q: sum(a == b for a, b in zip(q, exp)), default=None)
        if match is not None:
            pred_emp.remove(match)
        field_total += 4
        if match is None:
            continue
        field_ok += sum(1 for a, b in zip(match, exp) if a == b)
        if match == exp:
            assoc_ok += 1
        else:
            critical.append({"expected": list(exp), "predicted": list(match)})
    # Fields of non-employment records for exact-field accuracy.
    for kind in ("name", "email", "phone", "skill", "project", "education", "certification"):
        for exp in ek[kind]:
            field_total += len(exp)
            if exp in pk[kind]:
                field_ok += len(exp)
    invented = _invented(predicted, text) if text is not None else []
    return {
        "overall": {"tp": tp, "fp": fp, "fn": fn, "expectedFacts": tp + fn, "predictedFacts": tp + fp, **_prf(tp, fp, fn)},
        "perKind": per_kind,
        "exactFieldAccuracy": {"matched": field_ok, "total": field_total, "value": field_ok / field_total if field_total else None},
        "employmentAssociation": {"correct": assoc_ok, "expected": assoc_total, "value": assoc_ok / assoc_total if assoc_total else None, "criticalErrors": critical},
        "incorrectlyInventedFacts": invented,
        "defects": defects,
    }


def _invented(candidate: dict, text: str) -> list[str]:
    """A predicted value whose casefolded form does not occur in the stored text is invented (evidence-independent check)."""
    hay = norm(text)
    out: list[str] = []
    def check(label: str, value: str | None) -> None:
        if value and norm(value) not in hay:
            out.append(f"{label}: {value}")
    for k in ("name", "email", "phone"):
        v = candidate.get(k)
        if v:
            check(k, v["value"])
    for s in candidate.get("skills", []):
        check("skill", s["value"])
    for e in candidate.get("experience", []):
        check("employer", e["employer"]); check("title", e["title"])
    for e in candidate.get("education", []):
        check("degree", e["degree"]); check("institution", e.get("institution"))
    for p in candidate.get("projects", []):
        check("project", p["name"])
    for c in candidate.get("certifications", []):
        check("certification", c["name"])
    return out

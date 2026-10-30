"""Scoring for the resume-interpreter experiment. Pure functions over a neutral record format; no I/O, no model.

Neutral format (same as the reviewed labels):
  name/email/phone/location: str | None
  experience: [{employer,title,start,end}]   dates 'YYYY' | 'YYYY-MM' | 'present'
  education: [{degree,institution}]  (production rules@2 gives one combined line: {"combined": "..."} and is matched by containment)
  skills / certifications / projects: [str]
Precision/recall are computed ONLY against reviewed labels. A zero denominator yields None (reported as NOT_MEASURED), never 0 or 1.
"""
from __future__ import annotations

import re
import unicodedata

from app.parse_markdown import _partial


def norm(s: str | None) -> str:
    if not s:
        return ""
    t = unicodedata.normalize("NFC", s).casefold()
    return re.sub(r"[\s\-‐-―]+", "", t).strip(" .,;:")


def loose(a: str, b: str) -> bool:
    """Equal after normalization, or one is a prefix of the other covering >= 60% (a dated or located variant of the same name)."""
    a, b = norm(a), norm(b)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = sorted((a, b), key=len)
    return long_.startswith(short) and len(short) / len(long_) >= 0.6


def date(s: str | None) -> str:
    if not s:
        return ""
    t = s.strip()
    if re.fullmatch(r"(?:19|20)\d{2}-(?:0[1-9]|1[0-2])", t):
        return t  # already normalized
    pd = _partial(t) if t else None
    if pd is None:
        m = re.search(r"(?:19|20)\d{2}", t)
        return norm(t) if not m or len(t) > 4 else m.group(0)
    return "present" if pd.precision == "present" else (pd.value or "")


def head(entry: str) -> str:
    return entry.split("(")[0].strip()


def inner(entry: str) -> set[str]:
    m = re.search(r"\(([^)]*)\)", entry)
    return {norm(x) for x in m.group(1).split(",")} if m and "," in m.group(1) else set()


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f = 2 * p * r / (p + r) if p and r else (0.0 if p is not None and r is not None else None)
    return {"tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f}


def score_skills(pred: list[str], exp: list[str], categories: list[str]) -> dict:
    cats = {norm(c) for c in categories}
    exp_forms = [{norm(e), norm(head(e))} for e in exp]
    inner_all = set().union(*[inner(e) for e in exp]) if exp else set()
    matched: set[int] = set()
    tp = fp = n_inner = label_as_skill = 0
    seen: set[str] = set()
    wrong: list[str] = []
    for p in pred:
        k = norm(p)
        if not k or k in seen:
            continue
        seen.add(k)
        hit = next((i for i, f in enumerate(exp_forms) if k in f and i not in matched), None)
        if hit is not None:
            matched.add(hit)
            tp += 1
        elif k in inner_all:
            n_inner += 1
        else:
            fp += 1
            wrong.append(p)
            if k in cats:
                label_as_skill += 1
    out = prf(tp, fp, len(exp) - len(matched))
    out.update({"innerTerms": n_inner, "categoryLabelsAsSkills": label_as_skill, "falsePositiveItems": wrong,
                "missingItems": [e for i, e in enumerate(exp) if i not in matched]})
    return out


def score_names(pred: list[str], exp: list[str], head_split: bool) -> dict:
    """certifications / projects. head_split: a prediction equal to the part before ' — ' of an expected title also matches."""
    forms = [{norm(e)} | ({norm(e.split(" — ")[0])} if head_split else set()) for e in exp]
    matched: set[int] = set()
    tp = fp = 0
    wrong = []
    for p in pred:
        hit = next((i for i, f in enumerate(forms) if i not in matched and (norm(p) in f or any(loose(p, e) for e in [exp[i]]))), None)
        if hit is not None:
            matched.add(hit)
            tp += 1
        else:
            fp += 1
            wrong.append(p)
    out = prf(tp, fp, len(exp) - len(matched))
    out.update({"falsePositiveItems": wrong, "missingItems": [e for i, e in enumerate(exp) if i not in matched]})
    return out


def score_employment(pred: list[dict], exp: list[dict]) -> dict:
    def key(r):  # employer, title, start, end
        return (norm(r["employer"]), norm(r["title"]), date(r.get("start")), date(r.get("end")))

    ek = [key(e) for e in exp]
    used: set[int] = set()
    tp = fp = 0
    wrong_assoc: list[dict] = []
    for p in pred:
        k = key(p)
        hit = next((i for i, e in enumerate(ek) if i not in used and e == k), None)
        if hit is not None:
            used.add(hit)
            tp += 1
        else:
            fp += 1
            wrong_assoc.append({"predicted": [p["employer"], p["title"], p.get("start"), p.get("end")]})
    out = prf(tp, fp, len(exp) - len(used))
    # association: each expected record counts as correctly associated only when employer, title AND both dates agree on ONE predicted record
    out["associationAccuracy"] = (len(used) / len(exp)) if exp else None
    partial = []
    for i, e in enumerate(exp):
        if i in used:
            continue
        near = [p for p in pred if norm(p["employer"]) == ek[i][0] or norm(p["title"]) == ek[i][1]]
        if near:
            partial.append({"expected": [exp[i]["employer"], exp[i]["title"], exp[i]["start"], exp[i]["end"]], "closest": [near[0]["employer"], near[0]["title"], near[0].get("start"), near[0].get("end")]})
    out["incorrectAssociations"] = partial
    out["falsePositiveRecords"] = wrong_assoc
    out["missingRecords"] = len(exp) - len(used) - len(partial)
    return out


def score_education(pred: list[dict], exp: list[dict]) -> dict:
    used: set[int] = set()
    correct = wrong_inst = missing_inst = fp = 0
    for p in pred:
        if "combined" in p:  # production rules@2: one text line
            c = norm(p["combined"])
            hit = next((i for i, e in enumerate(exp) if i not in used and norm(e["degree"]) in c and norm(e["institution"]) in c), None)
            deg_only = next((i for i, e in enumerate(exp) if i not in used and norm(e["degree"]) in c), None)
        else:
            hit = next((i for i, e in enumerate(exp) if i not in used and loose(p["degree"], e["degree"]) and p.get("institution") and loose(p["institution"], e["institution"])), None)
            deg_only = next((i for i, e in enumerate(exp) if i not in used and loose(p["degree"], e["degree"])), None)
        if hit is not None:
            used.add(hit)
            correct += 1
        elif deg_only is not None:
            used.add(deg_only)
            if p.get("institution"):
                wrong_inst += 1
            else:
                missing_inst += 1
        else:
            fp += 1
    n = len(exp)
    return {"expected": n, "predicted": len(pred), "correct": correct, "wrongInstitution": wrong_inst, "missingInstitution": missing_inst, "falsePositives": fp,
            "missingRecords": n - len(used), "accuracy": (correct / n) if n else None}


def score_contacts(pred: dict, exp: dict) -> dict:
    out = {}
    for k in ("name", "email", "phone"):
        e, p = exp.get(k), pred.get(k)
        out[k] = ("NA" if e is None and p is None else "OK" if e is not None and p is not None and norm(e) == norm(p) else "MISSING" if p is None else "WRONG" if e is not None else "UNSUPPORTED")
    return out


def hallucinations(pred: dict, source_text: str) -> list[str]:
    """Predicted values whose normalized form does not occur anywhere in the source text. Evidence-independent."""
    hay = norm(re.sub(r"\*\*|__|\\(?=[$*_#\[\]()<>`])", "", source_text))
    bad: list[str] = []

    def chk(label, v):
        if v and norm(v) not in hay:
            bad.append(f"{label}: {v}")

    for k in ("name", "email", "phone"):
        chk(k, pred.get(k))
    for e in pred.get("experience", []):
        chk("employer", e["employer"])
        chk("title", e["title"])
    for e in pred.get("education", []):
        if "combined" not in e:
            chk("degree", e["degree"])
            chk("institution", e.get("institution"))
    for s in pred.get("skills", []):
        chk("skill", s)
    for c in pred.get("certifications", []):
        chk("certification", c)
    for p in pred.get("projects", []):
        chk("project", p)
    return bad


def score_document(pred: dict, label: dict, source_text: str) -> dict:
    return {
        "employment": score_employment(pred.get("experience", []), label["experience"]),
        "skills": score_skills(pred.get("skills", []), label["skills"], label.get("categories", [])),
        "education": score_education(pred.get("education", []), label["education"]),
        "certifications": score_names(pred.get("certifications", []), label["certifications"], False),
        "projects": score_names(pred.get("projects", []), label["projects"], True),
        "contacts": score_contacts(pred, label),
        "hallucinations": hallucinations(pred, source_text),
    }


def aggregate(per_doc: list[dict]) -> dict:
    def tot(section, key):
        return sum(d[section][key] for d in per_doc)

    out = {}
    for sec in ("employment", "skills", "certifications", "projects"):
        out[sec] = prf(tot(sec, "tp"), tot(sec, "fp"), tot(sec, "fn"))
    out["employment"]["associationAccuracy"] = (sum(d["employment"]["tp"] for d in per_doc) / sum(d["employment"]["tp"] + d["employment"]["fn"] for d in per_doc)) if sum(d["employment"]["tp"] + d["employment"]["fn"] for d in per_doc) else None
    ex = sum(d["education"]["expected"] for d in per_doc)
    out["education"] = {"expected": ex, "correct": sum(d["education"]["correct"] for d in per_doc), "wrongInstitution": sum(d["education"]["wrongInstitution"] for d in per_doc),
                        "missingInstitution": sum(d["education"]["missingInstitution"] for d in per_doc), "falsePositives": sum(d["education"]["falsePositives"] for d in per_doc),
                        "accuracy": (sum(d["education"]["correct"] for d in per_doc) / ex) if ex else None}
    out["categoryLabelsAsSkills"] = tot("skills", "categoryLabelsAsSkills")
    out["hallucinations"] = sum(len(d["hallucinations"]) for d in per_doc)
    return out

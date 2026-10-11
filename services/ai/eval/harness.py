"""Scoring for the baseline-vs-challenger comparison. Pure functions; no model, no network.

Every number here is computed against hand-written reference labels (heldout_cases.json) or from the proposals themselves
(span validity, unsupported facts, sensitive-field violations). Nothing is combined into a single quality score.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from app.contracts import FORBIDDEN_KINDS, ProposedFact
from app.parse_resume import RANGE_RE, SENSITIVE_PATTERNS, parse_date

SCORED_KINDS = ("skill", "employment", "education", "certification", "project")


def squash(s: str) -> str:
    return re.sub(r"[^a-z0-9+#]+", "", s.lower())


def key_of(kind: str, value: str, employer: str | None = None, title: str | None = None) -> tuple[str, str]:
    if kind == "employment" and employer and title:
        return kind, squash(employer) + squash(title)
    return kind, squash(value)


def proposal_key(f: ProposedFact) -> tuple[str, str]:
    return key_of(f.kind, f.value, f.attributes.employer, f.attributes.title)


def ratio(a: int, b: int) -> float | None:
    return None if b == 0 else round(a / b, 4)


def f1(p: float | None, r: float | None) -> float | None:
    return None if p is None or r is None or p + r == 0 else round(2 * p * r / (p + r), 4)


def percentile(values: list[float], q: float) -> float | None:
    """Nearest-rank percentile. With few samples p95 is simply the largest; the report says how many samples it rests on."""
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[max(0, math.ceil(q / 100 * len(ordered)) - 1)], 2)


@dataclass
class CaseScore:
    case_id: str
    category: str
    case_set: str = "regression"
    tp: int = 0
    fp: int = 0
    fn: int = 0
    per_kind: dict[str, dict[str, int]] = field(default_factory=dict)
    missed: list[tuple[str, str]] = field(default_factory=list)
    spurious: list[tuple[str, str]] = field(default_factory=list)
    employment_ref: int = 0
    exact: dict[str, int] = field(default_factory=lambda: {"employer": 0, "title": 0, "startDate": 0, "endDate": 0, "all": 0})
    category_without_support: int = 0


def score_case(case: dict, proposals: list[ProposedFact]) -> CaseScore:
    sc = CaseScore(case["id"], case["category"], case.get("set", "regression"))
    props = [p for p in proposals if p.kind in SCORED_KINDS]
    ref = case["reference"]
    entries = [(r, {key_of(r["kind"], r.get("value", ""), r.get("employer"), r.get("title"))} | {key_of(r["kind"], alt) for alt in r.get("alt", [])}) for r in ref]
    prop_keys: dict[tuple[str, str], ProposedFact] = {}
    for p in props:
        prop_keys.setdefault(proposal_key(p), p)
    for kind in SCORED_KINDS:
        of_kind = [(r, ks) for r, ks in entries if r["kind"] == kind]
        matched = [(r, ks) for r, ks in of_kind if ks & prop_keys.keys()]
        unmatched = [(r, ks) for r, ks in of_kind if not (ks & prop_keys.keys())]
        all_ref_keys = set().union(*[ks for _, ks in of_kind]) if of_kind else set()
        spurious = sorted(k for k in prop_keys if k[0] == kind and k not in all_ref_keys)
        sc.per_kind[kind] = {"tp": len(matched), "fp": len(spurious), "fn": len(unmatched)}
        sc.missed += [(kind, r.get("value") or f'{r.get("employer")} / {r.get("title")}') for r, _ in unmatched]
        sc.spurious += [(kind, prop_keys[k].value) for k in spurious]
    sc.tp = sum(v["tp"] for v in sc.per_kind.values())
    sc.fp = sum(v["fp"] for v in sc.per_kind.values())
    sc.fn = sum(v["fn"] for v in sc.per_kind.values())
    # exact employer/title/date accuracy: judged on the proposal that covers the reference record (same start month, else same employer+title)
    emp_props = [p for p in props if p.kind == "employment"]
    for r in (x for x in ref if x["kind"] == "employment"):
        sc.employment_ref += 1
        cand = next((p for p in emp_props if p.attributes.startDate == r["startDate"] and squash(p.value).startswith(squash(r["employer"])[:6])), None) \
            or next((p for p in emp_props if squash(r["employer"]) in squash(p.value) and squash(r["title"]) in squash(p.value)), None)
        if cand is None:
            continue
        a = cand.attributes
        e = squash(a.employer or "") == squash(r["employer"])
        t = squash(a.title or "") == squash(r["title"])
        s = a.startDate == r["startDate"]
        n = a.endDate == r.get("endDate")
        for name, ok in (("employer", e), ("title", t), ("startDate", s), ("endDate", n)):
            sc.exact[name] += int(ok)
        sc.exact["all"] += int(e and t and s and n)
    ref_type = {key_of(r["kind"], r.get("value", ""), r.get("employer"), r.get("title")): r.get("employmentType") for r in ref if r["kind"] == "employment"}
    for p in emp_props:
        if getattr(p.attributes, "employmentType", None) and ref_type.get(proposal_key(p)) != p.attributes.employmentType:
            sc.category_without_support += 1
    return sc


@dataclass
class Integrity:
    proposals: int = 0
    valid_spans: int = 0
    unsupported: list[str] = field(default_factory=list)
    sensitive_violations: list[str] = field(default_factory=list)
    negation_violations: list[str] = field(default_factory=list)


def integrity(case: dict, text: str, proposals: list[ProposedFact]) -> Integrity:
    out = Integrity()
    units = text.encode("utf-16-le")
    negated = [squash(t) for t in case.get("negatedTerms", [])]
    for p in proposals:
        out.proposals += 1
        s, e = p.span.start, p.span.end
        valid = 0 <= s < e <= len(units) // 2 and units[2 * s: 2 * e].decode("utf-16-le") == p.span.quote
        out.valid_spans += int(valid)
        quote = p.span.quote
        if p.kind == "employment":
            a = p.attributes
            ok = bool(a.employer and a.title and squash(a.employer) in squash(quote) and squash(a.title) in squash(quote))
            m = RANGE_RE.search(quote)
            if ok and a.startDate:
                ok = bool(m) and parse_date(m.group("s")) == a.startDate and (parse_date(m.group("e")) == a.endDate)
            elif not a.startDate:
                ok = False
        else:
            ok = squash(p.value) in squash(quote)
        if not ok:
            out.unsupported.append(f"{p.kind}: {p.value[:60]}")
        if p.kind in FORBIDDEN_KINDS or any(pat.search(p.value) for _, pat in SENSITIVE_PATTERNS):
            out.sensitive_violations.append(f"{p.kind}: {p.value[:60]}")
        if any(t and t in squash(p.value) for t in negated):
            out.negation_violations.append(f"{p.kind}: {p.value[:60]}")
    return out


def aggregate(scores: list[CaseScore]) -> dict:
    tp, fp, fn = (sum(getattr(s, k) for s in scores) for k in ("tp", "fp", "fn"))
    p, r = ratio(tp, tp + fp), ratio(tp, tp + fn)
    per_kind = {}
    for kind in SCORED_KINDS:
        k_tp, k_fp, k_fn = (sum(s.per_kind[kind][x] for s in scores) for x in ("tp", "fp", "fn"))
        kp, kr = ratio(k_tp, k_tp + k_fp), ratio(k_tp, k_tp + k_fn)
        per_kind[kind] = {"tp": k_tp, "fp": k_fp, "fn": k_fn, "precision": kp, "recall": kr, "f1": f1(kp, kr)}
    emp = sum(s.employment_ref for s in scores)
    return {
        "truePositives": tp, "falsePositives": fp, "falseNegatives": fn, "precision": p, "recall": r, "f1": f1(p, r), "perKind": per_kind,
        "employmentExact": {"referenceRecords": emp, **{k: sum(s.exact[k] for s in scores) for k in ("employer", "title", "startDate", "endDate", "all")},
                            "allFieldsExactRate": ratio(sum(s.exact["all"] for s in scores), emp)},
        "categoryAssignedWithoutSupport": sum(s.category_without_support for s in scores),
        "perCaseFailures": [{"case": s.case_id, "category": s.category, "missed": s.missed, "spurious": s.spurious} for s in scores if s.missed or s.spurious],
        "perCategory": _by_category(scores),
    }


def _by_category(scores: list[CaseScore]) -> dict:
    out: dict[str, dict[str, int]] = {}
    for s in scores:
        c = out.setdefault(s.category, {"tp": 0, "fp": 0, "fn": 0})
        c["tp"] += s.tp
        c["fp"] += s.fp
        c["fn"] += s.fn
    for c in out.values():
        c["f1"] = f1(ratio(c["tp"], c["tp"] + c["fp"]), ratio(c["tp"], c["tp"] + c["fn"]))
    return out

"""Baseline vs shadow challenger on the same held-out synthetic examples.

    cd services/ai && .venv/Scripts/python -I -m eval.run_eval [--no-challenger] [--runs 3] [--out report.json]
    (-I ignores PYTHONPATH, so run it as:  .venv\\Scripts\\python -c "import sys; sys.path.insert(0,'.'); from eval.run_eval import main; main()")

Baseline  : resume-rules@N (app.parse_resume), the production parser.
Challenger: local Qwen structured extraction (eval.challenger). SHADOW ONLY: nothing here touches PostgreSQL or the service.
The report never claims a model ran unless Ollama answered; an unavailable model is reported as UNAVAILABLE with the reason.
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import tracemalloc
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from app.extract_text import extract  # noqa: E402
from app.parse_resume import PARSER_REVISION, parse_resume  # noqa: E402
from eval.challenger import PROMPT_REVISION, QwenChallenger  # noqa: E402
from eval.harness import SCORED_KINDS, aggregate, integrity, percentile, score_case  # noqa: E402
from tests.builders import build  # noqa: E402


def rss_mb() -> float | None:
    """Resident memory of this Python process (Windows via psapi, POSIX via resource). None when unavailable."""
    try:
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes

            class Counters(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]

            c = Counters()
            c.cb = ctypes.sizeof(c)
            kernel32, psapi = ctypes.WinDLL("kernel32"), ctypes.WinDLL("psapi")
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            if not psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb):
                return None
            return round(c.WorkingSetSize / 1e6, 1)
        import resource

        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    except Exception:  # noqa: BLE001
        return None


def by_set(scores):
    return {name: {k: v for k, v in aggregate([s for s in scores if s.case_set == name]).items() if k in ("precision", "recall", "f1", "truePositives", "falsePositives", "falseNegatives", "employmentExact")} for name in sorted({s.case_set for s in scores})}


def lat(values: list[float]) -> dict:
    return {"samples": len(values), "p50Ms": percentile(values, 50), "p95Ms": percentile(values, 95), "meanMs": round(statistics.mean(values), 2) if values else None}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default=str(HERE / "heldout_cases.json"))
    ap.add_argument("--no-challenger", action="store_true")
    ap.add_argument("--runs", type=int, default=3, help="timed repetitions per case for latency (accuracy uses the first run; temperature is 0)")
    ap.add_argument("--model", default=os.environ.get("JH_AI_QWEN_MODEL", "qwen2.5:3b-instruct-q4_K_M"))
    ap.add_argument("--ollama", default=os.environ.get("JH_AI_OLLAMA_URL", "http://127.0.0.1:11434"))
    ap.add_argument("--out")
    args = ap.parse_args(argv)

    spec = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    cases = spec["cases"]
    docs = []
    for case in cases:
        doc = extract(build(case["format"], case["lines"]), case["format"])  # real PDF/DOCX bytes through the real text extractor
        docs.append((case, doc.text))

    # ---- baseline ------------------------------------------------------------------------------------------------------------------
    rss_before = rss_mb()
    tracemalloc.start()
    base_lat, base_scores, base_int = [], [], []
    base_props: dict[str, list] = {}
    for case, text in docs:
        runs = []
        for _ in range(max(1, args.runs)):
            t0 = time.perf_counter()
            out = parse_resume(text)
            runs.append((time.perf_counter() - t0) * 1000)
        base_lat += runs
        props = [f for f in out.facts if f.kind in SCORED_KINDS]
        base_props[case["id"]] = props
        base_scores.append(score_case(case, props))
        base_int.append(integrity(case, text, props))
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    rss_after = rss_mb()

    def integrity_summary(items):
        return {
            "proposals": sum(i.proposals for i in items), "validEvidenceSpans": sum(i.valid_spans for i in items),
            "evidenceSpanValidityRate": (round(sum(i.valid_spans for i in items) / max(1, sum(i.proposals for i in items)), 4)),
            "unsupportedOrFabricatedFacts": sum(len(i.unsupported) for i in items), "unsupportedExamples": [u for i in items for u in i.unsupported][:10],
            "sensitiveFieldViolations": sum(len(i.sensitive_violations) for i in items), "sensitiveExamples": [u for i in items for u in i.sensitive_violations][:10],
            "negatedStatementsExtractedAsFacts": sum(len(i.negation_violations) for i in items), "negationExamples": [u for i in items for u in i.negation_violations][:10],
        }

    report: dict = {
        "schema": "orbital-ai-eval/1", "mode": "SHADOW", "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "labelStatus": spec["labelStatus"], "labelProvenance": spec["labelProvenance"], "caseSets": spec["sets"], "heldOutCases": len(cases), "scoredKinds": list(SCORED_KINDS), "excludedKinds": spec["excludedKinds"],
        "baseline": {
            "parser": PARSER_REVISION, "accuracy": aggregate(base_scores), "accuracyBySet": by_set(base_scores), "integrity": integrity_summary(base_int),
            "latency": lat(base_lat), "runtime": {"processResidentMbBefore": rss_before, "processResidentMbAfter": rss_after, "pythonHeapPeakMb": round(peak / 1e6, 2), "model": None, "gpu": None},
        },
    }

    # ---- challenger ----------------------------------------------------------------------------------------------------------------
    if args.no_challenger:
        report["challenger"] = {"status": "SKIPPED", "reason": "--no-challenger"}
    else:
        ch = QwenChallenger(args.ollama, args.model)
        ok, why = ch.available()
        if not ok:
            report["challenger"] = {"status": "UNAVAILABLE", "reason": why, "claim": "No model ran. Nothing below is a model result."}
        else:
            load_ms = ch.warm_up()
            ch_lat, ch_scores, ch_int, per_case = [], [], [], []
            dropped_total: dict[str, int] = {}
            raw_total = raw_unsupported = raw_forbidden = errors = ptoks = ctoks = 0
            for case, text in docs:
                first = None
                for i in range(max(1, args.runs)):
                    res = ch.propose(text)
                    ch_lat.append(res.latency_ms)
                    if first is None:
                        first = res
                assert first is not None
                if first.error:
                    errors += 1
                raw_total += first.raw_count
                raw_unsupported += first.raw_unsupported
                raw_forbidden += first.raw_forbidden
                ptoks += first.prompt_tokens
                ctoks += first.completion_tokens
                for k, v in first.dropped.items():
                    dropped_total[k] = dropped_total.get(k, 0) + v
                ch_scores.append(score_case(case, first.facts))
                ch_int.append(integrity(case, text, first.facts))
                per_case.append({"case": case["id"], "error": first.error, "rawFacts": first.raw_count, "kept": len(first.facts), "dropped": first.dropped})
            report["challenger"] = {
                "status": "RAN", "model": args.model, "promptRevision": PROMPT_REVISION, "verifiedBy": "Ollama /api/chat answered every call; the model load time below is reported by Ollama itself",
                "accuracy": aggregate(ch_scores), "accuracyBySet": by_set(ch_scores), "integrity": integrity_summary(ch_int),
                "rawModelOutput": {
                    "factsReturned": raw_total, "unsupportedBeforeTheGate": raw_unsupported, "forbiddenKindsAttempted": raw_forbidden, "droppedByTheGate": dropped_total,
                    "note": "The gate (verbatim quote + value backed by quote + dates readable from quote) removes unsupported output. The 'integrity' block above is AFTER the gate; this block is the raw model behaviour.",
                },
                "latency": lat(ch_lat), "coldModelLoadMs": round(load_ms, 1),
                "runtime": {**ch.memory(), "tokensPrompt": ptoks, "tokensCompletion": ctoks, "callErrors": errors, "processResidentMbAfter": rss_mb()},
                "perCase": per_case,
            }

    report["comparison"] = compare(report)
    text_out = json.dumps(report, indent=2, ensure_ascii=False)
    target = Path(args.out) if args.out else Path(os.getcwd()).parent.parent / "private-runtime" / "ai-eval" / f"eval-{datetime.now().strftime('%Y%m%dT%H%M%S')}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text_out + "\n", encoding="utf-8")
    print_summary(report)
    print(f"\nfull report: {target}")
    return 0


def compare(report: dict) -> dict:
    b, c = report["baseline"], report.get("challenger", {})
    gate = {"mode": "SHADOW", "promotionAllowed": False, "reasons": []}
    r = gate["reasons"]
    r.append("Labels are author-written and not yet reviewed by a second person.")
    r.append(f"Only {report['heldOutCases']} held-out examples: too few to show a meaningful improvement.")
    if c.get("status") != "RAN":
        r.append(f"Challenger did not run ({c.get('status')}).")
        return {"gate": gate}
    bf, cf = b["accuracy"]["f1"], c["accuracy"]["f1"]
    gate["f1Delta"] = None if bf is None or cf is None else round(cf - bf, 4)
    if gate["f1Delta"] is None or gate["f1Delta"] < 0.05:
        r.append(f"Challenger F1 is not at least 0.05 above the baseline (delta {gate['f1Delta']}).")
    if c["integrity"]["unsupportedOrFabricatedFacts"] > b["integrity"]["unsupportedOrFabricatedFacts"]:
        r.append("Challenger has more unsupported facts than the baseline after the gate.")
    if c["rawModelOutput"]["unsupportedBeforeTheGate"] > 0:
        r.append(f"The raw model produced {c['rawModelOutput']['unsupportedBeforeTheGate']} unsupported fact(s) before the gate; production would depend on the gate catching all of them.")
    if c["integrity"]["negatedStatementsExtractedAsFacts"] > b["integrity"]["negatedStatementsExtractedAsFacts"]:
        r.append("Challenger extracted negated statements as facts (critical factual regression).")
    if c["integrity"]["sensitiveFieldViolations"] > 0 or c["rawModelOutput"]["forbiddenKindsAttempted"] > 0:
        r.append("Challenger attempted or produced sensitive-field facts.")
    r.append("Rollback is configuration only (JH_AI_QWEN_FALLBACK unset/0); it is exercised by tests/test_shadow_rollback.py.")
    return {"gate": gate}


def print_summary(rep: dict) -> None:
    def line(name: str, side: dict) -> None:
        a, i, l = side["accuracy"], side["integrity"], side["latency"]
        print(f"{name:<11} P {a['precision']}  R {a['recall']}  F1 {a['f1']}  | exact employer/title/dates (all four): {a['employmentExact']['all']}/{a['employmentExact']['referenceRecords']} "
              f"| unsupported {i['unsupportedOrFabricatedFacts']}  span-valid {i['evidenceSpanValidityRate']}  sensitive {i['sensitiveFieldViolations']}  negated-as-fact {i['negatedStatementsExtractedAsFacts']} "
              f"| p50 {l['p50Ms']} ms  p95 {l['p95Ms']} ms (n={l['samples']})")

    print(f"LABELS: {rep['labelStatus']} ({rep['heldOutCases']} cases). All numbers are provisional.")
    for name in ("stress", "regression"):
        tag = "NOT TUNED (generalisation)" if name == "stress" else "TUNED (regression check only)"
        for side in ("baseline", "challenger"):
            if side == "challenger" and rep["challenger"].get("status") != "RAN":
                continue
            a = rep[side]["accuracyBySet"][name]
            print(f"  {name:<10} {tag:<30} {side:<10} P {a['precision']}  R {a['recall']}  F1 {a['f1']}  (tp {a['truePositives']} fp {a['falsePositives']} fn {a['falseNegatives']}; employment exact {a['employmentExact']['all']}/{a['employmentExact']['referenceRecords']})")
    print(f"mode {rep['mode']}   (the lines below pool both sets; read the per-set lines above first)")
    line(f"baseline", rep["baseline"])
    ch = rep["challenger"]
    if ch["status"] == "RAN":
        line("challenger", ch)
        print(f"            raw model output: {ch['rawModelOutput']['factsReturned']} facts, {ch['rawModelOutput']['unsupportedBeforeTheGate']} unsupported before the gate, dropped {ch['rawModelOutput']['droppedByTheGate']}")
        print(f"            runtime: {ch['runtime']}  cold load {ch['coldModelLoadMs']} ms")
    else:
        print(f"challenger  {ch['status']}: {ch.get('reason')}")
    print("gate:", json.dumps(rep["comparison"]["gate"], indent=2))


if __name__ == "__main__":
    raise SystemExit(main())

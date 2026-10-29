"""Experiment 01: pretrained local model vs deterministic Parser v2 vs production resume-rules@N on the frozen 10-PDF manifest.
EVALUATION ONLY: nothing here is imported by the service, and no fact is approved.

    services/ai/.venv-marker/Scripts/python.exe services/ai/ml_experiment.py --root private-runtime --prompts v1,v2

Stages (each document is independent; one failure never stops the batch; every result is written before the next document):
 freeze -> Parser v2 on the saved Markdown -> production rules (separate venv, pdfplumber text) -> model per prompt version -> scoring -> report.
Labels (private-runtime/resume-ml-experiment-01/labels/labels.json) were typed from the rendered original PDFs, never from parser output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import time
import tracemalloc
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.ml_interpreter import INTERPRETER_REVISION, OllamaInterpreter, validate  # noqa: E402
from app.parse_markdown import PARSER_REVISION as V2_REVISION, parse_markdown  # noqa: E402
from app.resume_schema import ResumeExtraction  # noqa: E402
from eval.ml_score import aggregate, score_document  # noqa: E402

HERE = Path(__file__).resolve().parent
NM = "NOT_MEASURED"


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def sh(cmd: list[str]) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception as error:  # noqa: BLE001
        return f"ERROR {type(error).__name__}"


def write(p: Path, obj) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def mem_sample() -> dict:
    ps = sh(["powershell", "-NoProfile", "-Command",
             "$p=Get-Process | Where-Object { $_.ProcessName -like 'ollama*' }; ($p | Measure-Object WorkingSet64 -Sum).Sum; ($p | Measure-Object PeakWorkingSet64 -Maximum).Maximum"]).split()
    gpu = sh(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]).splitlines()
    return {"ollamaWorkingSetMiB": round(int(ps[0]) / 2**20) if len(ps) >= 2 and ps[0].isdigit() else None,
            "ollamaPeakWorkingSetMiB": round(int(ps[1]) / 2**20) if len(ps) >= 2 and ps[1].isdigit() else None,
            "gpuUsedMiB": int(gpu[0]) if gpu and gpu[0].strip().isdigit() else None}


def parse_pv(token: str) -> tuple[str, str, str]:
    """'v1' -> (name ml_v1, v1, optional); 'v2:req' -> (ml_v2_req, v2, required)."""
    ver, _, mode = token.partition(":")
    return f"ml_{ver}" + ("_req" if mode == "req" else ""), ver, "required" if mode == "req" else "optional"


def p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, math.ceil(0.95 * len(s)) - 1)]


def from_v2(cand: dict) -> dict:
    def d(x):
        return None if not x else ("present" if x["precision"] == "present" else x["value"])

    return {"name": (cand["name"] or {}).get("value"), "email": (cand["email"] or {}).get("value"), "phone": (cand["phone"] or {}).get("value"),
            "experience": [{"employer": e["employer"], "title": e["title"], "start": d(e["start"]), "end": d(e["end"])} for e in cand["experience"]],
            "education": [{"degree": e["degree"], "institution": e["institution"]} for e in cand["education"]],
            "skills": [s["value"] for s in cand["skills"]], "certifications": [c["name"] for c in cand["certifications"]], "projects": [p["name"] for p in cand["projects"]]}


def from_prod(facts: list[dict]) -> dict:
    out = {"name": None, "email": None, "phone": None, "experience": [], "education": [], "skills": [], "certifications": [], "projects": []}
    for f in facts:
        k, a = f["kind"], f.get("attributes") or {}
        if k == "legal_name":
            out["name"] = f["value"]
        elif k in ("email", "phone"):
            out[k] = f["value"]
        elif k == "skill":
            out["skills"].append(f["value"])
        elif k == "certification":
            out["certifications"].append(f["value"])
        elif k == "project":
            out["projects"].append(f["value"])
        elif k == "education":
            out["education"].append({"combined": f["value"]})
        elif k == "employment" and a.get("employer") and a.get("title"):
            out["experience"].append({"employer": a["employer"], "title": a["title"], "start": a.get("startDate"), "end": "present" if a.get("current") else a.get("endDate")})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path, help="private-runtime directory")
    ap.add_argument("--input-dir", type=Path, default=Path(r"C:\Users\ckvis\Downloads"))
    ap.add_argument("--prompts", default="v1,v2")
    ap.add_argument("--model", default="qwen2.5:3b-instruct-q4_K_M")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--rescore", action="store_true", help="reload saved outputs from disk and only re-run scoring (no parser or model calls)")
    args = ap.parse_args()
    root: Path = args.root
    exp = root / "resume-ml-experiment-01"
    base_manifest = root / "parser-batch-baseline" / "selected-10.json"
    manifest = json.loads(base_manifest.read_text(encoding="utf-8"))["selected"]
    labels = json.loads((exp / "labels" / "labels.json").read_text(encoding="utf-8"))["documents"]

    # ---- 1. freeze --------------------------------------------------------------------------------------------------
    repo = HERE.parent.parent
    hashes = {}
    for e in manifest:
        actual = sha256_file(args.input_dir / e["filename"])
        hashes[e["id"]] = {"filename": e["filename"], "recorded": e["sha256"], "actual": actual, "match": actual == e["sha256"]}
    if not all(h["match"] for h in hashes.values()):
        write(exp / "freeze.json", {"hashes": hashes})
        print("INPUT HASH MISMATCH; aborting", flush=True)
        return 2
    tags = json.loads(urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=20).read())
    model_rec = next((m for m in tags["models"] if m["name"] == args.model), None)
    inputs_dir = exp / "inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    md_info = {}
    for e in manifest:
        src = root / "parser-batch-after" / "documents" / e["id"] / "marker.md"
        dst = inputs_dir / f"{e['id']}.md"
        shutil.copyfile(src, dst)
        base_md = root / "parser-batch-baseline" / "documents" / e["id"] / "marker.md"
        md_info[e["id"]] = {"sha256": sha256_file(dst), "chars": len(dst.read_text(encoding="utf-8")), "identicalToBaselineMarkdown": base_md.exists() and sha256_file(base_md) == sha256_file(dst)}
    ollama_ver = sh(["ollama", "--version"])
    freeze = {"createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "repoRoot": str(repo), "branch": sh(["git", "-C", str(repo), "rev-parse", "--abbrev-ref", "HEAD"]),
              "head": sh(["git", "-C", str(repo), "rev-parse", "HEAD"]), "worktreeStatus": sh(["git", "-C", str(repo), "status", "--short"]).splitlines(),
              "parsers": {"production": "resume-rules@2 (app/parse_resume.py, invoked by app/main.py POST /internal/v1/ai/extract-resume and services/ai/preview.py; input = pdfplumber text)",
                          "deterministicV2": f"{V2_REVISION} (app/parse_markdown.py; invoked only by evaluate_resume.py/batch_resumes.py, NOT imported by app/main.py or preview.py)",
                          "mlInterpreter": INTERPRETER_REVISION},
              "python": platform.python_version(), "hashes": hashes, "inputMarkdown": md_info, "inputExtraction": "Marker 1.10.2, disable_ocr, figure-text recovery; the SAME saved Markdown feeds Parser v2 and the model",
              "model": {"name": args.model, "digest": model_rec and model_rec["digest"], "size": model_rec and model_rec["size"], "details": model_rec and model_rec["details"], "ollama": ollama_ver},
              "baselineArtifacts": {"parser-batch-baseline/selected-10.json": sha256_file(base_manifest), "parser-batch-after/batch-results.json": sha256_file(root / "parser-batch-after" / "batch-results.json")},
              "labelsSha256": sha256_file(exp / "labels" / "labels.json")}
    write(exp / "freeze.json", freeze)
    print("freeze ok; hashes match:", all(h["match"] for h in hashes.values()), flush=True)

    methods: dict[str, dict] = {"rules_v2": {}, "prod_rules": {}}
    if args.rescore:
        prod = json.loads((exp / "prod_rules" / "all.json").read_text(encoding="utf-8"))
        for e in manifest:
            did = e["id"]
            methods["rules_v2"][did] = json.loads((exp / "rules_v2" / f"{did}.json").read_text(encoding="utf-8"))
            d = prod["documents"][did]
            methods["prod_rules"][did] = {"pred": from_prod(d.get("facts", [])), "seconds": (d.get("extractMs", 0) + d.get("parseMs", 0)) / 1000, "peakPythonKiB": d.get("peakPythonKiB"),
                                          "schemaValid": not d.get("error"), "evidenceChecked": d.get("evidenceChecked"), "evidenceValid": d.get("evidenceValid"), "error": d.get("error"), "text": d.get("text", "")}
        for tok in [x for x in args.prompts.split(",") if x]:
            mname_, _, _ = parse_pv(tok)
            methods[mname_] = {}
            for e in manifest:
                did = e["id"]
                v = json.loads((exp / mname_ / did / "validated.json").read_text(encoding="utf-8"))
                r_ = json.loads((exp / mname_ / did / "run.json").read_text(encoding="utf-8"))
                methods[mname_][did] = {"pred": v["validated"], "seconds": r_["seconds"], "schemaValid": v["status"] not in ("SCHEMA_INVALID", "MODEL_ERROR"), "status": v["status"], "unsupported": v["unsupported"],
                                            "reviewRequired": v["reviewRequired"], "evidenceChecked": len(v["evidence"]), "evidenceValid": len(v["evidence"]), "modelQuoteSupport": v["modelQuoteSupport"],
                                            "memory": r_["memory"], "tokens": [r_["promptTokens"], r_["outputTokens"]], "error": r_["error"] or "; ".join(v["errors"]) or None, "rawUnsupportedCount": len(v["unsupported"])}
    else:
        # ---- 2. Parser v2 on the saved Markdown ----------------------------------------------------------------------
        for e in manifest:
            did = e["id"]
            md = (inputs_dir / f"{did}.md").read_text(encoding="utf-8")
            tracemalloc.start()
            t0 = time.perf_counter()
            try:
                ex = parse_markdown(md, source_hash=e["sha256"])
                ResumeExtraction.model_validate(ex.model_dump())
                cand = ex.model_dump(mode="json")
                rec = {"pred": from_v2(cand["candidate"]), "seconds": time.perf_counter() - t0, "schemaValid": True, "evidenceChecked": len(cand["facts"]), "evidenceValid": len(cand["facts"]), "error": None}
            except Exception as error:  # noqa: BLE001
                rec = {"pred": {"experience": [], "education": [], "skills": [], "certifications": [], "projects": []}, "seconds": time.perf_counter() - t0, "schemaValid": False, "error": f"{type(error).__name__}: {error}"}
            rec["peakPythonKiB"] = round(tracemalloc.get_traced_memory()[1] / 1024)
            tracemalloc.stop()
            methods["rules_v2"][did] = rec
            write(exp / "rules_v2" / f"{did}.json", rec)

        # ---- 3. production rules@N (separate venv, pdfplumber text) -------------------------------------------------
        py_prod = HERE / ".venv" / "Scripts" / "python.exe"
        prod_out = exp / "prod_rules" / "all.json"
        prod_out.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([str(py_prod), str(HERE / "prod_rules_baseline.py"), str(base_manifest), str(args.input_dir), str(prod_out)], capture_output=True, text=True, timeout=600)
        prod = json.loads(prod_out.read_text(encoding="utf-8")) if prod_out.exists() else {"documents": {}, "parserRevision": "UNAVAILABLE"}
        freeze["parsers"]["productionRevisionReported"] = prod.get("parserRevision")
        write(exp / "freeze.json", freeze)
        for e in manifest:
            d = prod["documents"].get(e["id"], {"error": "missing"})
            methods["prod_rules"][e["id"]] = {"pred": from_prod(d.get("facts", [])) if not d.get("error") else {"experience": [], "education": [], "skills": [], "certifications": [], "projects": []},
                                              "seconds": (d.get("extractMs", 0) + d.get("parseMs", 0)) / 1000 if not d.get("error") else None, "peakPythonKiB": d.get("peakPythonKiB"),
                                              "schemaValid": not d.get("error"), "evidenceChecked": d.get("evidenceChecked"), "evidenceValid": d.get("evidenceValid"), "error": d.get("error"), "text": d.get("text", "")}
        print("rules done", flush=True)

        # ---- 4. model per prompt version ----------------------------------------------------------------------------
        for tok in [x for x in args.prompts.split(",") if x]:
            name, pv, mode = parse_pv(tok)
            methods[name] = {}
            it = OllamaInterpreter(model=args.model, timeout_s=args.timeout, prompt_version=pv, schema_mode=mode)
            write(exp / name / "config.json", it.config())
            for e in manifest:
                did = e["id"]
                md = (inputs_dir / f"{did}.md").read_text(encoding="utf-8")
                call = it.call(md)
                mem = mem_sample()
                res = validate(md, call)
                qs = res.validated.pop("_modelQuoteSupport", None)
                d = exp / name / did
                d.mkdir(parents=True, exist_ok=True)
                (d / "raw_response.json").write_text(call.raw, encoding="utf-8")
                write(d / "validated.json", {"status": res.status, "validated": res.validated, "unsupported": res.unsupported, "reviewRequired": res.review_required, "evidence": res.evidence,
                                             "errors": res.errors, "modelQuoteSupport": qs})
                write(d / "run.json", {"seconds": call.seconds, "promptTokens": call.prompt_tokens, "outputTokens": call.output_tokens, "doneReason": call.done_reason, "error": call.error, "memory": mem})
                methods[name][did] = {"pred": res.validated, "seconds": call.seconds, "schemaValid": res.status not in ("SCHEMA_INVALID", "MODEL_ERROR"), "status": res.status, "unsupported": res.unsupported,
                                      "reviewRequired": res.review_required, "evidenceChecked": len(res.evidence), "evidenceValid": len(res.evidence), "modelQuoteSupport": qs, "memory": mem,
                                      "tokens": [call.prompt_tokens, call.output_tokens], "error": call.error or "; ".join(res.errors) or None, "rawUnsupportedCount": len(res.unsupported)}
                print(f"[{name}] {did}: {res.status} {call.seconds:.1f}s unsupported={len(res.unsupported)} review={len(res.review_required)}", flush=True)

    # ---- 5. scoring ---------------------------------------------------------------------------------------------
    results: dict = {}
    for mname, per in methods.items():
        docs = {}
        for e in manifest:
            did = e["id"]
            rec = per[did]
            src = rec.get("text") or (inputs_dir / f"{did}.md").read_text(encoding="utf-8")
            docs[did] = {"score": score_document(rec["pred"], labels[did], src), "seconds": rec["seconds"], "status": rec.get("status"), "error": rec.get("error"),
                         "unsupportedByEvidenceCheck": rec.get("unsupported", []), "reviewRequired": rec.get("reviewRequired", []), "modelQuoteSupport": rec.get("modelQuoteSupport")}
        per_doc = [v["score"] for v in docs.values()]
        secs = [v["seconds"] for v in docs.values() if v["seconds"] is not None]
        results[mname] = {"aggregate": aggregate(per_doc), "documents": docs,
                          "schemaValid": sum(1 for r in per.values() if r["schemaValid"]), "evidenceChecked": sum(r.get("evidenceChecked") or 0 for r in per.values()),
                          "evidenceValid": sum(r.get("evidenceValid") or 0 for r in per.values()), "avgSeconds": sum(secs) / len(secs) if secs else None, "p95Seconds": p95(secs),
                          "peakMemory": ({"ollamaPeakWorkingSetMiB": max((r["memory"]["ollamaPeakWorkingSetMiB"] or 0) for r in per.values()), "gpuUsedMiBMax": max((r["memory"]["gpuUsedMiB"] or 0) for r in per.values())}
                                         if mname.startswith("ml_") else {"peakPythonKiBMax": max((r.get("peakPythonKiB") or 0) for r in per.values())}),
                          "modelQuoteSupport": ({"checked": sum((r.get("modelQuoteSupport") or {}).get("checked", 0) for r in per.values()), "supported": sum((r.get("modelQuoteSupport") or {}).get("supported", 0) for r in per.values())} if mname.startswith("ml_") else None),
                          "rawUnsupportedClaims": sum(r.get("rawUnsupportedCount", 0) for r in per.values()) if mname.startswith("ml_") else None,
                          "reviewRequiredRecords": sum(len(r.get("reviewRequired", [])) for r in per.values()) if mname.startswith("ml_") else None,
                          "failedDocuments": sum(1 for r in per.values() if r.get("error"))}
    write(exp / "results.json", results)
    print("scoring done", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

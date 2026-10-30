"""Repeatable resume parser evaluation: PDF -> Marker Markdown -> deterministic parser -> strict JSON -> comparison with labeled truth.

    py -3.12 services/ai/evaluate_resume.py --pdf <file.pdf> --output-dir private-runtime/parser-eval [--expected <labeled.json>]

Run it with the isolated interpreter that has Marker installed (services/ai/.venv-marker). Never overwrites an existing expected.json.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.marker_extract import MarkerError, pdf_to_markdown, sha256_file  # noqa: E402
from app.parse_markdown import PARSER_REVISION, parse_markdown  # noqa: E402
from app.resume_schema import ResumeExtraction, all_evidence, evidence_valid  # noqa: E402
from app.offsets import Utf16Map  # noqa: E402
from eval.resume_compare import compare  # noqa: E402

DEFAULT_EXPECTED = Path(__file__).parent / "tests" / "fixtures" / "labeled" / "enhancv_two_column.expected.json"


def _write(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, type=Path)
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--expected", type=Path, default=DEFAULT_EXPECTED)
    ap.add_argument("--markdown", type=Path, help="reuse an existing Marker Markdown file (skips Stage 1; recorded in the report)")
    args = ap.parse_args(argv)
    out: Path = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []
    t0 = time.time()

    if args.markdown:
        markdown = args.markdown.read_text(encoding="utf-8")
        diagnostics = {"reusedMarkdown": str(args.markdown.name), "sourcePdfSha256": sha256_file(args.pdf)}
    else:
        try:
            result = pdf_to_markdown(args.pdf)
        except MarkerError as error:
            failures.append(f"{error.code}: {error.message}")
            _write(out / "accuracy-report.json", {"processingFailures": failures})
            print(json.dumps({"processingFailures": failures}))
            return 1
        markdown, diagnostics = result.markdown, result.diagnostics
        (out / "marker-resume.md").write_text(markdown, encoding="utf-8", newline="\n")
    diagnostics["stage1Seconds"] = round(time.time() - t0, 2)
    _write(out / "extraction-diagnostics.json", diagnostics)

    try:
        extraction = parse_markdown(markdown, source_hash=diagnostics["sourcePdfSha256"], extra_warnings=diagnostics.get("warnings"),
                                    metrics={"pageCount": diagnostics.get("pageCount", 0)})
        ResumeExtraction.model_validate(extraction.model_dump())  # strict round-trip validation (extra=forbid, evidence vs text)
    except Exception as error:  # noqa: BLE001 - reported as a processing failure, not hidden
        failures.append(f"{type(error).__name__}: {error}")
        _write(out / "accuracy-report.json", {"processingFailures": failures})
        print(json.dumps({"processingFailures": failures}))
        return 1
    _write(out / "candidate.json", extraction.model_dump(mode="json"))

    umap = Utf16Map(extraction.text)
    invalid_evidence = [label for label, ev in all_evidence(extraction.candidate) if not evidence_valid(ev, extraction.text, umap)]

    expected_path = out / "expected.json"
    if not expected_path.exists():
        shutil.copyfile(args.expected, expected_path)  # a reviewed file already in the output dir is never overwritten
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    cand = extraction.candidate.model_dump(mode="json")
    comparison = compare(cand, expected, text=extraction.text)
    _write(out / "comparison.json", comparison)

    o = comparison["overall"]
    mandatory = {
        "name": comparison["perKind"]["name"]["fn"] == 0 and comparison["perKind"]["name"]["fp"] == 0,
        "employment": comparison["perKind"]["employment"]["fn"] == 0 and comparison["perKind"]["employment"]["fp"] == 0,
        "education": comparison["perKind"]["education"]["fn"] == 0 and comparison["perKind"]["education"]["fp"] == 0,
        "projects": comparison["perKind"]["project"]["fn"] == 0 and comparison["perKind"]["project"]["fp"] == 0,
        "skills": comparison["perKind"]["skill"]["fn"] == 0 and comparison["perKind"]["skill"]["fp"] == 0,
        "noInventedFacts": not comparison["incorrectlyInventedFacts"],
        "evidenceValid": not invalid_evidence,
        "noCriticalAssociationErrors": not comparison["employmentAssociation"]["criticalErrors"],
    }
    report = {
        "parserRevision": PARSER_REVISION, "documents": 1, "labeledFacts": o["expectedFacts"],
        "tp": o["tp"], "fp": o["fp"], "fn": o["fn"], "precision": o["precision"], "recall": o["recall"], "f1": o["f1"],
        "exactFieldAccuracy": comparison["exactFieldAccuracy"], "employmentAssociation": comparison["employmentAssociation"],
        "incorrectlyInventedFacts": comparison["incorrectlyInventedFacts"], "invalidEvidenceReferences": invalid_evidence,
        "processingFailures": failures, "mandatoryChecks": mandatory, "mandatoryAllPass": all(mandatory.values()),
        "perKind": comparison["perKind"], "defects": comparison["defects"],
        "generalizationVerified": False,
        "generalizationNote": "One labeled document only. The >=99% real-world target is NOT verified.",
        "warningCodes": sorted({w.code for w in extraction.warnings}),
    }
    _write(out / "accuracy-report.json", report)
    print(json.dumps({k: report[k] for k in ("labeledFacts", "tp", "fp", "fn", "precision", "recall", "f1", "mandatoryAllPass", "mandatoryChecks")}, indent=2))
    for d in report["defects"]:
        print("DEFECT", d)
    return 0 if report["mandatoryAllPass"] else 3


if __name__ == "__main__":
    raise SystemExit(main())

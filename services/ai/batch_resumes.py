"""Sequential batch runner for the Marker -> deterministic parser pipeline. Measures CURRENT behavior; changes no parser rule.

    .venv-marker/Scripts/python.exe services/ai/batch_resumes.py --input-dir <Downloads> --output-dir private-runtime/parser-batch [--count 10] [--prefer Cloud_Resume.pdf]

Steps: inventory every PDF directly in the folder -> classify by CONTENT (section headings, page count) -> select the first N resumes in
case-insensitive alphabetical order (a preferred file replaces the last pick when it was not selected) -> save the manifest ->
convert and parse one PDF at a time, saving each result before the next. No network call carries resume content; no LLM.
Output holds private resume data: keep it out of Git (private-runtime/ is ignored).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.marker_extract import MarkerError, pdf_to_markdown, sha256_file  # noqa: E402
from app.offsets import Utf16Map  # noqa: E402
from app.parse_markdown import PARSER_REVISION, parse_markdown  # noqa: E402
from app.resume_schema import ResumeExtraction, all_evidence, evidence_valid, to_legacy_facts  # noqa: E402

SECTION_WORDS = ("experience", "education", "skills", "summary", "projects", "certifications", "employment", "objective", "profile")
URL_RE = re.compile(r"https?://[^\s)>\]]+|(?:www\.|linkedin\.com/|github\.com/)[^\s)>\]]+", re.IGNORECASE)
NA = "NOT_FOUND"


def pdf_text(path: Path) -> tuple[str, int]:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(path))
    pages = len(doc)
    text = "\n".join(doc[i].get_textpage().get_text_range() for i in range(min(pages, 3)))
    doc.close()
    return text, pages


def classify(path: Path) -> tuple[str, str, int]:
    """(classification, reason, pages). Content decides; the filename only breaks ties for obvious non-resumes."""
    try:
        text, pages = pdf_text(path)
    except Exception as error:  # noqa: BLE001
        return "UNREADABLE", type(error).__name__, 0
    low = text.lower()
    hits = [w for w in SECTION_WORDS if re.search(rf"(?m)^\s*{w}\b", low)]
    name = path.name.lower()
    if re.search(r"cover.?letter|offer letter|bill|manual|invoice", name):
        return "NOT_RESUME", "filename: letter/bill/manual", pages
    if len(hits) >= 3 and pages <= 3:
        return "RESUME", f"sections: {', '.join(hits)}", pages
    if len(hits) == 2 and pages <= 2 and re.search(r"resume|cv", name):
        return "RESUME", f"sections: {', '.join(hits)} + filename", pages
    return "NOT_RESUME", f"sections found: {', '.join(hits) or 'none'}; pages={pages}", pages


def select(resumes: list[dict], count: int, prefer: str | None) -> tuple[list[dict], list[str]]:
    ordered = sorted(resumes, key=lambda r: r["filename"].casefold())
    chosen, notes = ordered[:count], []
    if prefer:
        pref = next((r for r in ordered if r["filename"].casefold() == prefer.casefold()), None)
        if pref is None:
            notes.append(f"Preferred file {prefer} was not classified as a resume; no substitution.")
        elif pref not in chosen:
            dropped = chosen[-1]
            chosen[-1] = pref
            notes.append(f"Substitution: {prefer} was outside the first {count}; it replaced {dropped['filename']}.")
        else:
            notes.append(f"Preferred file {prefer} is already within the first {count}; no substitution.")
    return chosen, notes


def doc_id(index: int, filename: str) -> str:
    return f"{index:02d}-" + re.sub(r"[^A-Za-z0-9]+", "-", Path(filename).stem).strip("-").lower()[:50]


def location_after_range(quote_or_line: str) -> str:
    from app.parse_markdown import RANGE_RE
    m = RANGE_RE.search(quote_or_line)
    tail = quote_or_line[m.end():].strip(" ,|•·-–—") if m else ""
    return re.sub(r"[*_#\\]", "", tail).strip() or NA


def fmt_date(d: dict | None) -> str:
    if not d:
        return NA
    return "Present" if d["precision"] == "present" else d["value"]


def detail_for(cand: dict, text: str) -> dict:
    c = cand["candidate"]
    links = sorted({m.group(0).rstrip(".,;") for m in URL_RE.finditer(text)})
    emp = []
    for e in c["experience"]:
        line_end = e["evidence"]["quote"].split("\n")[-1]
        emp.append({"employer": e["employer"], "title": e["title"], "start": fmt_date(e["start"]), "end": fmt_date(e["end"]), "location": location_after_range(line_end)})
    return {"employment": emp, "links": links}


def structural_flags(c: dict, md: str) -> list[str]:
    """Heuristic red flags for HUMAN review. These are not accuracy measurements."""
    flags: list[str] = []
    n = c["name"]["value"] if c["name"] else None
    if n is None:
        flags.append("NAME_MISSING")
    elif not 2 <= len(n.split()) <= 4 or re.search(r"(?i)resume|curriculum|summary|experience|developer|engineer|analyst", n):
        flags.append(f"NAME_SUSPECT:{n}")
    if not c["experience"]:
        flags.append("NO_EMPLOYMENT")
    if not c["education"]:
        flags.append("NO_EDUCATION")
    if not c["skills"]:
        flags.append("NO_SKILLS")
    for s in c["skills"]:
        v = s["value"]
        if re.search(r"\d{4}|@|https?:|\.com", v) or len(v.split()) > 4:
            flags.append(f"SKILL_SUSPECT:{v}")
    for p in c["projects"]:
        if len(p["name"].split()) > 10:
            flags.append(f"PROJECT_NAME_LONG:{p['name'][:40]}")
    for k in c["certifications"]:
        if k["name"].endswith(".") or len(k["name"].split()) > 10:
            flags.append(f"CERT_SUSPECT:{k['name'][:40]}")
    if len(c["projects"]) > 8:
        flags.append(f"MANY_PROJECTS:{len(c['projects'])}")
    if re.search(r"(?im)^#{0,6}\s*\**(experience|work experience|professional experience)\**\s*$", md) and not c["experience"]:
        flags.append("EXPERIENCE_SECTION_BUT_NO_RECORDS")
    return flags


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def md_cell(v) -> str:
    return str(v).replace("|", "\\|").replace("\n", " ")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True, type=Path)
    ap.add_argument("--output-dir", required=True, type=Path)
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--prefer", default=None)
    ap.add_argument("--manifest", type=Path, help="reuse an existing selected-10.json (same files, same ids); skips selection")
    args = ap.parse_args(argv)
    out: Path = args.output_dir
    out.mkdir(parents=True, exist_ok=True)

    # ---- inventory + classification (content based) ----
    pdfs = sorted([p for p in args.input_dir.iterdir() if p.is_file() and p.suffix.lower() == ".pdf"], key=lambda p: p.name.casefold())
    inventory = []
    for i, p in enumerate(pdfs, 1):
        cls, reason, pages = classify(p)
        st = p.stat()
        inventory.append({"n": i, "filename": p.name, "sizeBytes": st.st_size, "modified": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                          "classification": cls, "reason": reason, "pages": pages})
    with (out / "pdf-inventory.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(inventory[0]))
        w.writeheader()
        w.writerows(inventory)
    resumes = [r for r in inventory if r["classification"] == "RESUME"]
    if args.manifest:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
        for entry in manifest["selected"]:  # the input must be byte-identical to the frozen selection
            actual = sha256_file(args.input_dir / entry["filename"])
            if actual != entry["sha256"]:
                raise SystemExit(f"input changed since the manifest was written: {entry['filename']}")
        manifest["rerunOf"] = str(args.manifest)
        manifest["rerunAt"] = datetime.now().isoformat(timespec="seconds")
        chosen = manifest["selected"]
    else:
        chosen, notes = select(resumes, args.count, args.prefer)
        manifest = {"createdAt": datetime.now().isoformat(timespec="seconds"), "inputDir": str(args.input_dir), "pdfsFound": len(pdfs), "resumesClassified": len(resumes),
                    "selectionRule": "case-insensitive alphabetical order of classified resumes; preferred file replaces the 10th pick when missing", "notes": notes,
                    "selected": [{"id": doc_id(i, r["filename"]), **r, "sha256": sha256_file(args.input_dir / r["filename"])} for i, r in enumerate(chosen, 1)]}
    write_json(out / "selected-10.json", manifest)
    print(f"PDFs found: {len(pdfs)}  classified as resumes: {len(resumes)}  selected: {len(chosen)}", flush=True)

    # ---- sequential conversion + parsing, models loaded once ----
    models = None
    results = []
    for entry in manifest["selected"]:
        did, fname = entry["id"], entry["filename"]
        ddir = out / "documents" / did
        rec = {"id": did, "filename": fname, "status": "FAILED", "seconds": None, "errors": [], "structuralValid": False, "evidenceValid": False, "flags": [], "counts": {}}
        t0 = time.time()
        try:
            if models is None:
                from marker.models import create_model_dict
                models = create_model_dict()
            mk = pdf_to_markdown(args.input_dir / fname, artifact_dict=models)
            ddir.mkdir(parents=True, exist_ok=True)
            (ddir / "marker.md").write_text(mk.markdown, encoding="utf-8", newline="\n")
            ex = parse_markdown(mk.markdown, source_hash=mk.diagnostics["sourcePdfSha256"], extra_warnings=mk.diagnostics.get("warnings"), metrics={"pageCount": mk.diagnostics["pageCount"]})
            ResumeExtraction.model_validate(ex.model_dump())  # strict structural round-trip
            rec["structuralValid"] = True
            cand = ex.model_dump(mode="json")
            umap = Utf16Map(ex.text)
            bad = [lab for lab, ev in all_evidence(ex.candidate) if not evidence_valid(ev, ex.text, umap)]
            rec["evidenceValid"] = not bad
            rec["invalidEvidence"] = bad
            det = detail_for(cand, ex.text)
            legacy_facts, legacy_warn = to_legacy_facts(ex)
            write_json(ddir / "candidate.json", cand)
            write_json(ddir / "warnings.json", {"warnings": cand["warnings"], "markerWarnings": mk.diagnostics.get("warnings", []), "legacyExportWarnings": [w.model_dump() for w in legacy_warn]})
            c = cand["candidate"]
            rec["counts"] = {"employment": len(c["experience"]), "education": len(c["education"]), "skills": len(c["skills"]), "certifications": len(c["certifications"]), "projects": len(c["projects"]), "facts": len(cand["facts"]), "warnings": len(cand["warnings"]), "legacyFacts": len(legacy_facts), "pages": mk.diagnostics["pageCount"]}
            rec["flags"] = structural_flags(c, ex.text)
            rec["warningCodes"] = sorted({w["code"] for w in cand["warnings"]})
            rec["detail"] = det
            rec["summary"] = {"name": c["name"]["value"] if c["name"] else NA, "email": c["email"]["value"] if c["email"] else NA, "phone": c["phone"]["value"] if c["phone"] else NA}
            review = bool(rec["flags"]) or any(w["code"] not in ("FIGURE_TEXT_RECOVERED",) for w in cand["warnings"]) or bad
            rec["status"] = "NEEDS_REVIEW" if review else "PARSED_OK"
        except MarkerError as error:
            rec["errors"].append(f"{error.code}: {error.message}")
        except Exception as error:  # noqa: BLE001 - recorded, never hidden
            rec["errors"].append(f"{type(error).__name__}: {error}")
            rec["traceback"] = traceback.format_exc(limit=4)
        rec["seconds"] = round(time.time() - t0, 1)
        results.append(rec)
        write_json(out / "batch-results.json", {"parserRevision": PARSER_REVISION, "results": results})  # saved before the next PDF
        print(f"[{len(results)}/{len(chosen)}] {fname}: {rec['status']} {rec['seconds']}s {rec['counts']}", flush=True)

    write_reports(out, manifest, inventory, results)
    return 0


def write_reports(out: Path, manifest: dict, inventory: list[dict], results: list[dict]) -> None:
    ok = [r for r in results if r["status"] != "FAILED"]
    tot = lambda k: sum(r["counts"].get(k, 0) for r in ok)  # noqa: E731
    # combined table
    head = "| PDF | Name | Email | Phone | Employment | Education | Skills | Certifications | Projects | Status |\n|---|---|---|---|---|---|---|---|---|---|\n"
    rows = ""
    for r in results:
        if r["status"] == "FAILED":
            rows += f"| {md_cell(r['filename'])} | {NA} | {NA} | {NA} | {NA} | {NA} | {NA} | {NA} | {NA} | FAILED |\n"
            continue
        c = r["counts"]
        rows += f"| {md_cell(r['filename'])} | {md_cell(r['summary']['name'])} | {md_cell(r['summary']['email'])} | {md_cell(r['summary']['phone'])} | {c['employment'] or NA} | {c['education'] or NA} | {c['skills'] or NA} | {c['certifications'] or NA} | {c['projects'] or NA} | {r['status']} |\n"
    # detailed tables + csv
    md = ["# All extracted facts (private)\n"]
    csv_rows = []
    for r in results:
        md.append(f"\n## {r['filename']}  ({r['id']}) — {r['status']}\n")
        if r["status"] == "FAILED":
            md.append(f"Errors: {'; '.join(r['errors'])}\n")
            continue
        cand = json.loads((out / "documents" / r["id"] / "candidate.json").read_text(encoding="utf-8"))
        c = cand["candidate"]
        md.append("### Employment\n\n| Employer | Title | Start | End | Location |\n|---|---|---|---|---|\n")
        for e in r["detail"]["employment"]:
            md.append(f"| {md_cell(e['employer'])} | {md_cell(e['title'])} | {e['start']} | {e['end']} | {md_cell(e['location'])} |\n")
        if not r["detail"]["employment"]:
            md.append(f"| {NA} | | | | |\n")
        md.append("\n### Skills\n\n" + (", ".join(f"{s['value']}" for s in c["skills"]) or NA) + "\n")
        md.append("\n### Education\n\n| Degree | Institution | Graduation |\n|---|---|---|\n")
        for e in c["education"]:
            md.append(f"| {md_cell(e['degree'])} | {md_cell(e['institution'] or NA)} | {fmt_date(e['graduation'])} |\n")
        if not c["education"]:
            md.append(f"| {NA} | | |\n")
        md.append("\n### Certifications\n\n" + ("\n".join(f"- {k['name']}" for k in c["certifications"]) or NA) + "\n")
        md.append("\n### Projects\n\n| Project | Dates | URL | Description |\n|---|---|---|---|\n")
        for p in c["projects"]:
            md.append(f"| {md_cell(p['name'])} | {fmt_date(p['start']) if p['start'] else NA} – {fmt_date(p['end']) if p['end'] else NA} | {md_cell(p['url'] or NA)} | {md_cell(p['description'] or NA)} |\n")
        if not c["projects"]:
            md.append(f"| {NA} | | | |\n")
        md.append("\n### Professional links\n\n" + ("\n".join(f"- {u}" for u in r["detail"]["links"]) or NA) + "\n")
        missing = [k for k, v in (("name", c["name"]), ("email", c["email"]), ("phone", c["phone"]), ("employment", c["experience"]), ("education", c["education"]), ("skills", c["skills"]), ("certifications", c["certifications"]), ("projects", c["projects"]), ("links", r["detail"]["links"])) if not v]
        md.append("\n### Missing information\n\n" + (", ".join(missing) or "none") + "\n")
        md.append("\n### Extraction warnings\n\n" + ("\n".join(f"- `{w['code']}`: {w['message']}" for w in cand["warnings"]) or "none") + "\n")
        if r["flags"]:
            md.append("\n### Structural red flags (heuristic, for review)\n\n" + "\n".join(f"- {f}" for f in r["flags"]) + "\n")
        for f in cand["facts"]:
            csv_rows.append({"document": r["id"], "kind": f["kind"], "value": f["value"], "confidence": f["confidence"], "start": f["evidence"]["start"], "end": f["evidence"]["end"], "quote": f["evidence"]["quote"].replace("\n", " ⏎ ")})
    (out / "all-extracted-facts.md").write_text("".join(md), encoding="utf-8")
    with (out / "all-extracted-facts.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["document", "kind", "value", "confidence", "start", "end", "quote"])
        w.writeheader()
        w.writerows(csv_rows)
    summary = [f"# Batch summary (private)\n\nParser `{PARSER_REVISION}` — structural validation is NOT accuracy; no independently labeled ground truth exists for these files.\n\n",
               f"- PDFs found: {manifest['pdfsFound']}\n- Classified as resumes: {manifest['resumesClassified']}\n- Selected: {len(manifest['selected'])}\n- Notes: {'; '.join(manifest['notes']) or 'none'}\n",
               f"- Parsed without failure: {len(ok)}  Failed: {len(results) - len(ok)}  Needs review: {sum(1 for r in results if r['status'] == 'NEEDS_REVIEW')}\n",
               f"- Totals: employment {tot('employment')}, skills {tot('skills')}, education {tot('education')}, certifications {tot('certifications')}, projects {tot('projects')}\n\n",
               head + rows, "\n## Runtime\n\n" + "\n".join(f"- {r['filename']}: {r['seconds']} s" for r in results) + "\n"]
    (out / "batch-summary.md").write_text("".join(summary), encoding="utf-8")
    fail = ["# Failure report (private)\n\n"]
    for r in results:
        issues = list(r["errors"]) + [f"flag: {f}" for f in r.get("flags", [])] + ([f"invalid evidence: {r['invalidEvidence']}"] if r.get("invalidEvidence") else []) + [f"warning: {c}" for c in r.get("warningCodes", []) if c != "FIGURE_TEXT_RECOVERED"]
        fail.append(f"## {r['filename']} — {r['status']}\n\n" + ("\n".join(f"- {i}" for i in issues) or "- none") + "\n\n")
    (out / "failure-report.md").write_text("".join(fail), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())

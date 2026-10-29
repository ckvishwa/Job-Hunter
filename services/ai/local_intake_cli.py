"""Local, offline intake of candidate documents into private drafts.

    .venv\\Scripts\\python.exe services/ai/local_intake_cli.py --input-dir "<folder>" --out-dir "F:\\JobHunterPrivate\\drafts"

Reads every .pdf and .docx directly in the folder, extracts text with the
service's own extractor, and writes one private draft per document. It does not
decide anything about the candidate: every draft is an input to review.

Privacy rules this CLI enforces rather than documents:

  * the output directory must be outside every Git checkout, or the run stops
    with PRIVATE_OUTPUT_INSIDE_REPO before a byte is read;
  * stdout carries pseudonymous document ids, status codes, counts and timings
    only. No file name, no extracted text, no error text from the document.
    `--show-names` is opt-in for interactive use on a private terminal;
  * offline is the default: the network guard is installed before any document
    library is imported, and missing dependencies end the run.

The id -> file name map lives in the private manifest, never in stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import sys
import time
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import offline_guard  # noqa: E402
from app.offline_guard import (  # noqa: E402
    EXIT_OK,
    EXIT_PRIVACY_VIOLATION,
    EXIT_USAGE,
)

DRAFT_SCHEMA = "local-intake-draft/4"
MANIFEST_SCHEMA = "local-intake-manifest/1"
SUPPORTED_SUFFIXES = (".pdf", ".docx")


def find_repo_root(start: Path) -> Path | None:
    """The nearest ancestor holding a .git entry (a worktree's .git is a file)."""
    for directory in [start, *start.parents]:
        if (directory / ".git").exists():
            return directory
    return None


def load_or_create_salt(private_root: Path) -> str:
    """A per-machine salt so a pseudonymous id cannot be recomputed from the file alone."""
    path = private_root / ".intake-salt"
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if len(value) >= 32:
            return value
    value = secrets.token_hex(32)
    path.write_text(value, encoding="utf-8")
    return value


def document_id(salt: str, source_sha256: str) -> str:
    return "doc-" + hashlib.sha256(f"{salt}|{source_sha256}".encode("utf-8")).hexdigest()[:12]


def candidate_id(salt: str, source_sha256: str) -> str:
    return "cand-" + hashlib.sha256(f"{salt}|candidate|{source_sha256}".encode("utf-8")).hexdigest()[:12]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover(paths: list[Path], input_dir: Path | None) -> list[Path]:
    found: list[Path] = []
    if input_dir:
        found.extend(p for p in sorted(input_dir.iterdir()) if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES)
    found.extend(p for p in paths if p.is_file())
    # Stable, case-insensitive order so a re-run processes documents identically.
    unique: dict[str, Path] = {}
    for path in found:
        unique.setdefault(str(path.resolve()).lower(), path)
    return sorted(unique.values(), key=lambda p: p.name.lower())


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--input-dir", type=Path, help="folder of .pdf/.docx documents (not searched recursively)")
    parser.add_argument("--file", type=Path, action="append", default=[], help="a single document; repeatable")
    parser.add_argument("--out-dir", type=Path, required=True, help="private output folder, outside every Git checkout")
    parser.add_argument("--allow-network", action="store_true", help="disable the offline guard (not for candidate data)")
    parser.add_argument("--show-names", action="store_true", help="print file names (private terminal only)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing draft for the same document")
    args = parser.parse_args(argv)

    if not args.input_dir and not args.file:
        print("USAGE one of --input-dir or --file is required")
        return EXIT_USAGE

    out_dir: Path = args.out_dir.resolve()
    repo = find_repo_root(out_dir if out_dir.exists() else out_dir.parent)
    if repo is not None:
        print("PRIVACY_VIOLATION PRIVATE_OUTPUT_INSIDE_REPO")
        print(f"The output folder is inside a Git checkout rooted at {repo}. Choose a folder outside every checkout.")
        return EXIT_PRIVACY_VIOLATION
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.allow_network:
        print("WARNING network guard disabled by --allow-network; do not use this for candidate documents")
        report = offline_guard.require_dependencies()
        if not report.ok:
            print(f"DEPENDENCY_UNAVAILABLE missing={','.join(report.missing)}")
            return offline_guard.EXIT_DEPENDENCY_UNAVAILABLE
    else:
        report = offline_guard.enforce()

    # Imported after the guard is installed, so an import-time call home would trip it.
    from app.candidate_reading import read_resume  # noqa: PLC0415
    from app.local_intake import INTAKE_REVISION, intake_bytes  # noqa: PLC0415

    documents = discover(list(args.file), args.input_dir)
    if not documents:
        print("NO_DOCUMENTS 0 supported files found")
        return EXIT_OK

    salt = load_or_create_salt(out_dir)
    started = time.time()
    rows: list[dict] = []
    counts: dict[str, int] = {}

    print(f"MODE offline={not args.allow_network} revision={INTAKE_REVISION} deps={json.dumps(report.versions, sort_keys=True)}")
    print(f"DOCUMENTS {len(documents)}")

    for position, path in enumerate(documents, start=1):
        begin = time.time()
        source_sha = sha256_file(path)
        doc_id = document_id(salt, source_sha)
        cand_id = candidate_id(salt, source_sha)
        draft_path = out_dir / f"{doc_id}.draft.json"
        if draft_path.exists() and not args.force:
            counts["SKIPPED_EXISTING"] = counts.get("SKIPPED_EXISTING", 0) + 1
            print(f"[{position}/{len(documents)}] {doc_id} SKIPPED_EXISTING")
            rows.append({"documentId": doc_id, "fileName": path.name, "sourceSha256": source_sha, "status": "SKIPPED_EXISTING"})
            continue

        data = path.read_bytes()
        result = intake_bytes(data, path.suffix.lower().lstrip("."))
        elapsed_ms = int((time.time() - begin) * 1000)
        counts[result.status] = counts.get(result.status, 0) + 1

        # Every category is read by the existing deterministic parser, over the text this
        # extraction produced, so each value is grouped and quoted by rules that already have
        # their own test suites rather than by anything new here.
        reading = read_resume(
            result.text,
            pages=[(page.index, page.start, page.end) for page in result.pages],
        )

        draft = {
            "schema": DRAFT_SCHEMA,
            "intakeRevision": INTAKE_REVISION,
            "documentId": doc_id,
            "candidateId": cand_id,
            "fileName": path.name,
            "fileType": path.suffix.lower().lstrip("."),
            "byteSize": len(data),
            "sourceSha256": source_sha,
            "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "status": result.status,
            "readingOrder": result.reading_order,
            "failure": None if result.failure_code is None else {"code": result.failure_code, "message": result.failure_message},
            "pageCount": result.page_count,
            "pages": [asdict(page) for page in result.pages],
            "warnings": sorted(set(result.warnings)),
            "metrics": result.metrics,
            "textSha256": result.text_sha256,
            "text": result.text,
            "lines": [asdict(line) for line in result.lines],
            "reading": reading.to_json(),
            "reviewStatus": "PENDING_REVIEW",
            "approval": {"approvedBy": None, "approvedAt": None},
        }
        tmp = draft_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, draft_path)

        name = f" {path.name}" if args.show_names else ""
        warn = ",".join(draft["warnings"]) or "-"
        print(
            f"[{position}/{len(documents)}] {doc_id} {result.status} pages={result.page_count} "
            f"lines={len(result.lines)} order={result.reading_order} "
            f"facts={{{','.join(f'{k}={v}' for k, v in reading.counts.items() if v)}}} warnings={warn} ms={elapsed_ms}{name}"
        )
        rows.append(
            {
                "documentId": doc_id,
                "candidateId": cand_id,
                "fileName": path.name,
                "sourceSha256": source_sha,
                "byteSize": len(data),
                "status": result.status,
                "failureCode": result.failure_code,
                "pageCount": result.page_count,
                "warnings": draft["warnings"],
                "proposed": reading.counts,
                "elapsedMs": elapsed_ms,
            }
        )

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "intakeRevision": INTAKE_REVISION,
        "offline": not args.allow_network,
        "dependencies": report.versions,
        "ranAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsedMs": int((time.time() - started) * 1000),
        "documentCount": len(documents),
        "statusCounts": counts,
        "documents": rows,
    }
    manifest_path = out_dir / "intake-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print("STATUS " + " ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    print(f"ELAPSED_MS {manifest['elapsedMs']}")
    print("DRAFTS_WRITTEN " + str(sum(1 for r in rows if r["status"] != "SKIPPED_EXISTING")))
    print("MANIFEST intake-manifest.json (in the private output folder; holds the id to file-name map)")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

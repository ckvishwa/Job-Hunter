"""Assemble per-document review bundles for the annotation pilot.

Each bundle points a human reviewer at everything needed to turn one draft
into a labelled example: the rendered page, the box overlay, the reading-order
line dump, the extraction warnings, the word TSV and the relation proposals -
plus a checklist that has to be signed before the draft counts as reviewed.

Nothing here reviews anything. It only makes review possible and records what
is still outstanding.

CLI::

    python -m src.pilot --annotations private-runtime/dataset-01/annotations \\
        --review private-runtime/dataset-01/review-columns \\
        --inventory private-runtime/dataset-01/inventory.json \\
        --out private-runtime/dataset-01/pilot
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Sequence

from src.annotate import (
    AnnotationDraft,
    _suggested_spans,
    build_draft,
    load_draft,
    write_draft,
    write_relation_tsvs,
)
from src.parser import ResumeDocumentParser
from src.review import _safe_stem, review_document

LOGGER = logging.getLogger(__name__)

CHECKLIST = (
    "Open the overlay and confirm every box encloses exactly its word "
    "(no shift, no clipping, no merged neighbours).",
    "Follow the reading-order path: does it run down one column before the next? "
    "Note any place it jumps.",
    "Fill `final_label` for every row of the TSV. Entity rows first, then bulk-fill "
    "the remainder with `O` - an empty cell stays UNREVIEWED and blocks promotion.",
    "Check each suggested span: the proposals come from a keyword baseline and are "
    "wrong often. Rejecting one means writing the correct label, not leaving it blank.",
    "Verify every employment record: employer, title, start and end must each point at "
    "words that are really on the page. Where the document does not say, mark the "
    "record AMBIGUOUS - do not infer a month, an employer or an end date.",
    "Verify every education record the same way (degree, school).",
    "Keep the original date precision: if the page says `2024`, do not write `Jan 2024`.",
    "Confirm the document is what the family file claims (layout family, content kind).",
    "Sign: set `reviewer` and `status` on the draft via "
    "`python -m src.annotate --apply <draft.json> --tsv <reviewed.tsv> --reviewer <name>`.",
)


def _inventory_index(path: Path | None) -> dict[str, dict[str, Any]]:
    if not path or not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {document["filename"]: document for document in payload.get("documents", [])}


def _relative(target: Path, start: Path) -> str:
    try:
        return target.resolve().relative_to(start.resolve()).as_posix()
    except ValueError:
        return target.resolve().as_posix()


def build_bundle(
    draft: AnnotationDraft,
    review_dir: Path,
    inventory: dict[str, dict[str, Any]],
    out_dir: Path,
) -> dict[str, Any]:
    """Write one document's review checklist and return its summary row."""
    pdf_path = Path(draft.pdf_path)
    document_review = review_dir / _safe_stem(pdf_path)
    record = inventory.get(pdf_path.name, {})

    page_rows: list[str] = []
    warnings: list[str] = []
    for page in draft.pages:
        preview = document_review / f"page{page.page_index:02d}-preview.png"
        overlay = document_review / f"page{page.page_index:02d}-overlay.png"
        page_rows.append(
            f"| {page.page_index} | {page.source} | {len(page.words)} | "
            f"[preview]({_relative(preview, out_dir)}) | [overlay]({_relative(overlay, out_dir)}) |"
        )
    for page_record in record.get("pages", []):
        for warning in page_record.get("warnings", []):
            warnings.append(f"page {page_record['page_index']}: {warning}")
        if page_record.get("reading_order_backsteps"):
            warnings.append(
                f"page {page_record['page_index']}: "
                f"{page_record['reading_order_backsteps']} reading-order backsteps in the "
                "native order (this draft was built with the column reflow)"
            )
    warnings.extend(record.get("warnings", []))

    suggestion_rows: list[str] = []
    for page in draft.pages:
        for entity, start, end, text in _suggested_spans(page):
            suggestion_rows.append(
                f"| {page.page_index} | {start}:{end} | {entity} | {text[:70]} | | |"
            )

    employment_rows = [
        "| {id} | {title} | {employer} | {start} | {end} | {missing} | {status} | |".format(
            id=record_.record_id.split("#")[-1],
            title=record_.job_title.text[:40] if record_.job_title else "-",
            employer=record_.employer.text[:40] if record_.employer else "-",
            start=record_.start_date.text if record_.start_date else "-",
            end=record_.end_date.text if record_.end_date else "-",
            missing=", ".join(record_.missing) or "-",
            status=record_.status,
        )
        for record_ in draft.employment
    ]
    education_rows = [
        "| {id} | {degree} | {school} | {missing} | {status} | |".format(
            id=record_.record_id.split("#")[-1],
            degree=record_.degree.text[:40] if record_.degree else "-",
            school=record_.school.text[:40] if record_.school else "-",
            missing=", ".join(record_.missing) or "-",
            status=record_.status,
        )
        for record_ in draft.education
    ]

    draft_dir = Path(draft.pdf_path).parent  # only used for display
    annotations_dir = out_dir.parent / "annotations"
    lines = [
        f"# Review checklist - {draft.doc_id}",
        "",
        "> Contains résumé content. Private evidence: never commit.",
        "",
        "## Document",
        "",
        f"- source PDF: `{pdf_path}`",
        f"- sha256: `{draft.source_sha256}`",
        f"- template family: **{draft.template_family}** (assigned by `{draft.family_source}`)",
        f"- content kind: **{draft.content_kind}**",
        f"- reading order used: `{draft.reading_order}`",
        f"- words: {draft.word_count} | entity suggestions: {draft.suggested_word_count} "
        f"| employment proposals: {len(draft.employment)} | education proposals: {len(draft.education)}",
        f"- draft: [`{draft.doc_id}.json`]({_relative(annotations_dir / (draft.doc_id + '.json'), out_dir)})",
        f"- word TSV: [`{draft.doc_id}.review.tsv`]({_relative(annotations_dir / (draft.doc_id + '.review.tsv'), out_dir)})",
        f"- reading-order line dump: [`lines.txt`]({_relative(document_review / 'lines.txt', out_dir)})",
        f"- status: **{draft.status}**, reviewer: {draft.reviewer or '_none_'}",
        "",
        "## Pages",
        "",
        "| page | source | words | preview | overlay |",
        "|---|---|---|---|---|",
        *page_rows,
        "",
        "## Extraction warnings",
        "",
    ]
    lines += [f"- {warning}" for warning in warnings] or ["- none recorded"]
    lines += [
        "",
        "## Suggested entity spans (UNREVIEWED proposals from the rules stand-in)",
        "",
        "| page | span | suggested | text | correct? (y/n) | final label |",
        "|---|---|---|---|---|---|",
        *(suggestion_rows or ["| - | - | - | no suggestions | | |"]),
        "",
        "## Employment relation proposals (UNREVIEWED)",
        "",
        "| record | title | employer | start | end | missing | status | reviewed status |",
        "|---|---|---|---|---|---|---|---|",
        *(employment_rows or ["| - | - | - | - | - | - | - | |"]),
        "",
        "## Education relation proposals (UNREVIEWED)",
        "",
        "| record | degree | school | missing | status | reviewed status |",
        "|---|---|---|---|---|---|",
        *(education_rows or ["| - | - | - | - | - | |"]),
        "",
        "## Checklist",
        "",
    ]
    lines += [f"- [ ] {item}" for item in CHECKLIST]
    lines += ["", f"Reviewer: ______________________   Date: ____________", ""]

    out_dir.mkdir(parents=True, exist_ok=True)
    checklist_path = out_dir / f"{draft.doc_id}.checklist.md"
    checklist_path.write_text("\n".join(lines), encoding="utf-8")

    return {
        "doc_id": draft.doc_id,
        "template_family": draft.template_family,
        "content_kind": draft.content_kind,
        "words": draft.word_count,
        "reviewed_words": draft.reviewed_word_count,
        "suggestions": draft.suggested_word_count,
        "employment": len(draft.employment),
        "education": len(draft.education),
        "status": draft.status,
        "checklist": str(checklist_path),
        "warnings": warnings,
    }



# --------------------------------------------------------------------------- #
# Single-document review package
# --------------------------------------------------------------------------- #
PACKAGE_INSTRUCTIONS = """# Human review instructions - {doc_id}

> Private. Contains resume content; this directory is gitignored.

Source PDF : `{pdf_path}`
SHA-256    : `{sha256}`
Family     : **{family}** ({content_kind})
Extraction : `{extraction_revision}` (reading order `{reading_order}`)
Tokens     : {word_count} across {page_count} page(s)
Current annotation revision: `{revision}`

Nothing here is approved. Every label stays UNREVIEWED until you write it.

## 1. Check the extraction first

Open `{overlay_name}` beside `{preview_name}`.

- Does every box enclose exactly its word? Note shifted, clipped or merged boxes.
- Does the faint path run down one column before starting the next?
- If the extraction is wrong, stop and fix extraction before labelling. A review
  recorded against a wrong extraction is worse than no review.

## 2. Label the words

Open `{tsv_name}` in a spreadsheet (tab separated, UTF-8).

- Fill **final_label** for every row. An empty cell stays UNREVIEWED and blocks promotion.
- `suggested` comes from a keyword baseline and is often wrong. Confirm or replace it;
  never copy the column wholesale.
- Valid labels: `O`, plus `B-`/`I-` for NAME, EMPLOYER, JOB_TITLE, DATE, SKILL, DEGREE, SCHOOL.
- Label what the page says, not what you infer. A heading such as EXPERIENCE is `O`.
- Do not edit `page`, `index`, `text` or `box`: the validator compares them against the
  saved extraction and rejects the file if they drift.

Apply the labels:

    python -m src.annotate --apply "{draft_name}" --tsv "{tsv_name}" --reviewer "<your name>"

## 3. Review the relationships

`{employment_name}` and `{education_name}` hold the proposed records.

- Set `final_status` to REVIEWED when employer / title / dates (or degree / school) are all
  correct, or AMBIGUOUS when the document genuinely does not say.
- Do not invent a month, an employer or an end date. Missing stays missing.
- Keep the original date precision: if the page says 2024, do not write Jan 2024.
- To move which words a record points at, edit the span in `{draft_name}`; the TSV cannot
  do that, by design.

## 4. Sign the manifest

Edit `{manifest_name}`:

    "review_status": "APPROVED",
    "reviewer": "<your name or handle>",
    "reviewed_at": "<ISO-8601 timestamp>",
    "annotation_revision": "<revision printed by --validate after your labels are applied>"

If the document truly has no entities, also set `"empty_document_confirmed": true`.

## 5. Validate, then promote

    python -m src.validate_annotations --draft "{draft_name}"
    python -m src.validate_annotations --draft "{draft_name}" --promote --to <training annotations dir>

The validator re-hashes the PDF, re-checks every token against the extraction, re-checks BIO
and relationship types, and only then promotes. Expect REVIEW_PENDING until step 4 is done.
"""


def build_review_package(
    pdf_path: Path,
    out_dir: Path,
    template_family: str = "unassigned",
    family_source: str = "unassigned",
    content_kind: str = "unknown",
    reading_order: str = "columns",
    dpi: int = 150,
) -> dict[str, Any]:
    """Assemble one document's complete human-review package.

    Reuses the existing draft builder, renderer, relationship exporter and
    manifest initialiser; it adds no second annotation format.
    """
    from src.validate_annotations import (
        annotation_revision,
        init_manifest,
        manifest_path_for,
        validate_annotation,
    )

    package_dir = out_dir / _safe_stem(pdf_path)
    package_dir.mkdir(parents=True, exist_ok=True)

    parser = ResumeDocumentParser(keep_images=True, render_dpi=dpi, reading_order=reading_order)
    draft = build_draft(
        pdf_path,
        parser,
        template_family=template_family,
        family_source=family_source,
        content_kind=content_kind,
    )
    draft_path, tsv_path = write_draft(draft, package_dir)
    employment_path, education_path = write_relation_tsvs(draft, package_dir)
    # review_document creates its own <stem> directory, which IS package_dir.
    rendered = review_document(pdf_path, out_dir, parser, dpi=dpi)
    manifest_path = manifest_path_for(draft_path)
    init_manifest(draft, manifest_path)

    first_page = rendered["pages"][0]
    instructions = PACKAGE_INSTRUCTIONS.format(
        doc_id=draft.doc_id,
        pdf_path=pdf_path,
        sha256=draft.source_sha256,
        family=draft.template_family,
        content_kind=draft.content_kind,
        extraction_revision=draft.extraction_revision,
        reading_order=draft.reading_order,
        word_count=draft.word_count,
        page_count=len(draft.pages),
        revision=annotation_revision(draft),
        preview_name=Path(first_page["preview"]).relative_to(package_dir).as_posix(),
        overlay_name=Path(first_page["overlay"]).relative_to(package_dir).as_posix(),
        tsv_name=tsv_path.name,
        draft_name=draft_path.name,
        employment_name=employment_path.name,
        education_name=education_path.name,
        manifest_name=manifest_path.name,
    )
    instructions_path = package_dir / "INSTRUCTIONS.md"
    instructions_path.write_text(instructions, encoding="utf-8")

    result = validate_annotation(draft, tsv_path=tsv_path, manifest=None, pdf_path=pdf_path)
    (package_dir / "validation.json").write_text(
        json.dumps(result.as_dict(), indent=2), encoding="utf-8"
    )

    return {
        "doc_id": draft.doc_id,
        "package_dir": str(package_dir),
        "draft": str(draft_path),
        "tsv": str(tsv_path),
        "employment_tsv": str(employment_path),
        "education_tsv": str(education_path),
        "manifest": str(manifest_path),
        "instructions": str(instructions_path),
        "pages": [
            {"preview": page["preview"], "overlay": page["overlay"]} for page in rendered["pages"]
        ],
        "word_count": draft.word_count,
        "employment": len(draft.employment),
        "education": len(draft.education),
        "annotation_revision": annotation_revision(draft),
        "status": result.status,
    }


def run(args: argparse.Namespace) -> int:
    if args.package:
        summary = build_review_package(
            Path(args.package),
            Path(args.out),
            template_family=args.template_family,
            family_source=args.family_source,
            content_kind=args.content_kind,
            reading_order=args.reading_order,
        )
        print(f"review package for {summary['doc_id']} -> {summary['package_dir']}")
        for key in ("draft", "tsv", "employment_tsv", "education_tsv", "manifest", "instructions"):
            print(f"  {key:<16} {Path(summary[key]).name}")
        for index, page in enumerate(summary["pages"]):
            print(f"  page {index:<11} {Path(page['preview']).name}, {Path(page['overlay']).name}")
        print(f"  words            {summary['word_count']}")
        print(f"  relationships    {summary['employment']} employment, {summary['education']} education")
        print(f"  revision         {summary['annotation_revision']}")
        print(f"  status           {summary['status']}")
        return 0

    if not args.annotations or not args.review:
        print("ERROR: --annotations and --review are required without --package", file=sys.stderr)
        return 1
    annotations = Path(args.annotations)
    if not annotations.is_dir():
        print(f"ERROR: not a directory: {annotations}", file=sys.stderr)
        return 1
    drafts = [load_draft(path) for path in sorted(annotations.glob("*.json"))]
    if not drafts:
        print(f"ERROR: no drafts in {annotations}", file=sys.stderr)
        return 1
    if args.limit:
        drafts = drafts[: args.limit]

    inventory = _inventory_index(Path(args.inventory) if args.inventory else None)
    out_dir = Path(args.out)
    rows = [build_bundle(draft, Path(args.review), inventory, out_dir) for draft in drafts]

    index_lines = [
        "# Annotation pilot - review bundles",
        "",
        "> Private evidence: résumé content, never commit.",
        "",
        f"- documents: {len(rows)}",
        f"- words: {sum(row['words'] for row in rows)}",
        f"- reviewed words: {sum(row['reviewed_words'] for row in rows)}",
        f"- employment proposals: {sum(row['employment'] for row in rows)}",
        f"- education proposals: {sum(row['education'] for row in rows)}",
        "",
        "| doc | family | content | words | reviewed | suggestions | emp | edu | status | checklist |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        index_lines.append(
            f"| {row['doc_id'][:34]} | {row['template_family']} | {row['content_kind']} | "
            f"{row['words']} | {row['reviewed_words']} | {row['suggestions']} | "
            f"{row['employment']} | {row['education']} | {row['status']} | "
            f"[checklist]({_relative(Path(row['checklist']), out_dir)}) |"
        )
    index_lines += [
        "",
        "Promotion gate: a draft reaches `data/annotations/` only when every word has a "
        "reviewed label and `status=REVIEWED` (`python -m src.annotate --promote`).",
        "",
    ]
    (out_dir / "INDEX.md").write_text("\n".join(index_lines), encoding="utf-8")
    (out_dir / "pilot.json").write_text(json.dumps({"documents": rows}, indent=2), encoding="utf-8")

    print(f"wrote {len(rows)} review bundle(s) to {out_dir}")
    print(f"  {out_dir / 'INDEX.md'}")
    pending = sum(row["words"] - row["reviewed_words"] for row in rows)
    print(f"  pending word labels: {pending}")
    return 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.pilot",
        description="Assemble per-document review bundles for the annotation pilot.",
    )
    cli.add_argument("--annotations", default=None, help="Directory of annotation drafts")
    cli.add_argument("--review", default=None, help="Directory of rendered previews/overlays")
    cli.add_argument("--package", default=None, help="Build a full review package for this PDF")
    cli.add_argument("--template-family", default="unassigned")
    cli.add_argument("--family-source", default="unassigned")
    cli.add_argument("--content-kind", default="unknown")
    cli.add_argument("--reading-order", choices=("native", "columns"), default="columns")
    cli.add_argument("--inventory", default=None, help="inventory.json for warnings")
    cli.add_argument("--out", required=True, help="Bundle output directory (private)")
    cli.add_argument("--limit", type=int, default=None)
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

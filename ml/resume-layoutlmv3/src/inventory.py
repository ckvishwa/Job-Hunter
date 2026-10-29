"""Read-only inventory of a résumé corpus: hashes, geometry, duplicates, layout.

Nothing here writes to the source directory. For each document it records what
the training harness needs to know before any labelling happens:

* SHA-256, kind (pdf / image), page count and page dimensions
* native-text availability and extracted word count per page
* whether a page would fall back to OCR (``< MIN_NATIVE_WORDS`` native words)
* bounding-box validity (grid range, inversion, degenerate and overlap rates)
* reading-order and column-separation observations
* exact-duplicate and near-duplicate groups (text shingles + layout signature)
* a *provisional* layout family, which is a machine guess to be confirmed by
  looking at the rendered pages - never the final ``template_family``

CLI::

    python -m src.inventory --pdf-dir ../../data/Resumes --out private-runtime/dataset-01
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from src.parser import (
    MIN_NATIVE_WORDS,
    ParsedDocument,
    ParserError,
    ResumeDocumentParser,
    _detect_gutter,
)

LOGGER = logging.getLogger(__name__)

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
PDF_SUFFIXES = {".pdf"}

#: Jaccard thresholds over 5-word shingles.
DUPLICATE_THRESHOLD = 0.85
NEAR_DUPLICATE_THRESHOLD = 0.50
#: Layout-signature distance below which two documents look like one template.
LAYOUT_SAME_FAMILY = 0.12


# --------------------------------------------------------------------------- #
# Records
# --------------------------------------------------------------------------- #
@dataclass
class PageRecord:
    """Per-page extraction facts."""

    page_index: int
    width: float
    height: float
    native_word_count: int
    ocr_required: bool
    source_used: str
    ocr_word_count: int | None = None
    boxes_out_of_grid: int = 0
    boxes_inverted: int = 0
    boxes_degenerate: int = 0
    overlap_rate: float = 0.0
    gutter_x: float | None = None
    words_crossing_gutter: int = 0
    reading_order_backsteps: int = 0
    warnings: list[str] = field(default_factory=list)


@dataclass
class DocumentRecord:
    """Everything the inventory knows about one file."""

    filename: str
    sha256: str
    kind: str
    size_bytes: int
    supported: bool
    page_count: int = 0
    total_words: int = 0
    pages: list[PageRecord] = field(default_factory=list)
    has_native_text: bool = False
    ocr_pages: int = 0
    provisional_family: str = "unassigned"
    layout_signature: dict[str, Any] = field(default_factory=dict)
    duplicate_of: str | None = None
    near_duplicates: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    text_preview: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def classify_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in PDF_SUFFIXES:
        return "pdf"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    return "other"


def _box_checks(boxes: Sequence[Sequence[int]]) -> tuple[int, int, int, float]:
    """Return (out_of_grid, inverted, degenerate, overlap_rate)."""
    out_of_grid = inverted = degenerate = 0
    for box in boxes:
        x0, y0, x1, y1 = box
        if not all(0 <= value <= 1000 for value in box):
            out_of_grid += 1
        if x1 < x0 or y1 < y0:
            inverted += 1
        if x1 == x0 or y1 == y0:
            degenerate += 1

    overlaps = 0
    comparisons = 0
    ordered = sorted(range(len(boxes)), key=lambda index: (boxes[index][1], boxes[index][0]))
    for position, index in enumerate(ordered):
        for other in ordered[position + 1 : position + 6]:  # local window only
            comparisons += 1
            a, b = boxes[index], boxes[other]
            if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                overlaps += 1
    return out_of_grid, inverted, degenerate, (overlaps / comparisons if comparisons else 0.0)


def _reading_order_backsteps(boxes: Sequence[Sequence[int]], gutter: float | None) -> int:
    """Count places where the emitted order jumps upwards inside one column.

    A few backsteps are normal (superscripts, inline runs); many mean the
    extraction order does not follow how a human reads the page.
    """
    backsteps = 0
    previous_column = None
    previous_y = -1
    for box in boxes:
        column = 0 if gutter is None or (box[0] + box[2]) / 2 < gutter else 1
        if column == previous_column and box[1] + 8 < previous_y:
            backsteps += 1
        previous_column, previous_y = column, box[1]
    return backsteps


def _density_grid(boxes: Sequence[Sequence[int]], rows: int = 4, columns: int = 4) -> list[float]:
    """Fraction of words whose centre falls in each cell of a 4x4 page grid."""
    cells = [0.0] * (rows * columns)
    if not boxes:
        return cells
    for box in boxes:
        centre_x = (box[0] + box[2]) / 2
        centre_y = (box[1] + box[3]) / 2
        column = min(columns - 1, int(centre_x / (1000 / columns)))
        row = min(rows - 1, int(centre_y / (1000 / rows)))
        cells[row * columns + column] += 1
    total = float(len(boxes))
    return [round(count / total, 4) for count in cells]


def _shingles(words: Sequence[str], size: int = 5) -> set[str]:
    """Normalised word 5-grams, used for near-duplicate detection."""
    tokens = [word.lower().strip(".,:;()[]") for word in words if word.strip()]
    if len(tokens) < size:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[index : index + size]) for index in range(len(tokens) - size + 1)}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def layout_signature(document: ParsedDocument) -> dict[str, Any]:
    """Coarse structural fingerprint: geometry, columns and ink distribution."""
    first = document.pages[0] if document.pages else None
    boxes = [word.box for word in first.words] if first else []
    px_boxes = [
        (box[0], box[1], box[2], box[3]) for box in boxes
    ]
    gutter = _detect_gutter(px_boxes, 1000.0) if px_boxes else None

    left_mass = right_mass = 0
    if gutter is not None:
        for box in boxes:
            if (box[0] + box[2]) / 2 < gutter:
                left_mass += 1
            else:
                right_mass += 1

    heights = [box[3] - box[1] for box in boxes] or [0]
    return {
        "page_width": round(first.width, 1) if first else 0.0,
        "page_height": round(first.height, 1) if first else 0.0,
        "aspect": round((first.width / first.height) if first and first.height else 0.0, 4),
        "word_count": len(boxes),
        "median_word_height": round(statistics.median(heights), 2),
        "gutter_x": None if gutter is None else round(gutter, 1),
        "left_mass_share": round(left_mass / len(boxes), 4) if boxes and gutter else None,
        "density_grid": _density_grid(boxes),
    }


def _signature_distance(left: dict[str, Any], right: dict[str, Any]) -> float:
    """L1 distance over the density grid plus penalties for geometry mismatch."""
    grid_left = left.get("density_grid") or []
    grid_right = right.get("density_grid") or []
    if len(grid_left) != len(grid_right) or not grid_left:
        return 1.0
    distance = sum(abs(a - b) for a, b in zip(grid_left, grid_right)) / 2.0
    if abs((left.get("aspect") or 0) - (right.get("aspect") or 0)) > 0.02:
        distance += 0.25
    if (left.get("gutter_x") is None) != (right.get("gutter_x") is None):
        distance += 0.25
    return distance


def describe_layout(signature: dict[str, Any]) -> str:
    """Name the provisional layout guess from the signature alone."""
    gutter = signature.get("gutter_x")
    share = signature.get("left_mass_share")
    if gutter is None:
        return "single-column"
    if share is None:
        return "two-column"
    if gutter < 420 and share < 0.42:
        return "left-sidebar"
    if gutter > 580 and share > 0.58:
        return "right-sidebar"
    return "two-column"


# --------------------------------------------------------------------------- #
# Inspection
# --------------------------------------------------------------------------- #
def inspect_document(
    path: Path,
    parser: ResumeDocumentParser,
    run_ocr: bool = False,
) -> DocumentRecord:
    """Hash, parse and measure one file without modifying it."""
    kind = classify_kind(path)
    record = DocumentRecord(
        filename=path.name,
        sha256=sha256_file(path),
        kind=kind,
        size_bytes=path.stat().st_size,
        supported=kind == "pdf",
    )
    if kind != "pdf":
        record.warnings.append(
            f"{kind} input: src.parser accepts PDFs only; needs a separate image adapter "
            "before it can be parsed or labelled"
        )
        return record

    try:
        document = parser.parse(path)
    except ParserError as exc:
        record.supported = False
        record.warnings.append(f"parse failed: {exc}")
        return record

    record.page_count = len(document.pages)
    record.total_words = document.word_count
    record.layout_signature = layout_signature(document)
    record.provisional_family = describe_layout(record.layout_signature)

    all_words: list[str] = []
    for page in document.pages:
        boxes = [word.box for word in page.words]
        out_of_grid, inverted, degenerate, overlap_rate = _box_checks(boxes)
        gutter = _detect_gutter([tuple(box) for box in boxes], 1000.0) if boxes else None
        page_record = PageRecord(
            page_index=page.page_index,
            width=round(page.width, 2),
            height=round(page.height, 2),
            native_word_count=len(page.words) if page.source == "native" else 0,
            ocr_required=len(page.words) < MIN_NATIVE_WORDS and page.source == "native",
            source_used=page.source,
            boxes_out_of_grid=out_of_grid,
            boxes_inverted=inverted,
            boxes_degenerate=degenerate,
            overlap_rate=round(overlap_rate, 4),
            gutter_x=None if gutter is None else round(gutter, 1),
            words_crossing_gutter=0
            if gutter is None
            else sum(1 for box in boxes if box[0] < gutter < box[2]),
            reading_order_backsteps=_reading_order_backsteps(boxes, gutter),
        )
        if page.source == "ocr":
            page_record.ocr_required = True
            page_record.ocr_word_count = len(page.words)
        if not page.words:
            page_record.warnings.append("no words extracted")
        if out_of_grid:
            page_record.warnings.append(f"{out_of_grid} boxes outside the 0-1000 grid")
        if degenerate:
            page_record.warnings.append(f"{degenerate} zero-area boxes")
        if page_record.words_crossing_gutter > 2:
            page_record.warnings.append(
                f"{page_record.words_crossing_gutter} words span the detected gutter; "
                "column split is unreliable"
            )
        record.pages.append(page_record)
        all_words.extend(word.text for word in page.words)

    record.has_native_text = any(page.source_used == "native" and page.native_word_count > 0 for page in record.pages)
    record.ocr_pages = sum(1 for page in record.pages if page.ocr_required)
    record.text_preview = " ".join(all_words[:40])
    if record.total_words == 0:
        record.warnings.append("zero words extracted from the whole document")
    if run_ocr and record.ocr_pages:
        record.warnings.append("OCR pass requested; see the OCR columns per page")
    return record


def find_duplicates(
    records: Sequence[DocumentRecord],
    texts: dict[str, set[str]],
) -> None:
    """Fill ``duplicate_of`` / ``near_duplicates`` in place."""
    by_hash: dict[str, str] = {}
    for record in records:
        if record.sha256 in by_hash:
            record.duplicate_of = by_hash[record.sha256]
            record.warnings.append(f"byte-identical to {by_hash[record.sha256]}")
        else:
            by_hash[record.sha256] = record.filename

    for index, record in enumerate(records):
        for other in records[index + 1 :]:
            if record.duplicate_of or other.duplicate_of:
                continue
            similarity = _jaccard(texts.get(record.filename, set()), texts.get(other.filename, set()))
            layout_distance = _signature_distance(record.layout_signature, other.layout_signature)
            if similarity >= DUPLICATE_THRESHOLD:
                relation = "duplicate-text"
            elif similarity >= NEAR_DUPLICATE_THRESHOLD:
                relation = "near-duplicate-text"
            elif layout_distance <= LAYOUT_SAME_FAMILY:
                relation = "same-layout"
            else:
                continue
            entry = {
                "relation": relation,
                "text_jaccard": round(similarity, 4),
                "layout_distance": round(layout_distance, 4),
            }
            record.near_duplicates.append({"other": other.filename, **entry})
            other.near_duplicates.append({"other": record.filename, **entry})


def group_families(records: Sequence[DocumentRecord]) -> dict[str, list[str]]:
    """Cluster documents into provisional families by layout signature distance."""
    groups: list[list[DocumentRecord]] = []
    for record in records:
        if not record.supported or not record.layout_signature:
            continue
        for group in groups:
            if _signature_distance(record.layout_signature, group[0].layout_signature) <= LAYOUT_SAME_FAMILY:
                group.append(record)
                break
        else:
            groups.append([record])

    assignment: dict[str, list[str]] = {}
    for index, group in enumerate(groups, start=1):
        name = f"{group[0].provisional_family}-{index:02d}"
        assignment[name] = [record.filename for record in group]
        for record in group:
            record.provisional_family = name
    return assignment


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def write_reports(
    records: Sequence[DocumentRecord],
    families: dict[str, list[str]],
    out_dir: Path,
    source_dir: Path,
) -> tuple[Path, Path]:
    """Write ``inventory.json`` (machine) and ``inventory.md`` (review)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "source_dir": str(source_dir),
        "file_count": len(records),
        "pdf_count": sum(1 for record in records if record.kind == "pdf"),
        "image_count": sum(1 for record in records if record.kind == "image"),
        "unsupported_count": sum(1 for record in records if not record.supported),
        "page_count": sum(record.page_count for record in records),
        "native_text_documents": sum(1 for record in records if record.has_native_text),
        "ocr_pages": sum(record.ocr_pages for record in records),
        "provisional_families": families,
        "documents": [record.as_dict() for record in records],
    }
    json_path = out_dir / "inventory.json"
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    lines = [
        "# Résumé corpus inventory (private - contains filenames and text previews)",
        "",
        f"- source: `{source_dir}`",
        f"- files: {payload['file_count']} ({payload['pdf_count']} pdf, {payload['image_count']} image)",
        f"- pages: {payload['page_count']}",
        f"- documents with native text: {payload['native_text_documents']}",
        f"- pages needing OCR: {payload['ocr_pages']}",
        f"- provisional layout families: {len(families)}",
        "",
        "| file | sha256 (12) | kind | pages | words | native | ocr pages | provisional family | dup/near-dup | warnings |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for record in records:
        related = record.duplicate_of or ", ".join(
            f"{entry['other']} ({entry['relation']} {entry['text_jaccard']})"
            for entry in record.near_duplicates
        )
        lines.append(
            f"| {record.filename} | `{record.sha256[:12]}` | {record.kind} | {record.page_count} | "
            f"{record.total_words} | {'yes' if record.has_native_text else 'no'} | {record.ocr_pages} | "
            f"{record.provisional_family} | {related or '-'} | "
            f"{'; '.join(record.warnings) or '-'} |"
        )

    lines += ["", "## Provisional families (machine guess - confirm visually)", ""]
    for name, members in families.items():
        lines.append(f"- **{name}**: {', '.join(members)}")

    lines += ["", "## Per-page geometry and extraction checks", ""]
    for record in records:
        if not record.pages:
            continue
        lines.append(f"### {record.filename}")
        lines.append("")
        lines.append(
            "| page | size | source | words | out-of-grid | inverted | zero-area | overlap | gutter | crossing | backsteps | warnings |"
        )
        lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for page in record.pages:
            words = page.ocr_word_count if page.source_used == "ocr" else page.native_word_count
            lines.append(
                f"| {page.page_index} | {page.width:.0f}x{page.height:.0f} | {page.source_used} | {words} | "
                f"{page.boxes_out_of_grid} | {page.boxes_inverted} | {page.boxes_degenerate} | "
                f"{page.overlap_rate} | {page.gutter_x if page.gutter_x is not None else '-'} | "
                f"{page.words_crossing_gutter} | {page.reading_order_backsteps} | "
                f"{'; '.join(page.warnings) or '-'} |"
            )
        lines.append("")

    md_path = out_dir / "inventory.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def run(args: argparse.Namespace) -> int:
    source_dir = Path(args.pdf_dir)
    if not source_dir.is_dir():
        print(f"ERROR: not a directory: {source_dir}", file=sys.stderr)
        return 1

    paths = sorted(path for path in source_dir.iterdir() if path.is_file())
    if not paths:
        print(f"ERROR: no files in {source_dir}", file=sys.stderr)
        return 1

    parser = ResumeDocumentParser(
        keep_images=False, min_native_words=MIN_NATIVE_WORDS, reading_order=args.reading_order
    )
    # Native-only pass: OCR is opt-in per page later, so the inventory stays fast
    # and does not load PaddleOCR for a corpus that may not need it.
    parser.force_ocr = False

    records: list[DocumentRecord] = []
    texts: dict[str, set[str]] = {}
    for path in paths:
        LOGGER.info("inspecting %s", path.name)
        record = inspect_document(path, parser, run_ocr=args.with_ocr)
        records.append(record)
        texts[record.filename] = _shingles(record.text_preview.split())

    # Shingle on the full text, not just the preview, when words were extracted.
    full_parser = ResumeDocumentParser(keep_images=False, reading_order=args.reading_order)
    for record in records:
        if record.kind != "pdf" or not record.supported:
            continue
        try:
            document = full_parser.parse(source_dir / record.filename)
        except ParserError:
            continue
        words = [word.text for page in document.pages for word in page.words]
        texts[record.filename] = _shingles(words)

    find_duplicates(records, texts)
    families = group_families(records)
    json_path, md_path = write_reports(records, families, Path(args.out), source_dir)

    print(f"inventoried {len(records)} files from {source_dir}")
    print(f"  pdf={sum(1 for r in records if r.kind == 'pdf')} "
          f"image={sum(1 for r in records if r.kind == 'image')} "
          f"unsupported={sum(1 for r in records if not r.supported)}")
    print(f"  pages={sum(r.page_count for r in records)} "
          f"words={sum(r.total_words for r in records)} "
          f"ocr_pages={sum(r.ocr_pages for r in records)}")
    print(f"  provisional families={len(families)}")
    for name, members in families.items():
        print(f"    {name}: {len(members)} -> {', '.join(members[:4])}{' ...' if len(members) > 4 else ''}")
    duplicates = [r for r in records if r.duplicate_of]
    if duplicates:
        print(f"  byte-identical duplicates: {len(duplicates)}")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")
    return 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.inventory",
        description="Read-only inventory of a résumé corpus (hashes, geometry, duplicates).",
    )
    cli.add_argument("--pdf-dir", required=True, help="Directory of source documents")
    cli.add_argument("--out", default="private-runtime/dataset-01", help="Private output directory")
    cli.add_argument("--with-ocr", action="store_true", help="Note OCR need per page")
    cli.add_argument(
        "--reading-order",
        choices=("native", "columns"),
        default="native",
        help="Word order: PyMuPDF block order, or column-first through the gutter",
    )
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

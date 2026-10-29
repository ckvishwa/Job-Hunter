"""Render page previews, bounding-box overlays and per-document extraction reports.

A successful extraction call proves nothing about whether the words and boxes
are right. This module makes that checkable by eye: every page gets a preview,
an overlay of the normalised boxes drawn back onto the rendered pixels, and a
report listing the words in emitted (reading) order.

Outputs land in a private directory (gitignored) because they contain résumé
content.

CLI::

    python -m src.review --pdf-dir ../../data/Resumes --out private-runtime/dataset-01/review
    python -m src.review --pdf-dir ../../data/Resumes --contact-sheet --out <dir>
    python -m src.review --pdf "one file.pdf" --out <dir> --dpi 150
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import sys
from pathlib import Path
from typing import Any, Sequence

from PIL import Image, ImageDraw, ImageFont

from src.parser import (
    GRID,
    PageLayout,
    ParsedDocument,
    ParserError,
    ResumeDocumentParser,
    _detect_gutter,
)

LOGGER = logging.getLogger(__name__)

DEFAULT_DPI = 150
#: Colours cycled per text line so adjacent lines stay distinguishable.
LINE_COLOURS = (
    (220, 30, 30),
    (30, 110, 220),
    (20, 150, 70),
    (200, 120, 0),
    (150, 40, 190),
)


def _font(size: int = 13) -> ImageFont.ImageFont:
    for name in ("arial.ttf", "DejaVuSans.ttf", "segoeui.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_overlay(page: PageLayout, image: Image.Image, show_order: bool = True) -> Image.Image:
    """Draw normalised word boxes (and the reading-order path) onto a page image."""
    canvas = image.convert("RGB").copy()
    draw = ImageDraw.Draw(canvas, "RGBA")
    width, height = canvas.size

    def to_pixels(box: Sequence[int]) -> tuple[float, float, float, float]:
        return (
            box[0] / GRID * width,
            box[1] / GRID * height,
            box[2] / GRID * width,
            box[3] / GRID * height,
        )

    gutter = _detect_gutter([tuple(word.box) for word in page.words], float(GRID))
    if gutter is not None:
        x = gutter / GRID * width
        draw.line([(x, 0), (x, height)], fill=(0, 0, 0, 120), width=2)

    centres: list[tuple[float, float]] = []
    for word in page.words:
        x0, y0, x1, y1 = to_pixels(word.box)
        colour = LINE_COLOURS[max(word.line_id, 0) % len(LINE_COLOURS)]
        draw.rectangle([x0, y0, x1, y1], outline=colour + (200,), width=1)
        centres.append(((x0 + x1) / 2, (y0 + y1) / 2))

    if show_order and len(centres) > 1:
        draw.line(centres, fill=(0, 0, 255, 70), width=1)

    legend = f"{len(page.words)} words | source={page.source}"
    if gutter is not None:
        legend += f" | gutter={gutter:.0f}/1000"
    draw.rectangle([0, 0, 8 + 7 * len(legend), 22], fill=(255, 255, 255, 220))
    draw.text((4, 4), legend, fill=(0, 0, 0), font=_font())
    return canvas


def page_report(page: PageLayout) -> dict[str, Any]:
    """Words in emitted order with their boxes, plus line grouping."""
    return {
        "page_index": page.page_index,
        "source": page.source,
        "width": round(page.width, 2),
        "height": round(page.height, 2),
        "word_count": len(page.words),
        "lines": _lines_as_text(page),
        "words": [
            {"i": index, "text": word.text, "box": list(word.box), "line": word.line_id}
            for index, word in enumerate(page.words)
        ],
    }


def _lines_as_text(page: PageLayout) -> list[dict[str, Any]]:
    """Reconstruct reading-order lines so text flow can be checked at a glance."""
    lines: list[dict[str, Any]] = []
    current_line = None
    for word in page.words:
        if current_line is None or word.line_id != current_line["line"]:
            current_line = {"line": word.line_id, "text": word.text, "box": list(word.box)}
            lines.append(current_line)
        else:
            current_line["text"] += " " + word.text
            box = current_line["box"]
            current_line["box"] = [
                min(box[0], word.box[0]),
                min(box[1], word.box[1]),
                max(box[2], word.box[2]),
                max(box[3], word.box[3]),
            ]
    return lines


def review_document(
    pdf_path: Path,
    out_dir: Path,
    parser: ResumeDocumentParser,
    dpi: int = DEFAULT_DPI,
    max_pages: int | None = None,
) -> dict[str, Any]:
    """Render previews/overlays and write an extraction report for one PDF."""
    document: ParsedDocument = parser.parse(pdf_path)
    stem = _safe_stem(pdf_path)
    document_dir = out_dir / stem
    document_dir.mkdir(parents=True, exist_ok=True)

    pages: list[dict[str, Any]] = []
    for page in document.pages:
        if max_pages is not None and page.page_index >= max_pages:
            break
        if page.image is None:
            raise ParserError("parser must run with keep_images=True for review rendering")
        preview_path = document_dir / f"page{page.page_index:02d}-preview.png"
        overlay_path = document_dir / f"page{page.page_index:02d}-overlay.png"
        page.image.save(preview_path)
        draw_overlay(page, page.image).save(overlay_path)

        report = page_report(page)
        report["preview"] = str(preview_path)
        report["overlay"] = str(overlay_path)
        pages.append(report)

    payload = {
        "filename": pdf_path.name,
        "page_count": len(document.pages),
        "word_count": document.word_count,
        "used_ocr": document.used_ocr,
        "pages": pages,
    }
    (document_dir / "extraction.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (document_dir / "lines.txt").write_text(
        "\n".join(
            f"[p{page['page_index']} l{line['line']:>3}] {line['text']}"
            for page in pages
            for line in page["lines"]
        )
        + "\n",
        encoding="utf-8",
    )
    return payload


def _safe_stem(path: Path) -> str:
    """Filesystem-safe directory name for a document."""
    return "".join(character if character.isalnum() else "-" for character in path.stem).strip("-")


def contact_sheet(
    previews: Sequence[tuple[str, Path]],
    out_path: Path,
    thumb_width: int = 320,
    columns: int = 5,
) -> Path:
    """Tile first-page previews with index labels for fast family grouping."""
    if not previews:
        raise ValueError("no previews to tile")
    thumbs: list[tuple[str, Image.Image]] = []
    for label, path in previews:
        image = Image.open(path).convert("RGB")
        ratio = thumb_width / image.width
        thumbs.append((label, image.resize((thumb_width, int(image.height * ratio)))))

    cell_height = max(thumb.height for _, thumb in thumbs) + 26
    rows = math.ceil(len(thumbs) / columns)
    sheet = Image.new("RGB", (columns * thumb_width, rows * cell_height), "white")
    draw = ImageDraw.Draw(sheet)
    font = _font(15)
    for index, (label, thumb) in enumerate(thumbs):
        x = (index % columns) * thumb_width
        y = (index // columns) * cell_height
        draw.text((x + 4, y + 4), label, fill=(0, 0, 0), font=font)
        sheet.paste(thumb, (x, y + 24))
        draw.rectangle([x, y + 24, x + thumb_width - 1, y + 24 + thumb.height - 1], outline=(180, 180, 180))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)
    return out_path


def run(args: argparse.Namespace) -> int:
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.pdf:
        paths = [Path(args.pdf)]
    else:
        source = Path(args.pdf_dir)
        if not source.is_dir():
            print(f"ERROR: not a directory: {source}", file=sys.stderr)
            return 1
        paths = sorted(path for path in source.iterdir() if path.suffix.lower() == ".pdf")
    if not paths:
        print("ERROR: no PDFs to review", file=sys.stderr)
        return 1

    parser = ResumeDocumentParser(
        render_dpi=args.dpi, keep_images=True, reading_order=args.reading_order
    )
    reports: list[dict[str, Any]] = []
    previews: list[tuple[str, Path]] = []
    for index, path in enumerate(paths, start=1):
        try:
            payload = review_document(path, out_dir, parser, dpi=args.dpi, max_pages=args.max_pages)
        except ParserError as exc:
            print(f"FAILED {path.name}: {exc}", file=sys.stderr)
            continue
        reports.append(payload)
        print(f"{index:>2}. {path.name}: {payload['page_count']} page(s), {payload['word_count']} words")
        if payload["pages"]:
            previews.append((f"{index:02d} {path.stem[:34]}", Path(payload["pages"][0]["preview"])))

    index_path = out_dir / "review-index.json"
    index_path.write_text(json.dumps({"documents": reports}, indent=2), encoding="utf-8")
    print(f"wrote {index_path}")

    if args.contact_sheet and previews:
        sheet_paths = []
        batch_size = args.sheet_batch
        for start in range(0, len(previews), batch_size):
            batch = previews[start : start + batch_size]
            path = contact_sheet(
                batch,
                out_dir / f"contact-sheet-{start // batch_size + 1:02d}.png",
                columns=args.sheet_columns,
            )
            sheet_paths.append(path)
            print(f"wrote {path}")
    return 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.review",
        description="Render page previews, box overlays and extraction reports for review.",
    )
    source = cli.add_mutually_exclusive_group(required=True)
    source.add_argument("--pdf-dir", help="Directory of PDFs to review")
    source.add_argument("--pdf", help="A single PDF to review")
    cli.add_argument("--out", required=True, help="Private output directory")
    cli.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    cli.add_argument("--max-pages", type=int, default=None, help="Limit pages per document")
    cli.add_argument("--contact-sheet", action="store_true", help="Also tile first pages")
    cli.add_argument("--sheet-columns", type=int, default=5)
    cli.add_argument("--sheet-batch", type=int, default=10)
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

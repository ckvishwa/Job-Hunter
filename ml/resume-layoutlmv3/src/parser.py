"""Layout-aware resume PDF parser with a PaddleOCR fallback.

Two paths, chosen per page:

* **native** - PyMuPDF (``fitz``) vector word extraction. Used whenever the
  page yields at least :data:`MIN_NATIVE_WORDS` words.
* **ocr** - the page is rendered to a PIL image and pushed through PaddleOCR.
  Used when native extraction finds fewer than :data:`MIN_NATIVE_WORDS` words,
  which is the signature of a flat image-only scan.

Every box leaves this module normalised to the integer ``0-1000`` grid
LayoutLMv3 expects: ``[x0, y0, x1, y1]`` relative to page width and height.

CLI::

    python -m src.parser --sample_pdf data/raw_pdfs/example.pdf
    python -m src.parser --sample_pdf scan.pdf --force-ocr --json out.json
    python -m src.parser --sample_pdf r.pdf --emit-annotation data/annotations/r.json \
        --template-family rendercv
"""

from __future__ import annotations

import argparse
import json
import logging
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Literal, Sequence

try:  # pragma: no cover - import guard
    # PyMuPDF >= 1.24 prefers the `pymupdf` name; `fitz` is the legacy alias and
    # warns on import from 2.0 onwards.
    import pymupdf as fitz
except ImportError:  # pragma: no cover
    try:
        import fitz  # type: ignore[no-redef]
    except ImportError as exc:
        raise ImportError(
            "PyMuPDF is required for parsing. Install it with `pip install pymupdf`."
        ) from exc

from PIL import Image

LOGGER = logging.getLogger(__name__)

#: A page with fewer native words than this is treated as a scan.
MIN_NATIVE_WORDS = 10
#: LayoutLMv3 coordinate grid.
GRID = 1000
#: Render DPI used for the page image (model input and OCR input).
DEFAULT_RENDER_DPI = 150
#: Identifies the extraction behaviour that produced a word stream. Bump this
#: whenever a change would alter the words or boxes of an unchanged PDF: a
#: review recorded against an older revision is then correctly treated as stale.
EXTRACTION_REVISION = "pymupdf-words@1"

SourceKind = Literal["native", "ocr"]
#: How words are ordered on the page. "native" keeps PyMuPDF block/line order;
#: "columns" reflows through the detected gutter so a sidebar is read as one
#: column before the main body (see README, reading-order findings).
ReadingOrder = Literal["native", "columns"]


class ParserError(RuntimeError):
    """Raised when a PDF cannot be parsed into layout features."""


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #
@dataclass
class LayoutWord:
    """One word with its normalised ``0-1000`` box."""

    text: str
    box: tuple[int, int, int, int]
    line_id: int = -1
    confidence: float | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "text": self.text,
            "box": list(self.box),
            "line_id": self.line_id,
        }
        if self.confidence is not None:
            out["confidence"] = round(self.confidence, 4)
        return out


@dataclass
class PageLayout:
    """Words of a single page plus the geometry they were normalised against."""

    page_index: int
    width: float
    height: float
    source: SourceKind
    words: list[LayoutWord] = field(default_factory=list)
    image: Image.Image | None = field(default=None, repr=False)

    @property
    def texts(self) -> list[str]:
        return [w.text for w in self.words]

    @property
    def boxes(self) -> list[list[int]]:
        return [list(w.box) for w in self.words]

    def as_dict(self, include_words: bool = True) -> dict[str, Any]:
        out: dict[str, Any] = {
            "page_index": self.page_index,
            "width": round(self.width, 2),
            "height": round(self.height, 2),
            "source": self.source,
            "word_count": len(self.words),
        }
        if include_words:
            out["words"] = [w.as_dict() for w in self.words]
        return out


@dataclass
class ParsedDocument:
    """All pages of one PDF."""

    pdf_path: Path
    pages: list[PageLayout] = field(default_factory=list)

    @property
    def doc_id(self) -> str:
        return self.pdf_path.stem

    @property
    def sources(self) -> set[SourceKind]:
        return {p.source for p in self.pages}

    @property
    def used_ocr(self) -> bool:
        return "ocr" in self.sources

    @property
    def word_count(self) -> int:
        return sum(len(p.words) for p in self.pages)

    def as_dict(self, include_words: bool = True) -> dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "pdf_path": str(self.pdf_path),
            "page_count": len(self.pages),
            "word_count": self.word_count,
            "used_ocr": self.used_ocr,
            "pages": [p.as_dict(include_words=include_words) for p in self.pages],
        }


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #
def normalize_box(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    width: float,
    height: float,
) -> tuple[int, int, int, int]:
    """Scale a pixel/point box to the integer ``0-1000`` grid.

    Malformed input is repaired rather than raised on: coordinates are
    re-ordered, non-positive page dimensions fall back to a degenerate box, and
    everything is clamped into ``[0, GRID]`` so the position embedding lookup
    cannot go out of range.
    """
    if width <= 0 or height <= 0:
        LOGGER.warning("Non-positive page size (%s x %s); emitting zero box", width, height)
        return (0, 0, 0, 0)

    lo_x, hi_x = (x0, x1) if x0 <= x1 else (x1, x0)
    lo_y, hi_y = (y0, y1) if y0 <= y1 else (y1, y0)

    def scale(value: float, extent: float) -> int:
        return int(max(0, min(GRID, round(value * GRID / extent))))

    nx0, nx1 = scale(lo_x, width), scale(hi_x, width)
    ny0, ny1 = scale(lo_y, height), scale(hi_y, height)
    # Keep x1 >= x0 and y1 >= y0 after rounding.
    return (nx0, ny0, max(nx0, nx1), max(ny0, ny1))


def _detect_gutter(
    boxes: Sequence[tuple[float, float, float, float]],
    page_width: float,
    min_gap_frac: float = 0.06,
) -> float | None:
    """Return the x of a vertical whitespace gutter, or ``None`` if single column.

    Sweeps candidate x positions across the middle of the page and keeps the
    widest run that no box crosses. Both sides must hold content, so a page with
    one text column never gets split.
    """
    if page_width <= 0 or len(boxes) < 6:
        return None

    step = max(page_width / 200.0, 1.0)
    start, end = page_width * 0.25, page_width * 0.75
    best_run: tuple[float, float] | None = None
    run_start: float | None = None
    x = start
    while x <= end:
        crossed = any(b[0] < x < b[2] for b in boxes)
        if crossed:
            if run_start is not None:
                if best_run is None or (x - run_start) > (best_run[1] - best_run[0]):
                    best_run = (run_start, x)
                run_start = None
        elif run_start is None:
            run_start = x
        x += step
    if run_start is not None and (
        best_run is None or (end - run_start) > (best_run[1] - best_run[0])
    ):
        best_run = (run_start, end)

    if best_run is None or (best_run[1] - best_run[0]) < min_gap_frac * page_width:
        return None

    gutter = (best_run[0] + best_run[1]) / 2.0
    left = sum(1 for b in boxes if (b[0] + b[2]) / 2 < gutter)
    right = len(boxes) - left
    if left < 2 or right < 2:
        return None
    return gutter


def _reading_order(
    items: list[tuple[tuple[float, float, float, float], Any]],
    page_width: float,
) -> list[tuple[tuple[float, float, float, float], Any]]:
    """Order ``(box, payload)`` pairs column-first, then top-down, then left-right."""
    if not items:
        return []

    boxes = [box for box, _ in items]
    gutter = _detect_gutter(boxes, page_width)
    heights = [max(b[3] - b[1], 1.0) for b in boxes]
    band = max(statistics.median(heights) * 0.6, 1.0)

    def key(entry: tuple[tuple[float, float, float, float], Any]) -> tuple[int, int, float]:
        box = entry[0]
        column = 0 if gutter is None or (box[0] + box[2]) / 2 < gutter else 1
        return (column, int(box[1] // band), box[0])

    return sorted(items, key=key)


def reflow_columns(words: Sequence[LayoutWord]) -> list[LayoutWord]:
    """Re-order already normalised words column-first, then top-down.

    PyMuPDF emits blocks in creation order, which interleaves a sidebar with
    the main body on two-column templates. Boxes are already on the 0-1000
    grid here, so the gutter sweep runs against that grid width.
    """
    ordered = _reading_order([(tuple(float(v) for v in word.box), word) for word in words], float(GRID))
    return [word for _, word in ordered]


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #
def render_page_image(page: "fitz.Page", dpi: int = DEFAULT_RENDER_DPI) -> Image.Image:
    """Rasterise a page to an RGB :class:`PIL.Image.Image`."""
    pixmap = page.get_pixmap(dpi=dpi, alpha=False)
    return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def render_pdf_page_image(
    pdf_path: str | Path,
    page_index: int,
    dpi: int = DEFAULT_RENDER_DPI,
) -> Image.Image:
    """Render one page of ``pdf_path`` without a full parse (used by the dataset)."""
    path = Path(pdf_path)
    if not path.is_file():
        raise ParserError(f"PDF not found: {path}")
    with fitz.open(path) as pdf:
        if not 0 <= page_index < pdf.page_count:
            raise ParserError(f"{path} has no page {page_index} (page_count={pdf.page_count})")
        return render_page_image(pdf[page_index], dpi=dpi)


# --------------------------------------------------------------------------- #
# Native extraction
# --------------------------------------------------------------------------- #
def _native_words(page: "fitz.Page") -> list[LayoutWord]:
    """Extract vector words in PyMuPDF block/line order (column safe)."""
    rect = page.rect
    width, height = float(rect.width), float(rect.height)
    raw = page.get_text("words") or []
    # Tuples are (x0, y0, x1, y1, word, block_no, line_no, word_no).
    raw = sorted(raw, key=lambda w: (w[5], w[6], w[7]))

    words: list[LayoutWord] = []
    line_key_to_id: dict[tuple[int, int], int] = {}
    for x0, y0, x1, y1, text, block_no, line_no, _word_no in raw:
        text = text.strip()
        if not text:
            continue
        line_key = (int(block_no), int(line_no))
        line_id = line_key_to_id.setdefault(line_key, len(line_key_to_id))
        words.append(
            LayoutWord(
                text=text,
                box=normalize_box(x0, y0, x1, y1, width, height),
                line_id=line_id,
            )
        )
    return words


# --------------------------------------------------------------------------- #
# OCR fallback
# --------------------------------------------------------------------------- #
class _PaddleOCRRunner:
    """Lazy PaddleOCR holder.

    PaddleOCR loads detection and recognition weights plus several seconds of
    startup, so it is only constructed the first time a scanned page is
    actually hit; parsing searchable PDFs never touches it.
    """

    _instance: "_PaddleOCRRunner | None" = None

    def __init__(self, lang: str = "en", use_gpu: bool = False, enable_mkldnn: bool = False) -> None:
        try:  # pragma: no cover - optional heavy dependency
            from paddleocr import PaddleOCR
        except ImportError as exc:  # pragma: no cover
            raise ParserError(
                "Scanned PDF needs the OCR fallback, but paddleocr is not installed. "
                "Install it with `pip install paddlepaddle paddleocr`."
            ) from exc

        # 3.x option names first, then the 2.x ones, then a bare constructor.
        # Document orientation and unwarping stay off: resume PDFs are rendered
        # upright by us, and those two extra models dominate startup time.
        # enable_mkldnn defaults off because some CPU paddle builds raise
        # "ConvertPirAttribute2RuntimeAttribute not support" with oneDNN on.
        attempts: list[dict[str, Any]] = [
            {
                "lang": lang,
                "use_textline_orientation": False,
                "use_doc_orientation_classify": False,
                "use_doc_unwarping": False,
                "enable_mkldnn": enable_mkldnn,
                "device": "gpu" if use_gpu else "cpu",
            },
            {"lang": lang, "use_angle_cls": True, "show_log": False, "use_gpu": use_gpu},
            {"lang": lang},
        ]
        errors: list[str] = []
        for kwargs in attempts:
            try:
                self._engine = PaddleOCR(**kwargs)
            except (TypeError, ValueError) as exc:
                errors.append(f"{sorted(kwargs)}: {exc}")
                continue
            self.options = kwargs
            LOGGER.info("PaddleOCR initialised with %s", kwargs)
            return
        raise ParserError("Could not construct PaddleOCR. Attempts: " + " | ".join(errors))

    @classmethod
    def get(
        cls, lang: str = "en", use_gpu: bool = False, enable_mkldnn: bool = False
    ) -> "_PaddleOCRRunner":
        if cls._instance is None:
            cls._instance = cls(lang=lang, use_gpu=use_gpu, enable_mkldnn=enable_mkldnn)
        return cls._instance

    def run(self, image: Image.Image) -> list[tuple[list[list[float]], str, float]]:
        """OCR one page image into ``(polygon, text, score)`` line records."""
        import numpy as np

        array = np.array(image.convert("RGB"))
        # 3.x exposes predict() and deprecates ocr(); 2.x only has ocr().
        call = getattr(self._engine, "predict", None) or self._engine.ocr
        try:
            raw: Any = call(array)
        except TypeError:  # pragma: no cover - 2.x signature
            raw = self._engine.ocr(array, cls=True)
        except Exception as exc:  # pragma: no cover - engine-specific
            raise ParserError(f"PaddleOCR failed: {exc}") from exc
        return list(_iter_paddle_results(raw))


def _is_line_record(entry: Any) -> bool:
    """True for a ``[polygon, (text, score)]`` record."""
    if not isinstance(entry, (list, tuple)) or len(entry) < 2:
        return False
    poly, payload = entry[0], entry[1]
    poly_ok = (
        isinstance(poly, (list, tuple))
        and len(poly) >= 2
        and all(isinstance(point, (list, tuple)) and len(point) >= 2 for point in poly)
    )
    payload_ok = isinstance(payload, str) or (
        isinstance(payload, (list, tuple)) and payload and isinstance(payload[0], str)
    )
    return poly_ok and payload_ok


def _iter_paddle_results(raw: Any) -> Iterator[tuple[list[list[float]], str, float]]:
    """Normalise the shapes different PaddleOCR versions return.

    Handles ``[[ [poly, (text, score)], ... ]]`` (2.x page buckets), the same
    list unnested, and the 3.x result objects exposing ``rec_texts`` /
    ``rec_polys`` / ``rec_scores``.
    """
    if raw is None:
        return

    # paddleocr 3.x returns OCRResult objects that behave like mappings.
    if isinstance(raw, dict) or (hasattr(raw, "get") and hasattr(raw, "keys")):
        polys = raw.get("rec_polys") if raw.get("rec_polys") is not None else raw.get("dt_polys")
        polys = [] if polys is None else list(polys)
        texts = list(raw.get("rec_texts") or [])
        scores = list(raw.get("rec_scores") or [])
        for idx, text in enumerate(texts):
            poly = polys[idx] if idx < len(polys) else None
            score = float(scores[idx]) if idx < len(scores) else 0.0
            if poly is not None and str(text).strip():
                yield ([[float(p[0]), float(p[1])] for p in poly], str(text), score)
        return

    if isinstance(raw, (list, tuple)):
        for entry in raw:
            if entry is None:
                continue
            if isinstance(entry, dict) or (hasattr(entry, "get") and hasattr(entry, "keys")):
                yield from _iter_paddle_results(entry)
                continue
            if _is_line_record(entry):
                poly, payload = entry[0], entry[1]
                if isinstance(payload, str):
                    text, score = payload, 0.0
                else:
                    text = str(payload[0])
                    score = float(payload[1]) if len(payload) > 1 else 0.0
                if text.strip():
                    try:
                        yield ([[float(p[0]), float(p[1])] for p in poly], text, score)
                    except (TypeError, IndexError, ValueError):
                        LOGGER.debug("Skipping malformed OCR polygon: %r", poly)
                continue
            if isinstance(entry, (list, tuple)):
                yield from _iter_paddle_results(entry)
                continue
            # 3.x returns result objects that behave like mappings.
            for attr in ("json", "res"):
                payload = getattr(entry, attr, None)
                if isinstance(payload, dict):
                    yield from _iter_paddle_results(payload)
                    break
            else:
                LOGGER.debug("Unrecognised OCR record type: %r", type(entry))


def _poly_to_bbox(poly: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    return (min(xs), min(ys), max(xs), max(ys))


def _split_line_into_words(
    text: str,
    bbox: tuple[float, float, float, float],
) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Split one OCR line into words, apportioning its box by character offset.

    PaddleOCR detects *lines*, not words, so word x-extents are interpolated
    from character position. That is approximate for proportional fonts - a
    known source of boundary error, reported separately by ``evaluate.py``.
    """
    x0, y0, x1, y1 = bbox
    if not text.strip():
        return []

    span = max(x1 - x0, 0.0)
    total = len(text)
    if total == 0 or span == 0:
        return [(token, bbox) for token in text.split()]

    per_char = span / total
    out: list[tuple[str, tuple[float, float, float, float]]] = []
    cursor = 0
    for token in text.split(" "):
        if token:
            wx0 = x0 + cursor * per_char
            wx1 = x0 + (cursor + len(token)) * per_char
            out.append((token, (wx0, y0, min(wx1, x1), y1)))
        cursor += len(token) + 1
    return out


def _ocr_words(
    image: Image.Image,
    lang: str = "en",
    use_gpu: bool = False,
    min_confidence: float = 0.0,
    enable_mkldnn: bool = False,
) -> list[LayoutWord]:
    """Run PaddleOCR on a rendered page and return normalised words."""
    runner = _PaddleOCRRunner.get(lang=lang, use_gpu=use_gpu, enable_mkldnn=enable_mkldnn)
    lines = runner.run(image)
    px_w, px_h = float(image.width), float(image.height)

    ordered = _reading_order(
        [(_poly_to_bbox(poly), (text, score)) for poly, text, score in lines],
        px_w,
    )

    words: list[LayoutWord] = []
    for line_id, (bbox, (text, score)) in enumerate(ordered):
        if score < min_confidence:
            continue
        for token, token_box in _split_line_into_words(text, bbox):
            words.append(
                LayoutWord(
                    text=token,
                    box=normalize_box(*token_box, px_w, px_h),
                    line_id=line_id,
                    confidence=score,
                )
            )
    return words


# --------------------------------------------------------------------------- #
# Parser
# --------------------------------------------------------------------------- #
class ResumeDocumentParser:
    """Turn a resume PDF into LayoutLMv3-ready words, boxes and page images.

    Args:
        render_dpi: DPI for the page raster handed to the model and to OCR.
        min_native_words: below this per-page word count the page is OCR'd.
        keep_images: retain the PIL image on each :class:`PageLayout`.
        force_ocr: skip native extraction entirely (useful for A/B checks).
        ocr_lang: PaddleOCR language pack.
        ocr_use_gpu: let PaddleOCR use the GPU when the build supports it.
        ocr_min_confidence: drop OCR lines scoring below this.
        ocr_enable_mkldnn: turn oneDNN back on; off by default because some CPU
            paddle builds crash with it enabled.
        reading_order: "native" keeps PyMuPDF block order (default, matches the
            original behaviour); "columns" reflows words column-first through a
            detected gutter, which fixes sidebar templates whose native order
            interleaves the two columns.
    """

    def __init__(
        self,
        render_dpi: int = DEFAULT_RENDER_DPI,
        min_native_words: int = MIN_NATIVE_WORDS,
        keep_images: bool = True,
        force_ocr: bool = False,
        ocr_lang: str = "en",
        ocr_use_gpu: bool = False,
        ocr_min_confidence: float = 0.0,
        ocr_enable_mkldnn: bool = False,
        reading_order: ReadingOrder = "native",
    ) -> None:
        self.render_dpi = render_dpi
        self.min_native_words = min_native_words
        self.keep_images = keep_images
        self.force_ocr = force_ocr
        self.ocr_lang = ocr_lang
        self.ocr_use_gpu = ocr_use_gpu
        self.ocr_min_confidence = ocr_min_confidence
        self.ocr_enable_mkldnn = ocr_enable_mkldnn
        self.reading_order = reading_order

    # -- public API -------------------------------------------------------- #
    def parse(self, pdf_path: str | Path, pages: Iterable[int] | None = None) -> ParsedDocument:
        """Parse ``pdf_path``; ``pages`` optionally restricts to 0-based indices."""
        path = Path(pdf_path)
        if not path.is_file():
            raise ParserError(f"PDF not found: {path}")

        wanted = set(pages) if pages is not None else None
        document = ParsedDocument(pdf_path=path)
        try:
            with fitz.open(path) as pdf:
                if pdf.page_count == 0:
                    raise ParserError(f"PDF has no pages: {path}")
                for index in range(pdf.page_count):
                    if wanted is not None and index not in wanted:
                        continue
                    document.pages.append(self._parse_page(pdf[index], index))
        except ParserError:
            raise
        except Exception as exc:  # fitz raises bare RuntimeError on damaged files
            raise ParserError(f"Could not open {path}: {exc}") from exc

        if document.word_count == 0:
            LOGGER.warning("No words extracted from %s (native or OCR)", path)
        return document

    def parse_many(self, pdf_paths: Iterable[str | Path]) -> list[ParsedDocument]:
        """Parse several PDFs, logging and skipping the ones that fail."""
        parsed: list[ParsedDocument] = []
        for pdf_path in pdf_paths:
            try:
                parsed.append(self.parse(pdf_path))
            except ParserError as exc:
                LOGGER.error("Skipping %s: %s", pdf_path, exc)
        return parsed

    def to_annotation_stub(
        self,
        document: ParsedDocument,
        template_family: str = "unknown",
    ) -> dict[str, Any]:
        """Emit an all-``O`` annotation document ready for hand labelling.

        The shape matches :class:`src.dataset.AnnotatedDocument`, so a labeller
        only has to change ``tag`` values.
        """
        return {
            "doc_id": document.doc_id,
            "pdf_path": str(document.pdf_path),
            "template_family": template_family,
            "source": "ocr" if document.used_ocr else "native",
            "pages": [
                {
                    "page_index": page.page_index,
                    "width": round(page.width, 2),
                    "height": round(page.height, 2),
                    "source": page.source,
                    "words": [
                        {"text": w.text, "box": list(w.box), "tag": "O"} for w in page.words
                    ],
                }
                for page in document.pages
            ],
        }

    # -- internals --------------------------------------------------------- #
    def _parse_page(self, page: "fitz.Page", index: int) -> PageLayout:
        rect = page.rect
        width, height = float(rect.width), float(rect.height)

        words: list[LayoutWord] = [] if self.force_ocr else _native_words(page)
        source: SourceKind = "native"
        image: Image.Image | None = None

        if self.force_ocr or len(words) < self.min_native_words:
            reason = "forced" if self.force_ocr else f"{len(words)} native words"
            LOGGER.info("Page %d: using OCR fallback (%s)", index, reason)
            image = render_page_image(page, self.render_dpi)
            ocr_words = _ocr_words(
                image,
                lang=self.ocr_lang,
                use_gpu=self.ocr_use_gpu,
                min_confidence=self.ocr_min_confidence,
                enable_mkldnn=self.ocr_enable_mkldnn,
            )
            if ocr_words or self.force_ocr:
                words, source = ocr_words, "ocr"
            else:
                LOGGER.warning("Page %d: OCR returned nothing; keeping native words", index)

        if self.reading_order == "columns" and words:
            words = reflow_columns(words)

        if self.keep_images and image is None:
            image = render_page_image(page, self.render_dpi)

        return PageLayout(
            page_index=index,
            width=width,
            height=height,
            source=source,
            words=words,
            image=image if self.keep_images else None,
        )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.parser",
        description="Parse a resume PDF into LayoutLMv3 words/boxes (OCR fallback for scans).",
    )
    cli.add_argument("--sample_pdf", required=True, help="Path to a PDF to parse")
    cli.add_argument("--page", type=int, action="append", help="0-based page index (repeatable)")
    cli.add_argument("--dpi", type=int, default=DEFAULT_RENDER_DPI)
    cli.add_argument("--force-ocr", action="store_true", help="Ignore native text; OCR every page")
    cli.add_argument("--ocr-gpu", action="store_true", help="Let PaddleOCR use the GPU")
    cli.add_argument(
        "--ocr-mkldnn",
        action="store_true",
        help="Enable oneDNN in PaddleOCR (faster on some CPUs, crashes on others)",
    )
    cli.add_argument("--max-words", type=int, default=25, help="Words to print per page")
    cli.add_argument("--json", help="Write the full parse (words + boxes) to this path")
    cli.add_argument("--emit-annotation", help="Write an all-O annotation stub to this path")
    cli.add_argument("--template-family", default="unknown", help="Family tag for the stub")
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    parser = ResumeDocumentParser(
        render_dpi=args.dpi,
        force_ocr=args.force_ocr,
        ocr_use_gpu=args.ocr_gpu,
        ocr_enable_mkldnn=args.ocr_mkldnn,
        keep_images=False,
    )
    try:
        document = parser.parse(args.sample_pdf, pages=args.page)
    except ParserError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"{document.doc_id}: {len(document.pages)} page(s), {document.word_count} word(s)")
    for page in document.pages:
        print(
            f"  page {page.page_index}: source={page.source} "
            f"size={page.width:.0f}x{page.height:.0f} words={len(page.words)}"
        )
        for word in page.words[: args.max_words]:
            print(f"    {word.box} {word.text}")
        if len(page.words) > args.max_words:
            print(f"    ... {len(page.words) - args.max_words} more")

    if args.json:
        Path(args.json).write_text(json.dumps(document.as_dict(), indent=2), encoding="utf-8")
        print(f"wrote {args.json}")
    if args.emit_annotation:
        stub = parser.to_annotation_stub(document, template_family=args.template_family)
        Path(args.emit_annotation).write_text(json.dumps(stub, indent=2), encoding="utf-8")
        print(f"wrote {args.emit_annotation}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

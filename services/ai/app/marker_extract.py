"""PDF -> Markdown through Marker (datalab-to/marker). Local only: no network call is made with resume content.

Failures are typed and raised; there is deliberately NO fallback to pdfplumber (a silent substitute would hide layout errors).
Marker is imported lazily so the deterministic parser and its tests run without the heavy ML stack installed.
"""
from __future__ import annotations

import hashlib
import platform
import re
import unicodedata
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path


class MarkerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class MarkerResult:
    markdown: str
    diagnostics: dict = field(default_factory=dict)


def normalize_markdown(raw: str) -> str:
    """UTF-8 canonical text. Only line endings, NFC and control characters are touched; spelling and spacing are preserved."""
    text = unicodedata.normalize("NFC", raw).replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return "\n".join(line.rstrip(" ") for line in text.split("\n")).strip("\n")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def marker_version() -> str:
    try:
        return metadata.version("marker-pdf")
    except metadata.PackageNotFoundError:
        return "NOT_INSTALLED"


def _recover_figure_text(document) -> int:  # noqa: ANN001 - marker Document
    """Marker's layout model labels bordered boxes (skill chips, tag pills) as Figure and its renderer then drops the text.
    A Figure that holds real text lines is retyped as Text so Marker's own renderer emits it. Pictures without text are untouched."""
    from marker.schema import BlockTypes
    from marker.schema.blocks import Text

    count = 0
    for page in document.pages:
        for block in page.contained_blocks(document, (BlockTypes.Figure, BlockTypes.Picture)):
            text = block.raw_text(document).strip()
            if not block.structure or len(re.sub(r"\s", "", text)) < 3:
                continue
            replacement = Text(polygon=block.polygon, page_id=block.page_id, block_id=block.block_id, structure=block.structure, source=block.source)
            for i, child in enumerate(page.children or []):
                if child.id == block.id:
                    page.children[i] = replacement
                    count += 1
                    break
    return count


def pdf_to_markdown(pdf_path: Path, *, fast: bool = True, disable_ocr: bool = True, artifact_dict: dict | None = None) -> MarkerResult:
    """Run Marker on a born-digital PDF. `fast` + `disable_ocr` use the embedded text layer; no generative LLM is configured."""
    if not pdf_path.is_file():
        raise MarkerError("UNREADABLE_FILE", f"PDF not found: {pdf_path.name}")
    try:
        from marker.config.parser import ConfigParser
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.output import text_from_rendered
    except Exception as error:
        raise MarkerError("MARKER_UNAVAILABLE", f"Marker import failed: {type(error).__name__}: {error}") from error
    warnings: list[str] = []
    config = {"output_format": "markdown", "disable_image_extraction": True, "use_llm": False}
    if disable_ocr:
        config["disable_ocr"] = True
    if fast:
        # Marker has no single "fast" flag in 1.10.x; the closest documented equivalent is to skip OCR and LLM passes.
        config["force_ocr"] = False
    try:
        parser = ConfigParser(config)
        converter = PdfConverter(config=parser.generate_config_dict(), artifact_dict=artifact_dict if artifact_dict is not None else create_model_dict(),
                                 processor_list=parser.get_processors(), renderer=parser.get_renderer())
        # Same steps as PdfConverter.__call__, with one extra step between build and render (see _recover_figure_text).
        document = converter.build_document(str(pdf_path))
        recovered = _recover_figure_text(document)
        if recovered:
            warnings.append(f"FIGURE_TEXT_RECOVERED: {recovered} Figure block(s) contained a born-digital text layer (e.g. bordered skill chips); the text was kept instead of dropped.")
        rendered = converter.resolve_dependencies(converter.renderer)(document)
        markdown, meta, _images = text_from_rendered(rendered)
        page_count = len(document.pages)
    except Exception as error:
        raise MarkerError("MARKER_FAILED", f"Marker conversion failed: {type(error).__name__}: {error}") from error
    markdown = normalize_markdown(markdown)
    if len(re.sub(r"\s", "", markdown)) < 80:
        raise MarkerError("NO_TEXT_LAYER", "Marker produced almost no text; the PDF may be scanned. OCR was disabled.")
    page_stats = meta.get("page_stats", []) if isinstance(meta, dict) else []
    return MarkerResult(markdown=markdown, diagnostics={
        "markerVersion": marker_version(),
        "python": platform.python_version(),
        "sourcePdfSha256": sha256_file(pdf_path),
        "pageCount": page_count,
        "figureBlocksRecovered": recovered,
        "pageStats": page_stats,
        "tableOfContents": meta.get("table_of_contents", []) if isinstance(meta, dict) else [],
        "config": {k: v for k, v in config.items()},
        "markdownChars": len(markdown),
        "markdownSha256": hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
        "warnings": warnings,
    })

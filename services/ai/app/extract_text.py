"""PDF / DOCX -> normalized plain text. Deterministic, no network, no OCR.

Typed failures (ExtractError.code): UNREADABLE_FILE, ENCRYPTED_PDF, TOO_MANY_PAGES, NO_TEXT_LAYER, UNSAFE_DOCX,
NO_DOCX_BODY. A scanned PDF is reported as NO_TEXT_LAYER; it is never silently treated as an empty resume.
"""
from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from collections import Counter
from dataclasses import dataclass
from xml.etree import ElementTree as ET

MAX_PAGES = 20
# pdfplumber joins glyphs closer than this many points. Its default (3) fuses words in tightly-kerned resumes ("Engineeredanend-to-end");
# 2 restores the spaces the layout actually contains. It only splits at real gaps; it never inserts text.
PDF_X_TOLERANCE = 2
MIN_TEXT_CHARS = 80  # non-whitespace characters below this means "no usable text layer"
MAX_DOCX_ENTRIES = 1000
MAX_DOCX_XML_BYTES = 20 * 1024 * 1024
MAX_DOCX_RATIO = 200  # uncompressed / compressed

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class ExtractError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ExtractedDocument:
    text: str
    page_count: int
    warnings: tuple[str, ...] = ()


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0e-\x1f\x7f]")


def normalize_text(raw: str) -> str:
    """Canonical text. Every span the service returns refers to THIS string."""
    text = unicodedata.normalize("NFC", raw)
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace(" ", " ").replace(" ", "\n")
    text = _CONTROL.sub("", text)
    lines = [line.rstrip(" ") for line in text.split("\n")]
    return "\n".join(lines).strip("\n")


def _check_has_text(text: str) -> None:
    if len(re.sub(r"\s", "", text)) < MIN_TEXT_CHARS:
        raise ExtractError(
            "NO_TEXT_LAYER",
            "The file has no usable text layer (it may be a scanned image). Upload a text-based PDF or DOCX; OCR is not performed.",
        )


def _ordered_pdf_page(page) -> tuple[str, str | None]:
    """Read a clear two-column body top-to-bottom, while retaining a full-width header.

    The gutter must be empty across all body words. Ambiguous pages keep pdfplumber's
    established order; no words are removed to make a layout appear parseable.
    """
    baseline = page.extract_text(x_tolerance=PDF_X_TOLERANCE) or ""
    words = page.extract_words(x_tolerance=PDF_X_TOLERANCE)
    body = [w for w in words if w["top"] > page.height * .10]
    intervals: list[tuple[float, float]] = []
    for w in sorted(body, key=lambda w: w["x0"]):
        a, b = w["x0"], w["x1"]
        if intervals and a <= intervals[-1][1]:
            intervals[-1] = (intervals[-1][0], max(b, intervals[-1][1]))
        else:
            intervals.append((a, b))
    gaps = [(b-a, (a+b)/2) for (_, a), (b, _) in zip(intervals, intervals[1:])
            if b-a >= 18 and .2 * page.width < a < .8 * page.width]
    if not gaps:
        return baseline, None
    _, split = max(gaps)
    left = [w for w in body if w["x1"] < split]
    right = [w for w in body if w["x0"] > split]
    if len(left) < 5 or len(right) < 5:
        return baseline, "LAYOUT_AMBIGUOUS"
    left_ys = (min(w["top"] for w in left), max(w["bottom"] for w in left))
    right_ys = (min(w["top"] for w in right), max(w["bottom"] for w in right))
    if min(left_ys[1], right_ys[1]) - max(left_ys[0], right_ys[0]) < 20:
        return baseline, "LAYOUT_AMBIGUOUS"
    header_bottom = min(left_ys[0], right_ys[0]) - 3
    regions = ((0, 0, page.width, header_bottom), (0, header_bottom, split, page.height),
               (split, header_bottom, page.width, page.height))
    parts = []
    recovered = Counter()
    for box in regions:
        crop = page.crop(box)
        parts.append(crop.extract_text(x_tolerance=PDF_X_TOLERANCE) or "")
        recovered.update(w["text"] for w in crop.extract_words(x_tolerance=PDF_X_TOLERANCE))
    if recovered != Counter(w["text"] for w in words):
        return baseline, "LAYOUT_AMBIGUOUS"
    return "\n".join(part for part in parts if part), None


def _password_protected(error: BaseException, password_type: type[BaseException]) -> bool:
    """pdfplumber wraps PDFPasswordIncorrect inside PdfminerException instead of raising it directly."""
    seen: set[int] = set()
    stack: list[BaseException] = [error]
    while stack:
        current = stack.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, password_type):
            return True
        name = type(current).__name__
        if "Password" in name or "Encrypt" in name:
            return True
        if current.__cause__ is not None:
            stack.append(current.__cause__)
        if current.__context__ is not None and current.__context__ is not current.__cause__:
            stack.append(current.__context__)
        stack.extend(arg for arg in current.args if isinstance(arg, BaseException))
    return False


def extract_pdf(data: bytes) -> ExtractedDocument:
    try:
        import pdfplumber
        from pdfminer.pdfdocument import PDFPasswordIncorrect
    except Exception as error:  # pragma: no cover - environment problem, not a file problem
        raise ExtractError("EXTRACTOR_UNAVAILABLE", f"PDF library unavailable: {type(error).__name__}") from error
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            if len(pdf.pages) > MAX_PAGES:
                raise ExtractError("TOO_MANY_PAGES", f"The PDF has {len(pdf.pages)} pages; the limit is {MAX_PAGES}.")
            ordered = [_ordered_pdf_page(page) for page in pdf.pages]
            pages = [part for part, _ in ordered]
            layout_warnings = tuple(f"{warning}:page={i+1}" for i, (_, warning) in enumerate(ordered) if warning)
            page_count = len(pdf.pages)
    except ExtractError:
        raise
    except Exception as error:
        if _password_protected(error, PDFPasswordIncorrect):
            raise ExtractError("ENCRYPTED_PDF", "The PDF is password protected.") from error
        raise ExtractError("UNREADABLE_FILE", f"The PDF could not be read ({type(error).__name__}).") from error
    if page_count == 0:
        raise ExtractError("UNREADABLE_FILE", "The PDF has no pages.")
    text = normalize_text("\n".join(pages))
    _check_has_text(text)
    return ExtractedDocument(text=text, page_count=page_count, warnings=layout_warnings)


def _paragraph_text(p: ET.Element) -> str:
    out: list[str] = []
    for node in p.iter():
        if node.tag == f"{W}t":
            out.append(node.text or "")
        elif node.tag == f"{W}tab":
            out.append("\t")
        elif node.tag in (f"{W}br", f"{W}cr"):
            out.append("\n")
    return "".join(out)


def extract_docx(data: bytes) -> ExtractedDocument:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ExtractError("UNREADABLE_FILE", "The file is not a valid DOCX (zip) container.") from error
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_DOCX_ENTRIES:
            raise ExtractError("UNSAFE_DOCX", "The DOCX has too many internal entries.")
        info = next((i for i in infos if i.filename == "word/document.xml"), None)
        if info is None:
            raise ExtractError("NO_DOCX_BODY", "word/document.xml was not found in the DOCX.")
        if info.file_size > MAX_DOCX_XML_BYTES or (info.compress_size > 0 and info.file_size / info.compress_size > MAX_DOCX_RATIO):
            raise ExtractError("UNSAFE_DOCX", "The DOCX body is too large or compressed suspiciously well.")
        try:
            xml = archive.read(info)
        except Exception as error:
            raise ExtractError("UNREADABLE_FILE", "The DOCX body could not be decompressed.") from error
    head = xml[:4096].lower()
    if b"<!doctype" in head or b"<!entity" in xml.lower():
        raise ExtractError("UNSAFE_DOCX", "The DOCX body declares a DTD or entity, which is not allowed.")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as error:
        raise ExtractError("UNREADABLE_FILE", "The DOCX body is not valid XML.") from error
    paragraphs = [_paragraph_text(p) for p in root.iter(f"{W}p")]
    text = normalize_text("\n".join(paragraphs))
    _check_has_text(text)
    return ExtractedDocument(text=text, page_count=1)


def extract(data: bytes, file_type: str) -> ExtractedDocument:
    if file_type == "pdf":
        return extract_pdf(data)
    if file_type == "docx":
        return extract_docx(data)
    raise ExtractError("UNSUPPORTED_FILE_TYPE", f"Unsupported file type {file_type!r}.")

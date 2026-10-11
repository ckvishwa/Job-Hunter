"""PDF / DOCX -> normalized plain text. Deterministic, no network, no OCR.

Typed failures (ExtractError.code): UNREADABLE_FILE, ENCRYPTED_PDF, TOO_MANY_PAGES, NO_TEXT_LAYER, UNSAFE_DOCX,
NO_DOCX_BODY. A scanned PDF is reported as NO_TEXT_LAYER; it is never silently treated as an empty resume.
"""
from __future__ import annotations

import io
import re
import unicodedata
import zipfile
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
            pages = [(page.extract_text(x_tolerance=PDF_X_TOLERANCE) or "") for page in pdf.pages]
            page_count = len(pdf.pages)
    except ExtractError:
        raise
    except PDFPasswordIncorrect as error:
        raise ExtractError("ENCRYPTED_PDF", "The PDF is password protected.") from error
    except Exception as error:
        name = type(error).__name__
        if "Password" in name or "Encrypt" in name:
            raise ExtractError("ENCRYPTED_PDF", "The PDF is encrypted or password protected.") from error
        raise ExtractError("UNREADABLE_FILE", f"The PDF could not be read ({name}).") from error
    if page_count == 0:
        raise ExtractError("UNREADABLE_FILE", "The PDF has no pages.")
    text = normalize_text("\n".join(pages))
    _check_has_text(text)
    return ExtractedDocument(text=text, page_count=page_count)


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

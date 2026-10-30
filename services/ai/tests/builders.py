"""Builds real PDF and DOCX bytes from plain lines so fixtures are text specs, not committed binaries."""
from __future__ import annotations

import io
import textwrap
import zipfile
from xml.sax.saxutils import escape


def _pdf_escape(line: str) -> bytes:
    raw = line.encode("cp1252", errors="replace")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def build_pdf(lines: list[str], per_page: int = 46, wrap: int = 92, blank_pages: int = 0) -> bytes:
    """Text PDF (Helvetica, WinAnsi). `lines=[]` with blank_pages>=1 yields a page with no text layer (a 'scan')."""
    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(textwrap.wrap(line, wrap) or [""])
    pages = [wrapped[i:i + per_page] for i in range(0, len(wrapped), per_page)] if wrapped else []
    pages += [[] for _ in range(blank_pages)]
    if not pages:
        pages = [[]]
    objects: list[bytes] = []
    n_pages = len(pages)
    first_page_obj = 4
    kids = " ".join(f"{first_page_obj + 2 * i} 0 R" for i in range(n_pages))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    for i, page_lines in enumerate(pages):
        page_obj = first_page_obj + 2 * i
        content_obj = page_obj + 1
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_obj} 0 R >>".encode()
        )
        stream = b""
        y = 760
        for line in page_lines:
            if line:
                stream += b"BT /F1 10 Tf 50 " + str(y).encode() + b" Td (" + _pdf_escape(line) + b") Tj ET\n"
            y -= 14
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for num, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{num} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n")
    for off in offsets:
        out.write(f"{off:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def _docx_paragraph(line: str) -> str:
    runs = []
    for i, piece in enumerate(line.split("\t")):
        if i:
            runs.append("<w:r><w:tab/></w:r>")
        if piece:
            runs.append(f'<w:r><w:t xml:space="preserve">{escape(piece)}</w:t></w:r>')
    return "<w:p>" + "".join(runs) + "</w:p>"


def build_docx(lines: list[str], extra_body_prefix: str = "") -> bytes:
    body = "".join(_docx_paragraph(line) for line in lines)
    document = (
        extra_body_prefix
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + body
        + "</w:body></w:document>"
    )
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr("_rels/.rels",
                   '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        z.writestr("word/document.xml", document)
    return out.getvalue()


def build(case_format: str, lines: list[str], blank_pages: int = 0) -> bytes:
    if case_format == "pdf":
        return build_pdf(lines, blank_pages=blank_pages)
    if case_format == "docx":
        return build_docx(lines)
    raise ValueError(case_format)

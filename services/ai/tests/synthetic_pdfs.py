"""Builders for the fictional PDF fixtures the local-intake tests run on.

Every byte here is written by this module: no fixture is derived from a real
candidate document, and nothing in this file is read from disk. The PDFs are
deliberately minimal (uncompressed streams, one base-14 font) so a failure is a
failure of the extractor, not of a PDF producer we do not control.

`tests/builders.py` already writes flowed single-column PDFs and DOCX files and
stays the builder for those cases; this module exists because the intake tests
need what it cannot express: text placed at chosen x positions (columns, a
LinkedIn rail) and a page whose only content is a drawn image.

Text is written in WinAnsiEncoding, which is what the /Helvetica base font
resolves to here; characters outside it (CJK, emoji) would need an embedded
font and are out of scope for a fixture. The Unicode fixture therefore uses
WinAnsi characters that still exercise normalization: é, ü, ñ, en dash, curly
quotes, non-breaking space.
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: One line of text on a page: x, y (PDF points, origin bottom-left) and the string.
Line = tuple[float, float, str]


@dataclass
class Page:
    """A page to draw. `lines` are text; `image` adds a drawn image XObject."""

    lines: list[Line] = field(default_factory=list)
    image: bool = False
    width: float = 612.0
    height: float = 792.0


def _escape(text: str) -> bytes:
    """A PDF literal string: escape the three structural characters, encode WinAnsi."""
    out = bytearray()
    for char in text:
        if char in "()\\":
            out.extend(b"\\")
            out.extend(char.encode("latin-1"))
        elif char == " ":  # non-breaking space: WinAnsi 0xA0
            out.extend(b"\xa0")
        elif char == "–":
            out.extend(b"\x96")  # en dash
        elif char == "—":
            out.extend(b"\x97")  # em dash
        elif char == "‘":
            out.extend(b"\x91")
        elif char == "’":
            out.extend(b"\x92")
        elif char == "“":
            out.extend(b"\x93")
        elif char == "”":
            out.extend(b"\x94")
        else:
            try:
                out.extend(char.encode("cp1252"))
            except UnicodeEncodeError as error:  # pragma: no cover - fixture authoring mistake
                raise ValueError(f"{char!r} is not in WinAnsiEncoding; pick another fixture character") from error
    return bytes(out)


def _content(page: Page) -> bytes:
    parts: list[bytes] = []
    if page.image:
        # Draw the image across the whole page: a scanned-looking PDF with no text operators.
        parts.append(b"q\n%f 0 0 %f 0 0 cm\n/Im0 Do\nQ\n" % (page.width, page.height))
    for x, y, text in page.lines:
        parts.append(b"BT\n/F1 11 Tf\n%f %f Td\n(" % (x, y) + _escape(text) + b") Tj\nET\n")
    return b"".join(parts)


def build_pdf(pages: list[Page], *, with_font: bool = True, trailing_garbage: bytes = b"") -> bytes:
    """Assemble a single-file PDF with a correct cross-reference table."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_num = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>") if with_font else None
    image_num = None
    if any(page.image for page in pages):
        pixels = bytes(range(64))  # 8x8 grey ramp, stored raw so no filter is needed
        image_num = add(
            b"<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 "
            b"/Length %d >>\nstream\n" % len(pixels) + pixels + b"\nendstream"
        )

    pages_num = len(objects) + 1 + 2 * len(pages)  # reserved: page objects and their streams come first
    page_nums: list[int] = []
    for page in pages:
        stream = _content(page)
        stream_num = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        resources = []
        if font_num:
            resources.append(b"/Font << /F1 %d 0 R >>" % font_num)
        if page.image and image_num:
            resources.append(b"/XObject << /Im0 %d 0 R >>" % image_num)
        page_nums.append(
            add(
                b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %f %f] /Resources << %s >> /Contents %d 0 R >>"
                % (pages_num, page.width, page.height, b" ".join(resources), stream_num)
            )
        )
    kids = b" ".join(b"%d 0 R" % n for n in page_nums)
    actual_pages_num = add(b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_nums)))
    assert actual_pages_num == pages_num, "page-tree object number was mispredicted"
    catalog_num = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_num)

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out.extend(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = len(out)
    out.extend(b"xref\n0 %d\n" % (len(objects) + 1))
    out.extend(b"0000000000 65535 f \n")
    for offset in offsets:
        out.extend(b"%010d 00000 n \n" % offset)
    out.extend(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, catalog_num, xref))
    out.extend(trailing_garbage)
    return bytes(out)


# ---------------------------------------------------------------------------------------------------------------------
# Named fixtures. Fictional people, fictional employers, fictional everything.
# ---------------------------------------------------------------------------------------------------------------------

def _column(lines: list[str], x: float, top: float = 740.0, leading: float = 14.0) -> list[Line]:
    return [(x, top - i * leading, line) for i, line in enumerate(lines)]


PLAIN_RESUME_LINES = [
    "Marisol Quintero-Habberdash",
    "Brindlewick, OR | marisol.qh@example.invalid | (555) 0144-8812",
    "PROFESSIONAL SUMMARY",
    "Test automation engineer with seven years building browser and API suites.",
    "TECHNICAL SKILLS",
    "Automation: Playwright, Selenium, Cypress, Pytest",
    "Languages: TypeScript, Python, SQL",
    "PROFESSIONAL EXPERIENCE",
    "Thistledown Analytics - Senior QA Engineer    March 2021 - Present",
    "Built an end-to-end Playwright suite covering checkout and refunds.",
    "Reduced flaky failures by rewriting waits around network idle states.",
    "Fernbrook Systems - QA Analyst    June 2018 - February 2021",
    "Wrote regression plans and executed manual exploratory passes.",
    "EDUCATION",
    "Bachelor of Science, Computer Science - Alderbury State University, 2018",
    "CERTIFICATIONS",
    "ISTQB Certified Tester Foundation Level - 2019",
]


def plain_resume() -> bytes:
    """A single-column, text-based resume: the ordinary case."""
    return build_pdf([Page(lines=_column(PLAIN_RESUME_LINES, 72.0))])


def linkedin_export() -> bytes:
    """LinkedIn's export shape: a narrow left rail of labels beside the body."""
    rail = ["Contact", "www.example.invalid", "Top Skills", "Kubernetes", "Terraform", "Go", "Languages", "English", "Spanish"]
    body = [
        "Oluwafemi Stranksberg",
        "Cloud Platform Engineer",
        "Harrowgate, WA",
        "Summary",
        "Platform engineer focused on Kubernetes operators and release tooling.",
        "Experience",
        "Pallisade Cloudworks",
        "Staff Platform Engineer",
        "January 2022 - Present (3 years)",
        "Ran the migration of forty services onto a shared Terraform module set.",
        "Quillon Data Group",
        "Site Reliability Engineer",
        "August 2019 - December 2021 (2 years 5 months)",
        "Owned the on-call rotation and cut paging volume by half.",
        "Education",
        "Alderbury State University",
        "Bachelor of Engineering, Computer Engineering, 2015 - 2019",
    ]
    return build_pdf([Page(lines=_column(rail, 48.0) + _column(body, 210.0))])


def two_column_resume() -> bytes:
    """Two balanced columns with a wide gutter: reading order is genuinely ambiguous."""
    left = [
        "Perpetua Vanterpool-Oyelaran",
        "SOC Analyst",
        "SKILLS",
        "Splunk",
        "Microsoft Sentinel",
        "KQL",
        "Incident triage",
        "EDUCATION",
        "Bachelor of Science",
        "Information Security",
        "Marchmont College, 2020",
    ]
    right = [
        "EXPERIENCE",
        "Umbral Defence Partners",
        "Security Analyst, Tier 2",
        "May 2022 - Present",
        "Investigated endpoint alerts in Splunk and wrote incident findings.",
        "Assisted the response lead during two confirmed intrusions.",
        "Castellan Managed Services",
        "SOC Analyst, Tier 1",
        "July 2020 - April 2022",
        "Triaged phishing reports and tuned twelve detection rules.",
    ]
    return build_pdf([Page(lines=_column(left, 56.0) + _column(right, 330.0))])


def two_column_with_banner() -> bytes:
    """Two columns under a full-width name banner, above a full-width footer.

    The banner and the footer cross the gutter, so they are reading-order boundaries:
    everything above the footer in either column belongs before it.
    """
    banner = [
        (56.0, 760.0, "Barnabas Okediji-Thistlewaite - Platform Engineer"),
        (56.0, 746.0, "Harrowgate, WA - barnabas.ot@example.invalid"),
    ]
    left = ["SKILLS", "Kubernetes", "Terraform", "Go", "EDUCATION", "Bachelor of Engineering", "Marchmont College, 2019"]
    right = [
        "EXPERIENCE",
        "Pallisade Cloudworks",
        "Staff Platform Engineer",
        "January 2022 - Present",
        "Migrated forty services onto a shared Terraform module set.",
        "Quillon Data Group",
        "Site Reliability Engineer",
        "August 2019 - December 2021",
    ]
    footer = [(56.0, 48.0, "References available on request - page 1 of 1 - Barnabas Okediji-Thistlewaite")]
    return build_pdf([Page(lines=banner + _column(left, 56.0, top=700.0) + _column(right, 330.0, top=700.0) + footer)])


def multipage_resume() -> bytes:
    """Three pages, with a repeated header and footer on each."""
    def page(index: int, body: list[str]) -> Page:
        header = [(72.0, 760.0, "Thaddeus Okonkwo-Reinholt - Data Engineer")]
        footer = [(72.0, 48.0, f"Page {index} of 3 - Thaddeus Okonkwo-Reinholt")]
        return Page(lines=header + _column(body, 72.0, top=720.0) + footer)

    return build_pdf(
        [
            page(1, [
                "PROFESSIONAL SUMMARY",
                "Data engineer building batch and streaming pipelines on Spark.",
                "TECHNICAL SKILLS",
                "Processing: Spark, dbt, Airflow",
                "Warehouses: Snowflake, BigQuery",
            ]),
            page(2, [
                "PROFESSIONAL EXPERIENCE",
                "Larkspur Freight Data - Data Engineer    April 2021 - Present",
                "Rebuilt the nightly load as incremental dbt models.",
                "Moreton Ledger Systems - Analytics Engineer    July 2019 - March 2021",
                "Modelled the finance mart and documented every source table.",
            ]),
            page(3, [
                "EDUCATION",
                "Master of Science, Analytics - Marchmont College, 2019",
                "CERTIFICATIONS",
                "SnowPro Core Certification - 2022",
            ]),
        ]
    )


def projects_resume() -> bytes:
    """A single column with a projects section: title line, then a stack-and-link bullet."""
    lines = [
        "Ignatius Fairweather-Mbeki",
        "PROFESSIONAL SUMMARY",
        "Security engineer building detection tooling and graph analytics.",
        "SKILLS",
        "Detection: Sigma, YARA",
        "Languages: Python, Go",
        "PROFESSIONAL EXPERIENCE",
        "Umbral Defence Partners - Detection Engineer March 2021 - Present",
        "Wrote and tuned detection content for endpoint telemetry.",
        "PROJECTS",
        "Threat Graph Explorer",
        "Technologies: Python, NetworkX, MITRE ATT&CK",
        "- github.com/example/threat-graph",
        "Maps technique coverage across a detection library and finds the gaps.",
        "Sigma Rule Linter",
        "Tech stack: Python, PyYAML, Sigma",
        "- github.com/example/sigma-linter",
        "Checks rule syntax and field names against a reference schema.",
        "EDUCATION",
        "Master of Science",
        "Information Security",
        "Marchmont College, 2018",
        "CERTIFICATIONS",
        "GIAC Certified Detection Analyst - 2022",
    ]
    return build_pdf([Page(lines=_column(lines, 72.0))])


def image_only_pdf() -> bytes:
    """A scan: one drawn image, not a single text operator."""
    return build_pdf([Page(image=True)], with_font=False)


def empty_pdf() -> bytes:
    """A valid PDF with a page that draws nothing at all."""
    return build_pdf([Page()])


def thin_text_pdf() -> bytes:
    """A text layer that exists but is far too thin to be a resume."""
    return build_pdf([Page(lines=[(72.0, 700.0, "Resume")])])


def corrupted_pdf() -> bytes:
    """Header and trailer survive; the body is shredded."""
    good = plain_resume()
    return good[:40] + b"\x00\x01\x02 not a pdf body at all \xff\xfe" + good[-60:]


def contradictory_dates_resume() -> bytes:
    """Dates that cannot all be true: an end before its start, and overlapping full-time roles."""
    lines = [
        "Wilhelmina Ashgrove-Petrakis",
        "PROFESSIONAL SUMMARY",
        "Software engineer working on payment services and ledger tooling.",
        "TECHNICAL SKILLS",
        "Languages: Java, Kotlin, SQL",
        "PROFESSIONAL EXPERIENCE",
        "Dunsmere Payments - Software Engineer II    March 2021 - January 2019",
        "Maintained the settlement service and its reconciliation jobs.",
        "Harrowgate Ledger - Software Engineer    June 2020 - Present",
        "Built the double-entry posting API used by four internal teams.",
        "Pellingbrook Retail - Junior Developer    June 2020 - Present",
        "Shipped the storefront checkout rewrite.",
        "EDUCATION",
        "Bachelor of Science, Software Engineering - Alderbury State University, 2020",
    ]
    return build_pdf([Page(lines=_column(lines, 72.0))])


def unicode_resume() -> bytes:
    """Accents, an en dash, curly quotes and a non-breaking space in the text layer."""
    lines = [
        "Zoé Müller-Ñandú",
        "PROFESSIONAL SUMMARY",
        "Ingénieure qualité who writes tooling in Python and TypeScript.",
        "TECHNICAL SKILLS",
        "Automation: Playwright, Pytest, Robot Framework",
        "PROFESSIONAL EXPERIENCE",
        "Société Brindlewick – QA Engineer    March 2021 – Present",
        "Wrote the “happy path” suite and the team’s flake triage runbook.",
        "EDUCATION",
        "Licence, Informatique – Université de Marchmont, 2019",
    ]
    return build_pdf([Page(lines=_column(lines, 72.0))])


#: Fixture name -> builder. The intake tests iterate this, so a new fixture is covered by adding it here.
FIXTURES = {
    "plain-resume": plain_resume,
    "linkedin-export": linkedin_export,
    "two-column": two_column_resume,
    "two-column-banner": two_column_with_banner,
    "projects": projects_resume,
    "multipage": multipage_resume,
    "image-only": image_only_pdf,
    "empty": empty_pdf,
    "thin-text": thin_text_pdf,
    "corrupted": corrupted_pdf,
    "contradictory-dates": contradictory_dates_resume,
    "unicode": unicode_resume,
}

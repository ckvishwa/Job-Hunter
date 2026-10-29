"""Local intake: extraction conditions, page/offset provenance, offline guard.

Every input is built in-process by tests/synthetic_pdfs.py or tests/builders.py.
No test reads a real candidate document, no test needs PostgreSQL, Docker or the
network, and the expected results are written from the fixture text, never from
the extractor's own output.
"""
from __future__ import annotations

import json
import re
import socket
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pytest

from app import offline_guard
from app.extract_text import extract_pdf, normalize_text, pdf_page_texts
from app.local_intake import (
    INTAKE_REVISION,
    detect_column_gutter,
    intake_bytes,
    verify_spans,
)
from tests.builders import build_docx
from tests.synthetic_pdfs import (
    FIXTURES,
    PLAIN_RESUME_LINES,
    contradictory_dates_resume,
    corrupted_pdf,
    empty_pdf,
    image_only_pdf,
    linkedin_export,
    multipage_resume,
    plain_resume,
    thin_text_pdf,
    two_column_resume,
    two_column_with_banner,
    unicode_resume,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CLI = REPO_ROOT / "services" / "ai" / "local_intake_cli.py"


# ---------------------------------------------------------------------------------------------------------------------
# Conditions
# ---------------------------------------------------------------------------------------------------------------------

def test_plain_text_resume_is_extracted():
    result = intake_bytes(plain_resume(), "pdf")
    assert result.status == "EXTRACTED", result.warnings
    assert result.page_count == 1
    assert result.failure_code is None
    # Every fixture line is present as its own line of the canonical text. A PDF has no tab
    # character: the fixture separates a title from its dates with a run of spaces, and
    # pdfplumber reports one space for that run, so the run is collapsed on the expected side.
    extracted = [line.text for line in result.lines]
    for expected in PLAIN_RESUME_LINES:
        assert re.sub(r" {2,}", " ", expected) in extracted


def test_two_column_resume_has_its_reading_order_rebuilt():
    result = intake_bytes(two_column_resume(), "pdf")
    assert result.status == "EXTRACTED"
    assert result.reading_order == "columns"
    assert result.pages[0].column_gutter is not None
    assert result.pages[0].reading_order == "columns"
    # The rebuild is recorded, and it replaces the bare "this might be two columns" doubt.
    assert "READING_ORDER_RECONSTRUCTED" in result.warnings
    assert "POSSIBLE_MULTI_COLUMN" not in result.warnings


def test_linkedin_export_rail_is_detected_as_a_column_split():
    result = intake_bytes(linkedin_export(), "pdf")
    assert result.pages[0].column_gutter is not None
    assert result.reading_order == "columns"
    assert result.status == "EXTRACTED"


def test_single_column_resume_reports_no_gutter():
    result = intake_bytes(plain_resume(), "pdf")
    assert result.pages[0].column_gutter is None


# ---------------------------------------------------------------------------------------------------------------------
# Reading-order reconstruction
# ---------------------------------------------------------------------------------------------------------------------

#: Written from the fixture definition in tests/synthetic_pdfs.py, not from any extractor output:
#: the left column of two_column_resume() top to bottom, then its right column.
TWO_COLUMN_READING_ORDER = [
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


def test_two_column_page_is_rebuilt_into_column_order():
    result = intake_bytes(two_column_resume(), "pdf")
    assert [line.text for line in result.lines] == TWO_COLUMN_READING_ORDER
    # A heading is a line of its own again, which is what the native order destroyed.
    assert "EDUCATION" in [line.text for line in result.lines]


def test_the_left_column_is_emitted_before_the_right_one():
    result = intake_bytes(two_column_resume(), "pdf")
    columns = [line.column for line in result.lines if line.column is not None]
    assert columns == sorted(columns)
    assert set(columns) == {0, 1}


def test_a_date_stays_with_the_entry_it_was_printed_under():
    result = intake_bytes(two_column_resume(), "pdf")
    texts = [line.text for line in result.lines]
    for title, dates in (("Security Analyst, Tier 2", "May 2022 - Present"), ("SOC Analyst, Tier 1", "July 2020 - April 2022")):
        assert texts.index(dates) == texts.index(title) + 1


def test_a_rebuilt_page_preserves_every_non_whitespace_character():
    native_pages, _, _ = pdf_page_texts(two_column_resume())
    result = intake_bytes(two_column_resume(), "pdf")
    assert Counter(re.sub(r"\s", "", result.text)) == Counter(re.sub(r"\s", "", normalize_text("\n".join(native_pages))))


def test_a_rebuilt_line_records_where_it_came_from():
    result = intake_bytes(two_column_resume(), "pdf")
    for line in result.lines:
        assert line.bbox is not None and len(line.bbox) == 4
        x0, top, x1, bottom = line.bbox
        assert x0 < x1 and top < bottom
        # The row of the extractor's own output a reviewer can check this text against.
        assert line.native_index is not None


def test_a_full_width_banner_and_footer_are_kept_whole_and_act_as_boundaries():
    result = intake_bytes(two_column_with_banner(), "pdf")
    texts = [line.text for line in result.lines]
    assert result.reading_order == "columns"
    # The banner is one line, first; the footer is one line, last. Neither is split by the gutter.
    assert texts[0] == "Barnabas Okediji-Thistlewaite - Platform Engineer"
    assert texts[1] == "Harrowgate, WA - barnabas.ot@example.invalid"
    assert texts[-1] == "References available on request - page 1 of 1 - Barnabas Okediji-Thistlewaite"
    assert [line.column for line in result.lines[:2]] == [None, None]
    assert result.lines[-1].column is None
    # Between the boundaries: the whole left column, then the whole right column.
    middle = [line for line in result.lines[2:-1]]
    assert [line.column for line in middle] == sorted(line.column for line in middle)
    assert texts[2:5] == ["SKILLS", "Kubernetes", "Terraform"]
    assert "EXPERIENCE" in texts and texts.index("EXPERIENCE") > texts.index("Marchmont College, 2019")


def test_a_single_column_page_is_left_in_native_order():
    result = intake_bytes(plain_resume(), "pdf")
    assert result.reading_order == "native"
    assert all(line.bbox is None for line in result.lines)
    assert all(line.native_index == line.index for line in result.lines)


def test_a_reflow_that_would_change_the_content_is_discarded(monkeypatch):
    from app import local_intake

    original = local_intake.reflow_page

    def lossy(layout, gutter):  # noqa: ANN001, ANN202 - test double: drops the last line
        return original(layout, gutter)[:-1]

    monkeypatch.setattr(local_intake, "reflow_page", lossy)
    result = intake_bytes(two_column_resume(), "pdf")
    assert result.reading_order == "native"
    assert result.status == "LOW_TEXT_CONFIDENCE"
    assert "REFLOW_REJECTED_CONTENT_MISMATCH" in result.warnings
    # The native text is kept rather than a rebuild that lost a line.
    native_pages, _, _ = pdf_page_texts(two_column_resume())
    assert result.text == normalize_text("\n".join(native_pages))


def test_group_rows_groups_a_row_and_keeps_it_left_to_right():
    from app.extract_text import PlacedWord
    from app.local_intake import group_rows

    words = [
        PlacedWord(text="second", x0=100.0, top=10.0, x1=140.0, bottom=21.0),
        PlacedWord(text="first", x0=10.0, top=10.5, x1=90.0, bottom=21.5),
        PlacedWord(text="below", x0=10.0, top=40.0, x1=60.0, bottom=51.0),
    ]
    rows = group_rows(words)
    assert [[w.text for w in row] for row in rows] == [["first", "second"], ["below"]]


def test_a_row_without_a_real_gap_at_the_gutter_is_one_line_not_two_columns():
    from app.extract_text import PageLayout, PlacedWord
    from app.local_intake import reflow_page

    # Two words either side of x=300 with a 4-point gap: ordinary word spacing, not a gutter.
    layout = PageLayout(
        width=612.0,
        height=792.0,
        words=(
            PlacedWord(text="Platform", x0=250.0, top=10.0, x1=298.0, bottom=21.0),
            PlacedWord(text="Engineer", x0=302.0, top=10.0, x1=350.0, bottom=21.0),
        ),
        image_count=0,
    )
    assert [(line.text, line.column) for line in reflow_page(layout, 300.0)] == [("Platform Engineer", None)]


def test_image_only_pdf_needs_local_ocr_and_is_never_an_empty_resume():
    result = intake_bytes(image_only_pdf(), "pdf")
    assert result.status == "NEEDS_LOCAL_OCR"
    assert result.failure_code == "NO_TEXT_LAYER"
    assert "IMAGE_ONLY_DOCUMENT" in result.warnings
    assert result.lines == []
    assert result.metrics["imageCount"] >= 1


def test_empty_pdf_is_distinguished_from_a_scan():
    result = intake_bytes(empty_pdf(), "pdf")
    assert result.status == "EXTRACTION_FAILED"
    assert result.failure_code == "EMPTY_DOCUMENT"
    assert "NO_TEXT_AND_NO_IMAGES" in result.warnings


def test_thin_text_layer_is_not_reported_as_extracted():
    result = intake_bytes(thin_text_pdf(), "pdf")
    assert result.status in ("EXTRACTION_FAILED", "NEEDS_LOCAL_OCR")
    assert result.status != "EXTRACTED"


def test_corrupted_pdf_fails_with_a_typed_code():
    result = intake_bytes(corrupted_pdf(), "pdf")
    assert result.status == "EXTRACTION_FAILED"
    assert result.failure_code == "UNREADABLE_FILE"


def test_unsupported_file_type_is_refused():
    result = intake_bytes(b"%PDF-1.4", "xlsx")
    assert result.status == "EXTRACTION_FAILED"
    assert result.failure_code == "UNSUPPORTED_FILE_TYPE"


def test_docx_intake_still_works():
    data = build_docx(["PROFESSIONAL SUMMARY", "Quality engineer with eight years of automation work.", "TECHNICAL SKILLS", "Automation: Playwright, Pytest", "EDUCATION", "Bachelor of Science, Computer Science - Alderbury State University"])
    result = intake_bytes(data, "docx")
    assert result.status in ("EXTRACTED", "LOW_TEXT_CONFIDENCE")
    assert result.page_count == 1
    assert any("Playwright" in line.text for line in result.lines)


# ---------------------------------------------------------------------------------------------------------------------
# Page and offset provenance
# ---------------------------------------------------------------------------------------------------------------------

def test_multipage_pages_resolve_and_do_not_overlap():
    result = intake_bytes(multipage_resume(), "pdf")
    assert result.page_count == 3
    assert all(page.resolved for page in result.pages)
    spans = [(page.start, page.end) for page in result.pages]
    assert all(start is not None and end is not None and start < end for start, end in spans)
    for earlier, later in zip(spans, spans[1:]):
        assert earlier[1] <= later[0]


def test_every_line_is_assigned_to_the_page_it_was_printed_on():
    result = intake_bytes(multipage_resume(), "pdf")
    footers = {line.page: line.text for line in result.lines if line.text.startswith("Page ")}
    assert footers == {0: "Page 1 of 3 - Thaddeus Okonkwo-Reinholt", 1: "Page 2 of 3 - Thaddeus Okonkwo-Reinholt", 2: "Page 3 of 3 - Thaddeus Okonkwo-Reinholt"}


def test_repeated_header_is_kept_on_every_page_not_deduplicated():
    result = intake_bytes(multipage_resume(), "pdf")
    headers = [line for line in result.lines if line.text.startswith("Thaddeus Okonkwo-Reinholt - Data Engineer")]
    assert len(headers) == 3
    assert sorted(line.page for line in headers) == [0, 1, 2]


@pytest.mark.parametrize("name", sorted(FIXTURES))
def test_every_emitted_span_reproduces_its_text(name):
    result = intake_bytes(FIXTURES[name](), "pdf")
    assert verify_spans(result.text, result.lines) == []
    assert "SPAN_VERIFICATION_FAILED" not in result.warnings


def test_unicode_text_is_nfc_and_spans_are_utf16_code_units():
    result = intake_bytes(unicode_resume(), "pdf")
    assert result.status in ("EXTRACTED", "LOW_TEXT_CONFIDENCE")
    assert "TEXT_NOT_NFC" not in result.warnings
    assert any("Müller" in line.text for line in result.lines), [line.text for line in result.lines][:3]
    units = result.text.encode("utf-16-le")
    for line in result.lines:
        assert units[line.start * 2 : line.end * 2].decode("utf-16-le") == line.text


def test_span_offsets_count_utf16_units_for_astral_text():
    # Exercised directly: no base-14 PDF font can carry an astral character.
    from app.local_intake import _finish, PageSpan
    from app.offsets import utf16_len

    text = "Lead \U0001F680 engineer\nSecond line"
    page = PageSpan(index=0, start=0, end=utf16_len(text), char_count=len(text), non_whitespace=0, image_count=0, resolved=True, column_gutter=None)
    result = _finish(text, [page], 1, [])
    second = next(line for line in result.lines if line.text == "Second line")
    # The rocket is one code point but two UTF-16 units, so the second line starts one unit later than len() would say.
    assert second.start == text.index("Second line") + 1


# ---------------------------------------------------------------------------------------------------------------------
# No inference
# ---------------------------------------------------------------------------------------------------------------------

def test_contradictory_dates_are_preserved_exactly_and_not_corrected():
    result = intake_bytes(contradictory_dates_resume(), "pdf")
    lines = [line.text for line in result.lines]
    # One space, not four: the fixture's space run is what pdfplumber collapses (see the plain-resume test).
    assert "Dunsmere Payments - Software Engineer II March 2021 - January 2019" in lines
    # Two overlapping "Present" roles both survive: intake records, it does not adjudicate.
    assert sum(1 for line in lines if line.endswith("June 2020 - Present")) == 2
    assert result.status in ("EXTRACTED", "LOW_TEXT_CONFIDENCE")


def test_intake_adds_no_text_of_its_own():
    data = plain_resume()
    result = intake_bytes(data, "pdf")
    joined = "\n".join(line.text for line in result.lines)
    for sentence in ("years of experience", "proficient", "expert", "advanced"):
        assert sentence not in joined.lower()


# ---------------------------------------------------------------------------------------------------------------------
# The refactor must not have changed the service's extraction
# ---------------------------------------------------------------------------------------------------------------------

def test_extract_pdf_is_unchanged_by_the_page_split():
    data = plain_resume()
    pages, count, layout = pdf_page_texts(data, with_layout=True)
    assert layout and count == 1
    assert extract_pdf(data).text == normalize_text("\n".join(pages))
    assert extract_pdf(data).page_count == count


def test_page_texts_without_layout_does_no_geometry_work():
    pages, count, layout = pdf_page_texts(multipage_resume())
    assert count == 3 and len(pages) == 3 and layout == []


def test_gutter_detection_ignores_a_page_with_too_few_words():
    from app.extract_text import PageLayout, PlacedWord

    layout = PageLayout(
        width=612.0,
        height=792.0,
        words=tuple(PlacedWord(text="word", x0=10.0 + 60 * i, top=100.0, x1=40.0 + 60 * i, bottom=111.0) for i in range(4)),
        image_count=0,
    )
    assert detect_column_gutter(layout) is None


# ---------------------------------------------------------------------------------------------------------------------
# Offline guard
# ---------------------------------------------------------------------------------------------------------------------

def test_network_guard_blocks_a_remote_connection_and_allows_loopback():
    offline_guard.block_network()
    try:
        with pytest.raises(offline_guard.NetworkBlocked):
            socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect(("93.184.216.34", 80))
        with pytest.raises(offline_guard.NetworkBlocked):
            socket.getaddrinfo("huggingface.co", 443)
        # Loopback stays usable: a local service is not an exfiltration path.
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client.connect(listener.getsockname())
        client.close()
        listener.close()
    finally:
        offline_guard.restore_network()
    # Restored: the guard is not left installed for the rest of the suite.
    assert socket.getaddrinfo("localhost", 80)


def test_dependency_check_reports_what_is_missing_and_installs_nothing():
    present = offline_guard.require_dependencies(("pdfplumber",))
    assert present.ok and "pdfplumber" in present.versions
    absent = offline_guard.require_dependencies(("a_module_that_is_not_installed_anywhere",))
    assert not absent.ok
    assert absent.missing == ("a_module_that_is_not_installed_anywhere",)
    assert "a_module_that_is_not_installed_anywhere" not in sys.modules


# ---------------------------------------------------------------------------------------------------------------------
# CLI: privacy behaviour
# ---------------------------------------------------------------------------------------------------------------------

def run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-I", str(CLI), *args], capture_output=True, text=True, cwd=str(REPO_ROOT))


def test_cli_refuses_an_output_directory_inside_a_git_checkout(tmp_path):
    inside = REPO_ROOT / "tmp" / "intake-guard-check"
    result = run_cli(["--input-dir", str(tmp_path), "--out-dir", str(inside)])
    assert result.returncode == offline_guard.EXIT_PRIVACY_VIOLATION
    assert "PRIVATE_OUTPUT_INSIDE_REPO" in result.stdout
    assert not inside.exists()


def test_cli_writes_drafts_and_prints_no_document_content(tmp_path):
    source = tmp_path / "in"
    source.mkdir()
    # A Windows-shaped name: spaces and parentheses.
    (source / "Synthetic Profile (3).pdf").write_bytes(plain_resume())
    (source / "Synthetic Scan (4).pdf").write_bytes(image_only_pdf())
    out = tmp_path / "private-out"

    result = run_cli(["--input-dir", str(source), "--out-dir", str(out)])
    assert result.returncode == 0, result.stdout + result.stderr
    assert "STATUS EXTRACTED=1 NEEDS_LOCAL_OCR=1" in result.stdout

    # Nothing from inside a document, and no file name, reaches stdout.
    for leak in ("Marisol", "Quintero", "Thistledown", "example.invalid", "Synthetic Profile", ".pdf"):
        assert leak not in result.stdout, f"{leak!r} leaked into CLI output"

    drafts = sorted(out.glob("*.draft.json"))
    assert len(drafts) == 2
    draft = json.loads(drafts[0].read_text(encoding="utf-8"))
    assert draft["schema"] == "local-intake-draft/4"
    assert draft["reading"]["parserRevision"] == "marker-deterministic-v2"
    assert draft["intakeRevision"] == INTAKE_REVISION
    assert draft["reviewStatus"] == "PENDING_REVIEW"
    assert draft["approval"] == {"approvedBy": None, "approvedAt": None}
    assert draft["documentId"].startswith("doc-") and draft["candidateId"].startswith("cand-")

    manifest = json.loads((out / "intake-manifest.json").read_text(encoding="utf-8"))
    assert manifest["offline"] is True
    assert manifest["documentCount"] == 2
    assert {row["status"] for row in manifest["documents"]} == {"EXTRACTED", "NEEDS_LOCAL_OCR"}


def test_cli_treats_a_duplicate_document_as_the_same_document(tmp_path):
    source = tmp_path / "in"
    source.mkdir()
    (source / "Profile A.pdf").write_bytes(plain_resume())
    (source / "Profile A copy.pdf").write_bytes(plain_resume())
    out = tmp_path / "private-out"

    result = run_cli(["--input-dir", str(source), "--out-dir", str(out)])
    assert result.returncode == 0, result.stdout
    # Same bytes, same source hash, same pseudonymous id: one draft, the second skipped.
    assert len(list(out.glob("*.draft.json"))) == 1
    assert "SKIPPED_EXISTING" in result.stdout
    manifest = json.loads((out / "intake-manifest.json").read_text(encoding="utf-8"))
    ids = {row["documentId"] for row in manifest["documents"]}
    assert len(ids) == 1
    assert {row["sourceSha256"] for row in manifest["documents"]}.__len__() == 1


def test_pseudonymous_ids_are_salted_per_private_directory(tmp_path):
    source = tmp_path / "in"
    source.mkdir()
    (source / "Profile A.pdf").write_bytes(plain_resume())
    first, second = tmp_path / "out-1", tmp_path / "out-2"
    run_cli(["--input-dir", str(source), "--out-dir", str(first)])
    run_cli(["--input-dir", str(source), "--out-dir", str(second)])
    ids = [
        json.loads(next(directory.glob("*.draft.json")).read_text(encoding="utf-8"))["documentId"]
        for directory in (first, second)
    ]
    # The id cannot be recomputed from the file alone; the salt lives with the private output.
    assert ids[0] != ids[1]

"""Tests for the dataset-preparation layer: inventory, review, annotation, relations.

Fixtures are PDFs built on the fly with PyMuPDF, so these run without the
corpus and without any model or OCR download. The OCR fallback is exercised
with the engine stubbed out - the real engine is covered by the parser's
shape-normalisation tests in ``test_harness.py``.

    python -m pytest tests -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

from src.annotate import (  # noqa: E402
    AnnotationDraft,
    EmploymentRecord,
    SpanRef,
    apply_review_tsv,
    build_draft,
    load_draft,
    promote,
    propose_relations,
    refine_suggestions,
    validate_draft,
    write_draft,
)
from src.inventory import (  # noqa: E402
    _jaccard,
    _shingles,
    classify_kind,
    find_duplicates,
    group_families,
    inspect_document,
    sha256_file,
)
from src.parser import LayoutWord, ResumeDocumentParser, reflow_columns  # noqa: E402
from src.review import draw_overlay, page_report  # noqa: E402

LEFT_COLUMN = ["CONTACT", "phone", "email", "SKILLS", "Python", "Selenium"]
RIGHT_COLUMN = ["EXPERIENCE", "QA", "Engineer", "Northwind", "Inc.", "2024"]


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _write_pdf(path: Path, pages: list[list[tuple[str, float, float]]]) -> Path:
    """Write a PDF whose pages hold the given (text, x, y) placements."""
    document = pymupdf.open()
    for placements in pages:
        page = document.new_page(width=612, height=792)
        for text, x, y in placements:
            page.insert_text((x, y), text, fontsize=11)
    document.save(path)
    document.close()
    return path


@pytest.fixture
def single_column_pdf(tmp_path: Path) -> Path:
    placements = [(f"word{index}", 72.0, 100.0 + index * 20) for index in range(20)]
    return _write_pdf(tmp_path / "single.pdf", [placements])


@pytest.fixture
def two_column_pdf(tmp_path: Path) -> Path:
    """Right column written FIRST, so native order interleaves the columns."""
    placements = [(text, 330.0, 120.0 + index * 24) for index, text in enumerate(RIGHT_COLUMN)]
    placements += [(text, 60.0, 120.0 + index * 24) for index, text in enumerate(LEFT_COLUMN)]
    return _write_pdf(tmp_path / "two-column.pdf", [placements])


@pytest.fixture
def two_page_pdf(tmp_path: Path) -> Path:
    first = [(f"first{index}", 72.0, 100.0 + index * 20) for index in range(15)]
    second = [(f"second{index}", 72.0, 100.0 + index * 20) for index in range(12)]
    return _write_pdf(tmp_path / "two-page.pdf", [first, second])


# --------------------------------------------------------------------------- #
# Inventory
# --------------------------------------------------------------------------- #
def test_sha256_is_stable_and_distinguishes_files(single_column_pdf: Path, two_page_pdf: Path) -> None:
    assert sha256_file(single_column_pdf) == sha256_file(single_column_pdf)
    assert sha256_file(single_column_pdf) != sha256_file(two_page_pdf)
    assert len(sha256_file(single_column_pdf)) == 64


def test_classify_kind_covers_pdf_image_other(tmp_path: Path) -> None:
    assert classify_kind(Path("a.pdf")) == "pdf"
    assert classify_kind(Path("a.PDF")) == "pdf"
    assert classify_kind(Path("a.png")) == "image"
    assert classify_kind(Path("a.jpeg")) == "image"
    assert classify_kind(Path("a.docx")) == "other"


def test_inspect_document_reports_geometry_and_valid_boxes(single_column_pdf: Path) -> None:
    record = inspect_document(single_column_pdf, ResumeDocumentParser(keep_images=False))
    assert record.supported and record.kind == "pdf"
    assert record.page_count == 1
    assert record.total_words == 20
    assert record.has_native_text
    assert record.ocr_pages == 0
    page = record.pages[0]
    assert (page.width, page.height) == (612.0, 792.0)
    assert page.boxes_out_of_grid == 0
    assert page.boxes_inverted == 0
    assert page.boxes_degenerate == 0


def test_inspect_document_marks_image_unsupported(tmp_path: Path) -> None:
    from PIL import Image

    image_path = tmp_path / "scan.png"
    Image.new("RGB", (80, 100), "white").save(image_path)
    record = inspect_document(image_path, ResumeDocumentParser(keep_images=False))
    assert record.kind == "image"
    assert record.supported is False
    assert record.page_count == 0
    assert any("image adapter" in warning for warning in record.warnings)


def test_inspect_document_handles_multi_page(two_page_pdf: Path) -> None:
    record = inspect_document(two_page_pdf, ResumeDocumentParser(keep_images=False))
    assert record.page_count == 2
    assert [page.page_index for page in record.pages] == [0, 1]
    assert record.total_words == 27


def test_inspect_document_reports_broken_pdf(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.7\nnot actually a pdf\n")
    record = inspect_document(broken, ResumeDocumentParser(keep_images=False))
    assert record.supported is False
    assert any("parse failed" in warning for warning in record.warnings)


# --------------------------------------------------------------------------- #
# Duplicates and families
# --------------------------------------------------------------------------- #
def test_find_duplicates_flags_byte_identical(single_column_pdf: Path, tmp_path: Path) -> None:
    copy = tmp_path / "copy.pdf"
    copy.write_bytes(single_column_pdf.read_bytes())
    parser = ResumeDocumentParser(keep_images=False)
    records = [inspect_document(single_column_pdf, parser), inspect_document(copy, parser)]
    find_duplicates(records, {record.filename: set() for record in records})
    assert records[1].duplicate_of == records[0].filename
    assert any("byte-identical" in warning for warning in records[1].warnings)


def test_find_duplicates_flags_near_duplicate_text(single_column_pdf: Path, two_page_pdf: Path) -> None:
    parser = ResumeDocumentParser(keep_images=False)
    records = [inspect_document(single_column_pdf, parser), inspect_document(two_page_pdf, parser)]
    shared = _shingles(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"])
    find_duplicates(records, {record.filename: shared for record in records})
    assert records[0].near_duplicates
    assert records[0].near_duplicates[0]["relation"] == "duplicate-text"
    assert records[0].near_duplicates[0]["other"] == records[1].filename


def test_jaccard_and_shingles_behaviour() -> None:
    left = _shingles("a b c d e f".split())
    assert _jaccard(left, left) == 1.0
    assert _jaccard(left, set()) == 0.0
    assert _jaccard(left, _shingles("x y z q r s".split())) == 0.0


def test_group_families_clusters_identical_layouts(single_column_pdf: Path, tmp_path: Path) -> None:
    copy = tmp_path / "same-layout.pdf"
    copy.write_bytes(single_column_pdf.read_bytes())
    parser = ResumeDocumentParser(keep_images=False)
    records = [inspect_document(single_column_pdf, parser), inspect_document(copy, parser)]
    families = group_families(records)
    assert len(families) == 1
    assert sorted(next(iter(families.values()))) == sorted(r.filename for r in records)


# --------------------------------------------------------------------------- #
# Column separation and reading order
# --------------------------------------------------------------------------- #
def test_column_reflow_reads_left_column_before_right(two_column_pdf: Path) -> None:
    native = ResumeDocumentParser(keep_images=False).parse(two_column_pdf)
    native_texts = [word.text for word in native.pages[0].words]
    # The fixture writes the right column first, so native order starts there.
    assert native_texts[0] == RIGHT_COLUMN[0]

    reflowed = ResumeDocumentParser(keep_images=False, reading_order="columns").parse(two_column_pdf)
    texts = [word.text for word in reflowed.pages[0].words]
    assert texts[: len(LEFT_COLUMN)] == LEFT_COLUMN
    assert texts[len(LEFT_COLUMN) :] == RIGHT_COLUMN


def test_reflow_columns_is_stable_for_single_column() -> None:
    words = [
        LayoutWord(text=f"w{index}", box=(100, 100 + index * 30, 400, 120 + index * 30), line_id=index)
        for index in range(8)
    ]
    assert [word.text for word in reflow_columns(words)] == [word.text for word in words]


def test_page_report_groups_words_into_lines(two_column_pdf: Path) -> None:
    document = ResumeDocumentParser(keep_images=False).parse(two_column_pdf)
    report = page_report(document.pages[0])
    assert report["word_count"] == len(RIGHT_COLUMN) + len(LEFT_COLUMN)
    assert report["lines"]
    assert all("text" in line and "box" in line for line in report["lines"])


def test_draw_overlay_returns_same_size_image(single_column_pdf: Path) -> None:
    document = ResumeDocumentParser(keep_images=True, render_dpi=72).parse(single_column_pdf)
    page = document.pages[0]
    overlay = draw_overlay(page, page.image)
    assert overlay.size == page.image.size
    assert overlay.mode == "RGB"


# --------------------------------------------------------------------------- #
# OCR fallback (engine stubbed)
# --------------------------------------------------------------------------- #
def test_ocr_fallback_triggers_on_image_only_page(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = _write_pdf(tmp_path / "source.pdf", [[("Hello", 72.0, 100.0)]])
    document = pymupdf.open(source)
    pixmap = document[0].get_pixmap(dpi=72)
    scanned = pymupdf.open()
    page = scanned.new_page(width=612, height=792)
    page.insert_image(page.rect, pixmap=pixmap)
    scan_path = tmp_path / "scan.pdf"
    scanned.save(scan_path)
    scanned.close()
    document.close()

    calls: list[int] = []

    def fake_ocr_words(image, lang="en", use_gpu=False, min_confidence=0.0, enable_mkldnn=False):
        calls.append(1)
        return [LayoutWord(text="Hello", box=(10, 10, 100, 40), line_id=0, confidence=0.99)]

    monkeypatch.setattr("src.parser._ocr_words", fake_ocr_words)
    parsed = ResumeDocumentParser(keep_images=False).parse(scan_path)
    assert calls, "OCR fallback was not used for an image-only page"
    assert parsed.pages[0].source == "ocr"
    assert [word.text for word in parsed.pages[0].words] == ["Hello"]


def test_native_page_never_calls_ocr(single_column_pdf: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(*args, **kwargs):  # pragma: no cover - must not run
        raise AssertionError("OCR must not run for a page with native text")

    monkeypatch.setattr("src.parser._ocr_words", explode)
    parsed = ResumeDocumentParser(keep_images=False).parse(single_column_pdf)
    assert parsed.pages[0].source == "native"


# --------------------------------------------------------------------------- #
# Proposal refinement
# --------------------------------------------------------------------------- #
def test_refine_suggestions_drops_swallowed_sentences() -> None:
    words = ["Results-driven"] + [f"w{index}" for index in range(10)]
    tags = ["B-EMPLOYER"] + ["I-EMPLOYER"] * 10
    assert refine_suggestions(words, tags) == ["O"] * 11


def test_refine_suggestions_drops_lone_date_glue_but_keeps_real_ranges() -> None:
    words = ["random", "to", "filler"]
    assert refine_suggestions(words, ["O", "B-DATE", "O"]) == ["O", "O", "O"]

    words = ["Jan", "2024", "to", "Mar", "2025"]
    tags = ["B-DATE", "I-DATE", "B-DATE", "B-DATE", "I-DATE"]
    refined = refine_suggestions(words, tags)
    assert refined[0] == "B-DATE" and refined[2] == "B-DATE"


def test_refine_suggestions_keeps_short_entities() -> None:
    words = ["Northwind", "Inc."]
    assert refine_suggestions(words, ["B-EMPLOYER", "I-EMPLOYER"]) == ["B-EMPLOYER", "I-EMPLOYER"]


# --------------------------------------------------------------------------- #
# Drafts, relations and promotion
# --------------------------------------------------------------------------- #
def _draft(tmp_path: Path, pdf: Path) -> AnnotationDraft:
    return build_draft(pdf, ResumeDocumentParser(keep_images=False), template_family="fixture")


def test_build_draft_is_unreviewed_and_round_trips(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    assert draft.status == "UNREVIEWED"
    assert draft.reviewed_word_count == 0
    assert draft.word_count == 20
    assert all(word.label is None for page in draft.pages for word in page.words)
    assert draft.source_sha256 == sha256_file(single_column_pdf)

    json_path, tsv_path = write_draft(draft, tmp_path / "drafts")
    reloaded = load_draft(json_path)
    assert reloaded.word_count == draft.word_count
    assert tsv_path.read_text(encoding="utf-8").startswith("page\tindex\tline\ttext\tbox")
    assert validate_draft(reloaded) == []


def test_promote_refuses_unreviewed_draft(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    with pytest.raises(ValueError, match="not REVIEWED"):
        promote(draft)


def test_promote_refuses_partially_reviewed_draft(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    for word in draft.pages[0].words[:5]:
        word.label, word.status = "O", "REVIEWED"
    draft.status, draft.reviewer = "REVIEWED", "someone"
    with pytest.raises(ValueError, match="unreviewed"):
        promote(draft)


def test_promote_emits_training_annotation_when_fully_reviewed(
    tmp_path: Path, single_column_pdf: Path
) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    for word in draft.pages[0].words:
        word.label, word.status = "O", "REVIEWED"
    draft.pages[0].words[0].label = "B-NAME"
    draft.status, draft.reviewer = "REVIEWED", "a-human"
    payload = promote(draft)
    assert payload["doc_id"] == draft.doc_id
    assert payload["reviewer"] == "a-human"
    assert payload["pages"][0]["words"][0]["tag"] == "B-NAME"
    assert all(word["tag"] is not None for word in payload["pages"][0]["words"])

    from src.dataset import AnnotatedDocument

    document = AnnotatedDocument.model_validate(payload)
    assert document.word_count == draft.word_count


def test_apply_review_tsv_marks_only_filled_rows(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    _json_path, tsv_path = write_draft(draft, tmp_path / "drafts")
    rows = tsv_path.read_text(encoding="utf-8").splitlines()
    rows[1] = rows[1].rsplit("\t", 2)[0] + "\tB-NAME\tUNREVIEWED"
    tsv_path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    issues = apply_review_tsv(draft, tsv_path, reviewer="a-human")
    assert issues == []
    assert draft.pages[0].words[0].label == "B-NAME"
    assert draft.pages[0].words[0].status == "REVIEWED"
    assert draft.status == "IN_REVIEW"  # the rest is still unreviewed
    assert draft.reviewed_word_count == 1


def test_apply_review_tsv_rejects_drifted_text(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    _json_path, tsv_path = write_draft(draft, tmp_path / "drafts")
    rows = tsv_path.read_text(encoding="utf-8").splitlines()
    columns = rows[1].split("\t")
    columns[3] = "SOMETHING-ELSE"
    columns[6] = "B-NAME"
    rows[1] = "\t".join(columns)
    tsv_path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    issues = apply_review_tsv(draft, tsv_path, reviewer="a-human")
    assert any("re-export the draft" in issue for issue in issues)
    assert draft.pages[0].words[0].label is None


def test_apply_review_tsv_rejects_unknown_tag(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    _json_path, tsv_path = write_draft(draft, tmp_path / "drafts")
    rows = tsv_path.read_text(encoding="utf-8").splitlines()
    columns = rows[1].split("\t")
    columns[6] = "B-NOT-A-TAG"
    rows[1] = "\t".join(columns)
    tsv_path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    issues = apply_review_tsv(draft, tsv_path, reviewer="a-human")
    assert any("unknown tag" in issue for issue in issues)


# --------------------------------------------------------------------------- #
# Relation validation
# --------------------------------------------------------------------------- #
def test_relation_span_must_match_extracted_text(tmp_path: Path, two_column_pdf: Path) -> None:
    draft = _draft(tmp_path, two_column_pdf)
    page = draft.pages[0]
    good = SpanRef(page_index=0, start=0, end=2, text=" ".join(w.text for w in page.words[:2]))
    draft.employment = [EmploymentRecord(record_id="r1", page_index=0, employer=good)]
    assert validate_draft(draft) == []

    draft.employment[0].employer = SpanRef(page_index=0, start=0, end=2, text="Totally Invented Ltd")
    issues = validate_draft(draft)
    assert any("!= extracted" in issue for issue in issues)


def test_relation_span_out_of_range_is_rejected(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    draft.employment = [
        EmploymentRecord(
            record_id="r1",
            page_index=0,
            employer=SpanRef(page_index=0, start=500, end=501, text="ghost"),
        )
    ]
    assert any("beyond" in issue for issue in validate_draft(draft))

    draft.employment = [
        EmploymentRecord(
            record_id="r2",
            page_index=0,
            employer=SpanRef(page_index=7, start=0, end=1, text="ghost"),
        )
    ]
    assert any("does not exist" in issue for issue in validate_draft(draft))


def test_employment_record_tracks_missing_fields() -> None:
    record = EmploymentRecord(record_id="r", page_index=0)
    assert record.missing == ["employer", "job_title", "start_date", "end_date"]
    assert record.status == "UNREVIEWED"


def test_reviewed_relation_with_missing_fields_is_rejected(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    draft.employment = [EmploymentRecord(record_id="r", page_index=0, status="REVIEWED")]
    issues = validate_draft(draft)
    assert any("use AMBIGUOUS" in issue for issue in issues)

    draft.employment[0].status = "AMBIGUOUS"
    assert validate_draft(draft) == []


def test_propose_relations_never_invents_text(tmp_path: Path, two_column_pdf: Path) -> None:
    draft = _draft(tmp_path, two_column_pdf)
    employment, education = propose_relations(draft)
    for record in list(employment) + list(education):
        for field in ("employer", "job_title", "degree", "school", "start_date", "end_date"):
            span = getattr(record, field, None)
            if span is None:
                continue
            page = draft.page(span.page_index)
            actual = " ".join(word.text for word in page.words[span.start : span.end])
            assert span.text == actual
        assert record.status == "UNREVIEWED"


def test_draft_status_reviewed_requires_reviewer(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    for word in draft.pages[0].words:
        word.label, word.status = "O", "REVIEWED"
    draft.status = "REVIEWED"
    assert any("no reviewer" in issue for issue in validate_draft(draft))


def test_reviewed_page_must_hold_valid_bio(tmp_path: Path, single_column_pdf: Path) -> None:
    draft = _draft(tmp_path, single_column_pdf)
    for word in draft.pages[0].words:
        word.label, word.status = "O", "REVIEWED"
    draft.pages[0].words[3].label = "I-NAME"  # orphan continuation
    draft.status, draft.reviewer = "REVIEWED", "a-human"
    assert any("BIO invalid" in issue for issue in validate_draft(draft))

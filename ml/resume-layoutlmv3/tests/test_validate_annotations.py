"""Regression tests for the annotation validation and promotion gate.

Every fixture is synthetic: a small PDF written with PyMuPDF, a draft built
from it by the real pipeline, and a review TSV/manifest mutated per test. No
corpus file and no model download is involved.

    python -m pytest tests/test_validate_annotations.py -q
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

from src.annotate import (  # noqa: E402
    AnnotationDraft,
    EducationRecord,
    EmploymentRecord,
    SpanRef,
    build_draft,
    write_draft,
    write_relation_tsvs,
)
from src.parser import ResumeDocumentParser  # noqa: E402
from src.validate_annotations import (  # noqa: E402
    LABEL_LIST,
    VALID_LABELS,
    ReviewManifest,
    annotation_revision,
    check_bio,
    check_box,
    init_manifest,
    manifest_path_for,
    parse_box,
    promote_draft,
    source_tokens,
    validate_annotation,
    validate_relationships,
    validate_rows,
)

WORDS = [
    "Harper",
    "Russo",
    "QA",
    "Engineer",
    "Northwind",
    "Inc",
    "2024",
    "Python",
    "Selenium",
    "Bachelor",
    "Technology",
    "Borcelle",
    "University",
]
LABELS_FOR_WORDS = [
    "B-NAME",
    "I-NAME",
    "B-JOB_TITLE",
    "I-JOB_TITLE",
    "B-EMPLOYER",
    "I-EMPLOYER",
    "B-DATE",
    "B-SKILL",
    "B-SKILL",
    "B-DEGREE",
    "I-DEGREE",
    "B-SCHOOL",
    "I-SCHOOL",
]

#: Fixtures must stay on the native path: a PDF with fewer than
#: MIN_NATIVE_WORDS words would be treated as a scan and sent to PaddleOCR.
def _parser() -> ResumeDocumentParser:
    return ResumeDocumentParser(keep_images=False, min_native_words=1)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _write_pdf(path: Path, pages: list[list[str]]) -> Path:
    document = pymupdf.open()
    for words in pages:
        page = document.new_page(width=612, height=792)
        for index, word in enumerate(words):
            page.insert_text((72.0, 100.0 + index * 24), word, fontsize=11)
    document.save(path)
    document.close()
    return path


@pytest.fixture
def pdf(tmp_path: Path) -> Path:
    return _write_pdf(tmp_path / "fixture.pdf", [WORDS])


@pytest.fixture
def two_page_pdf(tmp_path: Path) -> Path:
    return _write_pdf(
        tmp_path / "two-page.pdf", [WORDS, [f"second{index}" for index in range(12)]]
    )


@pytest.fixture
def draft(pdf: Path) -> AnnotationDraft:
    return build_draft(pdf, _parser(), template_family="fixture")


@pytest.fixture
def written(draft: AnnotationDraft, tmp_path: Path) -> tuple[AnnotationDraft, Path, Path]:
    draft_path, tsv_path = write_draft(draft, tmp_path / "pkg")
    return draft, draft_path, tsv_path


def _rows(tsv_path: Path) -> tuple[list[str], list[list[str]]]:
    lines = tsv_path.read_text(encoding="utf-8").splitlines()
    return lines[0].split("\t"), [line.split("\t") for line in lines[1:]]


def _write_rows(tsv_path: Path, header: list[str], rows: list[list[str]]) -> None:
    tsv_path.write_text(
        "\n".join(["\t".join(header)] + ["\t".join(row) for row in rows]) + "\n",
        encoding="utf-8",
    )


def _label_everything(draft: AnnotationDraft, labels: list[str] | None = None) -> None:
    """Mark every token reviewed, which is what a finished human pass produces."""
    for page in draft.pages:
        for position, word in enumerate(page.words):
            if labels is not None and position < len(labels):
                word.label = labels[position]
            else:
                word.label = "O"
            word.status = "REVIEWED"
    # A finished human pass replaces the machine proposals with its own
    # decisions; tests that need records add them explicitly.
    draft.employment = []
    draft.education = []
    draft.status = "REVIEWED"
    draft.reviewer = "a-human"


def _approved_manifest(draft: AnnotationDraft, **overrides) -> ReviewManifest:
    payload = {
        "doc_id": draft.doc_id,
        "source_sha256": draft.source_sha256,
        "extraction_revision": draft.extraction_revision,
        "annotation_revision": annotation_revision(draft),
        "review_status": "APPROVED",
        "reviewer": "a-human",
        "reviewed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    payload.update(overrides)
    return ReviewManifest(**payload)


# --------------------------------------------------------------------------- #
# 1-2. TSV schema
# --------------------------------------------------------------------------- #
def test_01_valid_tsv_schema_passes(written) -> None:
    draft, _draft_path, tsv_path = written
    assert validate_rows(tsv_path, source_tokens(draft)) == []


def test_02_missing_required_column_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    drop = header.index("text")
    header.pop(drop)
    for row in rows:
        row.pop(drop)
    _write_rows(tsv_path, header, rows)
    errors = validate_rows(tsv_path, source_tokens(draft))
    assert any("Missing columns" in error and "text" in error for error in errors)


def test_02b_label_and_token_id_aliases_are_accepted(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    header[header.index("final_label")] = "label"
    header[header.index("index")] = "token_id"
    _write_rows(tsv_path, header, rows)
    assert validate_rows(tsv_path, source_tokens(draft)) == []


# --------------------------------------------------------------------------- #
# 3-6. Row identity and count
# --------------------------------------------------------------------------- #
def test_03_duplicate_token_ids_are_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[1][header.index("index")] = rows[0][header.index("index")]
    _write_rows(tsv_path, header, rows)
    assert any("duplicate token ID" in error for error in validate_rows(tsv_path, source_tokens(draft)))


def test_04_reordered_tokens_are_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[0], rows[1] = rows[1], rows[0]
    _write_rows(tsv_path, header, rows)
    errors = validate_rows(tsv_path, source_tokens(draft))
    assert any("token ID mismatch" in error for error in errors)
    assert any("token text mismatch" in error for error in errors)


def test_05_missing_token_row_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    _write_rows(tsv_path, header, rows[:-1])
    errors = validate_rows(tsv_path, source_tokens(draft))
    assert any("Token count mismatch" in error for error in errors)


def test_06_added_token_row_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    extra = list(rows[-1])
    extra[header.index("index")] = "999"
    extra[header.index("text")] = "INVENTED"
    _write_rows(tsv_path, header, rows + [extra])
    errors = validate_rows(tsv_path, source_tokens(draft))
    assert any("Token count mismatch" in error for error in errors)


# --------------------------------------------------------------------------- #
# 7-10. Text and boxes
# --------------------------------------------------------------------------- #
def test_07_changed_token_text_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[0][header.index("text")] = "harper"  # lowercase must NOT be tolerated
    _write_rows(tsv_path, header, rows)
    assert any("token text mismatch" in error for error in validate_rows(tsv_path, source_tokens(draft)))


def test_08_box_not_matching_source_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[0][header.index("box")] = "10,10,20,20"
    _write_rows(tsv_path, header, rows)
    assert any("source box mismatch" in error for error in validate_rows(tsv_path, source_tokens(draft)))


def test_09_out_of_range_coordinates_are_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[0][header.index("box")] = "0,0,1200,50"
    _write_rows(tsv_path, header, rows)
    assert any("Outside 0-1000 grid" in error for error in validate_rows(tsv_path, source_tokens(draft)))


def test_10_zero_area_box_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[0][header.index("box")] = "100,100,100,140"
    _write_rows(tsv_path, header, rows)
    errors = validate_rows(tsv_path, source_tokens(draft))
    assert any("Non-positive width" in error for error in errors)


def test_10b_parse_box_rejects_floats_bools_and_short_boxes() -> None:
    assert parse_box("1,2,3,4") == [1, 2, 3, 4]
    assert parse_box("[1, 2, 3, 4]") == [1, 2, 3, 4]
    for bad in ("1,2,3", "1.5,2,3,4", "[true, 2, 3, 4]", "a,b,c,d", ""):
        with pytest.raises(ValueError):
            parse_box(bad)
    assert check_box([0, 0, 10, 10]) == []


# --------------------------------------------------------------------------- #
# 11-14. BIO sequences
# --------------------------------------------------------------------------- #
def test_11_invalid_bio_label_is_rejected(written) -> None:
    draft, _draft_path, tsv_path = written
    header, rows = _rows(tsv_path)
    rows[0][header.index("final_label")] = "B-SALARY"
    _write_rows(tsv_path, header, rows)
    assert any("invalid label" in error for error in validate_rows(tsv_path, source_tokens(draft)))


def test_12_orphan_inside_tag_is_rejected() -> None:
    errors = check_bio(["O", "I-EMPLOYER", "O"])
    assert errors and "orphan I-EMPLOYER" in errors[0]
    assert check_bio(["B-EMPLOYER", "I-EMPLOYER", "O"]) == []


def test_12b_blank_label_is_pending_not_invalid() -> None:
    assert check_bio(["", "", ""]) == []
    assert check_bio(["B-NAME", "", "I-NAME"]) == ["Token 2: orphan I-NAME"]


def test_13_relationship_span_starting_mid_entity_is_rejected(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    page = draft.pages[0]
    draft.employment = [
        EmploymentRecord(
            record_id="r1",
            page_index=0,
            employer=SpanRef(page_index=0, start=5, end=6, text=page.words[5].text),
            job_title=SpanRef(
                page_index=0, start=2, end=4, text=" ".join(w.text for w in page.words[2:4])
            ),
            status="REVIEWED",
        )
    ]
    errors = validate_relationships(draft)
    assert any("starts mid-entity" in error for error in errors)


def test_14_bio_resets_at_page_boundaries(two_page_pdf: Path, tmp_path: Path) -> None:
    draft = build_draft(two_page_pdf, _parser())
    assert len(draft.pages) == 2
    tokens = source_tokens(draft)
    pages = [token["page"] for token in tokens]

    # An I- tag opening page 2 is an orphan; a B- tag there is fine even though
    # page 1 ended inside an entity.
    labels = ["O"] * len(tokens)
    labels[len(draft.pages[0].words) - 1] = "B-SKILL"
    labels[len(draft.pages[0].words)] = "I-SKILL"
    assert any("orphan" in error for error in check_bio(labels, pages))

    labels[len(draft.pages[0].words)] = "B-SKILL"
    assert check_bio(labels, pages) == []


def test_14b_token_ids_may_repeat_across_pages(two_page_pdf: Path, tmp_path: Path) -> None:
    draft = build_draft(two_page_pdf, _parser())
    _draft_path, tsv_path = write_draft(draft, tmp_path / "pkg")
    assert validate_rows(tsv_path, source_tokens(draft)) == []


# --------------------------------------------------------------------------- #
# 15-16. Source identity
# --------------------------------------------------------------------------- #
def test_15_source_sha_mismatch_reports_source_changed(draft: AnnotationDraft, pdf: Path) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    manifest = _approved_manifest(draft)
    pdf.write_bytes(pdf.read_bytes() + b"\n% edited\n")  # same path, new bytes
    result = validate_annotation(draft, manifest=manifest, pdf_path=pdf)
    assert result.status == "SOURCE_CHANGED"
    assert any("SHA-256 changed" in error for error in result.source_errors)


def test_16_changed_extraction_revision_reports_source_changed(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    manifest = _approved_manifest(draft, extraction_revision="pymupdf-words@0:native")
    result = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert result.status == "SOURCE_CHANGED"
    assert any("extraction" in error for error in result.source_errors)


# --------------------------------------------------------------------------- #
# 17-19. Human review authority
# --------------------------------------------------------------------------- #
def test_17_missing_manifest_is_review_pending(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    result = validate_annotation(draft, manifest=None, check_source_file=False)
    assert result.status == "REVIEW_PENDING"
    assert any("unreviewed" in error for error in result.review_errors)


def test_18_unreviewed_all_o_stub_never_approves(draft: AnnotationDraft, tmp_path: Path) -> None:
    # A freshly generated draft: structurally fine, nothing reviewed.
    draft_path, tsv_path = write_draft(draft, tmp_path / "pkg")
    manifest = init_manifest(draft, manifest_path_for(draft_path))
    assert manifest.review_status == "UNREVIEWED"
    result = validate_annotation(
        draft, tsv_path=tsv_path, manifest=manifest, check_source_file=False
    )
    assert result.status == "REVIEW_PENDING"
    assert result.entity_token_count == 0


def test_19_empty_document_needs_explicit_confirmation(draft: AnnotationDraft) -> None:
    _label_everything(draft)  # every token reviewed as O
    manifest = _approved_manifest(draft)
    pending = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert pending.status == "REVIEW_PENDING"
    assert any("empty_document_confirmed" in error for error in pending.review_errors)

    confirmed = _approved_manifest(draft, empty_document_confirmed=True)
    approved = validate_annotation(draft, manifest=confirmed, check_source_file=False)
    assert approved.status == "APPROVED"


# --------------------------------------------------------------------------- #
# 20-22. Relationships and manifest freshness
# --------------------------------------------------------------------------- #
def test_20_invalid_employment_association_is_rejected(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    page = draft.pages[0]
    draft.employment = [
        EmploymentRecord(
            record_id="r1",
            page_index=0,
            # points at the NAME span, not an employer
            employer=SpanRef(page_index=0, start=0, end=2, text=" ".join(w.text for w in page.words[:2])),
            job_title=SpanRef(page_index=0, start=2, end=4, text=" ".join(w.text for w in page.words[2:4])),
            status="REVIEWED",
        )
    ]
    manifest = _approved_manifest(draft)
    result = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert result.status == "RELATIONSHIP_INVALID"
    assert any("expected EMPLOYER labels" in error for error in result.relationship_errors)


def test_21_invalid_education_association_is_rejected(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    page = draft.pages[0]
    draft.education = [
        EducationRecord(
            record_id="e1",
            page_index=0,
            degree=SpanRef(page_index=0, start=7, end=8, text=page.words[7].text),  # a SKILL word
            school=SpanRef(page_index=0, start=4, end=6, text=" ".join(w.text for w in page.words[4:6])),
            status="REVIEWED",
        )
    ]
    result = validate_annotation(draft, manifest=_approved_manifest(draft), check_source_file=False)
    assert result.status == "RELATIONSHIP_INVALID"
    assert any("expected DEGREE labels" in error for error in result.relationship_errors)


def test_21b_missing_required_relationship_field_is_rejected(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    draft.employment = [EmploymentRecord(record_id="r1", page_index=0, status="REVIEWED")]
    errors = validate_relationships(draft)
    assert any("missing required field" in error for error in errors)


def test_21c_ambiguous_record_with_missing_fields_is_allowed(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    draft.employment = [EmploymentRecord(record_id="r1", page_index=0, status="AMBIGUOUS")]
    assert validate_relationships(draft) == []


def test_22b_moving_a_relationship_span_invalidates_approval(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    page = draft.pages[0]
    draft.employment = [
        EmploymentRecord(
            record_id="r1",
            page_index=0,
            employer=SpanRef(page_index=0, start=4, end=6, text=" ".join(w.text for w in page.words[4:6])),
            job_title=SpanRef(page_index=0, start=2, end=4, text=" ".join(w.text for w in page.words[2:4])),
            status="REVIEWED",
        )
    ]
    manifest = _approved_manifest(draft)
    assert validate_annotation(draft, manifest=manifest, check_source_file=False).status == "APPROVED"

    # Same labels, different span: the approval must go stale.
    draft.employment[0].employer = SpanRef(
        page_index=0, start=5, end=6, text=page.words[5].text
    )
    result = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert result.status != "APPROVED"
    assert any("stale manifest" in error for error in result.review_errors)


def test_22_stale_manifest_is_not_approved(draft: AnnotationDraft) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    manifest = _approved_manifest(draft)
    draft.pages[0].words[-1].label = "O"  # a label edited after approval
    result = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert result.status == "REVIEW_PENDING"
    assert any("stale manifest" in error for error in result.review_errors)


# --------------------------------------------------------------------------- #
# 23-25. Promotion
# --------------------------------------------------------------------------- #
def test_23_approved_annotation_promotes_with_provenance(draft: AnnotationDraft, tmp_path: Path) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    manifest = _approved_manifest(draft)
    result = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert result.status == "APPROVED"

    target = tmp_path / "annotations"
    promoted = promote_draft(draft, result, target, manifest)
    assert promoted.status == "PROMOTED"
    payload = json.loads((target / f"{draft.doc_id}.json").read_text(encoding="utf-8"))
    assert payload["pages"][0]["words"][0]["tag"] == "B-NAME"
    assert payload["provenance"]["reviewer"] == "a-human"
    assert payload["provenance"]["annotation_revision"] == result.annotation_revision
    assert payload["provenance"]["source_sha256"] == draft.source_sha256

    from src.dataset import AnnotatedDocument

    assert AnnotatedDocument.model_validate(payload).word_count == draft.word_count


def test_24_repeated_promotion_is_idempotent_then_guarded(draft: AnnotationDraft, tmp_path: Path) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    manifest = _approved_manifest(draft)
    target = tmp_path / "annotations"

    first = promote_draft(
        draft, validate_annotation(draft, manifest=manifest, check_source_file=False), target, manifest
    )
    assert first.status == "PROMOTED"

    second = promote_draft(
        draft, validate_annotation(draft, manifest=manifest, check_source_file=False), target, manifest
    )
    assert second.status == "PROMOTED"
    assert any("already promoted" in warning for warning in second.warnings)

    # A new revision must not overwrite silently.
    draft.pages[0].words[-1].label = "O"
    changed_manifest = _approved_manifest(draft)
    changed = promote_draft(
        draft,
        validate_annotation(draft, manifest=changed_manifest, check_source_file=False),
        target,
        changed_manifest,
    )
    assert changed.status == "REJECTED"
    assert any("--replace" in error for error in changed.review_errors)

    replaced = promote_draft(
        draft,
        validate_annotation(draft, manifest=changed_manifest, check_source_file=False),
        target,
        changed_manifest,
        replace=True,
    )
    assert replaced.status == "PROMOTED"
    archived = list(target.glob("*.superseded.json"))
    assert archived, "previous annotation should be archived, not discarded"


def test_25_failed_promotion_preserves_existing_annotation(draft: AnnotationDraft, tmp_path: Path) -> None:
    _label_everything(draft, LABELS_FOR_WORDS)
    manifest = _approved_manifest(draft)
    target = tmp_path / "annotations"
    promote_draft(
        draft, validate_annotation(draft, manifest=manifest, check_source_file=False), target, manifest
    )
    good = (target / f"{draft.doc_id}.json").read_text(encoding="utf-8")

    # Now break the review: unreviewed tokens must not promote, and must not
    # damage what is already there.
    draft.pages[0].words[0].status = "UNREVIEWED"
    draft.pages[0].words[0].label = None
    broken = validate_annotation(draft, manifest=manifest, check_source_file=False)
    assert broken.status == "REVIEW_PENDING"
    after = promote_draft(draft, broken, target, manifest)
    assert after.status == "REVIEW_PENDING"
    assert (target / f"{draft.doc_id}.json").read_text(encoding="utf-8") == good


# --------------------------------------------------------------------------- #
# Taxonomy binding
# --------------------------------------------------------------------------- #
def test_label_list_matches_the_harness_taxonomy() -> None:
    from src.dataset import LABELS

    assert LABEL_LIST == list(LABELS)
    assert len(LABEL_LIST) == 15
    assert VALID_LABELS == set(LABELS)


def test_relationship_tsvs_round_trip(draft: AnnotationDraft, tmp_path: Path) -> None:
    from src.annotate import apply_relation_tsv

    draft.employment = [
        EmploymentRecord(
            record_id="r1",
            page_index=0,
            employer=SpanRef(page_index=0, start=4, end=6, text="Northwind Inc"),
            job_title=SpanRef(page_index=0, start=2, end=4, text="QA Engineer"),
        )
    ]
    employment_path, _education_path = write_relation_tsvs(draft, tmp_path / "pkg")

    rows = list(csv.DictReader(employment_path.open(encoding="utf-8"), delimiter="\t"))
    rows[0]["final_status"] = "REVIEWED"
    with employment_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), delimiter="\t", lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    assert apply_relation_tsv(draft, employment_path, "employment") == []
    assert draft.employment[0].status == "REVIEWED"


def test_relationship_tsv_text_edit_is_rejected(draft: AnnotationDraft, tmp_path: Path) -> None:
    from src.annotate import apply_relation_tsv

    draft.employment = [
        EmploymentRecord(
            record_id="r1",
            page_index=0,
            employer=SpanRef(page_index=0, start=4, end=6, text="Northwind Inc"),
            job_title=SpanRef(page_index=0, start=2, end=4, text="QA Engineer"),
        )
    ]
    employment_path, _ = write_relation_tsvs(draft, tmp_path / "pkg")
    text = employment_path.read_text(encoding="utf-8").replace("Northwind Inc", "Invented Ltd")
    employment_path.write_text(text, encoding="utf-8")

    issues = apply_relation_tsv(draft, employment_path, "employment")
    assert any("edit the span in the draft JSON" in issue for issue in issues)
    assert draft.employment[0].employer.text == "Northwind Inc"

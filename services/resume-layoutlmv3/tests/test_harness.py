"""Unit tests for the pure parts of the harness.

No model download, no OCR engine, no PDF needed - these cover the contracts
that silently corrupt a training run when they break: box normalisation, label
alignment, BIO span decoding, split leakage and OCR result shapes.

    python -m pytest tests -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.dataset import (  # noqa: E402
    IGNORE_INDEX,
    LABEL2ID,
    AnnotatedDocument,
    AnnotatedPage,
    AnnotatedWord,
    align_labels,
    build_samples,
    build_splits,
    synthetic_document,
    validate_splits,
    verify_bio,
    _window_bounds,
)
from src.evaluate import StubRulesV2Baseline, classify_failures, spans_from_tags  # noqa: E402
from src.parser import (  # noqa: E402
    _detect_gutter,
    _iter_paddle_results,
    _split_line_into_words,
    normalize_box,
)


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #
def test_normalize_box_scales_to_grid() -> None:
    assert normalize_box(0, 0, 306, 396, 612, 792) == (0, 0, 500, 500)
    assert normalize_box(612, 792, 612, 792, 612, 792) == (1000, 1000, 1000, 1000)


def test_normalize_box_repairs_inverted_and_out_of_range() -> None:
    assert normalize_box(306, 396, 0, 0, 612, 792) == (0, 0, 500, 500)
    assert normalize_box(-50, -50, 2000, 2000, 612, 792) == (0, 0, 1000, 1000)


def test_normalize_box_survives_zero_page_size() -> None:
    assert normalize_box(10, 10, 20, 20, 0, 0) == (0, 0, 0, 0)
    assert normalize_box(10, 10, 20, 20, 612, 0) == (0, 0, 0, 0)


def test_detect_gutter_finds_two_columns_and_ignores_one() -> None:
    two_column = [(10, y, 90, y + 10) for y in range(0, 60, 10)] + [
        (210, y, 290, y + 10) for y in range(0, 60, 10)
    ]
    gutter = _detect_gutter(two_column, page_width=300)
    assert gutter is not None and 90 < gutter < 210

    single_column = [(10, y, 290, y + 10) for y in range(0, 80, 10)]
    assert _detect_gutter(single_column, page_width=300) is None


def test_split_line_into_words_apportions_width() -> None:
    words = _split_line_into_words("QA Engineer", (0.0, 0.0, 110.0, 10.0))
    assert [text for text, _ in words] == ["QA", "Engineer"]
    (_, first_box), (_, second_box) = words
    assert first_box[0] == 0.0
    assert first_box[2] < second_box[0]
    assert second_box[2] <= 110.0


def test_split_line_into_words_handles_degenerate_box() -> None:
    words = _split_line_into_words("  spaced  out ", (5.0, 1.0, 5.0, 2.0))
    assert [text for text, _ in words] == ["spaced", "out"]
    assert _split_line_into_words("   ", (0.0, 0.0, 10.0, 5.0)) == []


# --------------------------------------------------------------------------- #
# OCR result shapes
# --------------------------------------------------------------------------- #
def test_iter_paddle_results_reads_2x_page_buckets() -> None:
    raw = [[[[[0, 0], [10, 0], [10, 5], [0, 5]], ("Hello", 0.98)]]]
    assert list(_iter_paddle_results(raw)) == [
        ([[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]], "Hello", 0.98)
    ]


def test_iter_paddle_results_reads_3x_mapping() -> None:
    raw = [
        {
            "rec_texts": ["Hello", "World"],
            "rec_polys": [
                [[0, 0], [10, 0], [10, 5], [0, 5]],
                [[0, 6], [10, 6], [10, 11], [0, 11]],
            ],
            "rec_scores": [0.9, 0.8],
        }
    ]
    assert [text for _, text, _ in _iter_paddle_results(raw)] == ["Hello", "World"]


def test_iter_paddle_results_skips_empty_and_none() -> None:
    assert list(_iter_paddle_results(None)) == []
    assert list(_iter_paddle_results([None, []])) == []
    raw = [[[[[0, 0], [1, 0], [1, 1], [0, 1]], ("   ", 0.5)]]]
    assert list(_iter_paddle_results(raw)) == []


# --------------------------------------------------------------------------- #
# Labels and alignment
# --------------------------------------------------------------------------- #
def test_align_labels_ignores_specials_and_continuations() -> None:
    word_ids = [None, 0, 0, 1, None]
    labels = align_labels(word_ids, ["B-NAME", "I-NAME"])
    assert labels == [
        IGNORE_INDEX,
        LABEL2ID["B-NAME"],
        IGNORE_INDEX,
        LABEL2ID["I-NAME"],
        IGNORE_INDEX,
    ]


def test_align_labels_can_label_continuations_as_inside() -> None:
    labels = align_labels([None, 0, 0], ["B-NAME"], label_all_subwords=True)
    assert labels == [IGNORE_INDEX, LABEL2ID["B-NAME"], LABEL2ID["I-NAME"]]


def test_verify_bio_flags_orphan_inside_tag() -> None:
    assert verify_bio(["O", "B-DATE", "I-DATE", "O"]) == []
    assert verify_bio(["O", "I-DATE"]) and "I-DATE follows O" in verify_bio(["O", "I-DATE"])[0]


def test_annotated_word_rejects_bad_tag_and_box() -> None:
    with pytest.raises(ValueError):
        AnnotatedWord(text="x", box=(0, 0, 10, 10), tag="B-NOPE")
    with pytest.raises(ValueError):
        AnnotatedWord(text="x", box=(0, 0, 1001, 10), tag="O")
    with pytest.raises(ValueError):
        AnnotatedWord(text="  ", box=(0, 0, 10, 10), tag="O")


# --------------------------------------------------------------------------- #
# Windowing
# --------------------------------------------------------------------------- #
def test_window_bounds_cover_everything_with_overlap() -> None:
    assert _window_bounds(5, 10, 2) == [(0, 5)]
    bounds = _window_bounds(25, 10, 2)
    assert bounds[0] == (0, 10)
    assert bounds[-1][1] == 25
    covered = {index for start, end in bounds for index in range(start, end)}
    assert covered == set(range(25))


def test_build_samples_keeps_word_offsets() -> None:
    document = synthetic_document()
    samples = build_samples([document], window_words=5, window_stride=1)
    # 15 words, window 5, stride 1 -> step 4, so the last window is 12..15.
    assert [sample.word_offset for sample in samples] == [0, 4, 8, 12]
    assert all(len(sample.words) == len(sample.tags) == len(sample.boxes) for sample in samples)


# --------------------------------------------------------------------------- #
# Splits
# --------------------------------------------------------------------------- #
def _documents(families: dict[str, int]) -> dict[str, AnnotatedDocument]:
    documents: dict[str, AnnotatedDocument] = {}
    counter = 0
    for family, count in families.items():
        for _ in range(count):
            doc_id = f"doc-{counter:02d}"
            counter += 1
            documents[doc_id] = AnnotatedDocument(
                doc_id=doc_id,
                template_family=family,
                pages=[
                    AnnotatedPage(
                        page_index=0,
                        words=[AnnotatedWord(text="word", box=(0, 0, 10, 10), tag="O")],
                    )
                ],
            )
    return documents


def test_build_splits_keeps_families_together() -> None:
    documents = _documents({"a": 7, "b": 2, "c": 2, "d": 1, "e": 1})
    splits = build_splits(documents)
    validate_splits(splits, documents)
    assert sum(len(splits[name]) for name in ("train", "val", "test")) == len(documents)
    for family, split in splits["family_assignment"].items():
        members = {doc_id for doc_id, doc in documents.items() if doc.template_family == family}
        assert members <= set(splits[split]), f"{family} leaked out of {split}"


def test_validate_splits_rejects_overlap_and_leakage() -> None:
    documents = _documents({"a": 2, "b": 1})
    with pytest.raises(ValueError, match="appears in both"):
        validate_splits({"train": ["doc-00"], "val": ["doc-00"], "test": []}, documents)
    with pytest.raises(ValueError, match="data leakage"):
        validate_splits({"train": ["doc-00"], "val": ["doc-01"], "test": ["doc-02"]}, documents)
    with pytest.raises(ValueError, match="unknown doc_ids"):
        validate_splits({"train": ["ghost"], "val": [], "test": []}, documents)


# --------------------------------------------------------------------------- #
# Spans and failure classification
# --------------------------------------------------------------------------- #
def test_spans_from_tags_decodes_and_recovers_from_orphan_inside() -> None:
    tags = ["B-NAME", "I-NAME", "O", "B-DATE", "B-DATE", "I-SKILL"]
    spans = spans_from_tags(tags, page_index=0, words=["Ada", "Lovelace", "x", "Jan", "Feb", "SQL"])
    assert [(s.entity, s.start, s.end) for s in spans] == [
        ("NAME", 0, 2),
        ("DATE", 3, 4),
        ("DATE", 4, 5),
        ("SKILL", 5, 6),
    ]
    assert spans[0].text == "Ada Lovelace"


def test_classify_failures_buckets_each_error_kind() -> None:
    words = ["Ada", "Lovelace", "QA", "Engineer", "SQL"]
    gold = spans_from_tags(["B-NAME", "I-NAME", "B-JOB_TITLE", "I-JOB_TITLE", "O"], 0, words)
    predicted = spans_from_tags(["B-NAME", "O", "B-EMPLOYER", "I-EMPLOYER", "B-SKILL"], 0, words)
    kinds = {failure["kind"] for failure in classify_failures(gold, predicted, "doc", "native")}
    assert kinds == {"boundary", "type", "spurious"}

    missed = classify_failures(gold, [], "doc", "native")
    assert {failure["kind"] for failure in missed} == {"missed"}


# --------------------------------------------------------------------------- #
# Baseline contract
# --------------------------------------------------------------------------- #
def test_stub_baseline_returns_one_tag_per_word() -> None:
    baseline = StubRulesV2Baseline()
    words = ["Ada", "Lovelace", "Senior", "QA", "Engineer", "Northwind", "Inc.", "2024", "SQL"]
    boxes = [[10 + index * 20, 10, 60 + index * 20, 22] for index in range(len(words))]
    tags = baseline.predict_page(words, boxes)
    assert len(tags) == len(words)
    assert all(tag in LABEL2ID for tag in tags)
    assert verify_bio(tags) == []
    assert baseline.predict_page([], []) == []


def test_stub_baseline_tags_years_as_dates() -> None:
    baseline = StubRulesV2Baseline()
    tags = baseline.predict_page(["random", "2024"], [[0, 300, 50, 312], [60, 300, 110, 312]])
    assert tags[1] == "B-DATE"


# --------------------------------------------------------------------------- #
# Annotation round trip
# --------------------------------------------------------------------------- #
def test_annotation_round_trip(tmp_path: Path) -> None:
    document = synthetic_document("round-trip")
    path = tmp_path / "round-trip.json"
    path.write_text(document.model_dump_json(indent=2), encoding="utf-8")

    from src.dataset import load_annotation

    reloaded = load_annotation(path)
    assert reloaded.doc_id == "round-trip"
    assert reloaded.word_count == document.word_count
    assert reloaded.tag_counts() == document.tag_counts()
    assert json.loads(path.read_text(encoding="utf-8"))["pages"][0]["words"][0]["tag"] == "B-NAME"

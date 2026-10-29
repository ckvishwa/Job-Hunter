"""Tests for the Rules v2 adapter: UTF-16 offsets, span projection, availability.

The integration tests skip when the ``universal-job-discovery`` worktree that
holds the production parser is not present, so the suite still runs in a bare
checkout.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.dataset import LABEL2ID  # noqa: E402
from src.rules_v2_adapter import (  # noqa: E402
    DEFAULT_SERVICES_AI,
    SUPPORTED_ENTITIES,
    UNSUPPORTED_ENTITIES,
    AdapterUnavailable,
    RulesV2Adapter,
    _words_in_span,
    build_text,
    utf16_length,
)

PARSER_PRESENT = (DEFAULT_SERVICES_AI / "app" / "parse_resume.py").is_file()
requires_parser = pytest.mark.skipif(
    not PARSER_PRESENT, reason=f"resume-rules@2 not found at {DEFAULT_SERVICES_AI}"
)


# --------------------------------------------------------------------------- #
# Offsets
# --------------------------------------------------------------------------- #
def test_utf16_length_counts_code_units_not_characters() -> None:
    assert utf16_length("abc") == 3
    assert utf16_length("é") == 1
    assert utf16_length("𝄞") == 2  # astral plane: surrogate pair
    assert utf16_length("") == 0


def test_build_text_offsets_cover_every_word() -> None:
    words = ["EMMA", "SANCHEZ", "Administrative", "Manager"]
    lines = [0, 0, 1, 1]
    text, offsets = build_text(words, lines)
    assert text == "EMMA SANCHEZ\nAdministrative Manager"
    assert len(offsets) == len(words)
    assert offsets[-1].end == utf16_length(text)
    for word, offset in zip(words, offsets):
        assert text[offset.start : offset.end] == word


def test_build_text_handles_astral_characters() -> None:
    words = ["𝄞clef", "next"]
    text, offsets = build_text(words, [0, 0])
    assert offsets[0].end == utf16_length(words[0])
    assert offsets[1].end == utf16_length(text)


def test_build_text_defaults_to_one_line_and_validates_lengths() -> None:
    text, offsets = build_text(["a", "b"])
    assert text == "a b" and len(offsets) == 2
    with pytest.raises(ValueError):
        build_text(["a", "b"], [0])


def test_words_in_span_selects_overlapping_words_only() -> None:
    _text, offsets = build_text(["alpha", "beta", "gamma"], [0, 0, 0])
    assert _words_in_span(offsets, 0, 5) == [0]
    assert _words_in_span(offsets, 0, 7) == [0, 1]
    assert _words_in_span(offsets, 6, 10) == [1]
    assert _words_in_span(offsets, 100, 110) == []


# --------------------------------------------------------------------------- #
# Availability
# --------------------------------------------------------------------------- #
def test_missing_parser_path_raises_adapter_unavailable(tmp_path: Path) -> None:
    with pytest.raises(AdapterUnavailable, match="resume-rules@2 not found"):
        RulesV2Adapter(services_ai_path=tmp_path)


def test_entity_coverage_is_declared_and_disjoint() -> None:
    assert set(SUPPORTED_ENTITIES).isdisjoint(UNSUPPORTED_ENTITIES)
    for entity in SUPPORTED_ENTITIES + UNSUPPORTED_ENTITIES:
        assert f"B-{entity}" in LABEL2ID


# --------------------------------------------------------------------------- #
# Integration with the real parser
# --------------------------------------------------------------------------- #
@requires_parser
def test_adapter_returns_one_tag_per_word() -> None:
    adapter = RulesV2Adapter()
    words = "EMMA SANCHEZ Administrative Manager".split()
    tags = adapter.predict_page(words, [[0, 0, 1, 1]] * len(words), [0, 0, 1, 1])
    assert len(tags) == len(words)
    assert all(tag in LABEL2ID for tag in tags)
    assert adapter.predict_page([], [], []) == []


@requires_parser
def test_adapter_tags_employer_and_degree_from_real_facts() -> None:
    adapter = RulesV2Adapter()
    lines = [
        "EMMA SANCHEZ",
        "WORK EXPERIENCE",
        "Administrative Assistant",
        "Arowwai Industries",
        "Oct 2023 - Present",
        "EDUCATION",
        "Bachelor of Business Administration",
    ]
    words: list[str] = []
    line_ids: list[int] = []
    for line_id, line in enumerate(lines):
        for token in line.split():
            words.append(token)
            line_ids.append(line_id)

    tags = adapter.predict_page(words, [[0, 0, 1, 1]] * len(words), line_ids)
    tagged = {word: tag for word, tag in zip(words, tags) if tag != "O"}
    assert tagged.get("Arowwai") == "B-EMPLOYER"
    assert tagged.get("Industries") == "I-EMPLOYER"
    assert tagged.get("Bachelor") == "B-DEGREE"
    assert any(tag.endswith("DATE") for tag in tags)


@requires_parser
def test_adapter_never_proposes_name_or_school() -> None:
    adapter = RulesV2Adapter()
    lines = ["EMMA SANCHEZ", "EDUCATION", "University of Business Excellence"]
    words: list[str] = []
    line_ids: list[int] = []
    for line_id, line in enumerate(lines):
        for token in line.split():
            words.append(token)
            line_ids.append(line_id)
    tags = adapter.predict_page(words, [[0, 0, 1, 1]] * len(words), line_ids)
    assert not any(tag.endswith("NAME") or tag.endswith("SCHOOL") for tag in tags)

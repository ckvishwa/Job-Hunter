"""Adapter from the production Rules v2 résumé parser to word-level BIO tags.

The real parser (``resume-rules@2``, ``services/ai/app/parse_resume.py`` in the
``universal-job-discovery`` worktree) takes plain text and returns
``ProposedFact`` records whose ``span`` is in **UTF-16 code units** into that
text - the project-wide offset convention. This module rebuilds the text from
the words ``src.parser`` extracted, keeps a word ↔ UTF-16 offset map, and
projects the parser's facts back onto words so both systems can be scored on
identical sequences by ``src.evaluate``.

Two things this adapter cannot do, and does not pretend to:

* **Taxonomy mismatch.** Rules v2 proposes ``employment`` / ``education`` /
  ``skills`` facts. It has no NAME fact and no separate school attribute, so
  ``B-NAME``/``I-NAME`` and ``B-SCHOOL``/``I-SCHOOL`` are never proposed.
  A fair comparison therefore scores it only on the entities it can emit;
  :data:`SUPPORTED_ENTITIES` records which those are.
* **Input mismatch.** Production feeds it pdfplumber (or Marker) text. Here it
  receives text rebuilt from PyMuPDF words, so line joins differ from
  production and its numbers here are not its production numbers.

CLI::

    python -m src.rules_v2_adapter --self-test
    python -m src.rules_v2_adapter --draft private-runtime/dataset-01/annotations/<doc>.json
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

LOGGER = logging.getLogger(__name__)

#: Entities the real parser can actually propose; everything else stays "O".
SUPPORTED_ENTITIES = ("EMPLOYER", "JOB_TITLE", "DATE", "DEGREE", "SKILL")
#: Entities in the project taxonomy that Rules v2 has no fact for.
UNSUPPORTED_ENTITIES = ("NAME", "SCHOOL")

#: Where the production parser lives, unless overridden.
DEFAULT_SERVICES_AI = (
    Path(__file__).resolve().parents[3]
    / ".claude"
    / "worktrees"
    / "universal-job-discovery"
    / "services"
    / "ai"
)
ENV_SERVICES_AI = "JOB_HUNTER_SERVICES_AI"


class AdapterUnavailable(RuntimeError):
    """Raised when the production parser cannot be imported."""


def utf16_length(text: str) -> int:
    """Length of ``text`` in UTF-16 code units (the project offset convention)."""
    return len(text.encode("utf-16-le")) // 2


@dataclass(frozen=True)
class WordOffset:
    """One word's position in the rebuilt text, in UTF-16 code units."""

    index: int
    start: int
    end: int


def build_text(words: Sequence[str], lines: Sequence[int] | None = None) -> tuple[str, list[WordOffset]]:
    """Rebuild document text from words, returning per-word UTF-16 offsets.

    Words on the same ``line`` id are joined with a space; a change of line id
    starts a new line. Offsets are what the parser's spans will refer to.
    """
    if lines is None:
        lines = [0] * len(words)
    if len(lines) != len(words):
        raise ValueError("words and lines must be the same length")

    pieces: list[str] = []
    offsets: list[WordOffset] = []
    cursor = 0
    previous_line: int | None = None
    for index, (word, line) in enumerate(zip(words, lines)):
        if previous_line is None:
            separator = ""
        elif line != previous_line:
            separator = "\n"
        else:
            separator = " "
        if separator:
            pieces.append(separator)
            cursor += utf16_length(separator)
        start = cursor
        pieces.append(word)
        cursor += utf16_length(word)
        offsets.append(WordOffset(index=index, start=start, end=cursor))
        previous_line = line
    return "".join(pieces), offsets


def _words_in_span(offsets: Sequence[WordOffset], start: int, end: int) -> list[int]:
    """Indices of words overlapping the UTF-16 range ``[start, end)``."""
    return [offset.index for offset in offsets if offset.start < end and start < offset.end]


def _assign(tags: list[str], indices: Sequence[int], entity: str, overwrite: bool = False) -> None:
    first = True
    for index in indices:
        if not overwrite and tags[index] != "O":
            continue
        tags[index] = f"{'B' if first else 'I'}-{entity}"
        first = False


class RulesV2Adapter:
    """``src.evaluate`` baseline backed by the real ``resume-rules@2`` parser."""

    name = "resume-rules@2"

    def __init__(self, services_ai_path: str | Path | None = None) -> None:
        path = Path(
            services_ai_path or os.environ.get(ENV_SERVICES_AI) or DEFAULT_SERVICES_AI
        ).resolve()
        if not (path / "app" / "parse_resume.py").is_file():
            raise AdapterUnavailable(
                f"resume-rules@2 not found: expected {path / 'app' / 'parse_resume.py'}. "
                f"Pass services_ai_path= or set {ENV_SERVICES_AI}."
            )
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
        try:
            self._module = importlib.import_module("app.parse_resume")
        except ImportError as exc:  # pragma: no cover - depends on that checkout
            raise AdapterUnavailable(f"could not import app.parse_resume from {path}: {exc}") from exc
        self.services_ai_path = path
        self.parse_date = getattr(self._module, "parse_date", None)

    # -- core -------------------------------------------------------------- #
    def facts_for_text(self, text: str) -> list[Any]:
        """Run the production parser and return its proposed facts."""
        return list(self._module.parse_resume(text).facts)

    def predict_page(
        self, words: Sequence[str], boxes: Sequence[Sequence[int]], lines: Sequence[int] | None = None
    ) -> list[str]:
        """Return one BIO tag per word, projected from the parser's facts.

        ``boxes`` is part of the baseline contract but unused: Rules v2 is a
        text parser and never sees geometry.
        """
        tags = ["O"] * len(words)
        if not words:
            return tags

        text, offsets = build_text(words, lines)
        for fact in self.facts_for_text(text):
            span_words = _words_in_span(offsets, fact.span.start, fact.span.end)
            if not span_words:
                continue
            kind = str(fact.kind)
            attributes = fact.attributes
            if kind == "employment":
                self._tag_value(tags, words, span_words, fact.value, "EMPLOYER")
                title = getattr(attributes, "title", None)
                if title:
                    self._tag_value(tags, words, span_words, title, "JOB_TITLE")
                self._tag_dates(tags, words, span_words)
            elif kind == "education":
                self._tag_value(tags, words, span_words, fact.value, "DEGREE")
                self._tag_dates(tags, words, span_words)
            elif kind == "skills":
                self._tag_value(tags, words, span_words, fact.value, "SKILL")
        return tags

    # -- helpers ----------------------------------------------------------- #
    def _tag_value(
        self,
        tags: list[str],
        words: Sequence[str],
        span_words: Sequence[int],
        value: str,
        entity: str,
    ) -> None:
        """Tag the run of words inside ``span_words`` that spells out ``value``."""
        target = [token for token in value.split() if token]
        if not target:
            return
        window = list(span_words)
        for position in range(len(window) - len(target) + 1):
            candidate = [words[window[position + step]] for step in range(len(target))]
            if [token.strip(",;") for token in candidate] == [
                token.strip(",;") for token in target
            ]:
                _assign(tags, window[position : position + len(target)], entity)
                return
        LOGGER.debug("value %r not located inside its own span; left untagged", value)

    def _tag_dates(self, tags: list[str], words: Sequence[str], span_words: Sequence[int]) -> None:
        """Tag date tokens inside a fact span using the parser's own date rules."""
        if self.parse_date is None:  # pragma: no cover - older parser revision
            return
        run: list[int] = []
        for index in span_words:
            token = words[index].strip(",;")
            recognised = False
            try:
                recognised = self.parse_date(token) is not None
            except Exception:  # pragma: no cover - defensive around their parser
                recognised = False
            if recognised and tags[index] == "O":
                run.append(index)
            else:
                if run:
                    _assign(tags, run, "DATE")
                    run = []
        if run:
            _assign(tags, run, "DATE")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _self_test(services_ai: str | None) -> int:
    adapter = RulesV2Adapter(services_ai)
    words = (
        "EMMA SANCHEZ|Administrative Manager|WORK EXPERIENCE|Administrative Assistant|"
        "Arowwai Industries|Oct 2023 - Present|EDUCATION|"
        "Bachelor of Business Administration|University of Business Excellence|Jan 2019 - Feb 2021"
    ).split("|")
    flat: list[str] = []
    lines: list[int] = []
    for line_id, line in enumerate(words):
        for token in line.split():
            flat.append(token)
            lines.append(line_id)

    text, offsets = build_text(flat, lines)
    assert offsets[-1].end == utf16_length(text), "offset map does not cover the text"
    tags = adapter.predict_page(flat, [[0, 0, 1, 1]] * len(flat), lines)

    print(f"parser: {adapter.name} from {adapter.services_ai_path}")
    print(f"supported entities: {', '.join(SUPPORTED_ENTITIES)}")
    print(f"never proposed:     {', '.join(UNSUPPORTED_ENTITIES)}")
    print()
    for word, tag in zip(flat, tags):
        if tag != "O":
            print(f"  {word:<18} {tag}")
    tagged = sum(1 for tag in tags if tag != "O")
    print(f"\n{tagged}/{len(flat)} words tagged")
    return 0


def _run_draft(path: str, services_ai: str | None) -> int:
    from src.annotate import load_draft

    adapter = RulesV2Adapter(services_ai)
    draft = load_draft(Path(path))
    for page in draft.pages:
        tags = adapter.predict_page(
            [word.text for word in page.words],
            [list(word.box) for word in page.words],
            [word.line for word in page.words],
        )
        counts: dict[str, int] = {}
        for tag in tags:
            if tag.startswith("B-"):
                counts[tag[2:]] = counts.get(tag[2:], 0) + 1
        print(f"{draft.doc_id} page {page.page_index}: {len(page.words)} words, spans={counts}")
    print(
        "\nThese are predictions, not labels. Scoring them needs reviewed annotations "
        "and `python -m src.evaluate --rules-adapter src.rules_v2_adapter:RulesV2Adapter`."
    )
    return 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.rules_v2_adapter",
        description="Project production Rules v2 facts onto word-level BIO tags.",
    )
    mode = cli.add_mutually_exclusive_group(required=True)
    mode.add_argument("--self-test", action="store_true", help="Run on a built-in snippet")
    mode.add_argument("--draft", help="Run over one annotation draft's words")
    cli.add_argument("--services-ai", default=None, help="Path to services/ai holding app/")
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    try:
        if args.self_test:
            return _self_test(args.services_ai)
        return _run_draft(args.draft, args.services_ai)
    except AdapterUnavailable as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

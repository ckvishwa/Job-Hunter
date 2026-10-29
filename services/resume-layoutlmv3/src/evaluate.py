"""Evaluation harness: fine-tuned LayoutLMv3 vs the Rules v2 baseline.

Runs both systems over the same held-out documents, scores them with
``seqeval`` (entity-level, strict IOB2) and prints a side-by-side table plus a
failure breakdown that separates missed, spurious, boundary and type errors -
and reports how many of them land on OCR-parsed pages, which is where
reading-order damage shows up.

The baseline is pluggable. With no ``--rules-adapter`` the built-in
:class:`StubRulesV2Baseline` runs: deterministic keyword and regex rules, good
enough to keep the comparison honest and explicitly NOT the production parser.

CLI::

    python -m src.evaluate --model-dir models/layoutlmv3-resume-pilot
    python -m src.evaluate --model-dir models/... --split test --out results.json
    python -m src.evaluate --model-dir models/... --rules-adapter app.parse_resume:RulesV2
    python -m src.evaluate --rules-only          # baseline numbers with no checkpoint
"""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Protocol, Sequence, runtime_checkable

from src.dataset import (
    DEFAULT_IMAGE_DPI,
    DEFAULT_MAX_LENGTH,
    DEFAULT_MODEL_NAME,
    DEFAULT_WINDOW_STRIDE,
    DEFAULT_WINDOW_WORDS,
    ENTITY_TYPES,
    LABELS,
    AnnotatedDocument,
    AnnotatedPage,
    build_processor,
    build_samples,
    load_annotations,
    load_splits,
    page_image_for,
    validate_splits,
)

LOGGER = logging.getLogger(__name__)

REPORTED_ENTITIES = ("EMPLOYER", "JOB_TITLE", "DATE")


# --------------------------------------------------------------------------- #
# Spans
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Span:
    """One entity occurrence, addressed by word index inside a page."""

    entity: str
    start: int
    end: int  # exclusive
    page_index: int
    text: str = ""

    def overlaps(self, other: "Span") -> bool:
        return self.page_index == other.page_index and self.start < other.end and other.start < self.end


def spans_from_tags(tags: Sequence[str], page_index: int, words: Sequence[str] = ()) -> list[Span]:
    """Decode a BIO sequence into spans. A stray ``I-X`` opens a new span."""
    spans: list[Span] = []
    entity: str | None = None
    start = 0
    for index, tag in enumerate(list(tags) + ["O"]):
        if tag.startswith("B-") or (tag.startswith("I-") and (entity is None or tag[2:] != entity)):
            if entity is not None:
                spans.append(_make_span(entity, start, index, page_index, words))
            entity, start = tag[2:], index
        elif tag == "O" or not tag.startswith("I-"):
            if entity is not None:
                spans.append(_make_span(entity, start, index, page_index, words))
            entity = None
    return spans


def _make_span(entity: str, start: int, end: int, page_index: int, words: Sequence[str]) -> Span:
    text = " ".join(words[start:end]) if words else ""
    return Span(entity=entity, start=start, end=end, page_index=page_index, text=text)


# --------------------------------------------------------------------------- #
# Baseline interface
# --------------------------------------------------------------------------- #
@runtime_checkable
class RulesBaseline(Protocol):
    """A deterministic baseline that tags words of one page.

    Implementations return exactly one BIO tag per input word, so both systems
    are scored on identical sequences. Point ``--rules-adapter`` at a
    ``module:attribute`` that is either an instance or a zero-argument callable
    producing one.
    """

    name: str

    def predict_page(
        self, words: Sequence[str], boxes: Sequence[Sequence[int]]
    ) -> list[str]: ...


DEFAULT_SKILL_GAZETTEER = {
    "python", "java", "javascript", "typescript", "sql", "selenium", "playwright",
    "cypress", "pytest", "junit", "testng", "appium", "postman", "rest", "api",
    "jenkins", "docker", "kubernetes", "terraform", "aws", "azure", "gcp", "git",
    "linux", "jira", "cucumber", "bdd", "tdd", "splunk", "wireshark", "nmap",
    "burp", "metasploit", "nessus", "siem", "soar", "powershell", "bash",
    "graphql", "kafka", "spark", "tableau", "grafana", "prometheus",
}
_TITLE_WORDS = {
    "engineer", "developer", "tester", "analyst", "sdet", "architect", "manager",
    "intern", "consultant", "administrator", "specialist", "lead", "qa", "sre",
}
_SCHOOL_WORDS = {"university", "college", "institute", "school", "academy", "polytechnic"}
_DEGREE_WORDS = {
    "b.tech", "btech", "b.s.", "bs", "bachelor", "bachelors", "m.s.", "ms",
    "master", "masters", "mba", "ph.d.", "phd", "b.e.", "m.tech",
}
_EMPLOYER_WORDS = {
    "inc", "inc.", "llc", "ltd", "ltd.", "corp", "corp.", "corporation",
    "technologies", "systems", "solutions", "labs", "software", "services",
    "consulting", "group", "limited", "pvt",
}
_MONTHS = (
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept",
    "oct", "nov", "dec",
)
_DATE_RE = re.compile(
    r"^(?:"
    r"(?:19|20)\d{2}|"                       # 1999, 2024
    r"\d{1,2}[/-]\d{4}|"                     # 06/2024
    r"present|current|now|to|–|-|—"          # range glue
    r")[.,]?$",
    re.IGNORECASE,
)


class StubRulesV2Baseline:
    """Deterministic keyword/regex baseline.

    This is a *stand-in*, not the production Rules v2 parser. It exists so the
    comparison harness runs end to end before the real parser is wired in via
    ``--rules-adapter``; its numbers must never be reported as the production
    baseline.
    """

    name = "RulesV2Stub"

    def __init__(self, skills: Iterable[str] | None = None) -> None:
        self.skills = {skill.lower() for skill in (skills or DEFAULT_SKILL_GAZETTEER)}

    # -- helpers ----------------------------------------------------------- #
    @staticmethod
    def _is_date(token: str) -> bool:
        clean = token.strip().lower().strip(".,")
        return clean[:4] in _MONTHS or clean[:3] in _MONTHS or bool(_DATE_RE.match(token.strip()))

    @staticmethod
    def _lines(boxes: Sequence[Sequence[int]]) -> list[int]:
        """Cheap line id per word: bucket the y0 coordinate."""
        return [int(box[1]) // 12 if len(box) >= 2 else 0 for box in boxes]

    def predict_page(
        self, words: Sequence[str], boxes: Sequence[Sequence[int]]
    ) -> list[str]:
        tags = ["O"] * len(words)
        if not words:
            return tags
        line_ids = self._lines(boxes)
        by_line: dict[int, list[int]] = defaultdict(list)
        for index, line_id in enumerate(line_ids):
            by_line[line_id].append(index)

        lowered = [word.lower().strip(".,:;()") for word in words]

        # NAME: capitalised tokens on the topmost line of the first page.
        if by_line:
            top_line = min(by_line)
            name_indices = [
                index
                for index in by_line[top_line]
                if words[index][:1].isupper() and words[index].isalpha()
            ]
            for position, index in enumerate(name_indices[:4]):
                tags[index] = "B-NAME" if position == 0 else "I-NAME"

        # Line-level cues: SCHOOL, DEGREE, EMPLOYER, JOB_TITLE.
        for _line_id, indices in by_line.items():
            line_tokens = [lowered[index] for index in indices]
            if any(token in _SCHOOL_WORDS for token in line_tokens):
                self._tag_run(tags, indices, "SCHOOL", respect_existing=True)
            if any(token in _DEGREE_WORDS for token in line_tokens):
                self._tag_run(tags, indices, "DEGREE", respect_existing=True)
            elif any(token in _EMPLOYER_WORDS for token in line_tokens):
                self._tag_run(tags, indices, "EMPLOYER", respect_existing=True)
            elif any(token in _TITLE_WORDS for token in line_tokens):
                self._tag_run(tags, indices, "JOB_TITLE", respect_existing=True)

        # Token-level cues: DATE then SKILL (skills never overwrite a date).
        previous_date = False
        for index, word in enumerate(words):
            if tags[index] != "O" and not tags[index].endswith("DATE"):
                previous_date = False
                continue
            if self._is_date(word):
                tags[index] = "I-DATE" if previous_date else "B-DATE"
                previous_date = True
            else:
                previous_date = False

        previous_skill = False
        for index, token in enumerate(lowered):
            if tags[index] == "O" and token in self.skills:
                tags[index] = "I-SKILL" if previous_skill else "B-SKILL"
                previous_skill = True
            else:
                previous_skill = False
        return tags

    @staticmethod
    def _tag_run(
        tags: list[str],
        indices: Sequence[int],
        entity: str,
        respect_existing: bool = True,
    ) -> None:
        first = True
        for index in indices:
            if respect_existing and tags[index] != "O":
                continue
            tags[index] = f"{'B' if first else 'I'}-{entity}"
            first = False


def load_rules_adapter(spec: str) -> RulesBaseline:
    """Load a baseline from ``module:attribute``.

    The attribute may be an instance, a class, or a factory; anything callable
    is called with no arguments. The result must expose ``predict_page``.
    """
    if ":" not in spec:
        raise ValueError(f"--rules-adapter must look like module:attribute, got {spec!r}")
    module_name, attribute = spec.split(":", 1)
    module = importlib.import_module(module_name)
    candidate = getattr(module, attribute)
    instance = candidate() if callable(candidate) and not hasattr(candidate, "predict_page") else candidate
    if not hasattr(instance, "predict_page"):
        raise TypeError(f"{spec} does not provide predict_page(words, boxes)")
    if not getattr(instance, "name", None):
        try:
            instance.name = f"{module_name}:{attribute}"
        except AttributeError:  # pragma: no cover - frozen objects
            pass
    return instance


# --------------------------------------------------------------------------- #
# Model inference
# --------------------------------------------------------------------------- #
class LayoutLMv3Predictor:
    """Run a fine-tuned checkpoint and project logits back onto words.

    Overlapping windows are merged by summing per-word logits, so a word seen
    twice is decided by both views rather than by whichever window came last.
    """

    def __init__(
        self,
        model_dir: str | Path,
        processor_dir: str | Path | None = None,
        max_length: int = DEFAULT_MAX_LENGTH,
        image_dpi: int = DEFAULT_IMAGE_DPI,
        window_words: int = DEFAULT_WINDOW_WORDS,
        window_stride: int = DEFAULT_WINDOW_STRIDE,
        device: str | None = None,
        require_images: bool = False,
    ) -> None:
        import torch
        from transformers import LayoutLMv3ForTokenClassification

        self.model_dir = str(model_dir)
        self.model = LayoutLMv3ForTokenClassification.from_pretrained(self.model_dir)
        self.model.eval()
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

        self.id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        if sorted(self.id2label.values()) != sorted(LABELS):
            LOGGER.warning(
                "Checkpoint labels differ from src.dataset.LABELS; using the checkpoint's mapping."
            )

        self.processor = build_processor(str(processor_dir or model_dir))
        self.max_length = max_length
        self.image_dpi = image_dpi
        self.window_words = window_words
        self.window_stride = window_stride
        self.allow_missing_images = not require_images

    def predict_document(self, document: AnnotatedDocument) -> dict[int, list[str]]:
        """Return predicted BIO tags per page, aligned 1:1 with annotated words."""
        import numpy as np
        import torch

        page_words = {page.page_index: len(page.words) for page in document.pages}
        accumulated = {
            index: np.zeros((count, len(self.id2label)), dtype=np.float64)
            for index, count in page_words.items()
        }
        seen = {index: np.zeros(count, dtype=np.int32) for index, count in page_words.items()}

        for sample in build_samples([document], self.window_words, self.window_stride):
            image = page_image_for(
                sample, dpi=self.image_dpi, allow_missing=self.allow_missing_images
            )
            encoding = self.processor(
                images=image,
                text=sample.words,
                boxes=sample.boxes,
                truncation=True,
                max_length=self.max_length,
                padding=False,
                return_tensors="pt",
            )
            batch = {key: value.to(self.device) for key, value in encoding.items()}

            with torch.no_grad():
                logits = self.model(**batch).logits[0].detach().cpu().numpy()

            word_ids = encoding.word_ids(0)
            previous = None
            for position, word_id in enumerate(word_ids):
                if word_id is None or word_id == previous:
                    previous = word_id
                    continue
                previous = word_id
                global_index = sample.word_offset + word_id
                if global_index < page_words[sample.page_index]:
                    accumulated[sample.page_index][global_index] += logits[position]
                    seen[sample.page_index][global_index] += 1

        predictions: dict[int, list[str]] = {}
        for page_index, matrix in accumulated.items():
            tags: list[str] = []
            for word_index in range(page_words[page_index]):
                if seen[page_index][word_index] == 0:
                    tags.append("O")  # never reached the model (truncated window)
                else:
                    tags.append(self.id2label[int(matrix[word_index].argmax())])
            predictions[page_index] = tags
        return predictions

# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
@dataclass
class SystemResult:
    """Scores and failures for one system over one split."""

    name: str
    overall: dict[str, float] = field(default_factory=dict)
    per_entity: dict[str, dict[str, float]] = field(default_factory=dict)
    failures: list[dict[str, Any]] = field(default_factory=list)
    failure_counts: Counter[str] = field(default_factory=Counter)
    ocr_failures: Counter[str] = field(default_factory=Counter)


def score_sequences(
    references: Sequence[Sequence[str]],
    predictions: Sequence[Sequence[str]],
) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    """Strict entity-level overall and per-entity scores."""
    from seqeval.metrics import classification_report, f1_score, precision_score, recall_score
    from seqeval.scheme import IOB2

    strict: dict[str, Any] = {"mode": "strict", "scheme": IOB2, "zero_division": 0}
    overall = {
        "precision": float(precision_score(references, predictions, **strict)),
        "recall": float(recall_score(references, predictions, **strict)),
        "f1": float(f1_score(references, predictions, **strict)),
    }
    report = classification_report(references, predictions, output_dict=True, **strict)
    per_entity: dict[str, dict[str, float]] = {}
    for entity, scores in report.items():
        if isinstance(scores, dict) and not entity.endswith("avg"):
            per_entity[entity] = {
                "precision": float(scores.get("precision", 0.0)),
                "recall": float(scores.get("recall", 0.0)),
                "f1": float(scores.get("f1-score", 0.0)),
                "support": float(scores.get("support", 0.0)),
            }
    return overall, per_entity


def classify_failures(
    gold: Sequence[Span],
    predicted: Sequence[Span],
    doc_id: str,
    source: str,
) -> list[dict[str, Any]]:
    """Bucket span errors as missed, spurious, boundary or type confusion."""
    failures: list[dict[str, Any]] = []
    matched_predictions: set[Span] = set()

    for gold_span in gold:
        exact = [p for p in predicted if p == gold_span]
        if exact:
            matched_predictions.update(exact)
            continue
        overlapping = [p for p in predicted if p.overlaps(gold_span)]
        if not overlapping:
            failures.append(_failure("missed", doc_id, source, gold_span, None))
            continue
        matched_predictions.update(overlapping)
        same_type = [p for p in overlapping if p.entity == gold_span.entity]
        if same_type:
            failures.append(_failure("boundary", doc_id, source, gold_span, same_type[0]))
        else:
            failures.append(_failure("type", doc_id, source, gold_span, overlapping[0]))

    for predicted_span in predicted:
        if predicted_span in matched_predictions:
            continue
        if not any(predicted_span.overlaps(g) for g in gold):
            failures.append(_failure("spurious", doc_id, source, None, predicted_span))
    return failures


def _failure(
    kind: str,
    doc_id: str,
    source: str,
    gold: Span | None,
    predicted: Span | None,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "doc_id": doc_id,
        "page_source": source,
        "entity": (gold or predicted).entity if (gold or predicted) else None,
        "gold": None if gold is None else {"entity": gold.entity, "span": [gold.start, gold.end], "text": gold.text},
        "predicted": None
        if predicted is None
        else {"entity": predicted.entity, "span": [predicted.start, predicted.end], "text": predicted.text},
    }


def evaluate_system(
    name: str,
    documents: Sequence[AnnotatedDocument],
    predict_page: Any,
) -> SystemResult:
    """Score one system. ``predict_page(document, page) -> list[str]``."""
    result = SystemResult(name=name)
    references: list[list[str]] = []
    predictions: list[list[str]] = []

    for document in documents:
        for page in document.pages:
            gold_tags = [word.tag for word in page.words]
            predicted_tags = list(predict_page(document, page))
            if len(predicted_tags) != len(gold_tags):
                raise ValueError(
                    f"{name} returned {len(predicted_tags)} tags for "
                    f"{document.doc_id} page {page.page_index} "
                    f"({len(gold_tags)} words expected)"
                )
            references.append(gold_tags)
            predictions.append(predicted_tags)

            words = [word.text for word in page.words]
            source = page.source or document.source
            failures = classify_failures(
                spans_from_tags(gold_tags, page.page_index, words),
                spans_from_tags(predicted_tags, page.page_index, words),
                document.doc_id,
                source,
            )
            result.failures.extend(failures)
            for failure in failures:
                result.failure_counts[failure["kind"]] += 1
                if source == "ocr":
                    result.ocr_failures[failure["kind"]] += 1

    result.overall, result.per_entity = score_sequences(references, predictions)
    return result


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #
def _percent(value: float) -> str:
    return f"{value * 100:5.1f}%"


def print_comparison(results: Sequence[SystemResult], documents: Sequence[AnnotatedDocument]) -> None:
    gold_entities = Counter(
        span.entity
        for document in documents
        for page in document.pages
        for span in spans_from_tags([word.tag for word in page.words], page.page_index)
    )
    width = max(len(result.name) for result in results) + 2

    print("\n== Entity-level strict scores (held-out) ==")
    header = f"{'system':<{width}}{'P':>8}{'R':>8}{'F1':>8}"
    print(header)
    print("-" * len(header))
    for result in results:
        print(
            f"{result.name:<{width}}"
            f"{_percent(result.overall['precision']):>8}"
            f"{_percent(result.overall['recall']):>8}"
            f"{_percent(result.overall['f1']):>8}"
        )

    reported = [e for e in REPORTED_ENTITIES] + [
        e for e in ENTITY_TYPES if e not in REPORTED_ENTITIES
    ]
    print("\n== Per-entity F1 ==")
    header = f"{'entity':<12}{'gold':>6}" + "".join(f"{result.name:>14}" for result in results)
    print(header)
    print("-" * len(header))
    for entity in reported:
        row = f"{entity:<12}{gold_entities.get(entity, 0):>6}"
        for result in results:
            scores = result.per_entity.get(entity)
            row += f"{(_percent(scores['f1']) if scores else '      -'):>14}"
        print(row)

    print("\n== Failure breakdown (span level) ==")
    kinds = ("missed", "spurious", "boundary", "type")
    header = f"{'system':<{width}}" + "".join(f"{kind:>10}" for kind in kinds) + f"{'on OCR':>9}"
    print(header)
    print("-" * len(header))
    for result in results:
        row = f"{result.name:<{width}}"
        row += "".join(f"{result.failure_counts.get(kind, 0):>10}" for kind in kinds)
        row += f"{sum(result.ocr_failures.values()):>9}"
        print(row)
    if any(result.ocr_failures for result in results):
        print(
            "OCR pages carry line-level boxes split into words by character offset, "
            "so boundary errors there may be a reading-order artefact rather than a model error."
        )


# --------------------------------------------------------------------------- #
# Entrypoint
# --------------------------------------------------------------------------- #
def run(args: argparse.Namespace) -> int:
    documents_by_id = load_annotations(args.annotations_dir)
    if args.splits and Path(args.splits).is_file():
        splits = load_splits(args.splits)
        validate_splits(splits, documents_by_id)
        doc_ids = list(splits.get(args.split, []))
        if not doc_ids:
            print(f"ERROR: split {args.split!r} is empty in {args.splits}", file=sys.stderr)
            return 1
    else:
        LOGGER.warning("No splits file at %s; evaluating every annotation", args.splits)
        doc_ids = sorted(documents_by_id)
    documents = [documents_by_id[doc_id] for doc_id in doc_ids]
    print(
        f"split={args.split} documents={len(documents)} "
        f"pages={sum(len(d.pages) for d in documents)} "
        f"words={sum(d.word_count for d in documents)}"
    )

    results: list[SystemResult] = []

    if not args.rules_only:
        if not args.model_dir:
            print("ERROR: --model-dir is required unless --rules-only is set", file=sys.stderr)
            return 1
        predictor = LayoutLMv3Predictor(
            args.model_dir,
            max_length=args.max_length,
            image_dpi=args.image_dpi,
            window_words=args.window_words,
            window_stride=args.window_stride,
            require_images=args.require_images,
        )
        cache: dict[str, dict[int, list[str]]] = {}

        def model_predict(document: AnnotatedDocument, page: AnnotatedPage) -> list[str]:
            if document.doc_id not in cache:
                cache[document.doc_id] = predictor.predict_document(document)
            return cache[document.doc_id][page.page_index]

        results.append(evaluate_system(args.model_label, documents, model_predict))

    baseline: RulesBaseline = (
        load_rules_adapter(args.rules_adapter) if args.rules_adapter else StubRulesV2Baseline()
    )
    LOGGER.info("baseline: %s", getattr(baseline, "name", baseline))

    def rules_predict(document: AnnotatedDocument, page: AnnotatedPage) -> list[str]:
        return baseline.predict_page(
            [word.text for word in page.words], [list(word.box) for word in page.words]
        )

    results.append(evaluate_system(getattr(baseline, "name", "rules"), documents, rules_predict))

    print_comparison(results, documents)
    if args.rules_adapter is None and not args.rules_only:
        print(
            "\nNOTE: the baseline column is StubRulesV2Baseline, not production Rules v2. "
            "Point --rules-adapter at the real parser before treating this as a decision."
        )

    if args.out:
        payload = {
            "split": args.split,
            "doc_ids": doc_ids,
            "model_dir": args.model_dir,
            "baseline": getattr(baseline, "name", "rules"),
            "systems": [
                {
                    "name": result.name,
                    "overall": result.overall,
                    "per_entity": result.per_entity,
                    "failure_counts": dict(result.failure_counts),
                    "ocr_failure_counts": dict(result.ocr_failures),
                }
                for result in results
            ],
        }
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nwrote {args.out}")

    if args.failures_out:
        Path(args.failures_out).parent.mkdir(parents=True, exist_ok=True)
        with Path(args.failures_out).open("w", encoding="utf-8") as handle:
            for result in results:
                for failure in result.failures:
                    handle.write(json.dumps({"system": result.name, **failure}) + "\n")
        print(f"wrote {args.failures_out}")
    return 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.evaluate",
        description="Compare a fine-tuned LayoutLMv3 checkpoint with the Rules v2 baseline.",
    )
    cli.add_argument("--model-dir", default=None, help="Fine-tuned checkpoint directory")
    cli.add_argument("--model-label", default="LayoutLMv3", help="Column name for the model")
    cli.add_argument("--annotations-dir", default="data/annotations")
    cli.add_argument("--splits", default="data/splits.json")
    cli.add_argument("--split", default="test", choices=("train", "val", "test"))
    cli.add_argument("--rules-adapter", default=None, help="module:attribute of the real parser")
    cli.add_argument("--rules-only", action="store_true", help="Skip the model entirely")
    cli.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    cli.add_argument("--window-words", type=int, default=DEFAULT_WINDOW_WORDS)
    cli.add_argument("--window-stride", type=int, default=DEFAULT_WINDOW_STRIDE)
    cli.add_argument("--image-dpi", type=int, default=DEFAULT_IMAGE_DPI)
    cli.add_argument("--require-images", action="store_true")
    cli.add_argument("--out", default=None, help="Write the comparison JSON here")
    cli.add_argument("--failures-out", default=None, help="Write failures as JSONL here")
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

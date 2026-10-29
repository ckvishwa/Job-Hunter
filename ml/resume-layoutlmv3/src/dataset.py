"""Annotation schema, BIO taxonomy and the LayoutLMv3 PyTorch dataset.

Annotation files live in ``data/annotations/<doc_id>.json`` and are validated by
:class:`AnnotatedDocument`. ``src.parser`` can emit an all-``O`` stub of exactly
that shape to label against.

Label alignment is done explicitly (not via the tokenizer's ``word_labels``
shortcut) so the policy is visible: every special token, pad token and
non-initial subword piece gets ``-100``, which ``CrossEntropyLoss`` ignores.

CLI::

    python -m src.dataset --self-test
    python -m src.dataset --inspect data/annotations/example.json
    python -m src.dataset --build-splits --annotations-dir data/annotations \\
        --out data/splits.json
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Sequence

from PIL import Image
from pydantic import BaseModel, Field, field_validator, model_validator

LOGGER = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Taxonomy
# --------------------------------------------------------------------------- #
ENTITY_TYPES: tuple[str, ...] = (
    "NAME",
    "EMPLOYER",
    "JOB_TITLE",
    "DATE",
    "SKILL",
    "DEGREE",
    "SCHOOL",
)

#: Fixed label order. The index of a label IS its class id; never reorder this
#: list without retraining, because checkpoints store the mapping by position.
LABELS: tuple[str, ...] = ("O",) + tuple(
    f"{prefix}-{entity}" for entity in ENTITY_TYPES for prefix in ("B", "I")
)

LABEL2ID: dict[str, int] = {label: idx for idx, label in enumerate(LABELS)}
ID2LABEL: dict[int, str] = {idx: label for label, idx in LABEL2ID.items()}

#: Loss-ignored positions (special tokens, padding, continuation subwords).
IGNORE_INDEX = -100

DEFAULT_MODEL_NAME = "microsoft/layoutlmv3-base"
DEFAULT_MAX_LENGTH = 512
#: Words per training window. ~350 words stays under 512 subwords for typical
#: resume text while leaving room for the CLS/SEP and image tokens.
DEFAULT_WINDOW_WORDS = 350
DEFAULT_WINDOW_STRIDE = 64
DEFAULT_IMAGE_DPI = 150
BLANK_PAGE_SIZE = (1000, 1294)  # ~US Letter aspect, used when a PDF is missing


# --------------------------------------------------------------------------- #
# Annotation schema
# --------------------------------------------------------------------------- #
class AnnotatedWord(BaseModel):
    """One labelled word: text, normalised ``0-1000`` box and a BIO tag."""

    text: str
    box: tuple[int, int, int, int]
    tag: str = "O"

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("word text must not be blank")
        return value

    @field_validator("tag")
    @classmethod
    def _known_tag(cls, value: str) -> str:
        if value not in LABEL2ID:
            raise ValueError(f"unknown tag {value!r}; expected one of {sorted(LABEL2ID)}")
        return value

    @field_validator("box")
    @classmethod
    def _box_in_grid(cls, value: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
        x0, y0, x1, y1 = value
        if not all(0 <= coordinate <= 1000 for coordinate in value):
            raise ValueError(f"box {value} outside the 0-1000 grid")
        if x1 < x0 or y1 < y0:
            raise ValueError(f"box {value} is inverted")
        return value


class AnnotatedPage(BaseModel):
    """One labelled page."""

    page_index: int = Field(ge=0)
    words: list[AnnotatedWord] = Field(default_factory=list)
    width: float | None = None
    height: float | None = None
    source: str = "native"


class AnnotatedDocument(BaseModel):
    """One labelled resume.

    ``template_family`` groups visually identical layouts (the same CV
    generator, employer portal export or sidebar theme). Splits are assigned by
    family, never by document, so no family straddles train and test.
    """

    doc_id: str
    pdf_path: str | None = None
    template_family: str = "unknown"
    source: str = "native"
    pages: list[AnnotatedPage] = Field(min_length=1)

    @model_validator(mode="after")
    def _pages_unique(self) -> "AnnotatedDocument":
        indices = [page.page_index for page in self.pages]
        if len(set(indices)) != len(indices):
            raise ValueError(f"{self.doc_id}: duplicate page_index values {indices}")
        self.pages.sort(key=lambda page: page.page_index)
        return self

    @property
    def word_count(self) -> int:
        return sum(len(page.words) for page in self.pages)

    def tag_counts(self) -> Counter[str]:
        return Counter(word.tag for page in self.pages for word in page.words)


def verify_bio(tags: Sequence[str]) -> list[str]:
    """Return human-readable BIO violations (``I-X`` not continuing an ``X`` span)."""
    issues: list[str] = []
    previous = "O"
    for index, tag in enumerate(tags):
        if tag.startswith("I-"):
            entity = tag[2:]
            if previous not in (f"B-{entity}", f"I-{entity}"):
                issues.append(f"position {index}: {tag} follows {previous}")
        previous = tag
    return issues


def load_annotation(path: str | Path) -> AnnotatedDocument:
    """Load and validate one annotation file."""
    file_path = Path(path)
    payload = json.loads(file_path.read_text(encoding="utf-8"))
    payload.setdefault("doc_id", file_path.stem)
    document = AnnotatedDocument.model_validate(payload)
    for page in document.pages:
        for issue in verify_bio([word.tag for word in page.words]):
            LOGGER.warning("%s page %d: %s", document.doc_id, page.page_index, issue)
    return document


def load_annotations(annotations_dir: str | Path) -> dict[str, AnnotatedDocument]:
    """Load every ``*.json`` in a directory, keyed by ``doc_id``."""
    directory = Path(annotations_dir)
    if not directory.is_dir():
        raise FileNotFoundError(f"annotations directory not found: {directory}")

    documents: dict[str, AnnotatedDocument] = {}
    for path in sorted(directory.glob("*.json")):
        if path.name in RESERVED_JSON_NAMES:
            continue
        # Harness outputs sometimes land next to annotations; a file with no
        # "pages" key is not an annotation, so skip it loudly rather than
        # failing the whole load.
        try:
            head = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path} is not valid JSON: {exc}") from exc
        if not isinstance(head, dict) or "pages" not in head:
            LOGGER.warning("Skipping %s: no 'pages' key, so not an annotation file", path.name)
            continue
        document = load_annotation(path)
        if document.doc_id in documents:
            raise ValueError(f"duplicate doc_id {document.doc_id!r} ({path})")
        documents[document.doc_id] = document
    if not documents:
        raise FileNotFoundError(f"no annotation files in {directory}")
    LOGGER.info("Loaded %d annotated documents from %s", len(documents), directory)
    return documents


# --------------------------------------------------------------------------- #
# Splits
# --------------------------------------------------------------------------- #
SPLIT_NAMES = ("train", "val", "test")
DEFAULT_RATIOS = (0.70, 0.15, 0.15)
#: Harness output filenames that may share the annotations directory.
RESERVED_JSON_NAMES = frozenset({"splits.json", "results.json", "metrics.json", "run_config.json"})


def build_splits(
    documents: dict[str, AnnotatedDocument],
    ratios: Sequence[float] = DEFAULT_RATIOS,
    seed: int = 13,
) -> dict[str, Any]:
    """Assign whole template families to train/val/test (70/15/15 by default).

    Families are placed largest-first into whichever split is furthest below
    its document quota, so a family never appears in two splits. With very few
    families the realised ratios drift from the targets - the returned payload
    records the achieved counts so that is visible rather than assumed.
    """
    if len(ratios) != 3 or abs(sum(ratios) - 1.0) > 1e-6:
        raise ValueError(f"ratios must be three values summing to 1.0, got {ratios}")

    families: dict[str, list[str]] = defaultdict(list)
    for doc_id, document in documents.items():
        families[document.template_family].append(doc_id)

    rng = random.Random(seed)
    ordered = sorted(families.items(), key=lambda item: (-len(item[1]), item[0]))
    for _, doc_ids in ordered:
        doc_ids.sort()
        rng.shuffle(doc_ids)

    total = len(documents)
    quotas = {name: ratio * total for name, ratio in zip(SPLIT_NAMES, ratios)}
    assigned: dict[str, list[str]] = {name: [] for name in SPLIT_NAMES}
    family_map: dict[str, str] = {}

    for family, doc_ids in ordered:
        target = max(
            SPLIT_NAMES,
            key=lambda name: (quotas[name] - len(assigned[name]), name == "train"),
        )
        assigned[target].extend(doc_ids)
        family_map[family] = target

    if len(families) < 3:
        LOGGER.warning(
            "Only %d template families: a family-grouped 70/15/15 split is not "
            "achievable, and held-out numbers will not be template-independent.",
            len(families),
        )

    payload: dict[str, Any] = {
        "seed": seed,
        "ratios": {name: ratio for name, ratio in zip(SPLIT_NAMES, ratios)},
        "grouping": "template_family",
        "family_assignment": family_map,
        "counts": {name: len(ids) for name, ids in assigned.items()},
        **{name: sorted(ids) for name, ids in assigned.items()},
    }
    validate_splits(payload, documents)
    return payload


def validate_splits(
    splits: dict[str, Any],
    documents: dict[str, AnnotatedDocument] | None = None,
) -> None:
    """Fail loudly on unknown ids, overlap between splits, or family leakage."""
    buckets = {name: list(splits.get(name, [])) for name in SPLIT_NAMES}
    seen: dict[str, str] = {}
    for name, doc_ids in buckets.items():
        for doc_id in doc_ids:
            if doc_id in seen:
                raise ValueError(f"{doc_id!r} appears in both {seen[doc_id]!r} and {name!r}")
            seen[doc_id] = name

    if documents is None:
        return

    missing = sorted(set(seen) - set(documents))
    if missing:
        raise ValueError(f"splits reference unknown doc_ids: {missing}")

    family_splits: dict[str, set[str]] = defaultdict(set)
    for doc_id, name in seen.items():
        family_splits[documents[doc_id].template_family].add(name)
    leaked = {family: sorted(names) for family, names in family_splits.items() if len(names) > 1}
    if leaked:
        raise ValueError(f"template families span multiple splits (data leakage): {leaked}")


def load_splits(path: str | Path) -> dict[str, Any]:
    """Read ``splits.json``."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_splits(payload)
    return payload


# --------------------------------------------------------------------------- #
# Windowing
# --------------------------------------------------------------------------- #
@dataclass
class Sample:
    """One model input: a window of words from one page of one document."""

    doc_id: str
    page_index: int
    window_index: int
    word_offset: int
    words: list[str]
    boxes: list[list[int]]
    tags: list[str]
    template_family: str = "unknown"
    source: str = "native"
    pdf_path: str | None = None

    def __len__(self) -> int:
        return len(self.words)


def _window_bounds(count: int, window: int, stride: int) -> list[tuple[int, int]]:
    """Window start/end pairs covering ``count`` items with overlap ``stride``."""
    if count <= window:
        return [(0, count)]
    step = max(window - stride, 1)
    bounds: list[tuple[int, int]] = []
    start = 0
    while start < count:
        end = min(start + window, count)
        bounds.append((start, end))
        if end == count:
            break
        start += step
    return bounds


def build_samples(
    documents: Iterable[AnnotatedDocument],
    window_words: int = DEFAULT_WINDOW_WORDS,
    window_stride: int = DEFAULT_WINDOW_STRIDE,
) -> list[Sample]:
    """Flatten documents into page-level windows, keeping provenance on each."""
    samples: list[Sample] = []
    for document in documents:
        for page in document.pages:
            if not page.words:
                LOGGER.debug("%s page %d has no words; skipped", document.doc_id, page.page_index)
                continue
            for window_index, (start, end) in enumerate(
                _window_bounds(len(page.words), window_words, window_stride)
            ):
                chunk = page.words[start:end]
                samples.append(
                    Sample(
                        doc_id=document.doc_id,
                        page_index=page.page_index,
                        window_index=window_index,
                        word_offset=start,
                        words=[word.text for word in chunk],
                        boxes=[list(word.box) for word in chunk],
                        tags=[word.tag for word in chunk],
                        template_family=document.template_family,
                        source=page.source or document.source,
                        pdf_path=document.pdf_path,
                    )
                )
    return samples


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
def blank_page_image(size: tuple[int, int] = BLANK_PAGE_SIZE) -> Image.Image:
    """A white page, used when the source PDF is unavailable."""
    return Image.new("RGB", size, color="white")


@lru_cache(maxsize=32)
def _cached_page_image(pdf_path: str, page_index: int, dpi: int) -> Image.Image:
    from src.parser import render_pdf_page_image  # local import keeps fitz optional

    return render_pdf_page_image(pdf_path, page_index, dpi=dpi)


def page_image_for(
    sample: Sample,
    dpi: int = DEFAULT_IMAGE_DPI,
    allow_missing: bool = True,
) -> Image.Image:
    """Render the page a sample came from, or a blank page when allowed."""
    if sample.pdf_path and Path(sample.pdf_path).is_file():
        try:
            return _cached_page_image(sample.pdf_path, sample.page_index, dpi)
        except Exception as exc:  # pragma: no cover - depends on the PDF
            if not allow_missing:
                raise
            LOGGER.warning("Falling back to a blank page for %s: %s", sample.doc_id, exc)
    elif not allow_missing:
        raise FileNotFoundError(
            f"{sample.doc_id}: pdf_path {sample.pdf_path!r} is missing and "
            "allow_missing_images is False"
        )
    else:
        LOGGER.debug("%s: no readable pdf_path; using a blank page image", sample.doc_id)
    return blank_page_image()


# --------------------------------------------------------------------------- #
# Processor + alignment
# --------------------------------------------------------------------------- #
def build_processor(model_name: str = DEFAULT_MODEL_NAME) -> Any:
    """Load :class:`LayoutLMv3Processor` with the built-in OCR disabled.

    ``apply_ocr=False`` matters: words and boxes come from ``src.parser``, and
    letting the processor run Tesseract would silently replace them.
    """
    from transformers import LayoutLMv3Processor

    return LayoutLMv3Processor.from_pretrained(model_name, apply_ocr=False)


def align_labels(
    word_ids: Sequence[int | None],
    tags: Sequence[str],
    label_all_subwords: bool = False,
) -> list[int]:
    """Project word-level BIO tags onto subword tokens.

    * special tokens and padding (``word_id is None``) -> ``IGNORE_INDEX``
    * first subword of a word -> that word's class id
    * later subwords -> ``IGNORE_INDEX`` by default. With
      ``label_all_subwords=True`` they inherit the word's tag instead, with a
      ``B-`` prefix demoted to ``I-`` so the span stays well-formed.
    """
    labels: list[int] = []
    previous_word_id: int | None = None
    for word_id in word_ids:
        if word_id is None:
            labels.append(IGNORE_INDEX)
        elif word_id != previous_word_id:
            labels.append(LABEL2ID[tags[word_id]])
        elif label_all_subwords:
            tag = tags[word_id]
            labels.append(LABEL2ID["I-" + tag[2:]] if tag.startswith("B-") else LABEL2ID[tag])
        else:
            labels.append(IGNORE_INDEX)
        previous_word_id = word_id
    return labels


# --------------------------------------------------------------------------- #
# Dataset
# --------------------------------------------------------------------------- #
class ResumeLayoutDataset:
    """``torch.utils.data.Dataset`` over labelled resume page windows.

    Each item is a dict of ``input_ids``, ``attention_mask``, ``bbox``,
    ``pixel_values`` and ``labels``, ready for
    ``LayoutLMv3ForTokenClassification``. Pass :func:`collate_fn` to the
    ``DataLoader``/``Trainer`` so a batch pads to its own longest sequence.
    """

    def __init__(
        self,
        samples: Sequence[Sample],
        processor: Any,
        max_length: int = DEFAULT_MAX_LENGTH,
        image_dpi: int = DEFAULT_IMAGE_DPI,
        label_all_subwords: bool = False,
        allow_missing_images: bool = True,
    ) -> None:
        if not samples:
            raise ValueError("ResumeLayoutDataset got zero samples")
        self.samples = list(samples)
        self.processor = processor
        self.max_length = max_length
        self.image_dpi = image_dpi
        self.label_all_subwords = label_all_subwords
        self.allow_missing_images = allow_missing_images
        self._truncation_warned = False

    def __len__(self) -> int:
        return len(self.samples)

    def encode(self, sample: Sample) -> dict[str, Any]:
        """Encode one sample into tensors (public so ``evaluate.py`` can reuse it)."""
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
        word_ids = encoding.word_ids(0)
        covered = {word_id for word_id in word_ids if word_id is not None}
        if len(covered) < len(sample.words) and not self._truncation_warned:
            self._truncation_warned = True
            LOGGER.warning(
                "%s page %d window %d: %d of %d words did not fit in %d tokens; "
                "lower --window-words to keep full coverage.",
                sample.doc_id,
                sample.page_index,
                sample.window_index,
                len(sample.words) - len(covered),
                len(sample.words),
                self.max_length,
            )

        item = {key: value.squeeze(0) for key, value in encoding.items()}
        import torch

        item["labels"] = torch.tensor(
            align_labels(word_ids, sample.tags, self.label_all_subwords),
            dtype=torch.long,
        )
        return item

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.encode(self.samples[index])

    # -- construction helpers ---------------------------------------------- #
    @classmethod
    def from_documents(
        cls,
        documents: Iterable[AnnotatedDocument],
        processor: Any,
        window_words: int = DEFAULT_WINDOW_WORDS,
        window_stride: int = DEFAULT_WINDOW_STRIDE,
        **kwargs: Any,
    ) -> "ResumeLayoutDataset":
        return cls(build_samples(documents, window_words, window_stride), processor, **kwargs)

    @classmethod
    def from_split(
        cls,
        annotations_dir: str | Path,
        splits_path: str | Path,
        split: str,
        processor: Any,
        window_words: int = DEFAULT_WINDOW_WORDS,
        window_stride: int = DEFAULT_WINDOW_STRIDE,
        **kwargs: Any,
    ) -> "ResumeLayoutDataset":
        """Build the dataset for one named split, enforcing the split contract."""
        documents = load_annotations(annotations_dir)
        splits = load_splits(splits_path)
        validate_splits(splits, documents)
        doc_ids = list(splits.get(split, []))
        if not doc_ids:
            raise ValueError(f"split {split!r} is empty in {splits_path}")
        selected = [documents[doc_id] for doc_id in doc_ids]
        LOGGER.info("split %s: %d documents", split, len(selected))
        return cls.from_documents(
            selected, processor, window_words=window_words, window_stride=window_stride, **kwargs
        )


def collate_fn(batch: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Pad a batch to its longest sequence; ``labels`` pad with ``IGNORE_INDEX``."""
    import torch

    pad_values = {"input_ids": 1, "attention_mask": 0, "labels": IGNORE_INDEX}
    longest = max(int(item["input_ids"].shape[0]) for item in batch)
    out: dict[str, Any] = {}

    for key in batch[0]:
        values = [item[key] for item in batch]
        if key == "pixel_values":
            out[key] = torch.stack(values)
            continue
        if key == "bbox":
            padded = []
            for value in values:
                gap = longest - value.shape[0]
                if gap:
                    filler = torch.zeros((gap, value.shape[1]), dtype=value.dtype)
                    value = torch.cat([value, filler], dim=0)
                padded.append(value)
            out[key] = torch.stack(padded)
            continue
        fill = pad_values.get(key, 0)
        padded = []
        for value in values:
            gap = longest - value.shape[0]
            if gap:
                filler = torch.full((gap,), fill, dtype=value.dtype)
                value = torch.cat([value, filler], dim=0)
            padded.append(value)
        out[key] = torch.stack(padded)
    return out


# --------------------------------------------------------------------------- #
# Self-test fixture
# --------------------------------------------------------------------------- #
def synthetic_document(doc_id: str = "synthetic-01") -> AnnotatedDocument:
    """A tiny hand-built document so the pipeline can be smoke-tested offline."""
    rows = [
        ("Ada", "B-NAME"),
        ("Lovelace", "I-NAME"),
        ("QA", "B-JOB_TITLE"),
        ("Engineer", "I-JOB_TITLE"),
        ("Northwind", "B-EMPLOYER"),
        ("Jan", "B-DATE"),
        ("2024", "I-DATE"),
        ("Playwright", "B-SKILL"),
        ("M.S.", "B-DEGREE"),
        ("Cybersecurity", "I-DEGREE"),
        ("University", "B-SCHOOL"),
        ("of", "I-SCHOOL"),
        ("New", "I-SCHOOL"),
        ("Haven", "I-SCHOOL"),
        ("responsibilities", "O"),
    ]
    words = [
        AnnotatedWord(
            text=text,
            box=(50, 40 + index * 30, 50 + 12 * len(text), 68 + index * 30),
            tag=tag,
        )
        for index, (text, tag) in enumerate(rows)
    ]
    return AnnotatedDocument(
        doc_id=doc_id,
        template_family="synthetic",
        pages=[AnnotatedPage(page_index=0, width=612, height=792, words=words)],
    )


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _cmd_inspect(path: str) -> int:
    document = load_annotation(path)
    print(f"{document.doc_id}: family={document.template_family} pages={len(document.pages)} "
          f"words={document.word_count}")
    for tag, count in sorted(document.tag_counts().items()):
        print(f"  {tag:<12} {count}")
    issues = [
        f"page {page.page_index}: {issue}"
        for page in document.pages
        for issue in verify_bio([word.tag for word in page.words])
    ]
    if issues:
        print("BIO issues:")
        for issue in issues:
            print(f"  {issue}")
        return 1
    print("BIO sequence OK")
    return 0


def _cmd_build_splits(annotations_dir: str, out: str, seed: int, ratios: Sequence[float]) -> int:
    documents = load_annotations(annotations_dir)
    payload = build_splits(documents, ratios=ratios, seed=seed)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {out}")
    for name in SPLIT_NAMES:
        families = sorted(
            {documents[doc_id].template_family for doc_id in payload[name]}
        )
        print(f"  {name:<5} {len(payload[name]):>3} docs  families={families}")
    return 0


def _cmd_self_test(model_name: str, annotations_dir: str | None) -> int:
    if annotations_dir:
        documents = list(load_annotations(annotations_dir).values())
    else:
        documents = [synthetic_document()]
        print("using the synthetic fixture (pass --annotations-dir for real files)")

    samples = build_samples(documents)
    print(f"documents={len(documents)} samples={len(samples)}")
    print(f"labels={len(LABELS)} -> {', '.join(LABELS)}")

    try:
        processor = build_processor(model_name)
    except Exception as exc:
        print(f"processor unavailable ({exc}); alignment check skipped", file=sys.stderr)
        return 1

    dataset = ResumeLayoutDataset(samples, processor)
    item = dataset[0]
    print("first item:")
    for key, value in item.items():
        print(f"  {key:<15} {tuple(value.shape)} {value.dtype}")

    batch = collate_fn([dataset[index] for index in range(min(2, len(dataset)))])
    print("collated batch:")
    for key, value in batch.items():
        print(f"  {key:<15} {tuple(value.shape)}")

    tokens = processor.tokenizer.convert_ids_to_tokens(item["input_ids"].tolist())
    print("alignment (first 20 tokens):")
    for token, label_id in list(zip(tokens, item["labels"].tolist()))[:20]:
        name = "IGNORED" if label_id == IGNORE_INDEX else ID2LABEL[label_id]
        print(f"  {_printable(token):<18} {name}")
    return 0


def _printable(token: str) -> str:
    """Make a BPE token safe for a legacy code page console (cp1252 on Windows)."""
    cleaned = token.replace("Ġ", "_").replace("Ċ", "\\n")
    return cleaned.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(
        sys.stdout.encoding or "utf-8", errors="replace"
    )


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.dataset",
        description="Annotation schema, splits and the LayoutLMv3 dataset.",
    )
    cli.add_argument("--inspect", help="Validate one annotation file and show tag counts")
    cli.add_argument("--build-splits", action="store_true", help="Write data/splits.json")
    cli.add_argument("--self-test", action="store_true", help="Smoke-test encoding + alignment")
    cli.add_argument("--annotations-dir", default=None)
    cli.add_argument("--out", default="data/splits.json")
    cli.add_argument("--seed", type=int, default=13)
    cli.add_argument(
        "--ratios",
        type=float,
        nargs=3,
        default=list(DEFAULT_RATIOS),
        metavar=("TRAIN", "VAL", "TEST"),
    )
    cli.add_argument("--model-name", default=DEFAULT_MODEL_NAME)
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    cli = _build_cli()
    args = cli.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if args.inspect:
        return _cmd_inspect(args.inspect)
    if args.build_splits:
        return _cmd_build_splits(
            args.annotations_dir or "data/annotations", args.out, args.seed, args.ratios
        )
    if args.self_test:
        return _cmd_self_test(args.model_name, args.annotations_dir)
    cli.print_help()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

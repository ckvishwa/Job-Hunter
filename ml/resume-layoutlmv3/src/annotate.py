"""Annotation drafts: word labels plus employment / education relations.

A draft is **not** a labelled example. Rules or models may *propose* a tag, but
every word stays ``UNREVIEWED`` until a human compares it against the rendered
page and writes a final label. :func:`promote` refuses to emit a training
annotation while anything is still unreviewed, so an unreviewed draft cannot
leak into a training run.

BIO tags alone cannot say *which* employer a title belongs to, so a draft also
carries explicit relation records - employment (employer / title / start / end)
and education (degree / school) - each with its own review status and an
``AMBIGUOUS`` state for documents that genuinely do not say.

CLI::

    python -m src.annotate --build --pdf-dir ../../data/Resumes \\
        --families private-runtime/dataset-01/families.json \\
        --out private-runtime/dataset-01/annotations --limit 10
    python -m src.annotate --validate private-runtime/dataset-01/annotations
    python -m src.annotate --status private-runtime/dataset-01/annotations
    python -m src.annotate --promote private-runtime/dataset-01/annotations \\
        --to data/annotations
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence

from pydantic import BaseModel, Field, field_validator, model_validator

from src.dataset import LABEL2ID, verify_bio
from src.inventory import sha256_file
from src.parser import EXTRACTION_REVISION, ParsedDocument, ParserError, ResumeDocumentParser

LOGGER = logging.getLogger(__name__)

#: Fields a REVIEWED relationship record must carry; dates stay optional.
REQUIRED_EMPLOYMENT_FIELDS = ("employer", "job_title")
REQUIRED_EDUCATION_FIELDS = ("degree", "school")

ReviewStatus = Literal["UNREVIEWED", "IN_REVIEW", "REVIEWED"]
WordStatus = Literal["UNREVIEWED", "REVIEWED", "SUGGESTION_REJECTED"]
RelationStatus = Literal["UNREVIEWED", "REVIEWED", "AMBIGUOUS"]

#: Bumped whenever the proposal logic changes, so a draft records what made it.
PROPOSER_REVISION = "rules-stub@1"
DRAFT_SCHEMA_VERSION = 1


# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #
class WordAnnotation(BaseModel):
    """One extracted word, its box, a proposal and the reviewed label."""

    index: int = Field(ge=0)
    text: str
    box: tuple[int, int, int, int]
    line: int = -1
    suggested: str | None = None
    label: str | None = None
    status: WordStatus = "UNREVIEWED"

    @field_validator("suggested", "label")
    @classmethod
    def _known_tag(cls, value: str | None) -> str | None:
        if value is not None and value not in LABEL2ID:
            raise ValueError(f"unknown tag {value!r}")
        return value

    @model_validator(mode="after")
    def _reviewed_needs_label(self) -> "WordAnnotation":
        if self.status == "REVIEWED" and self.label is None:
            raise ValueError(f"word {self.index} is REVIEWED but has no final label")
        return self


class PageAnnotation(BaseModel):
    page_index: int = Field(ge=0)
    width: float
    height: float
    source: str = "native"
    words: list[WordAnnotation] = Field(default_factory=list)


class SpanRef(BaseModel):
    """A reference into the extracted words, carrying the text it must match."""

    page_index: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(gt=0)  # exclusive
    text: str

    @model_validator(mode="after")
    def _ordered(self) -> "SpanRef":
        if self.end <= self.start:
            raise ValueError(f"span end {self.end} must exceed start {self.start}")
        return self


class EmploymentRecord(BaseModel):
    """One job: employer, title and dates, each pointing at extracted words."""

    record_id: str
    page_index: int = Field(ge=0)
    employer: SpanRef | None = None
    job_title: SpanRef | None = None
    start_date: SpanRef | None = None
    end_date: SpanRef | None = None
    section: str | None = None
    status: RelationStatus = "UNREVIEWED"
    missing: list[str] = Field(default_factory=list)
    notes: str = ""

    @model_validator(mode="after")
    def _record_missing(self) -> "EmploymentRecord":
        self.missing = [
            field
            for field in ("employer", "job_title", "start_date", "end_date")
            if getattr(self, field) is None
        ]
        return self


class EducationRecord(BaseModel):
    """One qualification: degree and school, with optional dates."""

    record_id: str
    page_index: int = Field(ge=0)
    degree: SpanRef | None = None
    school: SpanRef | None = None
    start_date: SpanRef | None = None
    end_date: SpanRef | None = None
    status: RelationStatus = "UNREVIEWED"
    missing: list[str] = Field(default_factory=list)
    notes: str = ""

    @model_validator(mode="after")
    def _record_missing(self) -> "EducationRecord":
        self.missing = [
            field for field in ("degree", "school") if getattr(self, field) is None
        ]
        return self


class AnnotationDraft(BaseModel):
    """Everything about one document's annotation, reviewed or not."""

    schema_version: int = DRAFT_SCHEMA_VERSION
    doc_id: str
    pdf_path: str
    source_sha256: str
    template_family: str = "unassigned"
    family_source: str = "unassigned"
    reading_order: str = "native"
    extraction_revision: str = "unknown"
    proposer: str = PROPOSER_REVISION
    content_kind: str = "unknown"
    status: ReviewStatus = "UNREVIEWED"
    reviewer: str | None = None
    reviewed_at: str | None = None
    notes: str = ""
    pages: list[PageAnnotation] = Field(min_length=1)
    employment: list[EmploymentRecord] = Field(default_factory=list)
    education: list[EducationRecord] = Field(default_factory=list)

    # -- derived counts ---------------------------------------------------- #
    @property
    def word_count(self) -> int:
        return sum(len(page.words) for page in self.pages)

    @property
    def reviewed_word_count(self) -> int:
        return sum(1 for page in self.pages for word in page.words if word.status == "REVIEWED")

    @property
    def suggested_word_count(self) -> int:
        return sum(
            1
            for page in self.pages
            for word in page.words
            if word.suggested and word.suggested != "O"
        )

    def page(self, page_index: int) -> PageAnnotation:
        for page in self.pages:
            if page.page_index == page_index:
                return page
        raise KeyError(f"{self.doc_id}: no page {page_index}")


# --------------------------------------------------------------------------- #
# Proposals
# --------------------------------------------------------------------------- #
#: Tokens that only glue a date range together; alone they are not a date.
GLUE_DATE_TOKENS = {"to", "-", "–", "—", "|", "/", "and"}
#: Line-cue entities longer than this are almost always a swallowed sentence.
MAX_PROPOSAL_SPAN_WORDS = 8


def propose_word_labels(words: Sequence[str], boxes: Sequence[Sequence[int]]) -> list[str]:
    """Deterministic tag proposals. Never ground truth - only a review aid.

    The Rules v2 stand-in tags whole lines, which on résumé prose swallows a
    summary sentence into one EMPLOYER span and marks range glue ("to", "-")
    as a DATE. Those two failure modes make a draft slower to review than an
    empty one, so they are filtered out here. The baseline itself is left
    untouched: it is the evaluation contract, not a labelling tool.
    """
    from src.evaluate import StubRulesV2Baseline

    tags = StubRulesV2Baseline().predict_page(words, boxes)
    return refine_suggestions(words, tags)


def refine_suggestions(words: Sequence[str], tags: Sequence[str]) -> list[str]:
    """Drop over-long line spans and standalone date glue from proposals."""
    from src.evaluate import spans_from_tags

    refined = list(tags)
    spans = spans_from_tags(refined, 0, words)
    date_spans = [span for span in spans if span.entity == "DATE"]

    def clear(start: int, end: int) -> None:
        for index in range(start, end):
            refined[index] = "O"

    for span in spans:
        length = span.end - span.start
        if span.entity in {"EMPLOYER", "JOB_TITLE", "SCHOOL", "DEGREE", "NAME"} and length > MAX_PROPOSAL_SPAN_WORDS:
            clear(span.start, span.end)
            continue
        if span.entity == "DATE":
            tokens = [words[index].strip().lower() for index in range(span.start, span.end)]
            if all(token in GLUE_DATE_TOKENS for token in tokens):
                near_real_date = any(
                    other is not span
                    and other.entity == "DATE"
                    and min(abs(other.start - span.end), abs(span.start - other.end)) <= 2
                    and not all(
                        words[index].strip().lower() in GLUE_DATE_TOKENS
                        for index in range(other.start, other.end)
                    )
                    for other in date_spans
                )
                if not near_real_date:
                    clear(span.start, span.end)
    return refined


def _suggested_spans(page: PageAnnotation) -> list[tuple[str, int, int, str]]:
    """Decode the *suggested* tags into ``(entity, start, end, text)`` spans."""
    from src.evaluate import spans_from_tags

    tags = [word.suggested or "O" for word in page.words]
    texts = [word.text for word in page.words]
    return [
        (span.entity, span.start, span.end, span.text)
        for span in spans_from_tags(tags, page.page_index, texts)
    ]


def propose_relations(
    draft: AnnotationDraft,
    max_gap: int = 24,
) -> tuple[list[EmploymentRecord], list[EducationRecord]]:
    """Pair suggested spans into employment / education record *proposals*.

    Pairing is positional: a title is matched to the nearest employer span and
    the nearest dates within ``max_gap`` words. Where no candidate exists the
    field is left ``None`` and listed in ``missing`` - nothing is invented, and
    every record is ``UNREVIEWED``.
    """
    employment: list[EmploymentRecord] = []
    education: list[EducationRecord] = []

    for page in draft.pages:
        spans = _suggested_spans(page)
        titles = [span for span in spans if span[0] == "JOB_TITLE"]
        employers = [span for span in spans if span[0] == "EMPLOYER"]
        degrees = [span for span in spans if span[0] == "DEGREE"]
        schools = [span for span in spans if span[0] == "SCHOOL"]
        dates = [span for span in spans if span[0] == "DATE"]

        def nearest(
            anchor: tuple[str, int, int, str],
            candidates: Sequence[tuple[str, int, int, str]],
            used: set[int],
        ) -> tuple[str, int, int, str] | None:
            best = None
            best_distance = max_gap + 1
            for index, candidate in enumerate(candidates):
                if index in used:
                    continue
                distance = min(
                    abs(candidate[1] - anchor[2]), abs(anchor[1] - candidate[2])
                )
                if distance < best_distance:
                    best, best_distance = (index, candidate), distance
            if best is None:
                return None
            used.add(best[0])
            return best[1]

        used_employers: set[int] = set()
        used_dates: set[int] = set()
        for number, title in enumerate(titles, start=1):
            employer = nearest(title, employers, used_employers)
            start_date = nearest(title, dates, used_dates)
            end_date = nearest(title, dates, used_dates)
            employment.append(
                EmploymentRecord(
                    record_id=f"{draft.doc_id}#emp-p{page.page_index}-{number:02d}",
                    page_index=page.page_index,
                    job_title=_span_ref(page, title),
                    employer=_span_ref(page, employer) if employer else None,
                    start_date=_span_ref(page, start_date) if start_date else None,
                    end_date=_span_ref(page, end_date) if end_date else None,
                    notes="positional proposal from suggested spans; verify against the page",
                )
            )

        used_schools: set[int] = set()
        used_education_dates: set[int] = set()
        for number, degree in enumerate(degrees, start=1):
            school = nearest(degree, schools, used_schools)
            start_date = nearest(degree, dates, used_education_dates)
            end_date = nearest(degree, dates, used_education_dates)
            education.append(
                EducationRecord(
                    record_id=f"{draft.doc_id}#edu-p{page.page_index}-{number:02d}",
                    page_index=page.page_index,
                    degree=_span_ref(page, degree),
                    school=_span_ref(page, school) if school else None,
                    start_date=_span_ref(page, start_date) if start_date else None,
                    end_date=_span_ref(page, end_date) if end_date else None,
                    notes="positional proposal from suggested spans; verify against the page",
                )
            )
    return employment, education


def _span_ref(page: PageAnnotation, span: tuple[str, int, int, str]) -> SpanRef:
    _entity, start, end, text = span
    return SpanRef(page_index=page.page_index, start=start, end=end, text=text)


# --------------------------------------------------------------------------- #
# Building drafts
# --------------------------------------------------------------------------- #
def build_draft(
    pdf_path: Path,
    parser: ResumeDocumentParser,
    template_family: str = "unassigned",
    family_source: str = "unassigned",
    content_kind: str = "unknown",
    propose: bool = True,
) -> AnnotationDraft:
    """Parse one PDF and wrap it in an all-``UNREVIEWED`` draft."""
    document: ParsedDocument = parser.parse(pdf_path)
    pages: list[PageAnnotation] = []
    for page in document.pages:
        words = [
            WordAnnotation(
                index=index,
                text=word.text,
                box=word.box,
                line=word.line_id,
            )
            for index, word in enumerate(page.words)
        ]
        if propose and words:
            suggestions = propose_word_labels(
                [word.text for word in words], [list(word.box) for word in words]
            )
            for word, suggestion in zip(words, suggestions):
                word.suggested = suggestion
        pages.append(
            PageAnnotation(
                page_index=page.page_index,
                width=round(page.width, 2),
                height=round(page.height, 2),
                source=page.source,
                words=words,
            )
        )

    draft = AnnotationDraft(
        doc_id=pdf_path.stem,
        pdf_path=str(pdf_path),
        source_sha256=sha256_file(pdf_path),
        template_family=template_family,
        family_source=family_source,
        content_kind=content_kind,
        reading_order=parser.reading_order,
        extraction_revision=f"{EXTRACTION_REVISION}:{parser.reading_order}",
        pages=pages,
    )
    if propose:
        draft.employment, draft.education = propose_relations(draft)
    return draft


def write_draft(draft: AnnotationDraft, out_dir: Path) -> tuple[Path, Path]:
    """Write the JSON draft plus a TSV a human can review in a spreadsheet."""
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{draft.doc_id}.json"
    json_path.write_text(draft.model_dump_json(indent=2), encoding="utf-8")

    tsv_path = out_dir / f"{draft.doc_id}.review.tsv"
    with tsv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(
            ["page", "index", "line", "text", "box", "suggested", "final_label", "status"]
        )
        for page in draft.pages:
            for word in page.words:
                writer.writerow(
                    [
                        page.page_index,
                        word.index,
                        word.line,
                        word.text,
                        ",".join(str(value) for value in word.box),
                        word.suggested or "",
                        word.label or "",
                        word.status,
                    ]
                )
    return json_path, tsv_path


EMPLOYMENT_TSV_COLUMNS = (
    "record_id",
    "page",
    "employer",
    "job_title",
    "start_date",
    "end_date",
    "missing",
    "proposed_status",
    "final_status",
    "reviewer_notes",
)
EDUCATION_TSV_COLUMNS = (
    "record_id",
    "page",
    "degree",
    "school",
    "start_date",
    "end_date",
    "missing",
    "proposed_status",
    "final_status",
    "reviewer_notes",
)
#: Statuses a reviewer may write into a relationship TSV.
REVIEWABLE_RELATION_STATUSES = ("REVIEWED", "AMBIGUOUS")


def _span_text(record: Any, field: str) -> str:
    span = getattr(record, field, None)
    return span.text if span is not None else ""


def write_relation_tsvs(draft: AnnotationDraft, out_dir: Path) -> tuple[Path, Path]:
    """Export employment and education proposals as reviewable TSVs.

    The TSV is for confirming, ambiguating or annotating a proposal. Correcting
    *which words* a record points at means editing the span in the draft JSON -
    the TSV deliberately cannot move a span, so a reviewer cannot invent one by
    typing text into a cell.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    employment_path = out_dir / f"{draft.doc_id}.employment.tsv"
    education_path = out_dir / f"{draft.doc_id}.education.tsv"

    with employment_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(EMPLOYMENT_TSV_COLUMNS)
        for record in draft.employment:
            writer.writerow(
                [
                    record.record_id,
                    record.page_index,
                    _span_text(record, "employer"),
                    _span_text(record, "job_title"),
                    _span_text(record, "start_date"),
                    _span_text(record, "end_date"),
                    ",".join(record.missing),
                    record.status,
                    # A record a reviewer has already decided exports that decision,
                    # so a re-export stays self-describing.
                    record.status if record.status != 'UNREVIEWED' else '',
                    record.notes,
                ]
            )

    with education_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
        writer.writerow(EDUCATION_TSV_COLUMNS)
        for record in draft.education:
            writer.writerow(
                [
                    record.record_id,
                    record.page_index,
                    _span_text(record, "degree"),
                    _span_text(record, "school"),
                    _span_text(record, "start_date"),
                    _span_text(record, "end_date"),
                    ",".join(record.missing),
                    record.status,
                    # A record a reviewer has already decided exports that decision,
                    # so a re-export stays self-describing.
                    record.status if record.status != 'UNREVIEWED' else '',
                    record.notes,
                ]
            )
    return employment_path, education_path


def apply_relation_tsv(draft: AnnotationDraft, tsv_path: Path, kind: str) -> list[str]:
    """Read ``final_status`` back from a reviewed relationship TSV.

    Only the status and notes are taken from the file; span text is compared
    and a mismatch is reported rather than applied, so an edited cell cannot
    rewrite what the record points at.
    """
    if kind not in ("employment", "education"):
        raise ValueError(f"kind must be employment or education, got {kind!r}")
    records = {record.record_id: record for record in getattr(draft, kind)}
    fields = ("employer", "job_title") if kind == "employment" else ("degree", "school")

    issues: list[str] = []
    with Path(tsv_path).open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))

    for row in rows:
        record = records.get((row.get("record_id") or "").strip())
        if record is None:
            issues.append(f"unknown record_id {row.get('record_id')!r}")
            continue
        for field in fields:
            if (row.get(field) or "") != _span_text(record, field):
                issues.append(
                    f"{record.record_id}.{field}: TSV text {row.get(field)!r} != "
                    f"span {_span_text(record, field)!r}; edit the span in the draft JSON"
                )
        final = (row.get("final_status") or "").strip().upper()
        if not final:
            continue
        if final not in REVIEWABLE_RELATION_STATUSES:
            issues.append(
                f"{record.record_id}: final_status {final!r} not in {REVIEWABLE_RELATION_STATUSES}"
            )
            continue
        record.status = final  # type: ignore[assignment]
        note = (row.get("reviewer_notes") or "").strip()
        if note:
            record.notes = note
    return issues


def load_draft(path: Path) -> AnnotationDraft:
    return AnnotationDraft.model_validate_json(Path(path).read_text(encoding="utf-8"))


def apply_review_tsv(draft: AnnotationDraft, tsv_path: Path, reviewer: str) -> list[str]:
    """Read ``final_label`` back from a reviewed TSV into the draft.

    Returns the problems found. A row with an empty ``final_label`` stays
    ``UNREVIEWED``; a row whose text no longer matches the extracted word is
    rejected rather than applied, because that means the TSV and the parse have
    drifted apart.
    """
    issues: list[str] = []
    with Path(tsv_path).open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle, delimiter="\t"))

    for row in rows:
        try:
            page = draft.page(int(row["page"]))
            word = page.words[int(row["index"])]
        except (KeyError, IndexError, ValueError) as exc:
            issues.append(f"row {row}: {exc}")
            continue
        if row["text"] != word.text:
            issues.append(
                f"page {row['page']} word {row['index']}: TSV text {row['text']!r} "
                f"!= extracted {word.text!r}; re-export the draft"
            )
            continue
        final = (row.get("final_label") or "").strip()
        if not final:
            continue
        if final not in LABEL2ID:
            issues.append(f"page {row['page']} word {row['index']}: unknown tag {final!r}")
            continue
        word.label = final
        word.status = "REVIEWED"

    if draft.reviewed_word_count:
        draft.reviewer = reviewer
        draft.status = "REVIEWED" if draft.reviewed_word_count == draft.word_count else "IN_REVIEW"
    return issues


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_draft(draft: AnnotationDraft) -> list[str]:
    """Structural checks that must hold before a draft can be promoted."""
    issues: list[str] = []

    for page in draft.pages:
        for position, word in enumerate(page.words):
            if word.index != position:
                issues.append(f"page {page.page_index}: word index {word.index} out of order")
            x0, y0, x1, y1 = word.box
            if not all(0 <= value <= 1000 for value in word.box):
                issues.append(f"page {page.page_index} word {word.index}: box outside 0-1000")
            if x1 < x0 or y1 < y0:
                issues.append(f"page {page.page_index} word {word.index}: inverted box")

        reviewed = [word for word in page.words if word.status == "REVIEWED"]
        if reviewed and len(reviewed) == len(page.words):
            for issue in verify_bio([word.label or "O" for word in page.words]):
                issues.append(f"page {page.page_index}: reviewed BIO invalid: {issue}")

    issues.extend(_validate_relations(draft))

    if draft.status == "REVIEWED" and draft.reviewed_word_count != draft.word_count:
        issues.append(
            f"status REVIEWED but {draft.word_count - draft.reviewed_word_count} words unreviewed"
        )
    if draft.status == "REVIEWED" and not draft.reviewer:
        issues.append("status REVIEWED but no reviewer recorded")
    return issues


def _validate_relations(draft: AnnotationDraft) -> list[str]:
    """Every span reference must point at real words whose text still matches."""
    issues: list[str] = []
    records: list[tuple[str, str, SpanRef | None]] = []
    for record in draft.employment:
        for field in ("employer", "job_title", "start_date", "end_date"):
            records.append((record.record_id, field, getattr(record, field)))
    for record in draft.education:
        for field in ("degree", "school", "start_date", "end_date"):
            records.append((record.record_id, field, getattr(record, field)))

    for record_id, field, span in records:
        if span is None:
            continue
        try:
            page = draft.page(span.page_index)
        except KeyError:
            issues.append(f"{record_id}.{field}: page {span.page_index} does not exist")
            continue
        if span.end > len(page.words):
            issues.append(
                f"{record_id}.{field}: span {span.start}:{span.end} beyond "
                f"{len(page.words)} words on page {span.page_index}"
            )
            continue
        actual = " ".join(word.text for word in page.words[span.start : span.end])
        if actual != span.text:
            issues.append(
                f"{record_id}.{field}: span text {span.text!r} != extracted {actual!r}"
            )

    # Dates are genuinely optional on a résumé line; the entity the record is
    # about is not. Only a missing required field blocks a REVIEWED record.
    for record, required in (
        *((record, REQUIRED_EMPLOYMENT_FIELDS) for record in draft.employment),
        *((record, REQUIRED_EDUCATION_FIELDS) for record in draft.education),
    ):
        if record.status != "REVIEWED":
            continue
        missing_required = [field for field in record.missing if field in required]
        if missing_required:
            issues.append(
                f"{record.record_id}: REVIEWED with missing fields {missing_required}; "
                "use AMBIGUOUS when the document does not say"
            )
    return issues


# --------------------------------------------------------------------------- #
# Promotion
# --------------------------------------------------------------------------- #
def promote(draft: AnnotationDraft) -> dict[str, Any]:
    """Convert a fully reviewed draft into the training annotation format.

    Raises if anything is unreviewed: suggestions must never reach training.
    """
    issues = validate_draft(draft)
    if issues:
        raise ValueError(f"{draft.doc_id}: draft does not validate: {issues[:5]}")
    if draft.status != "REVIEWED":
        raise ValueError(f"{draft.doc_id}: status is {draft.status}, not REVIEWED")
    unreviewed = draft.word_count - draft.reviewed_word_count
    if unreviewed:
        raise ValueError(f"{draft.doc_id}: {unreviewed} words still unreviewed")

    return {
        "doc_id": draft.doc_id,
        "pdf_path": draft.pdf_path,
        "template_family": draft.template_family,
        "source": draft.pages[0].source if draft.pages else "native",
        "source_sha256": draft.source_sha256,
        "extraction_revision": draft.extraction_revision,
        "reading_order": draft.reading_order,
        "reviewer": draft.reviewer,
        "pages": [
            {
                "page_index": page.page_index,
                "width": page.width,
                "height": page.height,
                "source": page.source,
                "words": [
                    {"text": word.text, "box": list(word.box), "tag": word.label}
                    for word in page.words
                ],
            }
            for page in draft.pages
        ],
    }


# --------------------------------------------------------------------------- #
# CLI commands
# --------------------------------------------------------------------------- #
def _load_families(path: str | None) -> dict[str, dict[str, str]]:
    if not path:
        return {}
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    families: dict[str, dict[str, str]] = {}
    for family, entry in payload.get("families", {}).items():
        for filename in entry.get("members", []):
            families[filename] = {
                "family": family,
                "family_source": payload.get("assigned_by", "unspecified"),
                "content_kind": entry.get("content_kind", "unknown"),
            }
    return families


def _cmd_build(args: argparse.Namespace) -> int:
    source = Path(args.pdf_dir)
    paths = sorted(path for path in source.iterdir() if path.suffix.lower() == ".pdf")
    families = _load_families(args.families)

    if args.families and args.one_per_family:
        seen: set[str] = set()
        chosen: list[Path] = []
        for path in paths:
            family = families.get(path.name, {}).get("family", "unassigned")
            if family in seen:
                continue
            seen.add(family)
            chosen.append(path)
        paths = chosen
    if args.limit:
        paths = paths[: args.limit]

    parser = ResumeDocumentParser(keep_images=False, reading_order=args.reading_order)
    out_dir = Path(args.out)
    built = 0
    for path in paths:
        meta = families.get(path.name, {})
        try:
            draft = build_draft(
                path,
                parser,
                template_family=meta.get("family", "unassigned"),
                family_source=meta.get("family_source", "unassigned"),
                content_kind=meta.get("content_kind", "unknown"),
                propose=not args.no_proposals,
            )
        except ParserError as exc:
            print(f"FAILED {path.name}: {exc}", file=sys.stderr)
            continue
        json_path, tsv_path = write_draft(draft, out_dir)
        write_relation_tsvs(draft, out_dir)
        built += 1
        print(
            f"{draft.doc_id}: {draft.word_count} words, "
            f"{draft.suggested_word_count} entity suggestions, "
            f"{len(draft.employment)} employment / {len(draft.education)} education proposals "
            f"-> {json_path.name}, {tsv_path.name}"
        )
    print(f"built {built} draft(s) in {out_dir} (all UNREVIEWED)")
    return 0 if built else 1


def _iter_drafts(directory: Path) -> Iterable[AnnotationDraft]:
    for path in sorted(directory.glob("*.json")):
        yield load_draft(path)


def _cmd_validate(args: argparse.Namespace) -> int:
    directory = Path(args.validate)
    total_issues = 0
    for draft in _iter_drafts(directory):
        issues = validate_draft(draft)
        total_issues += len(issues)
        marker = "OK " if not issues else "BAD"
        print(f"{marker} {draft.doc_id}: {len(issues)} issue(s)")
        for issue in issues[:10]:
            print(f"      {issue}")
    print(f"total issues: {total_issues}")
    return 1 if total_issues else 0


def _cmd_status(args: argparse.Namespace) -> int:
    directory = Path(args.status)
    drafts = list(_iter_drafts(directory))
    if not drafts:
        print(f"no drafts in {directory}", file=sys.stderr)
        return 1

    print(f"{'doc_id':<34}{'family':<22}{'words':>7}{'revd':>6}{'sugg':>6}{'emp':>5}{'edu':>5}  status")
    for draft in drafts:
        print(
            f"{draft.doc_id[:32]:<34}{draft.template_family[:20]:<22}{draft.word_count:>7}"
            f"{draft.reviewed_word_count:>6}{draft.suggested_word_count:>6}"
            f"{len(draft.employment):>5}{len(draft.education):>5}  {draft.status}"
        )
    words = sum(draft.word_count for draft in drafts)
    reviewed = sum(draft.reviewed_word_count for draft in drafts)
    ready = [draft for draft in drafts if draft.status == "REVIEWED"]
    print(
        f"\n{len(drafts)} draft(s): {reviewed}/{words} words reviewed, "
        f"{len(ready)} document(s) promotable"
    )
    relations = sum(len(draft.employment) for draft in drafts)
    reviewed_relations = sum(
        1 for draft in drafts for record in draft.employment if record.status == "REVIEWED"
    )
    print(f"employment relations: {reviewed_relations}/{relations} reviewed")
    education = sum(len(draft.education) for draft in drafts)
    reviewed_education = sum(
        1 for draft in drafts for record in draft.education if record.status == "REVIEWED"
    )
    print(f"education relations:  {reviewed_education}/{education} reviewed")
    return 0


def _cmd_promote(args: argparse.Namespace) -> int:
    directory = Path(args.promote)
    target = Path(args.to)
    target.mkdir(parents=True, exist_ok=True)
    promoted = skipped = 0
    for draft in _iter_drafts(directory):
        try:
            payload = promote(draft)
        except ValueError as exc:
            skipped += 1
            print(f"SKIP {draft.doc_id}: {exc}")
            continue
        (target / f"{draft.doc_id}.json").write_text(
            json.dumps(payload, indent=2), encoding="utf-8"
        )
        promoted += 1
        print(f"promoted {draft.doc_id}")
    print(f"promoted {promoted}, skipped {skipped}")
    return 0 if promoted else 1


def _cmd_apply(args: argparse.Namespace) -> int:
    draft = load_draft(Path(args.apply))
    issues = apply_review_tsv(draft, Path(args.tsv), reviewer=args.reviewer)
    write_draft(draft, Path(args.apply).parent)
    print(
        f"{draft.doc_id}: {draft.reviewed_word_count}/{draft.word_count} reviewed, "
        f"status={draft.status}, issues={len(issues)}"
    )
    for issue in issues[:10]:
        print(f"  {issue}")
    return 1 if issues else 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.annotate",
        description="Build, validate, review and promote résumé annotation drafts.",
    )
    mode = cli.add_mutually_exclusive_group(required=True)
    mode.add_argument("--build", action="store_true", help="Build drafts from PDFs")
    mode.add_argument("--validate", metavar="DIR", help="Validate drafts in a directory")
    mode.add_argument("--status", metavar="DIR", help="Review progress per draft")
    mode.add_argument("--promote", metavar="DIR", help="Promote REVIEWED drafts")
    mode.add_argument("--apply", metavar="DRAFT_JSON", help="Apply a reviewed TSV to a draft")

    cli.add_argument("--pdf-dir", default="../../data/Resumes")
    cli.add_argument("--families", default=None, help="families.json with reviewed grouping")
    cli.add_argument("--out", default="private-runtime/dataset-01/annotations")
    cli.add_argument("--to", default="data/annotations", help="Target for promoted annotations")
    cli.add_argument("--tsv", default=None, help="Reviewed TSV for --apply")
    cli.add_argument("--reviewer", default=None, help="Who reviewed (human name/handle)")
    cli.add_argument("--limit", type=int, default=None, help="Cap documents processed")
    cli.add_argument("--one-per-family", action="store_true", help="One document per family")
    cli.add_argument("--no-proposals", action="store_true", help="Leave suggestions empty")
    cli.add_argument("--reading-order", choices=("native", "columns"), default="columns")
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    if args.build:
        return _cmd_build(args)
    if args.validate:
        return _cmd_validate(args)
    if args.status:
        return _cmd_status(args)
    if args.promote:
        return _cmd_promote(args)
    if args.apply:
        if not args.tsv or not args.reviewer:
            print("ERROR: --apply needs --tsv and --reviewer", file=sys.stderr)
            return 1
        return _cmd_apply(args)
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

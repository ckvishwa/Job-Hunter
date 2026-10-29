"""Validation and promotion gate for reviewed résumé annotations.

Structural validity is not authorisation. This module separates the two:

* **structure** - TSV schema, boxes, token alignment against the saved
  extraction, BIO well-formedness, relationship integrity;
* **authority** - a review manifest naming a human reviewer, the source
  SHA-256 they reviewed, the extraction revision and the annotation revision
  they approved.

Only when both hold does :func:`promote_draft` hand the annotation to the
existing :func:`src.annotate.promote` and write it atomically into the training
directory. A draft, a stub, or an all-``O`` document without an explicit
reviewer decision never promotes.

CLI::

    python -m src.validate_annotations --draft <draft.json> --init-manifest
    python -m src.validate_annotations --draft <draft.json>            # validate
    python -m src.validate_annotations --draft <draft.json> --promote --to data/annotations

Exit codes: 0 approved/promoted, 2 review pending, 3 rejected,
4 source changed, 5 relationship invalid, 1 usage or I/O error.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence

from pydantic import BaseModel, Field

from src.annotate import AnnotationDraft, load_draft, promote, write_draft
from src.dataset import LABELS
from src.inventory import sha256_file
from src.parser import EXTRACTION_REVISION

LOGGER = logging.getLogger(__name__)

# The taxonomy lives in src.dataset; these are the names the validation
# contract uses, bound to that single authoritative definition.
LABEL_LIST: list[str] = list(LABELS)
ID2LABEL: dict[int, str] = dict(enumerate(LABEL_LIST))
LABEL2ID: dict[str, int] = {label: index for index, label in ID2LABEL.items()}
VALID_LABELS: set[str] = set(LABEL_LIST)

MANIFEST_SCHEMA_VERSION = 1
#: Column spellings this validator accepts, in priority order.
COLUMN_ALIASES: dict[str, tuple[str, ...]] = {
    "token_id": ("token_id", "index"),
    "text": ("text",),
    "box": ("box",),
    "label": ("label", "final_label"),
    "page": ("page", "page_id", "page_index"),
}
REQUIRED_COLUMNS = ("token_id", "text", "box", "label")

Status = Literal[
    "STRUCTURALLY_VALID",
    "REVIEW_PENDING",
    "APPROVED",
    "REJECTED",
    "SOURCE_CHANGED",
    "RELATIONSHIP_INVALID",
    "PROMOTED",
]

EXIT_CODES: dict[str, int] = {
    "APPROVED": 0,
    "PROMOTED": 0,
    "STRUCTURALLY_VALID": 2,
    "REVIEW_PENDING": 2,
    "REJECTED": 3,
    "SOURCE_CHANGED": 4,
    "RELATIONSHIP_INVALID": 5,
}

#: Which label each relationship field must carry on its words.
RELATION_FIELD_ENTITY: dict[str, str] = {
    "employer": "EMPLOYER",
    "job_title": "JOB_TITLE",
    "start_date": "DATE",
    "end_date": "DATE",
    "degree": "DEGREE",
    "school": "SCHOOL",
}
#: Relationship fields that may legitimately be absent.
OPTIONAL_RELATION_FIELDS = ("start_date", "end_date", "section")


# --------------------------------------------------------------------------- #
# Review manifest
# --------------------------------------------------------------------------- #
class ReviewManifest(BaseModel):
    """A human's signed statement about one document's annotation."""

    schema_version: int = MANIFEST_SCHEMA_VERSION
    doc_id: str
    source_sha256: str
    extraction_revision: str
    annotation_revision: str | None = None
    review_status: Literal["UNREVIEWED", "APPROVED", "REJECTED"] = "UNREVIEWED"
    reviewer: str | None = None
    reviewed_at: str | None = None
    empty_document_confirmed: bool = False
    tsv_sha256: str | None = None
    notes: str = ""

    @property
    def is_approved(self) -> bool:
        return self.review_status == "APPROVED"


def manifest_path_for(draft_path: Path) -> Path:
    return draft_path.with_suffix(".manifest.json")


def load_manifest(path: Path) -> ReviewManifest:
    return ReviewManifest.model_validate_json(Path(path).read_text(encoding="utf-8"))


def init_manifest(draft: AnnotationDraft, path: Path) -> ReviewManifest:
    """Write an UNREVIEWED manifest for a draft. Never pre-approves anything."""
    manifest = ReviewManifest(
        doc_id=draft.doc_id,
        source_sha256=draft.source_sha256,
        extraction_revision=draft.extraction_revision,
        annotation_revision=None,
        review_status="UNREVIEWED",
        notes=(
            "Set review_status=APPROVED, reviewer and reviewed_at only after comparing "
            "every label and relationship against the rendered page. Paste the "
            "annotation_revision printed by --validate."
        ),
    )
    path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
    return manifest


def annotation_revision(draft: AnnotationDraft) -> str:
    """Content hash of what a reviewer would be approving.

    Covers the source hash, the extraction revision, every token's text, box and
    final label, and every relationship record with the spans it points at - so
    editing a label, moving a span or re-extracting the PDF changes the revision
    and invalidates an older approval.
    """
    digest = hashlib.sha256()
    digest.update(draft.doc_id.encode("utf-8"))
    digest.update(draft.source_sha256.encode("utf-8"))
    digest.update(draft.extraction_revision.encode("utf-8"))
    for page in draft.pages:
        digest.update(f"|page{page.page_index}".encode("utf-8"))
        for word in page.words:
            digest.update(
                f"|{word.index}|{word.text}|{','.join(str(v) for v in word.box)}|{word.label}".encode(
                    "utf-8"
                )
            )
    for kind, records in (("emp", draft.employment), ("edu", draft.education)):
        for record in records:
            digest.update(f"|{kind}|{record.record_id}|{record.status}".encode("utf-8"))
            for field_name in ("employer", "job_title", "degree", "school", "start_date", "end_date"):
                span = getattr(record, field_name, None)
                marker = (
                    "none"
                    if span is None
                    else f"{span.page_index}:{span.start}:{span.end}:{span.text}"
                )
                digest.update(f"|{field_name}={marker}".encode("utf-8"))
    return digest.hexdigest()


# --------------------------------------------------------------------------- #
# TSV primitives
# --------------------------------------------------------------------------- #
def parse_box(value: str) -> list[int]:
    """Read a TSV bounding box without changing its values."""
    try:
        raw = value.strip()
        if raw.startswith("["):
            coordinates = json.loads(raw)
        else:
            coordinates = raw.split(",")

        if not isinstance(coordinates, list):
            raise ValueError("Box must be a list")
        if len(coordinates) != 4:
            raise ValueError("Box must have four coordinates")

        result: list[int] = []
        for coordinate in coordinates:
            if isinstance(coordinate, bool):
                raise ValueError("Boolean coordinate")
            if isinstance(coordinate, float):
                raise ValueError("Float coordinate")
            if isinstance(coordinate, str):
                if not coordinate.strip().lstrip("-").isdigit():
                    raise ValueError("Non-integer coordinate")
                coordinate = coordinate.strip()
            result.append(int(coordinate))
        return result
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid bounding box {value!r}: {exc}") from exc


def check_box(box: Sequence[int]) -> list[str]:
    """Grid-range and positive-area checks for one normalised box."""
    if len(box) != 4:
        return ["Expected four coordinates"]

    errors: list[str] = []
    x0, y0, x1, y1 = box
    if not all(0 <= number <= 1000 for number in box):
        errors.append("Outside 0-1000 grid")
    if x0 >= x1:
        errors.append("Non-positive width")
    if y0 >= y1:
        errors.append("Non-positive height")
    return errors


def check_bio(labels: Sequence[str], page_ids: Sequence[Any] | None = None) -> list[str]:
    """BIO well-formedness, restarting at each page boundary."""
    errors: list[str] = []
    previous_type: str | None = None
    previous_page: Any = None

    for index, label in enumerate(labels):
        page = page_ids[index] if page_ids is not None and index < len(page_ids) else None
        if page != previous_page:
            previous_type = None
            previous_page = page

        if not label:
            # Blank cell: the token is simply not reviewed yet. That is a review
            # gap (counted elsewhere), not a malformed label, and it breaks any
            # open entity because what follows is unknown.
            previous_type = None
            continue

        if label not in VALID_LABELS:
            errors.append(f"Token {index}: invalid label {label!r}")
            previous_type = None
            continue

        if label == "O":
            previous_type = None
        elif label.startswith("B-"):
            previous_type = label[2:]
        elif label.startswith("I-"):
            entity_type = label[2:]
            if previous_type != entity_type:
                errors.append(f"Token {index}: orphan {label}")
            previous_type = entity_type
    return errors


def _resolve_columns(headers: Sequence[str]) -> tuple[dict[str, str], list[str]]:
    """Map canonical column names onto the spellings this file actually uses."""
    resolved: dict[str, str] = {}
    errors: list[str] = []
    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in headers:
                resolved[canonical] = alias
                break
    missing = [name for name in REQUIRED_COLUMNS if name not in resolved]
    if missing:
        errors.append(
            f"Missing columns: {sorted(missing)} "
            f"(accepted spellings: {{{', '.join(f'{k}: {v}' for k, v in COLUMN_ALIASES.items())}}})"
        )
    return resolved, errors


# --------------------------------------------------------------------------- #
# Source tokens
# --------------------------------------------------------------------------- #
def source_tokens(draft: AnnotationDraft) -> list[dict[str, Any]]:
    """Flatten a draft into the token records the TSV must mirror, in order."""
    tokens: list[dict[str, Any]] = []
    for page in draft.pages:
        for word in page.words:
            tokens.append(
                {
                    "token_id": word.index,
                    "text": word.text,
                    "box": list(word.box),
                    "page": page.page_index,
                    "label": word.label,
                    "status": word.status,
                }
            )
    return tokens


def validate_rows(tsv_path: Path, tokens: Sequence[dict[str, Any]]) -> list[str]:
    """Check one review TSV against the tokens the extraction produced."""
    errors: list[str] = []

    with Path(tsv_path).open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t", restkey="__extra__", restval=None)
        headers = reader.fieldnames or []
        if len(headers) != len(set(headers)):
            return ["Duplicate TSV column names"]
        columns, column_errors = _resolve_columns(headers)
        if column_errors:
            return column_errors
        rows = list(reader)

    if len(rows) != len(tokens):
        errors.append(
            f"Token count mismatch: {len(rows)} reviewed vs {len(tokens)} source"
        )

    seen_ids: set[str] = set()
    labels: list[str] = []
    pages: list[Any] = []

    for index, row in enumerate(rows):
        row_number = index + 2  # header is row 1

        if row.get("__extra__"):
            errors.append(f"Row {row_number}: unexpected extra cells")
        if any(value is None for key, value in row.items() if key != "__extra__"):
            errors.append(f"Row {row_number}: missing TSV value")
            continue

        token_id = (row[columns["token_id"]] or "").strip()
        label = (row[columns["label"]] or "").strip()
        labels.append(label)
        page_value = row[columns["page"]].strip() if "page" in columns else None
        pages.append(page_value)

        if not token_id:
            errors.append(f"Row {row_number}: empty token ID")
        # Token ids restart on each page in this schema, so identity is the
        # (page, token_id) pair wherever a page column exists.
        identity = f"{page_value}:{token_id}" if page_value is not None else token_id
        if identity in seen_ids:
            errors.append(f"Row {row_number}: duplicate token ID")
        seen_ids.add(identity)

        try:
            box: list[int] | None = parse_box(row[columns["box"]])
            for error in check_box(box):
                errors.append(f"Row {row_number}: {error}")
        except ValueError as exc:
            box = None
            errors.append(f"Row {row_number}: {exc}")

        if index >= len(tokens):
            continue
        original = tokens[index]

        if str(token_id) != str(original["token_id"]):
            errors.append(
                f"Row {row_number}: token ID mismatch "
                f"({token_id!r} vs source {original['token_id']!r})"
            )
        if row[columns["text"]] != original["text"]:
            errors.append(
                f"Row {row_number}: token text mismatch "
                f"({row[columns['text']]!r} vs source {original['text']!r})"
            )
        if box is not None and box != original["box"]:
            errors.append(
                f"Row {row_number}: source box mismatch ({box} vs source {original['box']})"
            )
        if page_value is not None and str(page_value) != str(original["page"]):
            errors.append(
                f"Row {row_number}: page mismatch ({page_value!r} vs source {original['page']!r})"
            )

    source_pages = [token["page"] for token in tokens[: len(labels)]]
    errors.extend(check_bio(labels, pages if any(pages) else source_pages))
    return errors


# --------------------------------------------------------------------------- #
# Relationships
# --------------------------------------------------------------------------- #
def validate_relationships(draft: AnnotationDraft) -> list[str]:
    """Typed, resolvable, non-contradictory employment / education records.

    Span existence and quoted text are checked by
    :func:`src.annotate.validate_draft`; this adds the type contract (a span
    used as ``employer`` must carry EMPLOYER labels once reviewed), missing
    required fields, and the single-role rule that stops one span being an
    employer here and a job title there.
    """
    errors: list[str] = []
    roles: dict[tuple[int, int, int], set[str]] = {}

    def check(record: Any, fields: Sequence[str], required: Sequence[str], kind: str) -> None:
        # An UNREVIEWED record is a machine proposal, not a claim: it blocks
        # approval through the review gate, not through the type contract.
        if record.status == "UNREVIEWED":
            return
        for field_name in fields:
            span = getattr(record, field_name, None)
            if span is None:
                if field_name in required and record.status == "REVIEWED":
                    errors.append(
                        f"{record.record_id}: REVIEWED {kind} record is missing "
                        f"required field {field_name!r}; use AMBIGUOUS instead"
                    )
                continue

            try:
                page = draft.page(span.page_index)
            except KeyError:
                errors.append(f"{record.record_id}.{field_name}: page {span.page_index} missing")
                continue
            if span.end > len(page.words):
                errors.append(
                    f"{record.record_id}.{field_name}: span {span.start}:{span.end} beyond page"
                )
                continue

            key = (span.page_index, span.start, span.end)
            roles.setdefault(key, set()).add(RELATION_FIELD_ENTITY[field_name])

            words = page.words[span.start : span.end]
            expected = RELATION_FIELD_ENTITY[field_name]
            reviewed = [word for word in words if word.status == "REVIEWED"]
            if not reviewed:
                continue  # labels not reviewed yet; type cannot be checked
            wrong = [
                word
                for word in reviewed
                if not (word.label or "O").endswith(expected)
            ]
            if wrong:
                errors.append(
                    f"{record.record_id}.{field_name}: span words carry "
                    f"{[word.label for word in wrong][:3]}, expected {expected} labels"
                )
            head = reviewed[0]
            if head.label and not head.label.startswith("B-"):
                errors.append(
                    f"{record.record_id}.{field_name}: span starts mid-entity ({head.label})"
                )

    for record in draft.employment:
        check(
            record,
            ("employer", "job_title", "start_date", "end_date"),
            ("employer", "job_title"),
            "employment",
        )
    for record in draft.education:
        check(record, ("degree", "school", "start_date", "end_date"), ("degree", "school"), "education")

    for key, assigned in roles.items():
        date_roles = assigned - {"DATE"}
        if len(assigned) > 1 and date_roles and len(date_roles) > 1:
            errors.append(
                f"span page {key[0]} {key[1]}:{key[2]} is used as {sorted(assigned)} "
                "in different records (contradictory assignment)"
            )
    return errors


# --------------------------------------------------------------------------- #
# Result
# --------------------------------------------------------------------------- #
@dataclass
class ValidationResult:
    """Structured outcome of one document's validation."""

    doc_id: str
    status: Status
    annotation_revision: str
    structural_errors: list[str] = field(default_factory=list)
    relationship_errors: list[str] = field(default_factory=list)
    source_errors: list[str] = field(default_factory=list)
    review_errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    token_count: int = 0
    reviewed_token_count: int = 0
    entity_token_count: int = 0
    employment_records: int = 0
    education_records: int = 0
    reviewer: str | None = None
    promoted_path: str | None = None

    @property
    def ok(self) -> bool:
        return self.status in ("APPROVED", "PROMOTED")

    @property
    def all_errors(self) -> list[str]:
        return (
            self.source_errors
            + self.structural_errors
            + self.relationship_errors
            + self.review_errors
        )

    def as_dict(self) -> dict[str, Any]:
        payload = {
            "doc_id": self.doc_id,
            "status": self.status,
            "annotation_revision": self.annotation_revision,
            "token_count": self.token_count,
            "reviewed_token_count": self.reviewed_token_count,
            "entity_token_count": self.entity_token_count,
            "employment_records": self.employment_records,
            "education_records": self.education_records,
            "reviewer": self.reviewer,
            "source_errors": self.source_errors,
            "structural_errors": self.structural_errors,
            "relationship_errors": self.relationship_errors,
            "review_errors": self.review_errors,
            "warnings": self.warnings,
        }
        if self.promoted_path:
            payload["promoted_path"] = self.promoted_path
        return payload


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def validate_annotation(
    draft: AnnotationDraft,
    tsv_path: Path | None = None,
    manifest: ReviewManifest | None = None,
    pdf_path: Path | None = None,
    check_source_file: bool = True,
) -> ValidationResult:
    """Run every gate and return the single status that follows from them."""
    from src.annotate import validate_draft

    revision = annotation_revision(draft)
    tokens = source_tokens(draft)
    reviewed = [token for token in tokens if token["status"] == "REVIEWED"]
    entity_tokens = [
        token for token in reviewed if token["label"] and token["label"] != "O"
    ]

    result = ValidationResult(
        doc_id=draft.doc_id,
        status="REVIEW_PENDING",
        annotation_revision=revision,
        token_count=len(tokens),
        reviewed_token_count=len(reviewed),
        entity_token_count=len(entity_tokens),
        employment_records=len(draft.employment),
        education_records=len(draft.education),
        reviewer=manifest.reviewer if manifest else draft.reviewer,
    )

    # -- source identity ---------------------------------------------------- #
    source = Path(pdf_path or draft.pdf_path)
    if check_source_file:
        if not source.is_file():
            result.source_errors.append(f"source PDF missing: {source}")
        else:
            actual = sha256_file(source)
            if actual != draft.source_sha256:
                result.source_errors.append(
                    f"source SHA-256 changed: file {actual[:16]}… vs draft {draft.source_sha256[:16]}…"
                )
    if draft.extraction_revision == "unknown":
        result.warnings.append(
            "draft carries no extraction revision; rebuild it so staleness can be detected"
        )
    elif not draft.extraction_revision.startswith(EXTRACTION_REVISION):
        result.warnings.append(
            f"draft was made by extraction {draft.extraction_revision!r}, "
            f"this code is {EXTRACTION_REVISION!r}"
        )

    if manifest:
        if manifest.doc_id != draft.doc_id:
            result.source_errors.append(
                f"manifest is for {manifest.doc_id!r}, draft is {draft.doc_id!r}"
            )
        if manifest.source_sha256 != draft.source_sha256:
            result.source_errors.append(
                "manifest approved a different source SHA-256 than the draft holds"
            )
        if manifest.extraction_revision != draft.extraction_revision:
            result.source_errors.append(
                f"manifest approved extraction {manifest.extraction_revision!r}, "
                f"draft is {draft.extraction_revision!r}"
            )

    # -- structure ---------------------------------------------------------- #
    # validate_draft mixes two concerns: real structural defects and the review
    # state of the draft. Route the review-state messages to the review gate so
    # an unfinished review reads as REVIEW_PENDING, not REJECTED.
    for issue in validate_draft(draft):
        if issue.startswith("status REVIEWED but"):
            result.review_errors.append(issue)
        else:
            result.structural_errors.append(issue)
    if tsv_path is not None:
        if not Path(tsv_path).is_file():
            result.structural_errors.append(f"review TSV missing: {tsv_path}")
        else:
            result.structural_errors.extend(validate_rows(Path(tsv_path), tokens))
            if manifest and manifest.tsv_sha256:
                actual_tsv = sha256_file(Path(tsv_path))
                if actual_tsv != manifest.tsv_sha256:
                    result.source_errors.append(
                        "review TSV changed since the manifest was signed"
                    )

    # -- relationships ------------------------------------------------------ #
    result.relationship_errors.extend(validate_relationships(draft))

    # -- review authority --------------------------------------------------- #
    if manifest is None:
        result.review_errors.append("no review manifest: annotation is unreviewed")
    else:
        if manifest.review_status == "REJECTED":
            result.review_errors.append("manifest records review_status=REJECTED")
        elif not manifest.is_approved:
            result.review_errors.append(f"manifest review_status={manifest.review_status}")
        else:
            if not manifest.reviewer:
                result.review_errors.append("manifest is APPROVED but names no reviewer")
            if not manifest.reviewed_at:
                result.review_errors.append("manifest is APPROVED but has no reviewed_at")
            if manifest.annotation_revision is None:
                result.review_errors.append(
                    "manifest is APPROVED but records no annotation_revision"
                )
            elif manifest.annotation_revision != revision:
                result.review_errors.append(
                    f"stale manifest: approved revision {manifest.annotation_revision[:16]}… "
                    f"but current annotation is {revision[:16]}…"
                )

    if len(reviewed) != len(tokens):
        result.review_errors.append(
            f"{len(tokens) - len(reviewed)} of {len(tokens)} tokens are unreviewed"
        )
    if draft.status != "REVIEWED":
        result.review_errors.append(f"draft status is {draft.status}, not REVIEWED")
    if tokens and len(reviewed) == len(tokens) and not entity_tokens:
        if not (manifest and manifest.empty_document_confirmed):
            result.review_errors.append(
                "every reviewed label is O; an empty-document annotation needs "
                "empty_document_confirmed=true in the manifest"
            )

    unreviewed_relations = [
        record.record_id
        for record in list(draft.employment) + list(draft.education)
        if record.status == "UNREVIEWED"
    ]
    if unreviewed_relations:
        result.review_errors.append(
            f"{len(unreviewed_relations)} relationship record(s) still UNREVIEWED: "
            f"{unreviewed_relations[:3]}"
        )

    # -- status ladder ------------------------------------------------------ #
    if result.source_errors:
        result.status = "SOURCE_CHANGED"
    elif result.structural_errors:
        result.status = "REJECTED"
    elif result.relationship_errors:
        result.status = "RELATIONSHIP_INVALID"
    elif manifest is not None and manifest.review_status == "REJECTED":
        result.status = "REJECTED"
    elif result.review_errors:
        result.status = "REVIEW_PENDING"
    else:
        result.status = "APPROVED"
    return result


# --------------------------------------------------------------------------- #
# Promotion
# --------------------------------------------------------------------------- #
def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON through a temporary file in the same directory, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def promote_draft(
    draft: AnnotationDraft,
    result: ValidationResult,
    target_dir: Path,
    manifest: ReviewManifest,
    replace: bool = False,
) -> ValidationResult:
    """Promote an APPROVED annotation into the training directory.

    Refuses anything the gate did not approve, never silently overwrites an
    existing annotation (``replace=True`` archives the old one first), and is a
    no-op when the identical content is already there.
    """
    if result.status != "APPROVED":
        LOGGER.warning("%s: refusing to promote with status %s", draft.doc_id, result.status)
        return result

    payload = promote(draft)  # existing gate: raises unless fully reviewed
    payload["provenance"] = {
        "source_sha256": draft.source_sha256,
        "extraction_revision": draft.extraction_revision,
        "annotation_revision": result.annotation_revision,
        "reviewer": manifest.reviewer,
        "reviewed_at": manifest.reviewed_at,
        "promoted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "empty_document_confirmed": manifest.empty_document_confirmed,
    }

    target = Path(target_dir) / f"{draft.doc_id}.json"
    if target.is_file():
        existing = json.loads(target.read_text(encoding="utf-8"))
        existing_revision = (existing.get("provenance") or {}).get("annotation_revision")
        if existing_revision == result.annotation_revision:
            result.status = "PROMOTED"
            result.promoted_path = str(target)
            result.warnings.append("already promoted at this revision; nothing rewritten")
            return result
        if not replace:
            result.status = "REJECTED"
            result.review_errors.append(
                f"{target.name} already holds revision {str(existing_revision)[:16]}…; "
                "pass --replace to archive it and promote the new revision"
            )
            return result
        archive = target.with_name(
            f"{draft.doc_id}.{str(existing_revision or 'unknown')[:12]}.superseded.json"
        )
        os.replace(target, archive)
        result.warnings.append(f"archived previous annotation to {archive.name}")

    _atomic_write_json(target, payload)
    result.status = "PROMOTED"
    result.promoted_path = str(target)
    return result


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _print_result(result: ValidationResult, verbose: bool = False) -> None:
    print(f"{result.doc_id}: {result.status}")
    print(f"  annotation_revision : {result.annotation_revision}")
    print(
        f"  tokens              : {result.token_count} "
        f"({result.reviewed_token_count} reviewed, {result.entity_token_count} entity)"
    )
    print(
        f"  relationships       : {result.employment_records} employment, "
        f"{result.education_records} education"
    )
    print(f"  reviewer            : {result.reviewer or '-'}")
    for name, errors in (
        ("source", result.source_errors),
        ("structural", result.structural_errors),
        ("relationship", result.relationship_errors),
        ("review", result.review_errors),
    ):
        if errors:
            print(f"  {name} errors ({len(errors)}):")
            for error in errors[: None if verbose else 8]:
                print(f"    - {error}")
    for warning in result.warnings:
        print(f"  warning: {warning}")
    if result.promoted_path:
        print(f"  promoted to         : {result.promoted_path}")


def run(args: argparse.Namespace) -> int:
    draft_path = Path(args.draft)
    if not draft_path.is_file():
        print(f"ERROR: draft not found: {draft_path}", file=sys.stderr)
        return 1
    draft = load_draft(draft_path)

    manifest_path = Path(args.manifest) if args.manifest else manifest_path_for(draft_path)
    if args.init_manifest:
        if manifest_path.is_file() and not args.force:
            print(f"ERROR: {manifest_path} exists; pass --force to overwrite", file=sys.stderr)
            return 1
        manifest = init_manifest(draft, manifest_path)
        print(f"wrote {manifest_path} (review_status={manifest.review_status})")
        print(f"annotation_revision: {annotation_revision(draft)}")
        return 0

    tsv_path = Path(args.tsv) if args.tsv else draft_path.with_suffix("").with_suffix("")
    if not args.tsv:
        candidate = draft_path.with_name(f"{draft.doc_id}.review.tsv")
        tsv_path = candidate if candidate.is_file() else None  # type: ignore[assignment]

    manifest = load_manifest(manifest_path) if manifest_path.is_file() else None
    result = validate_annotation(
        draft,
        tsv_path=tsv_path,
        manifest=manifest,
        pdf_path=Path(args.pdf) if args.pdf else None,
        check_source_file=not args.skip_source_check,
    )

    if args.promote:
        if manifest is None:
            result.review_errors.append("cannot promote without a review manifest")
        else:
            result = promote_draft(
                draft, result, Path(args.to), manifest, replace=args.replace
            )

    _print_result(result, verbose=args.verbose)
    if args.json_out:
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(result.as_dict(), indent=2), encoding="utf-8")
        print(f"wrote {args.json_out}")
    return EXIT_CODES.get(result.status, 1)


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.validate_annotations",
        description="Validate a reviewed annotation and gate its promotion.",
    )
    cli.add_argument("--draft", required=True, help="Annotation draft JSON")
    cli.add_argument("--tsv", default=None, help="Review TSV (defaults to <doc>.review.tsv)")
    cli.add_argument("--manifest", default=None, help="Review manifest (defaults to <draft>.manifest.json)")
    cli.add_argument("--pdf", default=None, help="Source PDF, if moved since the draft was built")
    cli.add_argument("--init-manifest", action="store_true", help="Write an UNREVIEWED manifest")
    cli.add_argument("--force", action="store_true", help="Overwrite an existing manifest")
    cli.add_argument("--promote", action="store_true", help="Promote when APPROVED")
    cli.add_argument("--to", default="data/annotations", help="Training annotation directory")
    cli.add_argument("--replace", action="store_true", help="Archive and replace an existing annotation")
    cli.add_argument("--skip-source-check", action="store_true", help="Do not re-hash the PDF")
    cli.add_argument("--json-out", default=None, help="Write the structured result here")
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())

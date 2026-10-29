"""Candidate facts for a local intake draft, taken from the existing deterministic parser.

This module parses nothing. `parse_markdown` already reads every category below, with an
exact quote and UTF-16 offsets for each value, its own confidence, and a refusal instead of a
guess where the document is unclear:

  employment     entries spread over one to three lines, either order of employer and title,
                 dates only at the precision printed (`tests/test_markdown_layouts.py`)
  skills         comma lists, one-per-line items, bold "chips", and category labels, with
                 employer and title names excluded and a glued label flagged, not split blind
  education      degree with institution and graduation where stated, each separately quoted
  certifications name only, with a trailing date or issuer stripped off the name
  projects       name, description, technology stack and link where the layout provides them

What this file adds is only the join: it hands the intake text to that parser, attributes each
record to the page it was printed on, and reports the parser's own refusals beside the records
so an entry that was considered and rejected is visible rather than missing.

Offsets stay UTF-16 code units into the intake text, which is what the parser produces and
what the TypeScript boundary expects. Nothing here is approved: every record is a proposal.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field

from .parse_markdown import PARSER_REVISION, parse_markdown
from .resume_schema import (
    Certification,
    Education,
    Employment,
    Evidence,
    PartialDate,
    Project,
    Skill,
)

#: Parser warning codes that concern a fact it would not import, or a document-level finding a
#: reviewer must see. Identity warnings (no name, no e-mail) are left out: this pipeline does
#: not store direct identifiers, so their absence is not a defect to report.
REVIEW_WARNING_CODES = (
    "EMPLOYMENT_DATE_INVALID",
    "EMPLOYMENT_ROLE_MISSING",
    "EMPLOYMENT_ROLE_AMBIGUOUS",
    "EMPLOYMENT_INVALID",
    "EDUCATION_INVALID",
    "EDUCATION_PAIRING_AMBIGUOUS",
    "SKILL_LABEL_GLUED",
    "PLACEHOLDER_SKIPPED",
    "SENSITIVE_TERM_NOT_IMPORTED",
    "INSTRUCTION_LIKE_TEXT",
)

PageSpans = list[tuple[int, int | None, int | None]]


@dataclass(frozen=True)
class DatePart:
    """A date exactly as precise as the document was. A year-only date carries no month."""

    precision: str  # year | month | present
    value: str | None


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    quote: str


def _span(evidence: Evidence) -> Span:
    return Span(start=evidence.start, end=evidence.end, quote=evidence.quote)


def _date(part: PartialDate | None) -> DatePart | None:
    return None if part is None else DatePart(precision=part.precision, value=part.value)


def _page_of(offset: int | None, pages: PageSpans) -> int | None:
    if offset is None:
        return None
    for index, start, end in pages:
        if start is not None and end is not None and start <= offset < end:
            return index
    return None


@dataclass(frozen=True)
class EmploymentCandidate:
    employer: str
    title: str
    start: DatePart
    end: DatePart
    evidence: Span
    employer_evidence: Span
    title_evidence: Span
    confidence: str
    ambiguity: list[str]
    page: int | None

    def to_json(self) -> dict:
        return {
            "employer": self.employer,
            "title": self.title,
            "start": asdict(self.start),
            "end": asdict(self.end),
            "evidence": asdict(self.evidence),
            "employerEvidence": asdict(self.employer_evidence),
            "titleEvidence": asdict(self.title_evidence),
            "confidence": self.confidence,
            "ambiguity": list(self.ambiguity),
            "page": self.page,
        }


@dataclass(frozen=True)
class SkillCandidate:
    value: str
    #: The parser's normalized spelling where it knows one; never a substitute for the source text.
    canonical: str | None
    #: The group label the document printed above or beside the item, when there was one.
    category: str | None
    evidence: Span
    confidence: str
    ambiguity: list[str]
    page: int | None

    def to_json(self) -> dict:
        return {
            "value": self.value,
            "canonical": self.canonical,
            "category": self.category,
            "evidence": asdict(self.evidence),
            "confidence": self.confidence,
            "ambiguity": list(self.ambiguity),
            "page": self.page,
        }


@dataclass(frozen=True)
class EducationCandidate:
    degree: str
    institution: str | None
    graduation: DatePart | None
    evidence: Span
    institution_evidence: Span | None
    confidence: str
    ambiguity: list[str]
    page: int | None

    def to_json(self) -> dict:
        return {
            "degree": self.degree,
            "institution": self.institution,
            "graduation": None if self.graduation is None else asdict(self.graduation),
            "evidence": asdict(self.evidence),
            "institutionEvidence": None if self.institution_evidence is None else asdict(self.institution_evidence),
            "confidence": self.confidence,
            "ambiguity": list(self.ambiguity),
            "page": self.page,
        }


@dataclass(frozen=True)
class CertificationCandidate:
    name: str
    evidence: Span
    confidence: str
    ambiguity: list[str]
    page: int | None

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "evidence": asdict(self.evidence),
            "confidence": self.confidence,
            "ambiguity": list(self.ambiguity),
            "page": self.page,
        }


@dataclass(frozen=True)
class ProjectCandidate:
    name: str
    description: str | None
    technologies: list[str]
    url: str | None
    start: DatePart | None
    end: DatePart | None
    evidence: Span
    confidence: str
    ambiguity: list[str]
    page: int | None

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "technologies": list(self.technologies),
            "url": self.url,
            "start": None if self.start is None else asdict(self.start),
            "end": None if self.end is None else asdict(self.end),
            "evidence": asdict(self.evidence),
            "confidence": self.confidence,
            "ambiguity": list(self.ambiguity),
            "page": self.page,
        }


@dataclass(frozen=True)
class RefusedEntry:
    """Something the parser would not import, kept so the reviewer sees it was considered."""

    code: str
    message: str
    start: int | None
    end: int | None
    page: int | None

    def to_json(self) -> dict:
        return {"code": self.code, "message": self.message, "start": self.start, "end": self.end, "page": self.page}


@dataclass
class ResumeReading:
    parser_revision: str
    employment: list[EmploymentCandidate] = field(default_factory=list)
    skills: list[SkillCandidate] = field(default_factory=list)
    education: list[EducationCandidate] = field(default_factory=list)
    certifications: list[CertificationCandidate] = field(default_factory=list)
    projects: list[ProjectCandidate] = field(default_factory=list)
    refused: list[RefusedEntry] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "parserRevision": self.parser_revision,
            "employment": [c.to_json() for c in self.employment],
            "skills": [c.to_json() for c in self.skills],
            "education": [c.to_json() for c in self.education],
            "certifications": [c.to_json() for c in self.certifications],
            "projects": [c.to_json() for c in self.projects],
            "refused": [r.to_json() for r in self.refused],
        }

    @property
    def counts(self) -> dict[str, int]:
        return {
            "employment": len(self.employment),
            "skills": len(self.skills),
            "education": len(self.education),
            "certifications": len(self.certifications),
            "projects": len(self.projects),
            "refused": len(self.refused),
        }


def read_resume(text: str, *, pages: PageSpans | None = None) -> ResumeReading:
    """Every category the parser proposes for `text`, with page attribution and its refusals.

    `pages` is `(index, start, end)` per page in UTF-16 units, as the intake draft records
    them. Without it every record is page-less rather than guessed onto page 1.
    """
    page_spans = pages or []
    reading = ResumeReading(parser_revision=PARSER_REVISION)
    if not text.strip():
        return reading

    extraction = parse_markdown(text, source_hash=hashlib.sha256(text.encode("utf-8")).hexdigest())
    person = extraction.candidate

    for record in person.experience:
        reading.employment.append(_employment(record, page_spans))
    for record in person.skills:
        reading.skills.append(_skill(record, page_spans))
    for record in person.education:
        reading.education.append(_education(record, page_spans))
    for record in person.certifications:
        reading.certifications.append(_certification(record, page_spans))
    for record in person.projects:
        reading.projects.append(_project(record, page_spans))

    for warning in extraction.warnings:
        if warning.code in REVIEW_WARNING_CODES:
            reading.refused.append(
                RefusedEntry(
                    code=warning.code,
                    message=warning.message,
                    start=warning.start,
                    end=warning.end,
                    page=_page_of(warning.start, page_spans),
                )
            )
    return reading


def _employment(record: Employment, pages: PageSpans) -> EmploymentCandidate:
    return EmploymentCandidate(
        employer=record.employer,
        title=record.title,
        start=_date(record.start),
        end=_date(record.end),
        evidence=_span(record.evidence),
        employer_evidence=_span(record.employerEvidence),
        title_evidence=_span(record.titleEvidence),
        confidence=record.confidence,
        ambiguity=list(record.ambiguity),
        page=_page_of(record.evidence.start, pages),
    )


def _skill(record: Skill, pages: PageSpans) -> SkillCandidate:
    return SkillCandidate(
        value=record.value,
        canonical=record.canonical,
        category=record.category,
        evidence=_span(record.evidence),
        confidence=record.confidence,
        ambiguity=list(record.ambiguity),
        page=_page_of(record.evidence.start, pages),
    )


def _education(record: Education, pages: PageSpans) -> EducationCandidate:
    return EducationCandidate(
        degree=record.degree,
        institution=record.institution,
        graduation=_date(record.graduation),
        evidence=_span(record.evidence),
        institution_evidence=None if record.institutionEvidence is None else _span(record.institutionEvidence),
        confidence=record.confidence,
        ambiguity=list(record.ambiguity),
        page=_page_of(record.evidence.start, pages),
    )


def _certification(record: Certification, pages: PageSpans) -> CertificationCandidate:
    return CertificationCandidate(
        name=record.name,
        evidence=_span(record.evidence),
        confidence=record.confidence,
        ambiguity=list(record.ambiguity),
        page=_page_of(record.evidence.start, pages),
    )


def _project(record: Project, pages: PageSpans) -> ProjectCandidate:
    return ProjectCandidate(
        name=record.name,
        description=record.description,
        technologies=list(record.technologies),
        url=record.url,
        start=_date(record.start),
        end=_date(record.end),
        evidence=_span(record.evidence),
        confidence=record.confidence,
        ambiguity=list(record.ambiguity),
        page=_page_of(record.evidence.start, pages),
    )

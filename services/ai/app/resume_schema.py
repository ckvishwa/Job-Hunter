"""resume-extraction.v1: strict Pydantic v2 candidate model for the Marker -> deterministic parser pipeline.

Nothing here approves a fact: every record is PENDING_REVIEW, carries evidence (a quote plus UTF-16 offsets into the
exact Markdown stored with the result) and an explicit confidence. `to_legacy_facts` adapts the records to the existing
`ProposedFact` wire contract; year-only employment cannot be represented there (YYYY-MM only), so it is surfaced as a warning.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import FORBIDDEN_KINDS, FactAttributes, ProposedFact, Span, Warning_
from .offsets import Utf16Map

SCHEMA_VERSION = "resume-extraction.v1"
Confidence = Literal["high", "medium", "low"]
FactKind = Literal["legal_name", "email", "phone", "skill", "employment", "education", "certification", "project"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Evidence(Strict):
    start: int = Field(ge=0)  # UTF-16 code units into the stored Markdown
    end: int = Field(gt=0)
    quote: str = Field(min_length=1)


class PartialDate(Strict):
    """Date with explicit precision. A year-only date never carries a month."""
    precision: Literal["year", "month", "present"]
    value: str | None = None  # "2023" | "2024-08" | None when present

    @model_validator(mode="after")
    def _shape(self) -> "PartialDate":
        if self.precision == "year" and not (self.value and re.fullmatch(r"(19|20)\d{2}", self.value)):
            raise ValueError("year precision needs YYYY")
        if self.precision == "month" and not (self.value and re.fullmatch(r"(19|20)\d{2}-(0[1-9]|1[0-2])", self.value)):
            raise ValueError("month precision needs YYYY-MM")
        if self.precision == "present" and self.value is not None:
            raise ValueError("present carries no value")
        return self


class Record(Strict):
    evidence: Evidence
    confidence: Confidence = "high"
    ambiguity: list[str] = Field(default_factory=list)
    approvalStatus: Literal["PENDING_REVIEW"] = "PENDING_REVIEW"


class Scalar(Record):
    value: str = Field(min_length=1, max_length=300)


class Skill(Record):
    value: str = Field(min_length=1, max_length=80)  # original source text
    canonical: str | None = None
    category: str | None = None  # the skills-group label from the source, when present


class Employment(Record):
    employer: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    start: PartialDate
    end: PartialDate
    employerEvidence: Evidence
    titleEvidence: Evidence

    @model_validator(mode="after")
    def _order(self) -> "Employment":
        if self.end.precision != "present" and self.end.value is not None and self.start.value is not None and self.end.value[:4] < self.start.value[:4]:
            raise ValueError("employment ends before it starts")
        return self


class Education(Record):
    degree: str = Field(min_length=1, max_length=200)
    institution: str | None = Field(default=None, max_length=200)
    graduation: PartialDate | None = None
    institutionEvidence: Evidence | None = None


class Certification(Record):
    name: str = Field(min_length=1, max_length=200)


class Project(Record):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=600)
    start: PartialDate | None = None
    end: PartialDate | None = None
    url: str | None = None
    technologies: list[str] = Field(default_factory=list)


class Candidate(Strict):
    name: Scalar | None = None
    email: Scalar | None = None
    phone: Scalar | None = None
    skills: list[Skill] = Field(default_factory=list)
    experience: list[Employment] = Field(default_factory=list)
    education: list[Education] = Field(default_factory=list)
    certifications: list[Certification] = Field(default_factory=list)
    projects: list[Project] = Field(default_factory=list)


class FactOut(Strict):
    factId: str
    kind: FactKind
    value: str = Field(min_length=1, max_length=300)
    evidence: Evidence
    confidence: Confidence
    approvalStatus: Literal["PENDING_REVIEW"] = "PENDING_REVIEW"


class ExtractionWarning(Strict):
    code: str
    message: str
    start: int | None = None
    end: int | None = None


class ResumeExtraction(Strict):
    schemaVersion: Literal["resume-extraction.v1"] = SCHEMA_VERSION
    parserRevision: str
    sourceHash: str  # SHA-256 of the source PDF bytes
    textSha256: str  # SHA-256 of `text`
    text: str  # the exact Markdown every evidence offset refers to
    validationStatus: Literal["PENDING_REVIEW"] = "PENDING_REVIEW"
    candidate: Candidate
    facts: list[FactOut]
    warnings: list[ExtractionWarning]
    metrics: dict[str, int | float | str]

    @model_validator(mode="after")
    def _evidence_matches_text(self) -> "ResumeExtraction":
        umap = Utf16Map(self.text)
        bad = [f.factId for f in self.facts if not evidence_valid(f.evidence, self.text, umap)]
        if bad:
            raise ValueError(f"evidence does not match stored text for facts: {bad[:5]}")
        return self


def evidence_valid(ev: Evidence, text: str, umap: Utf16Map | None = None) -> bool:
    umap = umap or Utf16Map(text)
    try:
        a, b = umap.from_u16(ev.start), umap.from_u16(ev.end)
    except Exception:
        return False
    return 0 <= a < b <= len(text) and text[a:b] == ev.quote


def all_evidence(c: Candidate) -> list[tuple[str, Evidence]]:
    out: list[tuple[str, Evidence]] = []
    for label in ("name", "email", "phone"):
        v = getattr(c, label)
        if v:
            out.append((label, v.evidence))
    for s in c.skills:
        out.append(("skill", s.evidence))
    for e in c.experience:
        out += [("employment", e.evidence), ("employer", e.employerEvidence), ("title", e.titleEvidence)]
    for e in c.education:
        out.append(("education", e.evidence))
        if e.institutionEvidence:
            out.append(("institution", e.institutionEvidence))
    out += [("certification", x.evidence) for x in c.certifications]
    out += [("project", p.evidence) for p in c.projects]
    return out


def to_legacy_facts(extraction: ResumeExtraction) -> tuple[list[ProposedFact], list[Warning_]]:
    """Adapter to the existing wire contract. Month-precision employment only; year-only is reported, never guessed."""
    facts: list[ProposedFact] = []
    warnings: list[Warning_] = []
    c = extraction.candidate

    def span(ev: Evidence) -> Span:
        return Span(start=ev.start, end=ev.end, quote=ev.quote)

    for kind, rec in (("legal_name", c.name), ("email", c.email), ("phone", c.phone)):
        if rec:
            facts.append(ProposedFact(kind=kind, value=rec.value, span=span(rec.evidence), proposedBy="rules"))  # type: ignore[arg-type]
    facts += [ProposedFact(kind="skill", value=s.value, span=span(s.evidence), proposedBy="rules") for s in c.skills]
    for e in c.experience:
        if e.start.precision != "month" or e.end.precision == "year":
            warnings.append(Warning_(code="EMPLOYMENT_DATE_PRECISION", message="Year-precision employment cannot be represented in the legacy wire contract; not exported.", start=e.evidence.start, end=e.evidence.end))
            continue
        attrs = FactAttributes(employer=e.employer, title=e.title, startDate=e.start.value, endDate=e.end.value, current=True if e.end.precision == "present" else None)
        facts.append(ProposedFact(kind="employment", value=f"{e.employer} — {e.title}", attributes=attrs, span=span(e.evidence), proposedBy="rules"))
    for e in c.education:
        facts.append(ProposedFact(kind="education", value=e.degree if not e.institution else f"{e.degree} — {e.institution}", span=span(e.evidence), proposedBy="rules"))
    facts += [ProposedFact(kind="certification", value=x.name, span=span(x.evidence), proposedBy="rules") for x in c.certifications]
    for p in c.projects:
        facts.append(ProposedFact(kind="project", value=p.name, attributes=FactAttributes(technologies=p.technologies or None), span=span(p.evidence), proposedBy="rules"))
    assert not any(f.kind in FORBIDDEN_KINDS for f in facts)
    return facts, warnings

"""Versioned wire contract for POST /internal/v1/ai/extract-resume. TypeScript re-validates every field (zod) and
re-checks every span against the returned text; nothing here grants approval."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_REVISION = 1

# The proposer may never emit these kinds. The TypeScript side refuses them as well (defense in depth).
FORBIDDEN_KINDS = {"citizenship", "clearance", "work_authorization", "sponsorship_need"}
ProposedKind = Literal["skill", "employment", "project", "education", "certification", "legal_name", "email", "phone"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Span(Strict):
    start: int = Field(ge=0)  # UTF-16 code units into `text`
    end: int = Field(gt=0)
    quote: str


class FactAttributes(Strict):
    employer: str | None = None
    title: str | None = None
    startDate: str | None = None  # YYYY-MM, never invented
    endDate: str | None = None  # YYYY-MM; null/absent + current=True means "present"
    current: bool | None = None
    employmentType: Literal["internship"] | None = None  # only on an explicit keyword; professional/academic is a reviewer choice
    technologies: list[str] | None = None


class ProposedFact(Strict):
    kind: ProposedKind
    value: str = Field(min_length=1, max_length=300)
    attributes: FactAttributes = Field(default_factory=FactAttributes)
    span: Span
    proposedBy: Literal["rules", "qwen"]
    notes: str | None = Field(default=None, max_length=300)


class Warning_(Strict):
    code: str
    message: str
    start: int | None = None
    end: int | None = None


class ExtractStats(Strict):
    pageCount: int
    characterCount: int
    deterministicFacts: int
    qwenFacts: int
    qwenDropped: int
    qwenStatus: Literal["NOT_REQUIRED", "DISABLED", "USED", "UNAVAILABLE"]


class ExtractResponse(Strict):
    schemaRevision: Literal[1] = 1
    parserRevision: str
    fileType: Literal["pdf", "docx"]
    text: str
    textSha256: str
    warnings: list[Warning_]
    facts: list[ProposedFact]
    stats: ExtractStats


class ErrorBody(Strict):
    code: str
    message: str


class ErrorResponse(Strict):
    error: ErrorBody

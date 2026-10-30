"""Replaceable ML resume interpreter (EXPERIMENT ONLY; not wired into any production path).

Marker Markdown -> local Ollama model (structured JSON) -> Pydantic validation -> evidence validation against the exact input text.
The model only PROPOSES; nothing here approves a fact. Every record needs a quote that is located in the exact text sent to the model
(Markdown emphasis and link syntax are ignored for matching, offsets still map back to the stored Markdown). Anything unlocated is
dropped from the validated output and listed as unsupported; ambiguous records come back as REVIEW_REQUIRED, never as facts.

Local only: the endpoint must be loopback. No paid or external API is ever called.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import urllib.request
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .offsets import Utf16Map
from .parse_markdown import clean_line

INTERPRETER_REVISION = "ml-interpreter-exp01"
Status = Literal["OK", "REVIEW_REQUIRED"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Quoted(Strict):
    value: str
    quote: str


class MLEmployment(Strict):
    employer: str
    title: str
    start: str | None = None
    end: str | None = None
    current: bool = False
    quote: str
    technologies: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    status: Status = "OK"
    reason: str | None = None


class MLEducation(Strict):
    institution: str | None = None
    degree: str
    field_of_study: str | None = None
    graduation: str | None = None
    gpa: str | None = None
    quote: str
    status: Status = "OK"
    reason: str | None = None


class MLSkill(Strict):
    name: str
    category: str | None = None


class MLCertification(Strict):
    name: str
    issuer: str | None = None
    date: str | None = None
    quote: str


class MLProject(Strict):
    name: str
    start: str | None = None
    end: str | None = None
    technologies: list[str] = Field(default_factory=list)
    description: str | None = None
    quote: str


class MLResume(Strict):
    name: Quoted | None = None
    email: Quoted | None = None
    phone: Quoted | None = None
    location: Quoted | None = None
    employment: list[MLEmployment] = Field(default_factory=list)
    education: list[MLEducation] = Field(default_factory=list)
    skills: list[MLSkill] = Field(default_factory=list)
    certifications: list[MLCertification] = Field(default_factory=list)
    projects: list[MLProject] = Field(default_factory=list)


PROMPT_V1 = """You extract structured facts from one resume that was converted to Markdown. Return ONLY JSON matching the schema.
Rules:
- Copy values and quotes EXACTLY from the text. Never invent, correct, translate or complete anything. If something is not present, use null or an empty list.
- Every record needs "quote": the exact source text (one or more consecutive lines, Markdown markers may be left out) that supports it.
- employment: only paid or internship jobs, one record per job, with its own employer, title, start and end exactly as written (years or months). Never put project dates, education dates or section headings into employment. A job's employer and title are different things; if you cannot tell which text is the employer and which is the title, set status to REVIEW_REQUIRED and explain in reason.
- Set current=true only when the end date says Present/Current. technologies: tools named in that job's own bullets. responsibilities: at most 3 short bullets copied verbatim from that job.
- education: one record per degree with its own institution; field_of_study only if written; gpa only if written.
- skills: individual skill or tool names, one per entry. A group label such as "Languages" or "Cloud" is a category, never a skill. Names of employers, job titles, dates, places and URLs are never skills. Split lists at commas and bullets.
- certifications: certificates or licenses only. projects: named personal/academic projects, with their own dates; never job positions.
- email and phone only if the text contains them. Do not output sensitive attributes (citizenship, visa, clearance).
Generic example of the relationship you must capture: lines "Staff Engineer", "Acme Corp", "2020 - 2022" are ONE employment record with title "Staff Engineer", employer "Acme Corp", start "2020", end "2022"."""


# v2 adds generic clarifications for the failure classes seen in v1 (category labels taken as skills, missing institution, missing contacts and
# certifications). It contains no text from any evaluated document.
PROMPT_V2 = PROMPT_V1 + """
Clarifications:
- skills: the skills are the individual ITEMS listed after a category label. In "Languages: Python, Java" the skills are Python and Java and "Languages" is only the category. A skill list line may hold several labels; never output a label as a skill.
- name: the person's name is normally the first heading. email and phone normally sit next to it; an address may appear inside a Markdown link such as [x@y.z](mailto:x@y.z), copy the address itself.
- certifications: every entry listed under a certifications, licenses or training heading, one record per entry; entries are often separated by bullets.
- education: fill institution with the school name that belongs to the degree (it may be on an adjacent line); if two degrees and two schools cannot be matched with certainty, set status to REVIEW_REQUIRED."""
SYSTEM_PROMPT = PROMPT_V1
PROMPTS = {"v1": PROMPT_V1, "v2": PROMPT_V2}


def strict_schema() -> dict:
    """The Pydantic JSON schema with EVERY property required (nullable stay nullable). With optional keys a small model may skip whole
    sections; requiring them forces an explicit value or empty list per key."""
    schema = MLResume.model_json_schema()

    def fix(node):
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["required"] = list(node["properties"].keys())
            for v in node.values():
                fix(v)
        elif isinstance(node, list):
            for v in node:
                fix(v)

    fix(schema)
    return schema


def _loopback(url: str) -> None:
    host = urlparse(url).hostname or ""
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(f"model endpoint must be loopback, got {host!r}; resume text is never sent off-machine")


@dataclass
class ModelCall:
    raw: str
    seconds: float
    prompt_tokens: int | None
    output_tokens: int | None
    error: str | None = None
    done_reason: str | None = None


@dataclass
class OllamaInterpreter:
    model: str = "qwen2.5:3b-instruct-q4_K_M"
    endpoint: str = "http://127.0.0.1:11434"
    timeout_s: int = 300
    num_ctx: int = 8192
    num_predict: int = 4096
    seed: int = 0
    temperature: float = 0.0
    keep_alive: str = "10m"
    prompt_version: str = "v1"
    schema_mode: str = "optional"  # optional | required

    def config(self) -> dict:
        return {"model": self.model, "endpoint": self.endpoint, "temperature": self.temperature, "seed": self.seed, "num_ctx": self.num_ctx,
                "num_predict": self.num_predict, "timeoutSeconds": self.timeout_s, "structuredOutput": "ollama format=<Pydantic JSON schema>",
                "promptVersion": self.prompt_version, "schemaMode": self.schema_mode, "promptSha256": hashlib.sha256(PROMPTS[self.prompt_version].encode()).hexdigest()}

    def call(self, markdown: str) -> ModelCall:
        _loopback(self.endpoint)
        body = {"model": self.model, "stream": False, "format": strict_schema() if self.schema_mode == "required" else MLResume.model_json_schema(), "keep_alive": self.keep_alive,
                "options": {"temperature": self.temperature, "seed": self.seed, "num_ctx": self.num_ctx, "num_predict": self.num_predict},
                "messages": [{"role": "system", "content": PROMPTS[self.prompt_version]}, {"role": "user", "content": "RESUME MARKDOWN:\n\n" + markdown}]}
        req = urllib.request.Request(self.endpoint + "/api/chat", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310 - loopback enforced above
                data = json.loads(resp.read())
            return ModelCall(data.get("message", {}).get("content", ""), time.time() - t0, data.get("prompt_eval_count"), data.get("eval_count"), None, data.get("done_reason"))
        except Exception as error:  # noqa: BLE001 - recorded, never raised to the batch
            return ModelCall("", time.time() - t0, None, None, f"{type(error).__name__}: {error}")


# ---------------------------------------------------------------------------------------------------------------------
# Evidence: locate quotes in the exact model-input text (emphasis/link syntax ignored, whitespace collapsed)
# ---------------------------------------------------------------------------------------------------------------------

@dataclass
class EvidenceIndex:
    raw: str
    norm: str  # casefold-free, whitespace-collapsed clean text
    to_raw: list[int]  # norm index -> raw index
    umap: Utf16Map = field(init=False)

    def __post_init__(self) -> None:
        self.umap = Utf16Map(self.raw)

    @classmethod
    def build(cls, raw: str) -> "EvidenceIndex":
        chars: list[str] = []
        pos: list[int] = []
        start = 0
        for line in raw.split("\n"):
            c = clean_line(line, start)
            for ch, p in zip(c.text, c.pos):
                chars.append(ch)
                pos.append(start + p)
            chars.append("\n")
            pos.append(start + len(line))
            start += len(line) + 1
        out: list[str] = []
        idx: list[int] = []
        prev_space = True
        for ch, p in zip(chars, pos):
            if ch.isspace():
                if not prev_space:
                    out.append(" ")
                    idx.append(p)
                prev_space = True
            else:
                out.append(ch)
                idx.append(p)
                prev_space = False
        return cls(raw, "".join(out), idx)

    @staticmethod
    def _q(quote: str) -> str:
        q = re.sub(r"\\([$*_#\[\]()<>`])", r"\1", quote)
        q = re.sub(r"\*\*|__", "", q)
        return re.sub(r"\s+", " ", q).strip()

    def locate(self, quote: str, after: int = 0) -> tuple[int, int] | None:
        """UTF-16 (start, end) in the raw Markdown of the first occurrence at or after `after` (norm index), else None."""
        q = self._q(quote)
        if len(q) < 2:
            return None
        i = self.norm.find(q, after)
        if i < 0:
            i = self.norm.find(q)
        if i < 0:
            return None
        a, b = self.to_raw[i], self.to_raw[i + len(q) - 1] + 1
        return self.umap.to_u16(a), self.umap.to_u16(b)

    def cluster(self, values: list[str], window: int = 300) -> tuple[int, int] | None:
        """Smallest raw span that contains EVERY value within `window` characters (co-occurrence = association evidence), else None."""
        vals = [self._q(v) for v in values if v and self._q(v)]
        if not vals:
            return None
        occ: list[list[int]] = []
        for v in vals:
            hits, i = [], self.norm.find(v)
            while i >= 0 and len(hits) < 40:
                hits.append(i)
                i = self.norm.find(v, i + 1)
            if not hits:
                return None
            occ.append(hits)
        best: tuple[int, int] | None = None
        for a in occ[0]:
            lo, hi = a, a + len(vals[0])
            for k in range(1, len(vals)):
                near = min(occ[k], key=lambda h: abs(h - a))
                lo, hi = min(lo, near), max(hi, near + len(vals[k]))
            if hi - lo <= window and (best is None or hi - lo < best[1] - best[0]):
                best = (lo, hi)
        if best is None:
            return None
        return self.umap.to_u16(self.to_raw[best[0]]), self.umap.to_u16(self.to_raw[best[1] - 1] + 1)

    def quote_supports(self, quote: str, values: list[str]) -> bool:
        q = self._q(quote)
        return bool(q) and q in self.norm and all(self._q(v) in q for v in values if v and self._q(v))

    def contains(self, value: str) -> bool:
        v = self._q(value)
        return len(v) >= 1 and v in self.norm

    def raw_slice(self, span: tuple[int, int]) -> str:
        return self.raw[self.umap.from_u16(span[0]): self.umap.from_u16(span[1])]


@dataclass
class Interpretation:
    status: str  # OK | REVIEW | MODEL_ERROR | SCHEMA_INVALID
    resume: MLResume | None
    validated: dict  # evidence-validated records in the neutral scoring format
    unsupported: list[str]
    review_required: list[dict]
    evidence: list[dict]
    errors: list[str]
    call: ModelCall | None = None


def validate(markdown: str, call: ModelCall) -> Interpretation:
    """Pydantic validation, then evidence validation. Records without located evidence never reach `validated`."""
    empty = {"name": None, "email": None, "phone": None, "location": None, "experience": [], "education": [], "skills": [], "certifications": [], "projects": []}
    if call.error:
        return Interpretation("MODEL_ERROR", None, empty, [], [], [], [call.error], call)
    try:
        resume = MLResume.model_validate_json(call.raw)
    except (ValidationError, ValueError) as error:
        return Interpretation("SCHEMA_INVALID", None, empty, [], [], [], [f"{type(error).__name__}: {str(error)[:300]}"], call)
    ix = EvidenceIndex.build(markdown)
    unsupported: list[str] = []
    review: list[dict] = []
    evidence: list[dict] = []
    out = dict(empty)

    quote_stats = {"checked": 0, "supported": 0}

    def need(kind: str, label: str, quote: str, value_checks: list[str]) -> tuple[int, int] | None:
        """Evidence is DERIVED from the model's values: all of them must co-occur in one nearby span of the input. The model's own quote is
        only scored (does it contain the values?), because a correct fact with a misplaced quote is still supported by the source."""
        values = [v for v in value_checks if v]
        quote_stats["checked"] += 1
        if ix.quote_supports(quote, values):
            quote_stats["supported"] += 1
        span = ix.cluster(values) if len(values) > 1 else (ix.locate(values[0]) if values else None)
        if span is None:
            unsupported.append(f"{kind}: values not found together in the source for {label!r}: {values}")
            return None
        evidence.append({"kind": kind, "label": label, "start": span[0], "end": span[1], "quote": ix.raw_slice(span), "derived": True})
        return span

    for key, rec in (("name", resume.name), ("email", resume.email), ("phone", resume.phone), ("location", resume.location)):
        if rec and need(key, rec.value, rec.quote, [rec.value]):
            out[key] = rec.value
    for e in resume.employment:
        if e.status == "REVIEW_REQUIRED":
            review.append({"kind": "employment", "employer": e.employer, "title": e.title, "reason": e.reason})
            continue
        if need("employment", f"{e.employer} | {e.title}", e.quote, [e.employer, e.title, e.start or "", e.end if e.end and e.end.lower() not in ("present", "current") else ""]):
            out["experience"].append({"employer": e.employer, "title": e.title, "start": e.start, "end": "present" if e.current else e.end})
    for e in resume.education:
        if e.status == "REVIEW_REQUIRED":
            review.append({"kind": "education", "degree": e.degree, "institution": e.institution, "reason": e.reason})
            continue
        if need("education", f"{e.degree} @ {e.institution}", e.quote, [e.degree, e.institution or ""]):
            out["education"].append({"degree": e.degree, "institution": e.institution})
    cursor = 0
    sk = re.search(r"(?im)^#*\s*\**(technical\s+)?skills\b", ix.raw)
    if sk:
        cursor = next((i for i, p in enumerate(ix.to_raw) if p >= sk.start()), 0)
    seen: set[str] = set()
    for s in resume.skills:
        key = s.name.strip().casefold()
        if not key or key in seen:
            continue
        span = ix.locate(s.name, cursor)
        if span is None or not ix.contains(s.name):
            unsupported.append(f"skill: not in source: {s.name!r}")
            continue
        seen.add(key)
        evidence.append({"kind": "skill", "label": s.name, "start": span[0], "end": span[1], "quote": ix.raw_slice(span), "derived": True})
        out["skills"].append(s.name.strip())
    for c in resume.certifications:
        if need("certification", c.name, c.quote, [c.name]):
            out["certifications"].append(c.name)
    for p in resume.projects:
        if need("project", p.name, p.quote, [p.name]):
            out["projects"].append(p.name)
    status = "REVIEW" if review or unsupported else "OK"
    out["_modelQuoteSupport"] = quote_stats
    return Interpretation(status, resume, out, unsupported, review, evidence, [], call)

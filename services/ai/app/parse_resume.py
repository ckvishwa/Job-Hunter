"""Deterministic resume parser: normalized text -> source-backed fact proposals.

Rules, not a model. Every proposal quotes the exact text it came from. Nothing is inferred:
- no year counts, no proficiency, no professional/academic judgement (an employment category is tagged ONLY when the section heading itself says Internship; a job title is never used);
- citizenship, clearance, work authorization and sponsorship are NEVER proposed (mentions only produce a warning);
- year-only or unparseable employment dates are skipped with a warning rather than guessed.

Parsing runs on a line-break-repaired VIEW of the text (app/linebreaks.py). Values come from the view ("event correlation"); spans and
quotes always refer to the ORIGINAL text ("event corre-\nlation"), so every fact stays verifiable against the document.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .contracts import FactAttributes, ProposedFact, Span, Warning_
from .linebreaks import NormalizedText, normalize_line_breaks
from .offsets import Utf16Map

PARSER_REVISION = "resume-rules@3"

# ---------------------------------------------------------------------------------------------------------------------
# Lines and sections
# ---------------------------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Line:
    index: int
    start: int
    end: int
    text: str  # == source[start:end]

    @property
    def stripped(self) -> str:
        return self.text.strip()


def split_lines(text: str) -> list[Line]:
    lines: list[Line] = []
    pos = 0
    for i, raw in enumerate(text.split("\n")):
        lines.append(Line(i, pos, pos + len(raw), raw))
        pos += len(raw) + 1
    return lines


HEADINGS: dict[str, str] = {
    "skills": "skills", "technical skills": "skills", "core skills": "skills", "key skills": "skills",
    "technologies": "skills", "technical proficiencies": "skills", "core competencies": "skills", "skills and tools": "skills",
    "technical expertise": "skills", "technical and organizational expertise": "skills",
    "experience": "experience", "professional experience": "experience", "work experience": "experience",
    "employment": "experience", "employment history": "experience", "work history": "experience",
    "relevant experience": "experience", "career history": "experience",
    "experience continued": "experience", "professional experience continued": "experience",
    "internship": "internship", "internships": "internship", "internship experience": "internship",
    "education": "education", "academic background": "education", "education and training": "education",
    "education and certifications": "education_certifications",
    "certifications": "certifications", "certification": "certifications", "certificates": "certifications",
    "licenses and certifications": "certifications", "certifications and training": "certifications",
    "projects": "projects", "personal projects": "projects", "academic projects": "projects", "selected projects": "projects",
    "enterprise programs": "projects", "enterprise programs continued": "projects",
    "summary": "summary", "professional summary": "summary", "objective": "summary", "profile": "summary",
    "volunteer experience": "other", "volunteering": "other", "awards": "other", "references": "other", "publications": "other",
    "interests": "other", "languages": "other",
}


def heading_of(line: Line) -> str | None:
    s = line.stripped.rstrip(":").strip()
    if not s or len(s) > 40:
        return None
    key = re.sub(r"\s+", " ", s.lower().replace("&", "and"))
    if key in HEADINGS:
        return HEADINGS[key]
    if re.fullmatch(r"[A-Za-z][A-Za-z &/,\-]{2,39}", s) and len(s.split()) <= 5:
        if re.search(r"(?:^|\s)projects?$", key) and not key.startswith(("project manager", "project management")):
            return "projects"
        if key.endswith(" skills"):
            return "skills"
    if re.fullmatch(r"[A-Z][A-Z &/,\-]{2,39}", s):
        return "other"
    return None


BULLET = re.compile(r"^\s*[•●▪◦·\-\*–—]\s+")
PLACEHOLDER = re.compile(r"\[[^\]]+\]")


def is_bullet(text: str) -> bool:
    return bool(BULLET.match(text))


def strip_bullet(text: str) -> tuple[str, int]:
    m = BULLET.match(text)
    return (text[m.end():], m.end()) if m else (text, 0)


# ---------------------------------------------------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------------------------------------------------

_MONTH = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
_DATE_MY = rf"{_MONTH}\.?,?\s+\d{{4}}"
_DATE_NUM = r"(?:0?[1-9]|1[0-2])/\d{4}"
_START = rf"(?:{_DATE_MY}|{_DATE_NUM}|\d{{4}})"
_END = rf"(?:{_DATE_MY}|{_DATE_NUM}|\d{{4}}|Present|Current|Now|Ongoing)"
RANGE_RE = re.compile(rf"(?P<s>{_START})\s*(?:–|—|-|to|until)\s*(?P<e>{_END})", re.IGNORECASE)
_MONTHS = {m: f"{i:02d}" for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def parse_date(token: str) -> str | None | tuple[str]:
    """'YYYY-MM' | None (present) | ('YEAR_ONLY',) | ('INVALID',)"""
    t = token.strip().lower()
    if t in ("present", "current", "now", "ongoing"):
        return None
    m = re.fullmatch(r"([a-z]+)\.?,?\s+(\d{4})", t)
    if m and m.group(1)[:3] in _MONTHS:
        return f"{m.group(2)}-{_MONTHS[m.group(1)[:3]]}"
    m = re.fullmatch(r"(\d{1,2})/(\d{4})", t)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    if re.fullmatch(r"\d{4}", t):
        return ("YEAR_ONLY",)
    return ("INVALID",)


# ---------------------------------------------------------------------------------------------------------------------
# Splitting helpers
# ---------------------------------------------------------------------------------------------------------------------


def split_items(s: str, seps: str = ",;|•·") -> list[tuple[str, int, int]]:
    """Paren-aware split. Returns (stripped item, start, end) relative to s."""
    out: list[tuple[str, int, int]] = []
    depth = 0
    seg_start = 0
    for i, ch in enumerate(s + seps[0]):
        if i < len(s):
            if ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth = max(0, depth - 1)
        if (i == len(s) or (ch in seps and depth == 0)):
            seg = s[seg_start:i]
            lead = len(seg) - len(seg.lstrip())
            item = seg.strip()
            if item:
                out.append((item, seg_start + lead, seg_start + lead + len(item)))
            seg_start = i + 1
    return out


STATES = set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())
_LOC_TAIL = re.compile(r",\s*(?:[A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+)*,\s*)?(?P<st>[A-Z]{2}|Remote)\s*$")

TITLE_RE = re.compile(
    r"\b(engineer|analyst|developer|administrator|specialist|technician|associate|consultant|manager|lead|architect|tester|sdet|qa|"
    r"intern|internship|co-?op|assistant|coordinator|officer|director|scientist|programmer|support|investigator|auditor|trainee|"
    r"apprentice|researcher|operator|supervisor|representative)\b",
    re.IGNORECASE,
)
INTERN_RE = re.compile(r"\b(intern|internship|co-?op|apprentice|trainee)\b", re.IGNORECASE)


_TITLE_MODIFIER = re.compile(r"^(?:I{1,3}|IV|V|Jr\.?|Sr\.?|Senior|Junior|Lead|Principal|Staff|Associate|Intern)$", re.IGNORECASE)


def split_unseparated(s: str) -> tuple[str, str] | None:
    """'<title words> <Employer Name>' with no separator -> (title, employer), or None when it is not clear-cut.
    The title ends at the first title keyword plus any trailing level word (Intern, II, Senior...); the rest must be capitalised words that contain no title keyword."""
    tokens = s.split()
    if len(tokens) < 3 or len(tokens) > 14:
        return None
    first = next((i for i, t in enumerate(tokens) if TITLE_RE.fullmatch(t.strip(",.")) ), None)
    if first is None:
        return None
    end = first
    while end + 1 < len(tokens) and _TITLE_MODIFIER.fullmatch(tokens[end + 1].strip(",.")):
        end += 1  # only level/seniority words may extend the title; another title keyword is ambiguous and aborts the split below
    title, employer_tokens = tokens[: end + 1], tokens[end + 1:]
    if not employer_tokens or len(title) < 2:
        return None
    if any(TITLE_RE.search(t) for t in employer_tokens) or not all(t[:1].isupper() or t.lower() in {"of", "and", "&", "the"} for t in employer_tokens):
        return None
    if any(re.search(r"\d", t) for t in tokens):
        return None
    return " ".join(title), " ".join(employer_tokens)


def strip_location(s: str) -> str:
    m = _LOC_TAIL.search(s)
    if m and (m.group("st") == "Remote" or m.group("st") in STATES):
        return s[: m.start()].rstrip()
    return s


_PART_SEP = re.compile(r"\s*[|•·]\s*|\s+[—–-]\s+|\s*[—–]\s*|\s+at\s+|\t+")


def split_parts(s: str) -> list[str]:
    s = s.strip(" ,|—–-()\t")
    # Remove a whole location component, not just its state suffix.
    pieces = [p.strip() for p in s.split("|")]
    if len(pieces) > 1 and re.fullmatch(r"[A-Za-z .-]+,\s*(?:[A-Z]{2}|Remote)", pieces[-1]) and pieces[-1].split(",")[-1].strip() in STATES | {"Remote"}:
        s = "|".join(pieces[:-1]).strip()
    else:
        s = strip_location(s)
    parts = [p.strip(" ,()") for p in _PART_SEP.split(s) if p and p.strip(" ,()")]
    if len(parts) == 1 and parts[0].count(", ") == 1:
        parts = [p.strip() for p in parts[0].split(", ")]
    return parts


# ---------------------------------------------------------------------------------------------------------------------
# Sensitive-term and instruction-like scans (warnings only; never facts)
# ---------------------------------------------------------------------------------------------------------------------

SENSITIVE_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("citizenship", re.compile(r"\b(?:u\.?s\.?\s+citizen(?:ship)?|citizen(?:ship)?)\b", re.IGNORECASE)),
    ("clearance", re.compile(r"\b(?:security\s+clearance|clearance|ts/sci|top\s+secret|polygraph)\b", re.IGNORECASE)),
    ("work authorization", re.compile(r"\b(?:work\s+authori[sz]ation|authori[sz]ed\s+to\s+work|green\s*card|permanent\s+resident|h-?1b|stem\s+opt|opt|cpt|visa|ead)\b", re.IGNORECASE)),
    ("sponsorship", re.compile(r"\bsponsorship\b", re.IGNORECASE)),
]
INSTRUCTION_RE = re.compile(
    r"ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+(?:instructions|prompts)|"
    r"(?:mark|set|approve)\s+(?:all|every)\s+(?:facts?|skills?|items?)|system\s+prompt|you\s+are\s+now",
    re.IGNORECASE,
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?<![\d/])(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?![\d/])")
_NAME_WORD = r"[A-ZÀ-Þ](?:[^\W\d_]|[.'’\-])*"
NAME_RE = re.compile(rf"{_NAME_WORD}(?: {_NAME_WORD}){{1,3}}")

DEGREE_WORDS = re.compile(r"\b(?:bachelor|master|doctorate|doctor of|associate (?:of|degree)|diploma|ph\.?\s?d)\b", re.IGNORECASE)
DEGREE_ABBR = re.compile(r"\b(?:B\.?Tech\.?|M\.?Tech\.?|B\.E\.|M\.E\.|B\.S\.?|BS|B\.A\.?|BA|BSc|B\.Sc\.?|M\.S\.?|MS|MSc|M\.Sc\.?|M\.A\.?|MA|MBA|B\.Eng\.?|M\.Eng\.?|A\.A\.S\.?|AAS|A\.S\.)(?=[\s,.;:)]|$)")
LATEX_SPACING = re.compile(r"\s*\[\d+(?:\.\d+)?(?:pt|em|ex|mm|cm|in)\]\s*$")
TRAILING_DATE = re.compile(rf"\s+(?:{_DATE_MY}|{_DATE_NUM}|\d{{4}})$", re.IGNORECASE)
TECH_LABEL = re.compile(r"^\s*(?:technologies|tech stack|tools|stack|built with)\s*:\s*(?P<rest>.+)$", re.IGNORECASE)
SKILL_LABEL_BLOCK = re.compile(r"^(?P<label>[A-Za-z][A-Za-z /&+#.\-]{1,40}):\s*(?P<rest>.+)$", re.DOTALL)
SKILL_LABEL = re.compile(r"^(?P<label>[A-Za-z][A-Za-z /&+#.\-]{1,40}):\s*(?P<rest>.+)$")


@dataclass
class _Draft:
    kind: str
    value: str
    start: int
    end: int
    attributes: dict = field(default_factory=dict)
    notes: str | None = None
    field_spans: dict[str, tuple[int, int]] = field(default_factory=dict)


@dataclass
class ParseOutput:
    facts: list[ProposedFact]
    warnings: list[Warning_]


def _warn(warnings: list[Warning_], nt: NormalizedText, umap: Utf16Map, code: str, message: str, start: int | None = None, end: int | None = None) -> None:
    """`start`/`end` are offsets in the repaired view; the warning carries the matching ORIGINAL-text UTF-16 offsets."""
    if start is None or end is None or end <= start:
        warnings.append(Warning_(code=code, message=message))
        return
    a, b = nt.to_original(start, end)
    warnings.append(Warning_(code=code, message=message, start=umap.to_u16(a), end=umap.to_u16(b)))


def parse_resume(original: str) -> ParseOutput:
    nt = normalize_line_breaks(original)
    text = nt.text
    umap = Utf16Map(original)
    lines = split_lines(text)
    warnings: list[Warning_] = []
    drafts: list[_Draft] = []
    seen: set[tuple] = set()

    def add(kind: str, value: str, start: int, end: int, attributes: dict | None = None, notes: str | None = None, key: tuple | None = None) -> _Draft | None:
        k = key or (kind, value.lower())
        if k in seen:
            return None
        seen.add(k)
        d = _Draft(kind, value[:300], start, end, attributes or {}, notes)
        drafts.append(d)
        return d

    # --- section map ------------------------------------------------------------------------------------------------
    section_of: dict[int, str] = {}
    current = "header"
    first_heading_line: int | None = None
    after_page_header = False
    for ln in lines:
        h = heading_of(ln)
        if re.fullmatch(r"(?:.+?\s+)?PAGE\s+\d+\s+OF\s+\d+", ln.stripped, re.IGNORECASE) or (first_heading_line is not None and ln.index > first_heading_line and ln.stripped.casefold() == lines[0].stripped.casefold()):
            after_page_header = True
            section_of[ln.index] = "heading"
            continue
        if after_page_header and ln.stripped in {head.stripped for head in lines[1:4]}:
            section_of[ln.index] = "heading"
            continue
        after_page_header = False
        if current == "skills" and ln.stripped.rstrip(":").lower() in {"languages", "cloud & ci", "cloud and ci", "security", "testing", "platforms", "tools", "frameworks"}:
            section_of[ln.index] = "heading"
            continue
        if h is not None:
            current = h
            if first_heading_line is None:
                first_heading_line = ln.index
            section_of[ln.index] = "heading"
            continue
        section_of[ln.index] = current

    # --- contact (header region only) -------------------------------------------------------------------------------
    header_limit = first_heading_line if first_heading_line is not None else min(len(lines), 12)
    header_lines = [ln for ln in lines[: min(header_limit, 12)] if ln.stripped]
    if header_lines:
        first = header_lines[0]
        if NAME_RE.fullmatch(first.stripped) and not PLACEHOLDER.search(first.text) and heading_of(first) is None:
            lead = len(first.text) - len(first.text.lstrip())
            add("legal_name", first.stripped, first.start + lead, first.start + lead + len(first.stripped),
                notes="First line looks like a name (heuristic). Confirm spelling; given and family name are not split automatically.")
    for ln in header_lines:
        for m in EMAIL_RE.finditer(ln.text):
            add("email", m.group(0), ln.start + m.start(), ln.start + m.end(), notes="Contact detail from the resume header; confirm before use.")
        scrubbed = EMAIL_RE.sub(lambda m: " " * len(m.group(0)), ln.text)
        for m in PHONE_RE.finditer(scrubbed):
            add("phone", m.group(0), ln.start + m.start(), ln.start + m.end(), notes="Contact detail from the resume header; confirm before use.")

    # --- skills -----------------------------------------------------------------------------------------------------
    skill_consumed: set[int] = set()
    for ln in lines:
        if section_of[ln.index] != "skills" or not ln.stripped or ln.index in skill_consumed:
            continue
        # A lowercase line right after a full-width list line that ends without a separator continues that line's last item
        # ("... LLM agent" / "orchestration, prompt engineering"). The block is contiguous text, so its items keep exact spans.
        last = ln
        while True:
            nxt = lines[last.index + 1] if last.index + 1 < len(lines) else None
            acronym_wrap = bool(nxt and re.fullmatch(r"[A-Z][A-Za-z]+s", nxt.stripped) and re.search(r"\b[A-Z]{2,}$", last.stripped))
            if (nxt is None or section_of[nxt.index] != "skills" or not nxt.stripped or is_bullet(nxt.text)
                    or not (nxt.stripped[:1].islower() or acronym_wrap)
                    or (len(last.stripped) < 60 and not acronym_wrap) or last.stripped[-1] in ",;|:/" or not re.search(r"[,;|]|\s/\s", last.stripped)):
                break
            skill_consumed.add(nxt.index)
            last = nxt
        body, off = strip_bullet(text[ln.start:last.end])
        base = ln.start + off
        label = SKILL_LABEL_BLOCK.match(body)
        if label:
            base += label.start("rest")
            body = label.group("rest")
        # Only spaced slashes are separators; CI/CD and TCP/IP remain one technology.
        slash_body = re.sub(r"\s+/\s+", "|", body)
        items = split_items(slash_body) if len(slash_body) == len(body) else split_items(body)
        if len(slash_body) != len(body):
            boundaries = [m.span() for m in re.finditer(r"\s+/\s+", body)]
            items = []
            cursor = 0
            for a, b in boundaries + [(len(body), len(body))]:
                for item, s, e in split_items(body[cursor:a]):
                    items.append((item, cursor+s, cursor+e))
                cursor = b
        if not label and len(items) == 1 and (len(items[0][0].split()) > 4 or len(items[0][0]) > 40):
            continue
        for item, s, e in items:
            item_raw = item.rstrip("./ ").strip()  # trailing delimiters are not part of a technology name
            item_clean = re.sub(r"\s+", " ", item_raw)
            if not item_clean or len(item_clean) > 40 or len(item_clean.split()) > 5 or re.fullmatch(r"[\d\W]+", item_clean):
                continue
            if PLACEHOLDER.search(item_clean):
                _warn(warnings, nt, umap, "PLACEHOLDER_SKIPPED", "A skill contains an unfilled [placeholder]; not imported.", base + s, base + e)
                continue
            add("skill", item_clean, base + s, base + s + len(item_raw))

    # --- employment -------------------------------------------------------------------------------------------------
    used_as_prev: set[int] = set()
    exp_lines = [ln for ln in lines if section_of[ln.index] in ("experience", "internship")]
    for ln in exp_lines:
        if is_bullet(ln.text) or not ln.stripped:
            continue
        m = RANGE_RE.search(ln.text)
        if not m:
            continue
        in_internship_section = section_of[ln.index] == "internship"
        remainder = (ln.text[: m.start()] + " " + ln.text[m.end():]).strip(" ,|—–-()\t")
        parts = split_parts(remainder) if remainder else []
        start_pos, end_pos = ln.start, ln.end
        if not parts and ln.index >= 2:
            company_line, title_line = lines[ln.index-1], lines[ln.index-2]
            if (section_of[company_line.index] == section_of[ln.index] == section_of[title_line.index]
                    and not is_bullet(company_line.text) and not is_bullet(title_line.text)
                    and 1 <= len(company_line.stripped.split()) <= 6 and not TITLE_RE.search(company_line.stripped)
                    and TITLE_RE.search(title_line.stripped) and len(title_line.stripped) <= 80
                    and not RANGE_RE.search(company_line.text) and not RANGE_RE.search(title_line.text)):
                parts = [company_line.stripped, title_line.stripped]
                start_pos = title_line.start
                used_as_prev.update((company_line.index, title_line.index))
        if len(parts) < 2:
            prev = None
            for cand in reversed(lines[: ln.index]):
                if not cand.stripped:
                    continue
                prev = cand
                break
            if (prev is not None and section_of[prev.index] == section_of[ln.index] and prev.index not in used_as_prev
                    and not is_bullet(prev.text) and not RANGE_RE.search(prev.text) and len(prev.stripped) <= 80
                    and not prev.stripped.endswith(".") and len(prev.stripped.split()) <= 10):
                parts = split_parts(prev.stripped) + parts
                start_pos = prev.start
                used_as_prev.add(prev.index)
        if PLACEHOLDER.search(text[start_pos:end_pos]):
            _warn(warnings, nt, umap, "PLACEHOLDER_SKIPPED", "An employment line has an unfilled [placeholder]; not imported.", start_pos, end_pos)
            continue
        s_val = parse_date(m.group("s"))
        e_val = parse_date(m.group("e"))
        if isinstance(s_val, tuple) or isinstance(e_val, tuple):
            _warn(warnings, nt, umap, "EMPLOYMENT_DATE_PRECISION",
                  "Employment dates without a month cannot be imported (a month would have to be guessed). Not imported.", start_pos, end_pos)
            continue
        if s_val is None:
            _warn(warnings, nt, umap, "EMPLOYMENT_DATE_INVALID", "Employment start date is not a date; not imported.", start_pos, end_pos)
            continue
        if e_val is not None and e_val < s_val:
            _warn(warnings, nt, umap, "EMPLOYMENT_DATE_INVALID", "Employment ends before it starts; not imported.", start_pos, end_pos)
            continue
        if not parts:
            _warn(warnings, nt, umap, "EMPLOYMENT_NAME_MISSING", "Dates found but no employer or title text; not imported.", start_pos, end_pos)
            continue
        attrs: dict = {"startDate": s_val, "endDate": e_val}
        if e_val is None:
            attrs["current"] = True
        notes_parts: list[str] = []
        if in_internship_section:
            attrs["employmentType"] = "internship"
            notes_parts.append("Category 'internship' comes from the section heading of the resume, not from the job title; confirm it.")
        elif any(INTERN_RE.search(p) for p in parts):
            notes_parts.append("The title mentions an internship/co-op keyword. Employment category is NOT assigned automatically; set it when reviewing.")
        value: str
        if len(parts) == 1:
            split = split_unseparated(parts[0])
            if split is not None:
                parts = [split[1], split[0]]  # [employer, title] -> the 2-part branch below sorts them out by title keywords
                notes_parts.append("No separator in the source line; employer and title were split where the title keywords end. Verify the split.")
        if len(parts) == 2:
            hits = [bool(TITLE_RE.search(p)) for p in parts]
            if sum(hits) == 1:
                title = parts[hits.index(True)]
                employer = parts[hits.index(False)]
                attrs["employer"], attrs["title"] = employer, title
                value = f"{employer} — {title}"
            else:
                value = " — ".join(parts)
                notes_parts.append("Employer and title order could not be determined; set them when reviewing.")
        else:
            value = " — ".join(parts)
            notes_parts.append("Employer and title could not be separated reliably; set them when reviewing.")
        notes = " ".join(notes_parts)[:300] or None
        d = add("employment", value, start_pos, end_pos, attrs, notes, key=("employment", value.lower(), s_val))
        if d is None:
            continue
        for attr in ("employer", "title"):
            if attr in attrs:
                m_attr = re.search(re.escape(attrs[attr]), text[start_pos:end_pos])
                if m_attr:
                    d.field_spans[attr] = (start_pos+m_attr.start(), start_pos+m_attr.end())
        for attr, group in (("startDate", "s"), ("endDate", "e")):
            d.field_spans[attr] = (ln.start+m.start(group), ln.start+m.end(group))

    # --- education --------------------------------------------------------------------------------------------------
    for ln in lines:
        if section_of[ln.index] not in ("education", "education_certifications") or not ln.stripped or is_bullet(ln.text):
            continue
        body = LATEX_SPACING.sub("", ln.stripped).rstrip()  # "[1pt]" is a typesetting artefact, not a placeholder
        if PLACEHOLDER.search(body):
            _warn(warnings, nt, umap, "PLACEHOLDER_SKIPPED", "An education line has an unfilled [placeholder]; not imported.", ln.start, ln.end)
            continue
        if DEGREE_WORDS.search(body) or DEGREE_ABBR.search(body):
            lead = len(ln.text) - len(ln.text.lstrip())
            parts = [p.strip() for p in body.split("|")]
            value = parts[0] if len(parts) > 1 else body
            d = add("education", value, ln.start + lead, ln.start + lead + len(value))
            if d and len(parts) > 1:
                institution = parts[1]
                if institution:
                    d.attributes["institution"] = institution
                    pos = ln.text.find(institution)
                    d.field_spans["institution"] = (ln.start+pos, ln.start+pos+len(institution))
                if len(parts) > 2:
                    date = parse_date(parts[2])
                    if isinstance(date, str):
                        d.attributes["graduationDate"] = date
                        pos = ln.text.find(parts[2])
                        d.field_spans["graduationDate"] = (ln.start+pos, ln.start+pos+len(parts[2]))
            elif d and ln.index + 1 < len(lines):
                school = lines[ln.index + 1]
                if (section_of[school.index] == section_of[ln.index] and
                        re.search(r"\b(?:university|college|institute|school|academy)\b", school.stripped, re.IGNORECASE) and
                        not DEGREE_WORDS.search(school.stripped) and not DEGREE_ABBR.search(school.stripped)):
                    d.attributes["institution"] = school.stripped
                    begin = school.start + len(school.text) - len(school.text.lstrip())
                    d.field_spans["institution"] = (begin, begin+len(school.stripped))
                    if school.index + 1 < len(lines):
                        date_line = lines[school.index + 1]
                        date = parse_date(date_line.stripped)
                        if section_of[date_line.index] == section_of[ln.index] and isinstance(date, str):
                            d.attributes["graduationDate"] = date
                            begin = date_line.start + len(date_line.text) - len(date_line.text.lstrip())
                            d.field_spans["graduationDate"] = (begin, begin+len(date_line.stripped))

    # --- certifications ---------------------------------------------------------------------------------------------
    cert_lines = [ln for ln in lines if section_of[ln.index] in ("certifications", "education_certifications") and ln.stripped and not (DEGREE_WORDS.search(ln.stripped) or DEGREE_ABBR.search(ln.stripped))]
    consumed: set[int] = set()
    for pos, ln in enumerate(cert_lines):
        if ln.index in consumed:
            continue
        # A following issuer/date line belongs to the preceding credential.
        nxt = cert_lines[pos + 1] if pos + 1 < len(cert_lines) else None
        metadata = None
        if nxt is not None and nxt.index == ln.index + 1 and not is_bullet(nxt.text):
            meta_parts = [p.strip() for p in nxt.stripped.split("|")]
            if len(meta_parts) == 2 and isinstance(parse_date(meta_parts[1]), str):
                metadata = (nxt, meta_parts)
                consumed.add(nxt.index)
        body, off = strip_bullet(ln.text)
        inline_parts = [p.strip() for p in body.split("|")]
        inline_metadata = len(inline_parts) >= 3 and isinstance(parse_date(inline_parts[-1]), str)
        items = split_items(body, seps="•·" if metadata or inline_metadata else "•·|")
        if not items:
            continue
        # A short capitalised line right after a full-width list line continues the last item ("...Cisco Networking" / "Basics").
        nxt = cert_lines[pos + 1] if pos + 1 < len(cert_lines) else None
        cont: Line | None = None
        if (nxt is not None and nxt.index == ln.index + 1 and not is_bullet(nxt.text) and len(items) >= 2 and len(ln.stripped) >= 60
                and len(nxt.stripped.split()) <= 3 and nxt.stripped[:1].isupper() and not re.search(r"[•·|,;:.]", nxt.stripped)
                and not re.search(r"[•·|,;:]$", ln.stripped)):
            cont = nxt
            consumed.add(nxt.index)
        for k, (item, s_off, e_off) in enumerate(items):
            start = ln.start + off + s_off
            end = ln.start + off + e_off
            note = None
            if cont is not None and k == len(items) - 1:
                item = f"{item} {cont.stripped}"
                end = cont.start + (len(cont.text) - len(cont.text.lstrip())) + len(cont.stripped)
                note = "Joined across a line wrap (no hyphen in the source); verify the name."
            name = re.split(r"\s+[—–]\s+|\s*\|\s*|\s+\(|,\s+(?=issued|earned|expires|\d{4})", item, maxsplit=1)[0].strip()
            if not name or len(name) > 100 or name.endswith(".") or len(name.split()) > 12:
                continue
            if PLACEHOLDER.search(name):
                _warn(warnings, nt, umap, "PLACEHOLDER_SKIPPED", "A certification name is a placeholder; not imported.", start, end)
                continue
            d = add("certification", name, start, start + len(name) if note is None else end, notes=note)
            if d and metadata:
                meta_ln, meta_parts = metadata
                d.attributes["issuer"] = meta_parts[0]
                d.attributes["certificationDate"] = parse_date(meta_parts[1])
                for key, value in (("issuer", meta_parts[0]), ("certificationDate", meta_parts[1])):
                    p = meta_ln.text.find(value)
                    d.field_spans[key] = (meta_ln.start+p, meta_ln.start+p+len(value))
            elif d and inline_metadata:
                pipe_parts = [p.strip() for p in body.split("|")]
                if len(pipe_parts) >= 3 and pipe_parts[0] == name and isinstance(parse_date(pipe_parts[2]), str):
                    d.attributes["issuer"] = pipe_parts[1]
                    d.attributes["certificationDate"] = parse_date(pipe_parts[2])
                    for key, value in (("issuer", pipe_parts[1]), ("certificationDate", pipe_parts[2])):
                        p = ln.text.find(value)
                        d.field_spans[key] = (ln.start+p, ln.start+p+len(value))

    # --- projects ---------------------------------------------------------------------------------------------------
    last_project: _Draft | None = None
    prev_was_project = False
    description_lines: list[Line] = []

    def flush_description() -> None:
        nonlocal description_lines
        if last_project is not None and description_lines:
            last_project.attributes["description"] = " ".join(x.stripped for x in description_lines)
            last_project.field_spans["description"] = (description_lines[0].start, description_lines[-1].end)
        description_lines = []
    for ln in lines:
        if section_of[ln.index] != "projects" or not ln.stripped:
            continue
        tech = TECH_LABEL.match(ln.text)
        if tech:
            flush_description()
            if last_project is not None and "technologies" not in last_project.attributes:
                techs = [i for i, _, _ in split_items(tech.group("rest")) if len(i) <= 40][:40]
                if techs:
                    last_project.attributes["technologies"] = techs
                    last_project.field_spans["technologies"] = (ln.start+tech.start("rest"), ln.start+tech.end("rest"))
            prev_was_project = False
            continue
        if is_bullet(ln.text):
            flush_description()
            prev_was_project = False
            continue
        # A separator-delimited stack line right under a project title ("Python — Flask — SHAP •github.com/x/y") lists its technologies.
        stack = [i for i, _, _ in split_items(re.split(r"[•·]\s*\S*(?:github|gitlab)\S*", ln.stripped)[0], seps="—–|,•") if i]
        if (prev_was_project and last_project is not None and len(stack) >= 3 and all(len(i.split()) <= 4 and len(i) <= 40 for i in stack)
                and "technologies" not in last_project.attributes):
            last_project.attributes["technologies"] = stack[:40]
            last_project.field_spans["technologies"] = (ln.start, ln.end)
            prev_was_project = False
            continue
        explicit_project_title = "|" in ln.stripped and not TECH_LABEL.match(ln.text)
        if last_project is not None and not explicit_project_title and (description_lines or (prev_was_project and len(ln.stripped.split()) >= 7)):
            description_lines.append(ln)
            prev_was_project = False
            continue
        if len(ln.stripped) > 100 or ln.stripped.endswith("."):
            if last_project is not None:
                description_lines.append(ln)
            prev_was_project = False
            continue
        flush_description()
        name = re.split(r"\s+[—–-]\s+|\s*\|\s*|\s+\(", ln.stripped, maxsplit=1)[0].strip()
        name = TRAILING_DATE.sub("", name).strip(" ,")  # a trailing "Feb 2026" / "2026" is a date, not part of the name
        if not name or PLACEHOLDER.search(name) or len(name.split()) > 12:
            prev_was_project = False
            continue
        lead = len(ln.text) - len(ln.text.lstrip())
        d = add("project", name, ln.start + lead, ln.start + lead + len(name),
                notes="Project (not employment): never counted as professional years.")
        prev_was_project = d is not None
        if d is not None:
            last_project = d
            if explicit_project_title:
                rest = ln.stripped.split("|", 1)[1].strip()
                techs = [item for item, _, _ in split_items(rest) if len(item) <= 40]
                if techs:
                    d.attributes["technologies"] = techs
                    start = ln.text.find(rest)
                    d.field_spans["technologies"] = (ln.start+start, ln.start+start+len(rest))

    flush_description()

    # --- warnings from whole-document scans -------------------------------------------------------------------------
    for label, pattern in SENSITIVE_PATTERNS:
        m = pattern.search(text)
        if m:
            _warn(warnings, nt, umap, "SENSITIVE_TERM_NOT_IMPORTED",
                  f"The resume mentions {label} ('{m.group(0)}'). Job Hunter never imports this as a fact; add it yourself in Attested facts if it is true and current.",
                  m.start(), m.end())
    m = INSTRUCTION_RE.search(text)
    if m:
        _warn(warnings, nt, umap, "INSTRUCTION_LIKE_TEXT", "The resume contains text that reads like an instruction. It is treated as inert data and has no effect.", m.start(), m.end())

    for b in nt.ambiguous:
        warnings.append(Warning_(
            code="LINE_HYPHEN_AMBIGUOUS",
            message=f"A line ends with '{b.left}-' and the next line starts with '{b.right}'. It cannot be told whether this is one word or a hyphenated term, so the text is left as it is. Check the source.",
            start=umap.to_u16(b.start), end=umap.to_u16(b.end)))
    merged = [m for m in re.finditer(r"[A-Za-z]{30,}", text)]
    if merged:
        _warn(warnings, nt, umap, "TEXT_LAYER_MERGED_WORDS",
              f"{len(merged)} run(s) of 30+ letters with no spaces: the PDF text layer lost word spacing there, so facts from those lines may be missed. Nothing is guessed.",
              merged[0].start(), merged[0].end())

    drafts.sort(key=lambda d: (d.start, d.end))
    facts: list[ProposedFact] = []
    for d in drafts:
        a = d.attributes
        oa, ob = nt.to_original(d.start, d.end)
        if d.field_spans:
            a["fieldSpans"] = {}
            for key, (start, end) in d.field_spans.items():
                fa, fb = nt.to_original(start, end)
                a["fieldSpans"][key] = Span(start=umap.to_u16(fa), end=umap.to_u16(fb), quote=original[fa:fb])
        facts.append(
            ProposedFact(
                kind=d.kind,  # type: ignore[arg-type]
                value=d.value,
                attributes=FactAttributes(**{k: v for k, v in a.items()}),
                span=Span(start=umap.to_u16(oa), end=umap.to_u16(ob), quote=original[oa:ob]),
                proposedBy="rules",
                notes=d.notes,
            )
        )
    return ParseOutput(facts=facts, warnings=warnings)

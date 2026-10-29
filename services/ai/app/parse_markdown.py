"""Deterministic resume parser over Marker Markdown -> resume-extraction.v1 (strict Pydantic).

Rules only: no model, no network. Every record quotes the exact stored Markdown (evidence offsets are UTF-16 code units).
Nothing is inferred: citizenship/clearance/work-authorization/sponsorship are never facts (a mention only warns), a year-only date
stays year precision (no month is invented), and anything ambiguous is skipped with a warning instead of being guessed.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

from .offsets import Utf16Map
from .parse_resume import (DEGREE_ABBR, DEGREE_WORDS, EMAIL_RE, HEADINGS, INSTRUCTION_RE, NAME_RE, PHONE_RE, RANGE_RE, SENSITIVE_PATTERNS,
                           TITLE_RE, heading_of, split_items, split_parts, split_unseparated, Line)
from .resume_schema import (SCHEMA_VERSION, Candidate, Certification, Education, Employment, Evidence, ExtractionWarning, FactOut,
                            PartialDate, Project, ResumeExtraction, Scalar, Skill)

PARSER_REVISION = "marker-deterministic-v2"

# ---------------------------------------------------------------------------------------------------------------------
# Markdown line cleaning with a clean-index -> raw-index map, so evidence always quotes the stored text.
# Emphasis markers (**bold**, *italic*) never leak into values; their spans are kept for layout decisions.
# ---------------------------------------------------------------------------------------------------------------------

_LINK = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")
_AUTOLINK = re.compile(r"<(https?://[^>\s]+)>")
_LEAD = re.compile(r"\s*(?:#{1,6}\s+|[-*+•◦▪●]\s+)?")


@dataclass
class Clean:
    start: int  # raw offset of the line in the stored text
    raw: str
    text: str
    pos: list[int]  # raw index (within `raw`) for each clean char
    level: int  # markdown heading level, 0 when not a heading
    bullet: bool
    bold: list[tuple[int, int]] = field(default_factory=list)  # clean-coordinate spans of **bold** runs
    italic: list[tuple[int, int]] = field(default_factory=list)  # clean-coordinate spans of *italic* runs

    def span(self, a: int, b: int) -> tuple[int, int]:
        """Raw (absolute) offsets of clean[a:b]."""
        return self.start + self.pos[a], self.start + self.pos[b - 1] + 1


def clean_line(raw: str, start: int) -> Clean:
    m = _LEAD.match(raw)
    lead = raw[: m.end()]
    level = len(lead.strip()) if lead.strip().startswith("#") else 0
    bullet = bool(lead.strip()) and not lead.strip().startswith("#")
    out: list[str] = []
    pos: list[int] = []
    bold: list[tuple[int, int]] = []
    italic: list[tuple[int, int]] = []
    bold_open: int | None = None
    ital_open: int | None = None
    i = m.end()
    while i < len(raw):
        if raw.startswith("**", i) or raw.startswith("__", i):
            if bold_open is None:
                bold_open = len(out)
            else:
                bold.append((bold_open, len(out)))
                bold_open = None
            i += 2
            continue
        if raw[i] == "*":
            prev = raw[i - 1] if i > 0 else " "
            nxt = raw[i + 1] if i + 1 < len(raw) else " "
            if not (prev.isalnum() and nxt.isalnum()) and not (prev.isspace() and nxt.isspace()):
                if ital_open is None:
                    ital_open = len(out)
                else:
                    italic.append((ital_open, len(out)))
                    ital_open = None
                i += 1
                continue
        link = _LINK.match(raw, i) if raw[i] == "[" else None
        auto = _AUTOLINK.match(raw, i) if raw[i] == "<" else None
        if link or auto:
            inner = link.group(1) if link else auto.group(1)  # type: ignore[union-attr]
            base = i + 1
            for j, ch in enumerate(inner):
                out.append(ch)
                pos.append(base + j)
            i = (link or auto).end()  # type: ignore[union-attr]
            continue
        if raw[i] == "\\" and i + 1 < len(raw) and raw[i + 1] in "$*_#[]()<>`":
            i += 1
        out.append(raw[i])
        pos.append(i)
        i += 1
    text = "".join(out)
    lstripped = len(text) - len(text.lstrip())
    stripped = text.strip()
    shift = lstripped
    n = len(stripped)

    def norm_spans(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
        res = []
        for a, b in spans:
            a2, b2 = max(a - shift, 0), min(b - shift, n)
            if b2 > a2:
                res.append((a2, b2))
        return res

    return Clean(start, raw, stripped, pos[lstripped: lstripped + n], level, bullet, norm_spans(bold), norm_spans(italic))


# ---------------------------------------------------------------------------------------------------------------------
# Small lexicons and shape tests
# ---------------------------------------------------------------------------------------------------------------------

# Canonical forms for common aliases; the ORIGINAL text is always kept as the fact value.
SKILL_CANONICAL = {
    "js": "JavaScript", "javascript": "JavaScript", "ts": "TypeScript", "typescript": "TypeScript", "nodejs": "Node.js", "node.js": "Node.js", "node": "Node.js",
    "reactjs": "React", "react.js": "React", "vuejs": "Vue", "vue.js": "Vue", "py": "Python", "golang": "Go", "postgres": "PostgreSQL", "postgresql": "PostgreSQL",
    "mongo": "MongoDB", "k8s": "Kubernetes", "tf": "TensorFlow", "scikit-learn": "scikit-learn", "sklearn": "scikit-learn", "numpy": "NumPy", "scipy": "SciPy",
    "git": "Git", "aws": "AWS", "html": "HTML", "css": "CSS", "html5": "HTML", "css3": "CSS", "http/2": "HTTP/2", "mysql": "MySQL", "ci/cd": "CI/CD",
}
URL_RE = re.compile(r"(?:https?://|www\.)\S+|\b[\w.-]+\.(?:com|io|org|net|dev|co)(?:/\S*)?\b", re.IGNORECASE)
FOOTER_RE = re.compile(r"powered by|enhancv|page \d+|www\.\S+|^\s*resume of\b", re.IGNORECASE)
INSTITUTION_RE = re.compile(r"\b(university|college|institute|polytechnic|school|academy|universit[a-z]*)\b", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
SEPS = " ,|—–-()\t"
_MONTH_YEAR_TAIL = re.compile(r"\s+(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+)?(?:19|20)\d{2}$|\s+\d{1,2}/(?:19|20)\d{2}$")
STRONG_DEGREE = re.compile(r"^(?:(?:Master|Bachelor|Doctor|Associate)(?:'s)?\b.{0,60}|(?:B\.?\s?S\.?|M\.?\s?S\.?|B\.?\s?A\.?|M\.?\s?A\.?|MBA|Ph\.?\s?D\.?|B\.?\s?Tech\.?|M\.?\s?Tech\.?|B\.?\s?Eng\.?|M\.?\s?Eng\.?)(?=[\s,.]).{0,60})$")


def _is_section(c: Clean) -> str | None:
    if not c.text:
        return None
    h = heading_of(Line(0, 0, len(c.text), c.text))
    if h is None:
        return None
    if h == "other" and c.text.lower().replace("&", "and") not in HEADINGS and c.level == 0:
        return None  # an all-caps plain line is not a heading unless Markdown says so (it may be the name)
    return h


def _partial(token: str) -> PartialDate | None:
    t = token.strip().lower()
    if t in ("present", "current", "now", "ongoing"):
        return PartialDate(precision="present")
    m = re.fullmatch(r"(\d{1,2})/((?:19|20)\d{2})", t)
    if m:
        return PartialDate(precision="month", value=f"{m.group(2)}-{int(m.group(1)):02d}") if 1 <= int(m.group(1)) <= 12 else None
    m = re.fullmatch(r"([a-z]+)\.?,?\s+((?:19|20)\d{2})", t)
    if m:
        months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        if m.group(1)[:3] in months:
            return PartialDate(precision="month", value=f"{m.group(2)}-{months.index(m.group(1)[:3]) + 1:02d}")
        return None
    if re.fullmatch(r"(?:19|20)\d{2}", t):
        return PartialDate(precision="year", value=t)
    return None


def _name_ok(c: Clean) -> bool:
    t = c.text
    return bool(NAME_RE.fullmatch(t)) and not re.search(r"\[[^\]]+\]|@|\d", t) and t.lower() not in HEADINGS and 2 <= len(t.split()) <= 4


def parse_markdown(markdown: str, *, source_hash: str, extra_warnings: list[str] | None = None, metrics: dict | None = None) -> ResumeExtraction:
    text = markdown
    umap = Utf16Map(text)
    warnings: list[ExtractionWarning] = []

    def warn(code: str, message: str, s: int | None = None, e: int | None = None) -> None:
        warnings.append(ExtractionWarning(code=code, message=message, start=umap.to_u16(s) if s is not None else None, end=umap.to_u16(e) if e is not None else None))

    def ev(c: Clean, a: int, b: int) -> Evidence:
        s, e = c.span(a, b)
        return Evidence(start=umap.to_u16(s), end=umap.to_u16(e), quote=text[s:e])

    def ev_raw(s: int, e: int) -> Evidence:
        return Evidence(start=umap.to_u16(s), end=umap.to_u16(e), quote=text[s:e])

    lines: list[Clean] = []
    pos = 0
    for raw in text.split("\n"):
        lines.append(clean_line(raw, pos))
        pos += len(raw) + 1

    # --- name (first line, else the first Markdown heading that looks like a name: sidebar-first layouts) -----------------
    first_text = next((i for i, c in enumerate(lines) if c.text), None)
    name_idx: int | None = None
    if first_text is not None and _name_ok(lines[first_text]) and not lines[first_text].bullet:
        name_idx = first_text
    else:
        for i, c in enumerate(lines[:80]):
            if c.text and 1 <= c.level <= 2 and _name_ok(c):
                name_idx = i
                break

    # --- sections ---------------------------------------------------------------------------------------------------
    section: list[str] = []
    cur = "header"
    for i, c in enumerate(lines):
        if not c.text:
            section.append("")
            continue
        if i == name_idx and i != first_text:
            cur = "header"  # a sidebar before the name must not bleed into the main column
            section.append("header")
            continue
        h = _is_section(c)
        if h is not None and not (i == first_text and h == "other"):  # an all-caps first line is the name, not a heading
            cur = h
            section.append("HEADING")
            continue
        section.append(cur)

    def in_section(*names: str) -> list[tuple[int, Clean]]:
        return [(i, c) for i, c in enumerate(lines) if c.text and section[i] in names]

    candidate = Candidate()

    # --- identity ---------------------------------------------------------------------------------------------------
    header = [(i, c) for i, c in enumerate(lines) if c.text and section[i] == "header"]
    sidebar = [(i, c) for i, c in enumerate(lines) if c.text and i < (name_idx or 0)]
    if name_idx is not None:
        c0 = lines[name_idx]
        amb = ["Name taken from the first header line; given and family name are not split."]
        if name_idx != first_text:
            amb = ["Name found after sidebar content (first Markdown heading that looks like a name); given and family name are not split."]
        candidate.name = Scalar(value=c0.text, evidence=ev(c0, 0, len(c0.text)), confidence="medium", ambiguity=amb)
    else:
        warn("NAME_NOT_FOUND", "No header line looks like a person's name; no name proposed.")
    for _, c in sidebar + header:
        for m in EMAIL_RE.finditer(c.text):
            if candidate.email is None:
                candidate.email = Scalar(value=m.group(0), evidence=ev(c, m.start(), m.end()))
        scrub = EMAIL_RE.sub(lambda m: " " * len(m.group(0)), c.text)
        for m in PHONE_RE.finditer(scrub):
            if candidate.phone is None:
                candidate.phone = Scalar(value=m.group(0), evidence=ev(c, m.start(), m.end()))
    if candidate.email is None:
        warn("EMAIL_NOT_FOUND", "No e-mail address appears in the text layer (it may be a hyperlink label such as 'Email'); none proposed.")

    # --- experience -------------------------------------------------------------------------------------------------
    exp = in_section("experience", "internship")
    used: set[int] = set()

    def plain_candidate(k: int) -> tuple[int, Clean] | None:
        """exp[k] when it can be an employer/title line: not a bullet, not a date line, not used, short, no sentence end."""
        if not 0 <= k < len(exp):
            return None
        i, c = exp[k]
        if c.bullet or i in used or RANGE_RE.search(c.text) or len(c.text) > 90 or c.text.endswith(".") or len(c.text.split()) > 10:
            return None
        return exp[k]

    def kw(t: str) -> bool:
        return bool(TITLE_RE.search(t))

    for k, (i, c) in enumerate(exp):
        if c.bullet or i in used:
            continue
        m = RANGE_RE.search(c.text)
        if not m:
            continue
        used.add(i)
        sd, ed = _partial(m.group("s")), _partial(m.group("e"))
        raw_before = c.text[: m.start()]
        before = raw_before.strip(" ,|—–-	")
        a0 = len(raw_before) - len(raw_before.lstrip(" ,|—–-	"))
        if before.endswith("(") and not before.count(")") >= before.count("("):  # "Role (2020 - 2022)": the "(" belongs to the date
            before = before[:-1].rstrip(" ,|—–-	")
        if before.startswith("(") and ")" not in before:
            before, a0 = before[1:].lstrip(), a0 + 1
        line_end = c.span(0, len(c.text))[1]
        segs: list[tuple[Clean, int, int]] = []
        notes: list[str] = []
        touched = [c]

        if before and re.search(r"[A-Za-z]", before):
            seg_a, seg_b = a0, a0 + len(before)
            if "[" in before and "]" in before:
                warn("PLACEHOLDER_SKIPPED", "An employment line has an unfilled [placeholder]; not imported.", c.span(0, len(c.text))[0], line_end)
                continue
            parts = [q.strip(" ,()") for q in split_parts(before) if q.strip(" ,()")]
            pair: list[tuple[Clean, int, int]] | None = None
            if len(parts) == 2:  # explicit separator or comma form
                cur_ = seg_a
                pair = []
                for q in parts:
                    off = c.text.find(q, cur_)
                    pair.append((c, off, off + len(q)))
                    cur_ = off + len(q)
            if pair is None:  # emphasis boundary: one bold run at the start or end of the role text, the rest plain
                for ba, bb in c.bold:
                    if seg_a <= ba and bb <= seg_b and (ba == seg_a or bb == seg_b) and not (ba == seg_a and bb == seg_b):
                        rest = (bb, seg_b) if ba == seg_a else (seg_a, ba)
                        piece = c.text[rest[0]:rest[1]]
                        if piece.strip(SEPS):
                            r0 = rest[0] + (len(piece) - len(piece.lstrip(SEPS)))
                            r1 = rest[1] - (len(piece) - len(piece.rstrip(SEPS)))
                            pair = [(c, ba, bb), (c, r0, r1)] if ba == seg_a else [(c, r0, r1), (c, ba, bb)]
                            break
            if pair is None:  # title keywords end the title; the rest must be a capitalised employer (split_unseparated rules)
                sp = split_unseparated(before)
                if sp is not None:
                    t_, e_ = sp
                    ta = c.text.find(t_, seg_a)
                    ea = c.text.find(e_, ta + len(t_)) if ta >= 0 else -1
                    if ta >= 0 and ea >= 0:
                        pair = [(c, ta, ta + len(t_)), (c, ea, ea + len(e_))]
                        notes.append("No separator or emphasis in the source line; employer and title were split where the title keywords end. Verify the split.")
            segs = pair if pair is not None else [(c, seg_a, seg_b)]
        # one role segment on the date line, or none: take the counterpart(s) from adjacent lines
        if len(segs) < 2:
            if segs:
                seg_text = segs[0][0].text[segs[0][1]:segs[0][2]]
                want_title = not kw(seg_text)  # an employer-like segment needs a title line, and vice versa
                chosen = None
                for kk in (k - 1, k + 1):
                    cand_ = plain_candidate(kk)
                    if cand_ and (kw(cand_[1].text) == want_title):
                        chosen = (kk, cand_)
                        break
                if chosen is not None:
                    kk, (ci, cc) = chosen
                    used.add(ci)
                    touched.append(cc)
                    other = (cc, 0, len(cc.text))
                    segs = [other, segs[0]] if kk < k else [segs[0], other]
            else:
                a_near, a_far = plain_candidate(k - 1), plain_candidate(k - 2)
                if a_near is not None and a_far is not None:
                    used.update({a_near[0], a_far[0]})
                    touched += [a_near[1], a_far[1]]
                    segs = [(a_far[1], 0, len(a_far[1].text)), (a_near[1], 0, len(a_near[1].text))]
                else:
                    b_near = plain_candidate(k + 1)
                    if a_near is not None and b_near is not None:
                        used.update({a_near[0], b_near[0]})
                        touched += [a_near[1], b_near[1]]
                        segs = [(a_near[1], 0, len(a_near[1].text)), (b_near[1], 0, len(b_near[1].text))]
        span_start = min(t.span(0, len(t.text))[0] for t in touched)
        span_end = max(t.span(0, len(t.text))[1] for t in touched)
        if sd is None or ed is None:
            warn("EMPLOYMENT_DATE_INVALID", "Employment dates could not be read; record not imported.", span_start, span_end)
            continue
        if len(segs) != 2:
            warn("EMPLOYMENT_ROLE_MISSING", "Dates found without a separable employer and title; record not imported.", span_start, span_end)
            continue
        (c1, a1_, b1_), (c2, a2_, b2_) = segs
        t1, t2 = c1.text[a1_:b1_], c2.text[a2_:b2_]
        h1, h2 = kw(t1), kw(t2)
        if h1 == h2:
            warn("EMPLOYMENT_ROLE_AMBIGUOUS", "Employer and title could not be told apart by title keywords; record not imported.", span_start, span_end)
            continue
        (tc, ta_, tb_), (ec, ea_, eb_) = ((c1, a1_, b1_), (c2, a2_, b2_)) if h1 else ((c2, a2_, b2_), (c1, a1_, b1_))
        try:
            candidate.experience.append(Employment(
                employer=ec.text[ea_:eb_], title=tc.text[ta_:tb_], start=sd, end=ed,
                evidence=ev_raw(span_start, span_end), employerEvidence=ev(ec, ea_, eb_), titleEvidence=ev(tc, ta_, tb_),
                confidence="medium" if notes else "high", ambiguity=notes))
        except ValueError as error:
            warn("EMPLOYMENT_INVALID", f"Employment record failed validation: {error}", span_start, span_end)

    # --- skills -----------------------------------------------------------------------------------------------------
    sk = in_section("skills")
    names_to_exclude = {r.employer.lower() for r in candidate.experience} | {r.title.lower() for r in candidate.experience}
    category: str | None = None
    seen_skill: set[str] = set()

    def add_skill(c: Clean, a: int, b: int, value: str, ambiguity: list[str] | None = None) -> None:
        v = re.sub(r"\s+", " ", value).strip(" .;:,")
        if "(" in v:  # "Python (NetworkX, graph algorithms)": keep the head term; inner lists are not separate facts here
            head = v.split("(", 1)[0].strip(" .;:,")
            if head and ("," in v[v.index("("):] or len(v) > 40):
                b = a + len(c.text[a:b].split("(", 1)[0].rstrip())
                v = head
        if not v or len(v) > 40 or len(v.split()) > 5 or v.lower() in seen_skill or v.lower() in names_to_exclude:
            return
        if re.fullmatch(r"[\d\W]+", v) or YEAR_RE.fullmatch(v) or (URL_RE.search(v) and not re.fullmatch(r"[\w.+#/-]+", v)):
            return
        if "[" in v and "]" in v:
            warn("PLACEHOLDER_SKIPPED", "A skill contains an unfilled [placeholder]; not imported.", *c.span(a, b))
            return
        seen_skill.add(v.lower())
        amb = ambiguity or []
        candidate.skills.append(Skill(value=v, canonical=SKILL_CANONICAL.get(v.lower()), category=category, evidence=ev(c, a, b),
                                      confidence="medium" if amb else "high", ambiguity=amb))

    def bold_label_spans(c: Clean) -> list[tuple[int, int]]:
        """Bold runs that are category labels: 'Label:' inside the run or ':' right after it."""
        return [(a, b) for a, b in c.bold if c.text[a:b].rstrip().endswith(":") or c.text[b:b + 1] == ":"]

    # A bare short line in the skills section is normally a group heading ("Development
    # Operations" above a list of tools). That only holds when some line in the section
    # actually carries items: a section whose every line is one bare term, as a LinkedIn
    # "Top Skills" rail or a one-per-line sidebar list is, is a list of skills, and reading
    # all of them as headings returned no skills at all.
    skills_list_has_items = len(sk) < 2 or any(re.search(r"[,;|•:]", cc.text) or cc.bold or cc.bullet for _, cc in sk)

    for _, c in sk:
        labels = bold_label_spans(c)
        chips = [r for r in c.bold if r not in labels]
        if labels or not c.bold:
            # segments: the text between labels; a label becomes the category of the items that follow it
            cuts = [(a, b + 1 if c.text[b:b + 1] == ":" else b, c.text[a:b].strip().rstrip(":").strip()) for a, b in labels]
            seg_bounds: list[tuple[int, int, str | None]] = []
            prev_end, prev_cat = 0, category
            for a, end, lab in cuts:
                if prev_end < a:
                    seg_bounds.append((prev_end, a, prev_cat))
                prev_end, prev_cat = end, lab
            seg_bounds.append((prev_end, len(c.text), prev_cat))
            for s0, s1, cat in seg_bounds:
                category = cat
                body = c.text[s0:s1]
                if not body.strip():
                    continue
                if not cuts and not re.search(r"[,;|•:]", body) and (c.level or (len(body.split()) <= 4 and not c.bullet)) and skills_list_has_items:
                    category = body.strip()  # a bare short line is a group heading, not a skill
                    continue
                for n_item, (item, ia, ib) in enumerate(split_items(body, seps=",;|•·")):
                    a_abs, b_abs = s0 + ia, s0 + ib
                    if ":" in item:  # plain "Label: first item", or a label glued after the previous list ("SQL Test Automation: Selenium")
                        head, _, tail = item.partition(":")
                        toks = head.split()
                        if n_item > 0 and len(toks) >= 2:  # a label glued after the previous list by Markdown
                            lead = a_abs + (len(head) - len(head.lstrip()))
                            if re.fullmatch(r"[A-Z0-9][A-Z0-9/+#.\-]{1,}", toks[0]):  # an acronym first word ("SQL Test Automation:") is a skill of its own
                                add_skill(c, lead, lead + len(toks[0]), toks[0],
                                          ["Label glued to the previous item by Markdown; split heuristically (acronym first word = skill, rest = label)."])
                                category = " ".join(toks[1:])
                            else:  # "Nmap Malware & RE:" cannot be split safely: skip the glued head and keep the label
                                category = None  # the label text itself is uncertain
                            warn("SKILL_LABEL_GLUED", f"'{head.strip()}:' looks like a category label glued to the previous skill; boundary uncertain.", *c.span(a_abs, a_abs + len(head)))
                        else:
                            category = head.strip()
                        if tail.strip():
                            t_lead = len(tail) - len(tail.lstrip())
                            tail_s = a_abs + len(head) + 1
                            add_skill(c, tail_s + t_lead, tail_s + len(tail.rstrip()), tail.strip())
                        continue
                    add_skill(c, a_abs, b_abs, item)
        else:
            # Enhancv-style chips: bold runs are the skills; plain text between them is a group label ("Client-Side"), never a skill
            cursor = 0
            for a, b in chips:
                lab = c.text[cursor:a].strip(" ,;|•\t")
                if lab:
                    category = lab
                add_skill(c, a, b, c.text[a:b])
                cursor = b
            tail = c.text[cursor:].strip(" ,;|•\t")
            if tail:
                category = tail

    # --- education --------------------------------------------------------------------------------------------------
    def edu_split(t: str) -> tuple[int, int] | None:
        """(start, end) of the degree text inside a line, dates and trailing location removed."""
        dm = DEGREE_WORDS.search(t) or DEGREE_ABBR.search(t)
        if not dm:
            return None
        end = len(t)
        rm = RANGE_RE.search(t)
        if rm and rm.start() > dm.start():
            end = rm.start()
        mid = re.search(r"\s*·\s*\(|\s+\((?:\w+\s+)?(?:19|20)\d{2}", t)
        if mid and mid.start() > dm.start():
            end = min(end, mid.start())
        return dm.start(), len(t[:end].rstrip(" ,|—–-"))

    def grad_of(t: str) -> PartialDate | None:
        rm = RANGE_RE.search(t)
        if rm:
            return _partial(rm.group("e"))
        ym = re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)", t)
        return PartialDate(precision="year", value=ym.group(1)) if ym else None

    def inst_span(t: str, c: Clean) -> tuple[Clean, int, int] | None:
        """Institution text of a line: before the first date or comma-separated location."""
        rm = RANGE_RE.search(t)
        head = t[: rm.start()] if rm else t
        head = re.split(r",\s|\s+\(|\s·\s", head)[0]
        head = re.sub(r"\s+(?:19|20)\d{2}\b.*$", "", head).strip(" ,|—–-")
        if not head or not INSTITUTION_RE.search(head):
            return None
        a = t.find(head)
        return (c, a, a + len(head))

    edu_records: list[Education] = []

    def build_edu(c: Clean, da: int, db: int, inst: tuple[Clean, int, int] | None, grad: PartialDate | None, notes: list[str], conf: str = "high") -> None:
        try:
            edu_records.append(Education(
                degree=c.text[da:db], institution=inst[0].text[inst[1]:inst[2]] if inst else None, graduation=grad, evidence=ev(c, da, db),
                institutionEvidence=ev(inst[0], inst[1], inst[2]) if inst else None, confidence=conf if inst else "medium",
                ambiguity=notes if inst else notes + ["No institution could be paired with this degree unambiguously."]))
        except ValueError as error:
            warn("EDUCATION_INVALID", f"Education record failed validation: {error}")

    ed_lines = [(i, c) for i, c in in_section("education") if not c.bullet]
    items: list[dict] = []
    for i, c in ed_lines:
        t = c.text
        d = edu_split(t)
        im = INSTITUTION_RE.search(t)
        if d is not None and im is not None and im.start() < d[0]:  # "<Institution> <Degree>" on one line
            items.append({"k": "DI", "c": c, "d": (d[0], d[1]), "i": (c, 0, len(t[: d[0]].rstrip(" ,|—–-"))), "g": grad_of(t)})
        elif d is not None:
            inst = None
            for ba, bb in c.bold + c.italic:  # "<Degree> **<Institution>**": an emphasis boundary on the same line
                if ba > d[0] and t[ba:bb].strip() and t[:ba].strip():
                    head = re.split(r",\s", t[ba:bb])[0].rstrip()  # "<Institution>, <City, Country>": the location is not part of the name
                    inst = (c, ba, ba + len(head))
                    break
            if inst is not None:
                d = (d[0], min(d[1], len(t[: inst[1]].rstrip(" ,|—–-"))))
            items.append({"k": "DI" if inst else "D", "c": c, "d": d, "i": inst, "g": grad_of(t)})
        else:
            ins = inst_span(t, c)
            if ins is not None:
                items.append({"k": "I", "c": c, "i": ins, "g": grad_of(t)})
            elif re.match(r"^(?:19|20)\d{2}\b", t) and items and items[-1].get("g") is None:
                items[-1]["g"] = grad_of(t)
    loose = [x for x in items if x["k"] in ("D", "I")]
    kinds = "".join(x["k"] for x in loose)
    pairing: dict[int, dict] = {}
    if loose and re.fullmatch(r"(?:DI)+", kinds):
        for n in range(0, len(loose), 2):
            pairing[id(loose[n])] = loose[n + 1]
    elif loose and re.fullmatch(r"(?:ID)+", kinds):
        for n in range(0, len(loose), 2):
            pairing[id(loose[n + 1])] = loose[n]
    for x in items:
        if x["k"] == "I":
            continue
        grad, inst = x["g"], x["i"]
        if x["k"] == "D":
            partner = pairing.get(id(x))
            if partner is not None:
                inst = partner["i"]
                grad = grad or partner["g"]
            else:
                names = [y["i"][0].text[y["i"][1]:y["i"][2]] for y in loose if y["k"] == "I"]
                if names:
                    warn("EDUCATION_PAIRING_AMBIGUOUS", f"Degree and institution lines do not pair one-to-one in an adjacent pattern ({', '.join(names)}); no institution is assigned.",
                         *x["c"].span(0, len(x["c"].text)))
        build_edu(x["c"], x["d"][0], x["d"][1], inst, grad, [])
    # education without a heading: a strong degree line directly followed by an institution line, outside any education section
    in_edu = {i for i, _ in ed_lines}
    for i, c in enumerate(lines):
        if not c.text or i in in_edu or section[i] in ("education", "HEADING") or c.bullet or c.text.endswith(".") or len(c.text.split()) > 12:
            continue
        if not STRONG_DEGREE.match(c.text):
            continue
        nxt = next((x for x in lines[i + 1: i + 3] if x.text), None)
        ins = inst_span(nxt.text, nxt) if nxt is not None else None
        d = edu_split(c.text)
        if ins is not None and d is not None:
            build_edu(c, d[0], d[1], ins, grad_of(nxt.text) or grad_of(c.text),
                      ["No Education heading in the source; degree and institution lines recognised by shape only. Verify."], conf="medium")
    candidate.education.extend(edu_records)

    # --- certifications ---------------------------------------------------------------------------------------------
    for _, c in in_section("certifications"):
        # A repeated page footer that lands under the heading is not a certification. The
        # projects block already skips these; the same test belongs here.
        if FOOTER_RE.search(c.text):
            continue
        for item, s, e in split_items(c.text, seps="•·|;"):
            name = re.split(r"\s+[—–-]\s+|\s+\(|,\s+(?=issued|earned|expires|\d{4})", item, maxsplit=1)[0].strip()
            if not name or len(name) > 120 or name.endswith(".") or len(name.split()) > 12 or URL_RE.fullmatch(name) or YEAR_RE.fullmatch(name):
                continue
            if "[" in name:
                warn("PLACEHOLDER_SKIPPED", "A certification name is a placeholder; not imported.")
                continue
            candidate.certifications.append(Certification(name=name, evidence=ev(c, s, s + len(name))))

    # --- projects ---------------------------------------------------------------------------------------------------
    pr = in_section("projects")
    current: Project | None = None
    prev_kind = "start"  # start | title | meta | desc | bullet
    for k, (i, c) in enumerate(pr):
        t = c.text
        if FOOTER_RE.search(t):
            continue
        if c.bullet:
            um = URL_RE.search(t)
            if current is not None and um and len(t.split()) <= 16 and not t.endswith("."):  # a stack/link bullet is metadata, not a description
                if current.url is None:
                    current.url = um.group(0)
            elif current is not None and current.description is None:
                current.description = t[:600]
            prev_kind = "bullet"
            continue
        tech = re.match(r"^(?:technologies|tech stack|tools|stack|built with)\s*:\s*(.+)$", t, re.IGNORECASE)
        if tech and current is not None:
            current.technologies = [x for x, _, _ in split_items(tech.group(1)) if len(x) <= 40][:40]
            prev_kind = "meta"
            continue
        m = RANGE_RE.search(t)
        if m and current is not None and not t[: m.start()].strip(" ,|—–-()"):
            current.start, current.end = _partial(m.group("s")), _partial(m.group("e"))
            prev_kind = "meta"
            continue
        if len(t.split()) == 1 and URL_RE.search(t):
            if current is not None and current.url is None:
                current.url = t
            prev_kind = "meta"
            continue
        if current is not None and prev_kind == "title" and re.search(r"\s[—–]\s", t) and not t.endswith("."):
            # stack line under a title ("Python — NetworkX — MITRE ATT&CK • github.com/x/y"): technologies and link, not a description
            stack_part, _, link_part = t.partition("•")
            techs = [x.strip() for x in re.split(r"\s+[—–]\s+", stack_part) if x.strip() and len(x.strip()) <= 40]
            if len(techs) >= 2:
                current.technologies = techs[:40]
                um = URL_RE.search(link_part)
                if um and current.url is None:
                    current.url = um.group(0)
                prev_kind = "meta"
                continue
        words = len(t.split())
        title_like = (c.level >= 2 or (prev_kind != "title" and words <= 12 and not t.endswith(".")))
        if title_like and len(t) <= 100 and not t.endswith("."):
            name = re.split(r"\s+[—–-]\s+|\s*\|\s+", t, maxsplit=1)[0].strip()
            tail = _MONTH_YEAR_TAIL.search(name)
            date_tok = name[tail.start():].strip() if tail else None
            if tail:
                name = name[: tail.start()].strip(" ,")
            if not name or "[" in name or YEAR_RE.fullmatch(name) or URL_RE.fullmatch(name):
                continue
            current = Project(name=name, evidence=ev(c, 0, len(name)))
            if date_tok:
                current.start = _partial(date_tok)
            candidate.projects.append(current)
            prev_kind = "title"
            continue
        if current is not None and current.description is None and len(t) <= 600:
            current.description = t
        prev_kind = "desc"

    # --- whole-document warnings -----------------------------------------------------------------------------------
    for label, pattern in SENSITIVE_PATTERNS:
        m = pattern.search(text)
        if m:
            warn("SENSITIVE_TERM_NOT_IMPORTED", f"The resume mentions {label} ('{m.group(0)}'). Job Hunter never imports this as a fact; add it yourself in Attested facts if it is true and current.", m.start(), m.end())
    m = INSTRUCTION_RE.search(text)
    if m:
        warn("INSTRUCTION_LIKE_TEXT", "The resume contains text that reads like an instruction. It is treated as inert data and has no effect.", m.start(), m.end())
    for w in extra_warnings or []:
        code, _, msg = w.partition(":")
        warn(code.strip(), msg.strip() or code)

    # --- facts (one per proposed value, each with evidence) -------------------------------------------------------
    facts: list[FactOut] = []

    def fact(kind: str, value: str, evidence: Evidence, confidence: str) -> None:
        facts.append(FactOut(factId=f"{kind}-{len(facts) + 1}", kind=kind, value=value[:300], evidence=evidence, confidence=confidence))  # type: ignore[arg-type]

    for kind, rec in (("legal_name", candidate.name), ("email", candidate.email), ("phone", candidate.phone)):
        if rec:
            fact(kind, rec.value, rec.evidence, rec.confidence)
    for s in candidate.skills:
        fact("skill", s.value, s.evidence, s.confidence)
    for e in candidate.experience:
        fact("employment", f"{e.employer} — {e.title}", e.evidence, e.confidence)
    for e in candidate.education:
        fact("education", e.degree if not e.institution else f"{e.degree} — {e.institution}", e.evidence, e.confidence)
    for x in candidate.certifications:
        fact("certification", x.name, x.evidence, x.confidence)
    for p in candidate.projects:
        fact("project", p.name, p.evidence, p.confidence)

    text_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return ResumeExtraction(
        schemaVersion=SCHEMA_VERSION, parserRevision=PARSER_REVISION, sourceHash=source_hash, textSha256=text_sha, text=text,
        candidate=candidate, facts=facts, warnings=warnings,
        metrics={"skills": len(candidate.skills), "experience": len(candidate.experience), "education": len(candidate.education),
                 "certifications": len(candidate.certifications), "projects": len(candidate.projects), "facts": len(facts), "warnings": len(warnings),
                 **(metrics or {})})

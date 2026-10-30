"""Layout-dependent line wraps -> a parsing view of the text, with a map back to the original characters.

PDF text layers break words at the right margin ("corre-" / "lation"). Rules parse a *view* in which such a break is repaired, and every
span is mapped back to the ORIGINAL text, so a fact's quote is always verbatim source text ("event corre-\\nlation") while its value is
the repaired phrase ("event correlation"). The original text is never modified, and nothing is ever invented: the repaired word is
always the literal concatenation of the two fragments found in the document.

Decision for a "<letters>-<newline><lowercase letters>" site, first match wins:
  1. The hyphenated form appears elsewhere in the document in the middle of a line  -> legitimate hyphen: keep it, join only the lines.
  2. The un-hyphenated joined word appears elsewhere in the document               -> broken word: join.
  3. The joined word is in a small bundled vocabulary of tech/security terms       -> broken word: join.
  4. The left fragment is a prefix that is normally hyphenated (self, multi, ...)  -> legitimate hyphen: keep it, join only the lines.
  5. The right fragment is a short word-ending (tion, ment, lation, ...)           -> broken word: join.
  6. Anything else is AMBIGUOUS: left exactly as it is and reported (LINE_HYPHEN_AMBIGUOUS). A human decides.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Terms that commonly get split at a margin. Data only; used when the document itself holds no unbroken copy of the word.
VOCAB = frozenset(
    """kubernetes orchestration automation correlation containerization virtualization vulnerability vulnerabilities infrastructure
    authentication authorization configuration investigation remediation visualization segmentation encryption cryptography detection
    engineering engineered integration implementation development management administration monitoring forensics intelligence
    explainability observability architecture application applications compliance documentation environment environments
    framework frameworks governance identity infrastructure kubernetes microservices middleware networking penetration persistence
    ransomware repository scripting sandboxing telemetry terraform workflows pipeline pipelines analytics analysis behavioral
    classification deployment troubleshooting prioritization normalization optimization""".split()
)
# Prefixes that are normally written with a hyphen ("self-service"). A break after one of them keeps the hyphen.
HYPHEN_PREFIXES = frozenset("self multi non anti cross semi pseudo co pre post inter intra ex all well high low full part".split())
# Word-endings that are never a whole word on their own, so "<left>-" + one of these is a broken word.
SUFFIX_FRAGMENTS = (
    "tion", "tions", "sion", "sions", "ment", "ments", "ness", "ing", "ings", "ity", "ities", "able", "ible", "ance", "ances", "ence",
    "ences", "ally", "ical", "ation", "ations", "ization", "izations", "lation", "ular", "ology", "ologies", "ture", "tures", "ated",
    "ating", "ators", "ator", "ious", "ous", "ful", "less", "ies", "ers", "ures", "rity", "bility", "ively", "ively",
)
MAX_SUFFIX_FRAGMENT_LEN = 7

_SITE = re.compile(r"(?P<left>[A-Za-z]{2,})-\n(?P<right>[a-z]{2,})")
_WORD = re.compile(r"[A-Za-z]+")
_HYPHENATED_MIDLINE = re.compile(r"[A-Za-z]+-[A-Za-z]+")


@dataclass(frozen=True)
class AmbiguousBreak:
    start: int  # original index of the hyphen
    end: int  # original index just past the first fragment of the next line
    left: str
    right: str


@dataclass(frozen=True)
class NormalizedText:
    original: str
    text: str
    # origin[i] is the index in `original` of normalized character i; origin[len(text)] == len(original).
    origin: tuple[int, ...]
    ambiguous: tuple[AmbiguousBreak, ...]
    repaired: int

    def to_original(self, start: int, end: int) -> tuple[int, int]:
        """Half-open normalized range -> half-open original range covering exactly the same source characters."""
        if not (0 <= start < end <= len(self.text)):
            raise ValueError("range outside normalized text")
        return self.origin[start], self.origin[end - 1] + 1


def _sites(text: str) -> list[re.Match[str]]:
    return list(_SITE.finditer(text))


def _document_evidence(text: str, sites: list[re.Match[str]]) -> tuple[set[str], set[str]]:
    """Words and mid-line hyphenated words found in the document OUTSIDE the break sites."""
    masked = text
    for m in reversed(sites):
        masked = masked[: m.start()] + " " * (m.end() - m.start()) + masked[m.end():]
    # Hyphenated forms are searched per line so a line-end hyphen is never mistaken for a mid-line one.
    hyphenated = {h.lower() for line in masked.split("\n") for h in _HYPHENATED_MIDLINE.findall(line)}
    words = {w.lower() for w in _WORD.findall(masked)}
    return words, hyphenated


def _classify(left: str, right: str, words: set[str], hyphenated: set[str]) -> str:
    """'join' | 'keep-hyphen' | 'ambiguous'"""
    l, r = left.lower(), right.lower()
    if f"{l}-{r}" in hyphenated:
        return "keep-hyphen"
    if l + r in words or l + r in VOCAB:
        return "join"
    if l in HYPHEN_PREFIXES:
        return "keep-hyphen"
    if len(r) <= MAX_SUFFIX_FRAGMENT_LEN and r in SUFFIX_FRAGMENTS:
        return "join"
    return "ambiguous"


def normalize_line_breaks(original: str) -> NormalizedText:
    sites = _sites(original)
    if not sites:
        return NormalizedText(original, original, tuple(range(len(original) + 1)), (), 0)
    words, hyphenated = _document_evidence(original, sites)
    out: list[str] = []
    origin: list[int] = []
    ambiguous: list[AmbiguousBreak] = []
    repaired = 0
    cursor = 0

    def copy(a: int, b: int) -> None:
        out.append(original[a:b])
        origin.extend(range(a, b))

    for m in sites:
        verdict = _classify(m.group("left"), m.group("right"), words, hyphenated)
        hyphen_at = m.start("left") + len(m.group("left"))  # index of "-"
        newline_at = hyphen_at + 1
        if verdict == "ambiguous":
            ambiguous.append(AmbiguousBreak(hyphen_at, m.end(), m.group("left"), m.group("right")))
            continue
        copy(cursor, hyphen_at if verdict == "join" else newline_at)  # join: drop "-" and "\n"; keep-hyphen: drop only "\n"
        cursor = newline_at + 1
        repaired += 1
    copy(cursor, len(original))
    origin.append(len(original))
    return NormalizedText(original, "".join(out), tuple(origin), tuple(ambiguous), repaired)

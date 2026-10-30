"""Local candidate-document intake: PDF/DOCX -> a paged, offset-checked private draft.

What this adds over `extract_text.extract`, which the HTTP service already uses:

  * page boundaries, so a fact can cite the page it came from;
  * line spans in UTF-16 code units (the TypeScript boundary convention), each
    one verified against the canonical text before it is emitted;
  * a four-way extraction condition instead of one exception:
    EXTRACTED / LOW_TEXT_CONFIDENCE / NEEDS_LOCAL_OCR / EXTRACTION_FAILED;
  * reading-order reconstruction for a multi-column page.

It adds no second PDF parser: the bytes are read by `extract_text.pdf_page_texts`,
which is the same pdfplumber call, x-tolerance and failure mapping the service
uses. Nothing here performs OCR, and nothing here reaches the network.

Reading order
-------------
A two-column page extracts top-to-bottom across the gutter, so a sidebar entry
lands between two body lines and the result reads as nonsense ("EDUCATION" between
a job title and its dates). Where a gutter is found, the page is rebuilt from word
coordinates: each band of full-width text acts as a boundary, and within a band the
left column is emitted in full before the right one.

Two rules keep that from inventing anything:

  * no word is moved within a line and no line is split or merged across columns,
    so a date never leaves the entry it was printed with;
  * the rebuilt text must contain exactly the same non-whitespace characters as the
    extractor's own text for that page. If one character differs, the reflow is
    thrown away, the native order is kept, and the document is marked
    LOW_TEXT_CONFIDENCE with REFLOW_REJECTED_CONTENT_MISMATCH. Spacing may differ,
    because joining words inserts single spaces; content may not.

Every line records where it came from before the rebuild (`native_index`), the box
it occupied on the page (`bbox`), and which column it belonged to, so a reviewer can
check a reordered line against the page itself.

A scan is never reported as an empty resume: no text with an image present is
NEEDS_LOCAL_OCR, and no text with nothing drawn at all is EXTRACTION_FAILED with
code EMPTY_DOCUMENT. Those are different problems with different fixes.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, field

from .extract_text import (
    MIN_TEXT_CHARS,
    ExtractedDocument,
    ExtractError,
    PageLayout,
    PlacedWord,
    extract_docx,
    normalize_text,
    pdf_page_texts,
)
from .offsets import Utf16Map, utf16_len

#: Bump when a change here would alter the text, spans or pages of an unchanged input.
#: @2 added reading-order reconstruction, so a reflowed document's text differs from @1's.
INTAKE_REVISION = "local-intake@2"

Status = str  # EXTRACTED | LOW_TEXT_CONFIDENCE | NEEDS_LOCAL_OCR | EXTRACTION_FAILED
ReadingOrder = str  # native | columns

#: Below this many non-whitespace characters on a page, the page carries no usable text.
LOW_CHARS_PER_PAGE = 200
#: A gutter must be at least this fraction of the page width to count as a column split.
MIN_GUTTER_SHARE = 0.06
#: Both sides must hold at least this many words and ink at least this fraction of the page
#: width. A word-count share would reject a LinkedIn export, whose label rail holds ten words
#: against the body's seventy-eight and is still unmistakably a second column.
MIN_SIDE_WORDS = 3
MIN_SIDE_EXTENT_SHARE = 0.12
#: Minimum clear horizontal gap, in points and as a share of the page width, before a row
#: is read as two column entries rather than one line of text that happens to span the gutter.
MIN_COLUMN_GAP = 10.0
MIN_COLUMN_GAP_SHARE = 0.02
#: A candidate gutter must be straddled by at least this many more rows than cross it.
#: Three is the smallest number that cannot be produced by one stray row pair.
MIN_SPLIT_ROWS = 3
#: Fraction of lines that are 1-2 characters long above which the text looks shredded.
MAX_STUB_LINE_SHARE = 0.25
#: Two words belong to the same printed line when their vertical boxes overlap by at least
#: this fraction of the shorter box. Superscripts and small caps still group with their line.
MIN_ROW_OVERLAP = 0.4

_SECTION_WORDS = (
    "summary", "objective", "profile", "experience", "employment", "education", "skills",
    "projects", "certifications", "certification", "awards", "publications", "contact",
)


@dataclass(frozen=True)
class LineSpan:
    """One line of the canonical text. `start`/`end` are UTF-16 code units.

    `native_index` is the line's position before any reading-order rebuild, and `bbox`
    is `(x0, top, x1, bottom)` on the page in PDF points. Both are None when the
    document carries no geometry (DOCX) or needed no rebuild.
    """

    index: int
    page: int | None
    start: int
    end: int
    text: str
    native_index: int | None = None
    column: int | None = None
    bbox: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class PageSpan:
    index: int
    start: int | None
    end: int | None
    char_count: int
    non_whitespace: int
    image_count: int
    #: False when the page's text could not be located in the canonical string; spans are then None.
    resolved: bool
    column_gutter: float | None
    reading_order: ReadingOrder = "native"


@dataclass
class IntakeResult:
    status: Status
    failure_code: str | None = None
    failure_message: str | None = None
    text: str = ""
    text_sha256: str = ""
    page_count: int = 0
    pages: list[PageSpan] = field(default_factory=list)
    lines: list[LineSpan] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    metrics: dict[str, float | int | bool] = field(default_factory=dict)
    reading_order: ReadingOrder = "native"

    def sanitized(self) -> dict:
        """Everything except the document's own words: safe to print or log."""
        return {
            "status": self.status,
            "failureCode": self.failure_code,
            "readingOrder": self.reading_order,
            "pageCount": self.page_count,
            "lineCount": len(self.lines),
            "warnings": sorted(set(self.warnings)),
            "metrics": self.metrics,
            "textSha256": self.text_sha256,
            "pages": [{k: v for k, v in asdict(page).items()} for page in self.pages],
        }


# ---------------------------------------------------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class ReflowLine:
    """A printed line of one column, assembled from words that share a row."""

    text: str
    #: 0 = left of the gutter, 1 = right of it, None = spans the gutter (header, footer, rule).
    column: int | None
    x0: float
    top: float
    x1: float
    bottom: float


def _line_of(row: list[PlacedWord], column: int | None) -> ReflowLine:
    return ReflowLine(
        text=" ".join(word.text for word in row).strip(),
        column=column,
        x0=min(w.x0 for w in row),
        top=min(w.top for w in row),
        x1=max(w.x1 for w in row),
        bottom=max(w.bottom for w in row),
    )


def group_rows(words: list[PlacedWord]) -> list[list[PlacedWord]]:
    """Group words into printed lines by vertical overlap, each line left to right."""
    rows: list[list[PlacedWord]] = []
    for word in sorted(words, key=lambda w: (w.top, w.x0)):
        placed = False
        for row in rows:
            top = min(w.top for w in row)
            bottom = max(w.bottom for w in row)
            overlap = min(bottom, word.bottom) - max(top, word.top)
            shorter = min(bottom - top, word.bottom - word.top)
            if shorter > 0 and overlap / shorter >= MIN_ROW_OVERLAP:
                row.append(word)
                placed = True
                break
        if not placed:
            rows.append([word])
    for row in rows:
        row.sort(key=lambda w: w.x0)
    rows.sort(key=lambda row: (min(w.top for w in row), min(w.x0 for w in row)))
    return rows


def detect_column_gutter(layout: PageLayout) -> float | None:
    """The x of the vertical band that most printed rows straddle and none of them crosses.

    Scored per row rather than per page. A band of whitespace running the height of the
    page does not survive a name banner or a footer that runs its width, and nearly every
    real two-column resume has one, so each candidate x is scored as

        (rows with words on both sides and none crossing x) - (rows crossing x)

    and the full-width rows cost a few points instead of hiding the gutter. Those same
    crossing rows become the reading-order boundaries in `reflow_page`.

    Returns None when the page is single-column, nearly empty, or the band is too narrow
    or too lopsided to be a column boundary. One gutter per page: a page with a sidebar
    *and* a two-up sub-block still reports only the main split.
    """
    placed = [w for w in layout.words if w.x1 > w.x0]
    if len(placed) < 12 or layout.width <= 0:
        return None
    words = [(w.x0, w.x1) for w in placed]
    left_edge = min(w[0] for w in words)
    right_edge = max(w[1] for w in words)
    if right_edge - left_edge <= 0:
        return None

    size = int(right_edge - left_edge) + 2
    straddling = [0] * size
    crossing = [0] * size
    for row in group_rows(placed):
        row_min = min(w.x0 for w in row)
        row_max = max(w.x1 for w in row)
        covered = [False] * size
        for word in row:
            for b in range(int(word.x0 - left_edge), int(word.x1 - left_edge) + 1):
                if 0 <= b < size:
                    covered[b] = True
        for b in range(size):
            x = left_edge + b
            if covered[b]:
                crossing[b] += 1
            elif row_min < x < row_max:
                straddling[b] += 1

    scores = [straddling[b] - crossing[b] for b in range(size)]
    if max(scores) < MIN_SPLIT_ROWS:
        return None
    # The widest contiguous run of bins that all clear the threshold. Taking only the
    # single best-scoring run would measure the gutter from the end of the longest
    # banner line instead of the end of the left column, which can be tens of points
    # narrower and fail the width test on a page that plainly has two columns.
    best: tuple[int, int] | None = None  # (width, start bin)
    run = 0
    for b in range(size + 1):
        if b < size and scores[b] >= MIN_SPLIT_ROWS:
            run += 1
            continue
        if run and (best is None or run > best[0]):
            best = (run, b - run)
        run = 0
    if best is None:
        return None
    width, start = best
    if width < MIN_GUTTER_SHARE * layout.width:
        return None
    centre = left_edge + start + width / 2
    left = [w for w in words if w[1] <= centre]
    right = [w for w in words if w[0] >= centre]
    if min(len(left), len(right)) < MIN_SIDE_WORDS:
        return None
    for side in (left, right):
        extent = max(w[1] for w in side) - min(w[0] for w in side)
        if extent < MIN_SIDE_EXTENT_SHARE * layout.width:
            return None
    # A gutter hugging a margin is whitespace, not a column split.
    if not (left_edge + 0.1 * (right_edge - left_edge) < centre < right_edge - 0.1 * (right_edge - left_edge)):
        return None
    return round(centre, 2)


def reflow_page(layout: PageLayout, gutter: float) -> list[ReflowLine]:
    """Rebuild one page's reading order around a column gutter.

    A line that spans the gutter (a name banner, a page footer, a full-width section)
    is a boundary: everything above it in either column is emitted first, in column
    order, then the spanning line itself. Nothing is reordered inside a line.

    The unit of work is the printed row, not the word. Splitting a page by word would
    cut a banner in half the moment one of its words happened to sit over the gutter,
    and the halves would then be reordered against each other. A row is treated as two
    column entries only when its words leave a real gap at the gutter; otherwise it is
    one line of continuous text and is kept whole.
    """
    gap_needed = max(MIN_COLUMN_GAP, MIN_COLUMN_GAP_SHARE * layout.width)
    left: list[ReflowLine] = []
    right: list[ReflowLine] = []
    full: list[ReflowLine] = []

    for row in group_rows(list(layout.words)):
        before = [w for w in row if w.x1 <= gutter]
        after = [w for w in row if w.x0 >= gutter]
        crosses = any(w.x0 < gutter < w.x1 for w in row)
        gap = (min(w.x0 for w in after) - max(w.x1 for w in before)) if before and after else 0.0
        if crosses or (before and after and gap < gap_needed):
            full.append(_line_of(row, None))  # one printed line that happens to span the gutter
            continue
        if before:
            left.append(_line_of(before, 0))
        if after:
            right.append(_line_of(after, 1))

    ordered: list[ReflowLine] = []
    left_at = right_at = 0
    for boundary in full:
        while left_at < len(left) and left[left_at].top < boundary.top:
            ordered.append(left[left_at])
            left_at += 1
        while right_at < len(right) and right[right_at].top < boundary.top:
            ordered.append(right[right_at])
            right_at += 1
        ordered.append(boundary)
    ordered.extend(left[left_at:])
    ordered.extend(right[right_at:])
    return [line for line in ordered if line.text]


def _content_counter(text: str) -> Counter:
    """Non-whitespace characters of `text`, as a multiset: what reflow must preserve."""
    return Counter(re.sub(r"\s", "", text))


# ---------------------------------------------------------------------------------------------------------------------
# Span resolution: native order
# ---------------------------------------------------------------------------------------------------------------------

def _page_spans(text: str, pages: list[str], layout: list[PageLayout], umap: Utf16Map) -> tuple[list[PageSpan], list[str]]:
    """Locate each page's normalized text inside the canonical string.

    The canonical text is `normalize_text("\\n".join(pages))`, which is what the
    service already returns; normalization is not distributive over the join, so
    each page is located by searching forward from the previous page's end and the
    result is verified by comparison. A page that cannot be verified is reported
    unresolved rather than given a guessed span.
    """
    spans: list[PageSpan] = []
    warnings: list[str] = []
    cursor = 0
    for index, raw in enumerate(pages):
        normalized = normalize_text(raw)
        geometry = layout[index] if index < len(layout) else None
        non_ws = len(re.sub(r"\s", "", normalized))
        found = text.find(normalized, cursor) if normalized else -1
        resolved = found >= 0 and bool(normalized) and text[found : found + len(normalized)] == normalized
        if resolved:
            start_u16, end_u16 = umap.to_u16(found), umap.to_u16(found + len(normalized))
            cursor = found + len(normalized)
        else:
            start_u16 = end_u16 = None
            if normalized:
                warnings.append("PAGE_SPAN_UNRESOLVED")
        spans.append(
            PageSpan(
                index=index,
                start=start_u16,
                end=end_u16,
                char_count=len(normalized),
                non_whitespace=non_ws,
                image_count=geometry.image_count if geometry else 0,
                resolved=resolved,
                column_gutter=detect_column_gutter(geometry) if geometry else None,
                reading_order="native",
            )
        )
    return spans, warnings


def _lines(text: str, pages: list[PageSpan], umap: Utf16Map) -> list[LineSpan]:
    """Every non-blank line of the canonical text, with its verified span and page."""
    out: list[LineSpan] = []
    index = 0
    for match in re.finditer(r"[^\n]+", text):
        body = match.group(0)
        stripped = body.strip()
        if not stripped:
            continue
        offset = match.start() + body.index(stripped)
        start_u16 = umap.to_u16(offset)
        end_u16 = umap.to_u16(offset + len(stripped))
        page = next(
            (p.index for p in pages if p.resolved and p.start is not None and p.end is not None and p.start <= start_u16 < p.end),
            None,
        )
        out.append(LineSpan(index=index, page=page, start=start_u16, end=end_u16, text=stripped, native_index=index))
        index += 1
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Span resolution: reconstructed order
# ---------------------------------------------------------------------------------------------------------------------

@dataclass
class Reflowed:
    text: str
    pages: list[PageSpan]
    lines: list[LineSpan]
    #: Pages whose reading order was rebuilt.
    rebuilt_pages: list[int]


def _native_line_index(page_text: str) -> list[str]:
    return [line.strip() for line in normalize_text(page_text).split("\n") if line.strip()]


def _locate_native(text: str, native_lines: list[str]) -> int | None:
    """Which line of the native extraction this rebuilt line was printed in.

    On a two-column page the native extraction usually merges a left-column line and
    the right-column line beside it into one row, so an exact match is the exception
    and containment is the rule. Both are reported as the same thing: the row number
    a reviewer will find the text on if they look at the extractor's own output.
    """
    try:
        return native_lines.index(text)
    except ValueError:
        pass
    for index, line in enumerate(native_lines):
        if text and text in line:
            return index
    return None


def build_reflowed(page_texts: list[str], layout: list[PageLayout], gutters: list[float | None]) -> Reflowed | None:
    """Assemble the whole document in reconstructed reading order, spans included.

    Returns None when any page's rebuilt content differs from what the extractor read
    for that page: a reflow that loses or gains a character is not an improvement.
    """
    assembled: list[str] = []
    pages: list[PageSpan] = []
    lines: list[LineSpan] = []
    rebuilt: list[int] = []
    cursor = 0  # code points into the assembled text

    for index, page_text in enumerate(page_texts):
        geometry = layout[index] if index < len(layout) else None
        gutter = gutters[index]
        native_lines = _native_line_index(page_text)
        if geometry is not None and gutter is not None:
            page_lines = reflow_page(geometry, gutter)
            rebuilt.append(index)
        else:
            page_lines = [
                ReflowLine(text=line, column=None, x0=0.0, top=float(position), x1=0.0, bottom=float(position))
                for position, line in enumerate(native_lines)
            ]
        body = "\n".join(line.text for line in page_lines)
        if _content_counter(body) != _content_counter(page_text):
            return None

        page_start = cursor
        for line in page_lines:
            start = cursor
            end = start + len(line.text)
            native_index = _locate_native(line.text, native_lines)
            lines.append(
                LineSpan(
                    index=len(lines),
                    page=index,
                    start=start,
                    end=end,
                    text=line.text,
                    native_index=native_index,
                    column=line.column,
                    bbox=(round(line.x0, 2), round(line.top, 2), round(line.x1, 2), round(line.bottom, 2)) if gutter is not None else None,
                )
            )
            cursor = end + 1  # the newline that follows
        if page_lines:
            cursor -= 1  # the last line of a page has no trailing newline of its own
        assembled.append(body)
        pages.append(
            PageSpan(
                index=index,
                start=page_start,
                end=cursor,
                char_count=len(body),
                non_whitespace=len(re.sub(r"\s", "", body)),
                image_count=geometry.image_count if geometry else 0,
                resolved=bool(body),
                column_gutter=gutter,
                reading_order="columns" if gutter is not None else "native",
            )
        )
        cursor += 1  # the newline between pages

    text = "\n".join(assembled)
    # Spans were counted in code points; convert once the final text exists.
    umap = Utf16Map(text)
    converted = [
        LineSpan(
            index=line.index,
            page=line.page,
            start=umap.to_u16(line.start),
            end=umap.to_u16(line.end),
            text=line.text,
            native_index=line.native_index,
            column=line.column,
            bbox=line.bbox,
        )
        for line in lines
    ]
    converted_pages = [
        PageSpan(
            index=page.index,
            start=umap.to_u16(page.start) if page.start is not None else None,
            end=umap.to_u16(page.end) if page.end is not None else None,
            char_count=page.char_count,
            non_whitespace=page.non_whitespace,
            image_count=page.image_count,
            resolved=page.resolved,
            column_gutter=page.column_gutter,
            reading_order=page.reading_order,
        )
        for page in pages
    ]
    return Reflowed(text=text, pages=converted_pages, lines=converted, rebuilt_pages=rebuilt)


# ---------------------------------------------------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------------------------------------------------

def verify_spans(text: str, lines: list[LineSpan]) -> list[str]:
    """Re-slice the canonical text by every emitted span. Any mismatch is a defect, not a warning to ignore."""
    problems: list[str] = []
    utf16 = text.encode("utf-16-le")
    for line in lines:
        sliced = utf16[line.start * 2 : line.end * 2].decode("utf-16-le")
        if sliced != line.text:
            problems.append(f"line {line.index}: span does not reproduce its text")
    return problems


def _confidence_warnings(text: str, pages: list[PageSpan], lines: list[LineSpan]) -> list[str]:
    warnings: list[str] = []
    if any(page.column_gutter is not None for page in pages):
        warnings.append("POSSIBLE_MULTI_COLUMN")
    if "�" in text:
        warnings.append("REPLACEMENT_CHARACTERS")
    if lines:
        stubs = sum(1 for line in lines if len(line.text) <= 2)
        if stubs / len(lines) > MAX_STUB_LINE_SHARE:
            warnings.append("MANY_STUB_LINES")
    low = [p.index for p in pages if p.non_whitespace < LOW_CHARS_PER_PAGE]
    if low and len(low) == len(pages):
        warnings.append("THIN_TEXT_ON_EVERY_PAGE")
    elif low:
        warnings.append("THIN_TEXT_ON_SOME_PAGES")
    lowered = text.lower()
    if sum(1 for word in _SECTION_WORDS if word in lowered) < 2:
        warnings.append("NO_RESUME_SECTION_WORDS")
    if unicodedata.normalize("NFC", text) != text:
        warnings.append("TEXT_NOT_NFC")
    return warnings


#: Warnings that, on their own, make the extraction untrustworthy enough to need a look.
#: POSSIBLE_MULTI_COLUMN is not among them once the order has been rebuilt and verified -
#: READING_ORDER_RECONSTRUCTED says so, and the content check proves nothing was lost.
LOW_CONFIDENCE_WARNINGS = {
    "POSSIBLE_MULTI_COLUMN",
    "REPLACEMENT_CHARACTERS",
    "MANY_STUB_LINES",
    "THIN_TEXT_ON_EVERY_PAGE",
    "NO_RESUME_SECTION_WORDS",
    "PAGE_SPAN_UNRESOLVED",
    "REFLOW_REJECTED_CONTENT_MISMATCH",
}


# ---------------------------------------------------------------------------------------------------------------------
# Intake
# ---------------------------------------------------------------------------------------------------------------------

def intake_bytes(data: bytes, file_type: str) -> IntakeResult:
    """Extract one document. Never raises for a bad document: the condition is the answer."""
    if file_type == "docx":
        return _intake_docx(data)
    if file_type == "pdf":
        return _intake_pdf(data)
    return IntakeResult(
        status="EXTRACTION_FAILED",
        failure_code="UNSUPPORTED_FILE_TYPE",
        failure_message=f"Unsupported file type {file_type!r}.",
    )


def _finish(
    text: str,
    pages: list[PageSpan],
    page_count: int,
    warnings: list[str],
    lines: list[LineSpan] | None = None,
    reading_order: ReadingOrder = "native",
) -> IntakeResult:
    umap = Utf16Map(text)
    resolved_lines = lines if lines is not None else _lines(text, pages, umap)
    defects = verify_spans(text, resolved_lines)
    all_warnings = list(warnings) + _confidence_warnings(text, pages, resolved_lines)
    if defects:
        all_warnings.append("SPAN_VERIFICATION_FAILED")
    # A rebuilt page is no longer a reason for doubt by itself: the rebuild is recorded and
    # its content was checked character for character against the extractor's own text.
    if reading_order == "columns" and "REFLOW_REJECTED_CONTENT_MISMATCH" not in all_warnings:
        all_warnings = [w for w in all_warnings if w != "POSSIBLE_MULTI_COLUMN"]
        all_warnings.append("READING_ORDER_RECONSTRUCTED")
    status: Status
    if defects:
        status = "EXTRACTION_FAILED"
    elif any(w in LOW_CONFIDENCE_WARNINGS for w in all_warnings):
        status = "LOW_TEXT_CONFIDENCE"
    else:
        status = "EXTRACTED"
    return IntakeResult(
        status=status,
        failure_code="SPAN_VERIFICATION_FAILED" if defects else None,
        failure_message="; ".join(defects)[:300] if defects else None,
        text=text,
        text_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
        page_count=page_count,
        pages=pages,
        lines=resolved_lines,
        warnings=all_warnings,
        reading_order=reading_order,
        metrics={
            "textChars": utf16_len(text),
            "nonWhitespaceChars": len(re.sub(r"\s", "", text)),
            "lineCount": len(resolved_lines),
            "pagesResolved": sum(1 for p in pages if p.resolved),
            "columnPages": sum(1 for p in pages if p.column_gutter is not None),
            "rebuiltPages": sum(1 for p in pages if p.reading_order == "columns"),
            "imageCount": sum(p.image_count for p in pages),
        },
    )


def _intake_pdf(data: bytes) -> IntakeResult:
    try:
        raw_pages, page_count, layout = pdf_page_texts(data, with_layout=True)
    except ExtractError as error:
        return IntakeResult(status="EXTRACTION_FAILED", failure_code=error.code, failure_message=error.message)

    native_text = normalize_text("\n".join(raw_pages))
    pages, warnings = _page_spans(native_text, raw_pages, layout, Utf16Map(native_text))
    images = sum(p.image_count for p in pages)
    if len(re.sub(r"\s", "", native_text)) < MIN_TEXT_CHARS:
        if images > 0:
            return IntakeResult(
                status="NEEDS_LOCAL_OCR",
                failure_code="NO_TEXT_LAYER",
                failure_message=f"No usable text layer on {page_count} page(s); {images} drawn image(s) present. Local OCR is required; none is performed here.",
                page_count=page_count,
                pages=pages,
                warnings=["IMAGE_ONLY_DOCUMENT"],
                metrics={"imageCount": images, "nonWhitespaceChars": len(re.sub(r"\s", "", native_text))},
            )
        return IntakeResult(
            status="EXTRACTION_FAILED",
            failure_code="EMPTY_DOCUMENT",
            failure_message=f"The PDF has {page_count} page(s) with neither a text layer nor drawn images.",
            page_count=page_count,
            pages=pages,
            warnings=["NO_TEXT_AND_NO_IMAGES"],
            metrics={"imageCount": 0, "nonWhitespaceChars": len(re.sub(r"\s", "", native_text))},
        )

    gutters = [page.column_gutter for page in pages]
    if not any(gutter is not None for gutter in gutters):
        return _finish(native_text, pages, page_count, warnings)

    reflowed = build_reflowed(raw_pages, layout, gutters)
    if reflowed is None:
        # The rebuild would have changed the content, so it is discarded and the document
        # is flagged: the native order is still the wrong reading order for a column layout.
        return _finish(native_text, pages, page_count, [*warnings, "REFLOW_REJECTED_CONTENT_MISMATCH"])
    return _finish(reflowed.text, reflowed.pages, page_count, warnings, lines=reflowed.lines, reading_order="columns")


def _intake_docx(data: bytes) -> IntakeResult:
    try:
        document: ExtractedDocument = extract_docx(data)
    except ExtractError as error:
        status = "NEEDS_LOCAL_OCR" if error.code == "NO_TEXT_LAYER" else "EXTRACTION_FAILED"
        return IntakeResult(status=status, failure_code=error.code, failure_message=error.message)
    text = document.text
    page = PageSpan(
        index=0,
        start=0,
        end=utf16_len(text),
        char_count=len(text),
        non_whitespace=len(re.sub(r"\s", "", text)),
        image_count=0,
        resolved=True,
        column_gutter=None,
    )
    # A DOCX has no page geometry here, so no column check applies.
    return _finish(text, [page], 1, [])

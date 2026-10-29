import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runImport } from "../../src/candidate/cli.js";
import {
  draftToDocument,
  intakeDraftSchema,
  loadIntakeDrafts,
  runIntakeWorker,
  verifyDraftSpans,
  verifyReadingSpans,
  verifyTextDigest,
  type IntakeDraft,
} from "../../src/candidate/pdf-intake.js";
import { checkPrivateTarget, isInside } from "../../src/candidate/private-paths.js";
import { buildPendingFacts, type EmploymentCandidate, type EvidenceSpan } from "../../src/candidate/resume-import.js";
import { buildDocx } from "../helpers/docx.js";

// Every draft in this file is built here from fictional text. No test reads a candidate
// document, spawns Python, needs PostgreSQL or touches the network.

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

const RESUME_PAGE_1 = [
  "Marisol Quintero-Habberdash",
  "PROFESSIONAL SUMMARY",
  "Test automation engineer building browser and API suites for payment flows.",
  "TECHNICAL SKILLS",
  "Automation: Playwright, Selenium, Pytest",
  "PROFESSIONAL EXPERIENCE",
  "Thistledown Analytics - Senior QA Engineer March 2021 - Present",
  "Built an end-to-end Playwright suite covering checkout and refunds.",
];
const RESUME_PAGE_2 = [
  "EDUCATION",
  "Bachelor of Science, Computer Science - Alderbury State University, 2018",
  "CERTIFICATIONS",
  "ISTQB Certified Tester Foundation Level - 2019",
];

/** A draft exactly as the worker writes one: spans measured against the joined text. */
function makeDraft(overrides: Partial<IntakeDraft> = {}, pages: string[][] = [RESUME_PAGE_1, RESUME_PAGE_2]): IntakeDraft {
  const text = pages.map((lines) => lines.join("\n")).join("\n");
  const lines: IntakeDraft["lines"] = [];
  const pageSpans: IntakeDraft["pages"] = [];
  let cursor = 0;
  pages.forEach((pageLines, pageIndex) => {
    const body = pageLines.join("\n");
    const pageStart = text.indexOf(body, cursor);
    pageSpans.push({
      index: pageIndex,
      start: pageStart,
      end: pageStart + body.length,
      char_count: body.length,
      non_whitespace: body.replace(/\s/g, "").length,
      image_count: 0,
      resolved: true,
      column_gutter: null,
      reading_order: "native",
    });
    let within = pageStart;
    for (const line of pageLines) {
      const start = text.indexOf(line, within);
      lines.push({ index: lines.length, page: pageIndex, start, end: start + line.length, text: line, native_index: lines.length, column: null, bbox: null });
      within = start + line.length;
    }
    cursor = pageStart + body.length;
  });

  return {
    schema: "local-intake-draft/4",
    intakeRevision: "local-intake@2",
    documentId: "doc-0123456789ab",
    candidateId: "cand-0123456789ab",
    fileName: "Synthetic Profile (3).pdf",
    fileType: "pdf",
    byteSize: 48_000,
    sourceSha256: "a".repeat(64),
    extractedAt: "2026-10-28T00:00:00Z",
    status: "EXTRACTED",
    readingOrder: "native",
    failure: null,
    pageCount: pages.length,
    pages: pageSpans,
    warnings: [],
    metrics: { lineCount: lines.length },
    textSha256: sha256(text),
    text,
    lines,
    reading: { parserRevision: "marker-deterministic-v2", employment: [], skills: [], education: [], certifications: [], projects: [], refused: [] },
    reviewStatus: "PENDING_REVIEW",
    approval: { approvedBy: null, approvedAt: null },
    ...overrides,
  };
}

function writeDrafts(drafts: IntakeDraft[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jh-drafts-"));
  for (const draft of drafts) writeFileSync(path.join(dir, `${draft.documentId}.draft.json`), JSON.stringify(draft, null, 2), "utf-8");
  return dir;
}

describe("intake draft schema", () => {
  it("accepts a worker draft", () => {
    expect(intakeDraftSchema.safeParse(makeDraft()).success).toBe(true);
  });

  it("refuses a draft that claims it was reviewed or approved", () => {
    const approved = { ...makeDraft(), reviewStatus: "APPROVED" };
    expect(intakeDraftSchema.safeParse(approved).success).toBe(false);
    const signed = { ...makeDraft(), approval: { approvedBy: "someone", approvedAt: "2026-10-28" } };
    expect(intakeDraftSchema.safeParse(signed).success).toBe(false);
  });

  it("refuses an unknown status and an unknown extra field", () => {
    expect(intakeDraftSchema.safeParse({ ...makeDraft(), status: "FINE" }).success).toBe(false);
    expect(intakeDraftSchema.safeParse({ ...makeDraft(), readingOrder: "guessed" }).success).toBe(false);
    expect(intakeDraftSchema.safeParse({ ...makeDraft(), trustMe: true }).success).toBe(false);
  });
});

describe("span verification", () => {
  it("passes for a well-formed draft", () => {
    expect(verifyDraftSpans(makeDraft())).toEqual([]);
  });

  it("catches a span that no longer reproduces its text", () => {
    const draft = makeDraft();
    draft.lines[2] = { ...draft.lines[2]!, end: draft.lines[2]!.end - 3 };
    expect(verifyDraftSpans(draft).map((p) => p.code)).toEqual(["SPAN_MISMATCH"]);
  });

  it("catches a span past the end of the text", () => {
    const draft = makeDraft();
    draft.lines[0] = { ...draft.lines[0]!, start: draft.text.length - 1, end: draft.text.length + 40 };
    expect(verifyDraftSpans(draft)[0]!.code).toBe("SPAN_MISMATCH");
  });

  it("catches a page marked resolved with an unusable range", () => {
    const draft = makeDraft();
    draft.pages[1] = { ...draft.pages[1]!, start: null };
    expect(verifyDraftSpans(draft).some((p) => p.code === "PAGE_RANGE_INVALID")).toBe(true);
  });

  it("catches text edited after extraction", () => {
    const draft = makeDraft();
    draft.text = draft.text.replace("Senior QA Engineer", "Principal QA Engineer");
    expect(verifyTextDigest(draft, sha256)[0]!.code).toBe("TEXT_DIGEST_MISMATCH");
  });
});

describe("loadIntakeDrafts", () => {
  it("keeps a usable resume draft", () => {
    const dir = writeDrafts([makeDraft()]);
    const result = loadIntakeDrafts(dir, { sha256 });
    expect(result.rejected).toEqual([]);
    expect(result.usable).toHaveLength(1);
    expect(result.usable[0]!.classification.type).toBe("RESUME");
  });

  it("refuses a scan instead of importing an empty resume", () => {
    const scan = makeDraft({
      documentId: "doc-feedfacefeed",
      status: "NEEDS_LOCAL_OCR",
      failure: { code: "NO_TEXT_LAYER", message: "no usable text layer" },
      warnings: ["IMAGE_ONLY_DOCUMENT"],
      lines: [],
      pages: [],
      text: "",
      textSha256: "",
      pageCount: 1,
    });
    const result = loadIntakeDrafts(writeDrafts([scan]), { sha256 });
    expect(result.usable).toEqual([]);
    expect(result.rejected[0]!.problems.map((p) => p.code)).toContain("NO_USABLE_TEXT");
  });

  it("refuses a document that is not a resume", () => {
    const jd = makeDraft({ documentId: "doc-00000000000d" }, [[
      "Senior QA Engineer",
      "About the role",
      "We are looking for a test engineer to own our automation suite end to end.",
      "Responsibilities",
      "Own the regression suite and the release sign-off process for two products.",
      "Minimum qualifications",
      "Five years of experience with Playwright or Selenium in a professional setting.",
      "Benefits",
      "We are an equal opportunity employer and value a wide range of backgrounds.",
    ]]);
    const result = loadIntakeDrafts(writeDrafts([jd]), { sha256 });
    expect(result.usable).toEqual([]);
    expect(result.rejected[0]!.problems.map((p) => p.code)).toContain("NOT_A_RESUME");
  });

  it("reports a file that is not a draft at all", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jh-drafts-"));
    writeFileSync(path.join(dir, "broken.draft.json"), JSON.stringify({ schema: "something-else" }), "utf-8");
    const result = loadIntakeDrafts(dir, { sha256 });
    expect(result.rejected[0]!.problems[0]!.code).toBe("NOT_A_DRAFT");
  });

  it("imports only the drafts whose source document was asked for", () => {
    const wanted = makeDraft({ documentId: "doc-aaaaaaaaaaaa", sourceSha256: "b".repeat(64) });
    const other = makeDraft({ documentId: "doc-bbbbbbbbbbbb", sourceSha256: "c".repeat(64) });
    const result = loadIntakeDrafts(writeDrafts([wanted, other]), { sha256, onlySourceSha256: new Set(["b".repeat(64)]) });
    expect(result.usable.map((d) => d.draft.documentId)).toEqual(["doc-aaaaaaaaaaaa"]);
  });

  it("returns nothing for a directory that does not exist", () => {
    const result = loadIntakeDrafts(path.join(tmpdir(), "jh-no-such-dir-98213"), { sha256 });
    expect(result).toEqual({ usable: [], rejected: [] });
  });
});

describe("draft to pending facts", () => {
  it("carries the page and character span of every fact and approves none of them", () => {
    const document = draftToDocument(makeDraft());
    const result = buildPendingFacts([document], { candidateId: "cand-x", importedAt: "2026-10-28T00:00:00Z" });
    expect(result.profile.facts.length).toBeGreaterThan(0);
    expect(result.profile.facts.every((f) => f.approvalStatus === "pending")).toBe(true);
    expect(result.profile.facts.every((f) => f.verification.verifiedBy === null && f.verification.verifiedAt === null)).toBe(true);
    // The pseudonymous id is the reference, not the file name.
    expect(result.profile.facts.every((f) => f.source.reference === "doc-0123456789ab")).toBe(true);
    for (const fact of result.profile.facts) {
      expect(fact.source.locator).toMatch(/^page \d+, line \d+, chars \d+-\d+$/);
    }
  });

  it("imports a PDF-shaped employment line with the dates the document states", () => {
    const result = buildPendingFacts([draftToDocument(makeDraft())], { candidateId: "cand-x", importedAt: "2026-10-28T00:00:00Z" });
    const employment = result.profile.facts.filter((f) => f.kind === "employment");
    expect(employment).toHaveLength(1);
    expect(employment[0]!.attributes).toMatchObject({ employer: "Thistledown Analytics", title: "Senior QA Engineer", startDate: "2021-03", endDate: null });
    // Role tags and years are never inferred from a title.
    expect(employment[0]!.attributes.roleTags).toBeUndefined();
  });

  it("leaves an employment line whose dates are not stated in full for the reviewer", () => {
    const vague = [...RESUME_PAGE_1];
    vague[6] = "Thistledown Analytics - Senior QA Engineer 2021 - now";
    const result = buildPendingFacts([draftToDocument(makeDraft({}, [vague]))], { candidateId: "cand-x", importedAt: "2026-10-28T00:00:00Z" });
    expect(result.profile.facts.filter((f) => f.kind === "employment")).toEqual([]);
  });

  it("keeps importing a PDF whose dates contradict each other, and reports the line", () => {
    const contradictory = [...RESUME_PAGE_1];
    contradictory[6] = "Dunsmere Payments - Software Engineer II March 2021 - January 2019";
    const result = buildPendingFacts([draftToDocument(makeDraft({}, [contradictory, RESUME_PAGE_2]))], { candidateId: "cand-x", importedAt: "2026-10-28T00:00:00Z" });
    expect(result.profile.facts.filter((f) => f.kind === "employment")).toEqual([]);
    expect(result.profile.facts.some((f) => f.value === "Playwright")).toBe(true);
    expect(result.issues.some((i) => i.message.includes("end before they start"))).toBe(true);
  });

  it("locates a fact on the page it was printed on", () => {
    const result = buildPendingFacts([draftToDocument(makeDraft())], { candidateId: "cand-x", importedAt: "2026-10-28T00:00:00Z" });
    const certification = result.profile.facts.find((f) => f.kind === "certification");
    expect(certification?.source.locator).toMatch(/^page 2, /);
    const skill = result.profile.facts.find((f) => f.kind === "skill");
    expect(skill?.source.locator).toMatch(/^page 1, /);
  });
});

describe("two-column document that Stage B rejected", () => {
  // The same page, twice. NATIVE is what pdfplumber returns for the two-column fixture: each
  // left-column line glued to the right-column line printed beside it. COLUMNS is the rebuilt
  // reading order. Both strings were taken from the extractor, so this test pins the exact
  // document that came back NOT_A_RESUME.
  const NATIVE = [
    "Perpetua Vanterpool-Oyelaran EXPERIENCE",
    "SOC Analyst Umbral Defence Partners",
    "SKILLS Security Analyst, Tier 2",
    "Splunk May 2022 - Present",
    "Microsoft Sentinel Investigated endpoint alerts in Splunk and wrote incident findings.",
    "KQL Assisted the response lead during two confirmed intrusions.",
    "Incident triage Castellan Managed Services",
    "EDUCATION SOC Analyst, Tier 1",
    "Bachelor of Science July 2020 - April 2022",
    "Information Security Triaged phishing reports and tuned twelve detection rules.",
    "Marchmont College, 2020",
  ];
  const COLUMNS = [
    "Perpetua Vanterpool-Oyelaran",
    "SOC Analyst",
    "SKILLS",
    "Splunk",
    "Microsoft Sentinel",
    "KQL",
    "Incident triage",
    "EDUCATION",
    "Bachelor of Science",
    "Information Security",
    "Marchmont College, 2020",
    "EXPERIENCE",
    "Umbral Defence Partners",
    "Security Analyst, Tier 2",
    "May 2022 - Present",
    "Investigated endpoint alerts in Splunk and wrote incident findings.",
    "Assisted the response lead during two confirmed intrusions.",
    "Castellan Managed Services",
    "SOC Analyst, Tier 1",
    "July 2020 - April 2022",
    "Triaged phishing reports and tuned twelve detection rules.",
  ];

  const rebuilt = (): IntakeDraft => {
    const draft = makeDraft({ documentId: "doc-2c0000000001", readingOrder: "columns" }, [COLUMNS]);
    draft.pages[0] = { ...draft.pages[0]!, column_gutter: 268.0, reading_order: "columns" };
    draft.lines = draft.lines.map((line, i) => ({
      ...line,
      column: i < 11 ? 0 : 1,
      bbox: [i < 11 ? 56 : 330, 43 + (i % 11) * 14, i < 11 ? 205 : 455, 54 + (i % 11) * 14] as [number, number, number, number],
    }));
    return draft;
  };

  it("was rejected in native order, and still is: an uncertain document is not forced through", () => {
    const native = makeDraft({ documentId: "doc-2c0000000002" }, [NATIVE]);
    const result = loadIntakeDrafts(writeDrafts([native]), { sha256 });
    expect(result.usable).toEqual([]);
    expect(result.rejected[0]!.problems.map((p) => p.code)).toEqual(["NOT_A_RESUME"]);
    expect(result.rejected[0]!.problems[0]!.detail).toContain("NO_CLEAR_DOCUMENT_STRUCTURE");
  });

  it("classifies as a resume once the reading order is rebuilt", () => {
    const result = loadIntakeDrafts(writeDrafts([rebuilt()]), { sha256 });
    expect(result.rejected).toEqual([]);
    expect(result.usable).toHaveLength(1);
    expect(result.usable[0]!.classification.type).toBe("RESUME");
    expect(result.usable[0]!.classification.confidence).toBe("HIGH");
    // The three headings the glued text hid are what makes the difference.
    expect(result.usable[0]!.classification.signals.map((s) => s.name)).toEqual(
      expect.arrayContaining(["section:experience", "section:education", "section:skills"]),
    );
  });

  it("carries every span, the column it came from and the row it was printed on", () => {
    const draft = rebuilt();
    expect(verifyDraftSpans(draft)).toEqual([]);
    expect(verifyTextDigest(draft, sha256)).toEqual([]);
    for (const line of draft.lines) {
      expect(draft.text.slice(line.start, line.end)).toBe(line.text);
      expect(line.column === 0 || line.column === 1).toBe(true);
      expect(line.bbox).not.toBeNull();
      expect(line.native_index).not.toBeNull();
    }
  });

  it("keeps each date on the line it was printed under", () => {
    const texts = rebuilt().lines.map((l) => l.text);
    expect(texts[texts.indexOf("Security Analyst, Tier 2") + 1]).toBe("May 2022 - Present");
    expect(texts[texts.indexOf("SOC Analyst, Tier 1") + 1]).toBe("July 2020 - April 2022");
  });

  it("imports, and every fact it does emit has evidence that re-slices to its own line", () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const draft = rebuilt();
    expect(runImport({ intakeDir: writeDrafts([draft]), out, candidateId: "c", force: false }, () => {})).toBe(0);
    const profile = JSON.parse(readFileSync(out, "utf-8")) as { facts: Array<{ value: string; approvalStatus: string; source: { reference: string; locator: string } }> };

    for (const fact of profile.facts) {
      const match = /^page (\d+), line (\d+), chars (\d+)-(\d+)$/.exec(fact.source.locator);
      expect(match, `locator not traceable: ${fact.source.locator}`).not.toBeNull();
      const [, page, , start, end] = match!;
      const evidence = draft.text.slice(Number(start), Number(end));
      // The quoted span is a real line of the document, and the fact's wording came from it.
      expect(draft.lines.some((l) => l.text === evidence)).toBe(true);
      expect(evidence).toContain(fact.value);
      expect(Number(page)).toBe(1);
      expect(fact.approvalStatus).toBe("pending");
    }
  });

  it("emits no employment fact from a three-line entry rather than guessing one", () => {
    // "Umbral Defence Partners" / "Security Analyst, Tier 2" / "May 2022 - Present" are three
    // separate lines. The importer reads an employer, a title and a date range from ONE line,
    // so it takes nothing here. Under-extraction is the intended failure; invention is not.
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    expect(runImport({ intakeDir: writeDrafts([rebuilt()]), out, candidateId: "c", force: false }, () => {})).toBe(0);
    const profile = JSON.parse(readFileSync(out, "utf-8")) as { facts: Array<{ kind: string }> };
    expect(profile.facts.filter((f) => f.kind === "employment")).toEqual([]);
  });
});

describe("employment from the parser's reading", () => {
  // A three-line entry as the two-column fixture prints it, with the spans the parser reports.
  const THREE_LINE = [
    "Perpetua Vanterpool-Oyelaran",
    "SOC Analyst",
    "SKILLS",
    "Splunk",
    "Microsoft Sentinel",
    "KQL",
    "Incident triage",
    "EDUCATION",
    "Bachelor of Science",
    "Information Security",
    "Marchmont College, 2020",
    "EXPERIENCE",
    "Umbral Defence Partners",
    "Security Analyst, Tier 2",
    "May 2022 - Present",
    "Investigated endpoint alerts in Splunk and wrote incident findings.",
    "Assisted the response lead during two confirmed intrusions.",
  ];

  const span = (text: string, quote: string): { start: number; end: number; quote: string } => {
    const start = text.indexOf(quote);
    expect(start, `quote not in text: ${quote}`).toBeGreaterThanOrEqual(0);
    return { start, end: start + quote.length, quote };
  };

  function withEmployment(
    overrides: Partial<EmploymentCandidate> = {},
    refused: IntakeDraft["reading"]["refused"] = [],
    lines: string[] = THREE_LINE,
  ): IntakeDraft {
    const draft = makeDraft({ documentId: "doc-e000000000e1" }, [lines]);
    const text = draft.text;
    const candidate: EmploymentCandidate = {
      employer: "Umbral Defence Partners",
      title: "Security Analyst, Tier 2",
      start: { precision: "month", value: "2022-05" },
      end: { precision: "present", value: null },
      evidence: span(text, "Umbral Defence Partners\nSecurity Analyst, Tier 2\nMay 2022 - Present"),
      employerEvidence: span(text, "Umbral Defence Partners"),
      titleEvidence: span(text, "Security Analyst, Tier 2"),
      confidence: "high",
      ambiguity: [],
      page: 0,
      ...overrides,
    };
    draft.reading = { ...draft.reading, parserRevision: "marker-deterministic-v2", employment: [candidate], refused };
    return draft;
  }

  const importFrom = (drafts: IntakeDraft[]): { facts: Array<{ kind: string; value: string; attributes: Record<string, unknown>; notes?: string; source: { locator: string } }>; issues: string[] } => {
    const issues: string[] = [];
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const code = runImport({ intakeDir: writeDrafts(drafts), out, candidateId: "c", force: false }, (l) => issues.push(l));
    expect(code).toBe(0);
    return { facts: JSON.parse(readFileSync(out, "utf-8")).facts, issues };
  };

  it("imports a three-line entry the single-line rule could never read", () => {
    const { facts } = importFrom([withEmployment()]);
    const employment = facts.filter((f) => f.kind === "employment");
    expect(employment).toHaveLength(1);
    expect(employment[0]!.value).toBe("Umbral Defence Partners — Security Analyst, Tier 2");
    expect(employment[0]!.attributes).toMatchObject({
      employer: "Umbral Defence Partners",
      title: "Security Analyst, Tier 2",
      startDate: "2022-05",
      endDate: null,
    });
    // Still nothing inferred about what the role counts as.
    expect(employment[0]!.attributes.roleTags).toBeUndefined();
  });

  it("locates the fact by the span the parser quoted", () => {
    const draft = withEmployment();
    const { facts } = importFrom([draft]);
    const fact = facts.find((f) => f.kind === "employment")!;
    const match = /^page (\d+), chars (\d+)-(\d+)$/.exec(fact.source.locator);
    expect(match).not.toBeNull();
    const [, page, start, end] = match!;
    expect(page).toBe("1");
    expect(draft.text.slice(Number(start), Number(end))).toBe(draft.reading.employment[0]!.evidence.quote);
  });

  it("refuses a year-only range rather than inventing the month the profile schema needs", () => {
    // candidate-profile.ts requires YYYY-MM on an employment fact. The document said "2019 - 2022",
    // so the entry is reported with its dates verbatim and left for a person.
    const { facts, issues } = importFrom([
      withEmployment({ start: { precision: "year", value: "2019" }, end: { precision: "year", value: "2022" } }),
    ]);
    expect(facts.filter((f) => f.kind === "employment")).toEqual([]);
    const log = issues.join("\n");
    expect(log).toContain("is dated 2019 to 2022");
    expect(log).toContain("no month was invented");
    // The run completes (importFrom asserts exit 0); the entry is simply absent, and said so.
    expect(facts.every((f) => f.kind !== "employment")).toBe(true);
  });

  it("keeps a month start with a year-only end, recording the end verbatim", () => {
    const { facts } = importFrom([
      withEmployment({ start: { precision: "month", value: "2019-04" }, end: { precision: "year", value: "2022" } }),
    ]);
    const fact = facts.find((f) => f.kind === "employment")!;
    expect(fact.attributes.startDate).toBe("2019-04");
    expect(fact.attributes.endDate).toBeUndefined();
    expect(fact.attributes.detail).toBe("End date as printed: 2022 (year precision; no month is recorded)");
    expect(fact.notes).toContain("end date is year-precision");
  });

  it("carries the parser's own doubt into the fact instead of hiding it", () => {
    const { facts } = importFrom([
      withEmployment({ confidence: "medium", ambiguity: ["No separator or emphasis in the source line; employer and title were split where the title keywords end. Verify the split."] }),
    ]);
    const fact = facts.find((f) => f.kind === "employment")!;
    expect(fact.notes).toContain("Verify the split");
    expect(fact.notes).toContain("Parser confidence medium");
    expect(fact.notes).toContain("marker-deterministic-v2");
  });

  it("reports a refused entry as a note and imports no fact for it", () => {
    const { facts, issues } = importFrom([
      withEmployment({}, [
        { code: "EMPLOYMENT_ROLE_AMBIGUOUS", message: "Employer and title could not be told apart by title keywords; record not imported.", start: 10, end: 60, page: 0 },
      ]),
    ]);
    expect(facts.filter((f) => f.kind === "employment")).toHaveLength(1); // the good one only
    const log = issues.join("\n");
    expect(log).toContain("EMPLOYMENT_ROLE_AMBIGUOUS");
    expect(log).toContain("page 1, chars 10-60");
  });

  it("refuses a month-level inversion the parser's year check cannot see, without failing the batch", () => {
    const bad = withEmployment({ start: { precision: "month", value: "2022-05" }, end: { precision: "month", value: "2022-01" } });
    const good = makeDraft({ documentId: "doc-e000000000e2" });
    const { facts, issues } = importFrom([bad, good]);
    expect(facts.filter((f) => f.kind === "employment").map((f) => f.attributes.employer)).toEqual(["Thistledown Analytics"]);
    expect(issues.join("\n")).toContain("ends before it starts");
    // The second document still imported: one bad record does not take the run down.
    expect(facts.some((f) => f.value === "Playwright")).toBe(true);
  });

  it("does not import the same job twice when a line also happens to match", () => {
    // The single-line form AND a parser reading for the same job: exactly one fact.
    const draft = makeDraft({ documentId: "doc-e000000000e3" });
    const text = draft.text;
    draft.reading = {
      ...draft.reading,
      parserRevision: "marker-deterministic-v2",
      employment: [
        {
          employer: "Thistledown Analytics",
          title: "Senior QA Engineer",
          start: { precision: "month", value: "2021-03" },
          end: { precision: "present", value: null },
          evidence: span(text, "Thistledown Analytics - Senior QA Engineer March 2021 - Present"),
          employerEvidence: span(text, "Thistledown Analytics"),
          titleEvidence: span(text, "Senior QA Engineer"),
          confidence: "high",
          ambiguity: [],
          page: 0,
        },
      ],
      refused: [],
    };
    const { facts } = importFrom([draft]);
    expect(facts.filter((f) => f.kind === "employment")).toHaveLength(1);
    expect(facts.find((f) => f.kind === "employment")!.source.locator).toMatch(/^page 1, chars /);
  });

  it("catches an employment quote that no longer matches the text it claims", () => {
    const draft = withEmployment();
    draft.reading.employment[0]!.employerEvidence = { start: 0, end: 10, quote: "Fabricated" };
    expect(verifyReadingSpans(draft).map((p) => p.code)).toContain("SPAN_MISMATCH");
    const result = loadIntakeDrafts(writeDrafts([draft]), { sha256 });
    expect(result.usable).toEqual([]);
  });

  it("catches an employer that is not inside its own evidence", () => {
    const draft = withEmployment({ employer: "Someone Else Entirely" });
    expect(verifyReadingSpans(draft).some((p) => p.detail.includes("not inside its own evidence"))).toBe(true);
  });

  it("refuses a draft whose year-only date smuggles in a month", () => {
    const draft = withEmployment({ start: { precision: "year", value: "2019-04" }, end: { precision: "year", value: "2022" } });
    expect(intakeDraftSchema.safeParse(draft).success).toBe(false);
  });

  it("leaves the .docx path on its own line rule", () => {
    // No employment reading: the single-line rule is what reads this, as it always did.
    const result = buildPendingFacts(
      [{ name: "Resume_A.docx", paragraphs: ["PROFESSIONAL EXPERIENCE", "Acme Corp — QA Engineer\tJanuary 2020 – March 2022"] }],
      { candidateId: "cand-1", importedAt: "2026-10-28T00:00:00Z" },
    );
    const employment = result.profile.facts.filter((f) => f.kind === "employment");
    expect(employment).toHaveLength(1);
    expect(employment[0]!.attributes).toMatchObject({ employer: "Acme Corp", title: "QA Engineer", startDate: "2020-01", endDate: "2022-03" });
    expect(employment[0]!.source.locator).toBe("paragraph 2");
  });
});

describe("skills, education, certifications and projects from the reading", () => {
  const LINES = [
    "Ignatius Fairweather-Mbeki",
    "PROFESSIONAL SUMMARY",
    "Security engineer building detection tooling and graph analytics.",
    "SKILLS",
    "Detection: Sigma, YARA",
    "PROFESSIONAL EXPERIENCE",
    "Umbral Defence Partners - Detection Engineer March 2021 - Present",
    "PROJECTS",
    "Threat Graph Explorer",
    "EDUCATION",
    "Master of Science",
    "Marchmont College, 2018",
    "CERTIFICATIONS",
    "GIAC Certified Detection Analyst",
  ];

  const at = (text: string, quote: string): EvidenceSpan => {
    const start = text.indexOf(quote);
    expect(start, `quote not in text: ${quote}`).toBeGreaterThanOrEqual(0);
    return { start, end: start + quote.length, quote };
  };

  function draftWithReading(overrides: Partial<IntakeDraft["reading"]> = {}): IntakeDraft {
    const draft = makeDraft({ documentId: "doc-f000000000f1" }, [LINES]);
    const t = draft.text;
    draft.reading = {
      parserRevision: "marker-deterministic-v2",
      employment: [],
      skills: [
        { value: "Sigma", canonical: null, category: "Detection", evidence: at(t, "Sigma"), confidence: "high", ambiguity: [], page: 0 },
        { value: "YARA", canonical: null, category: "Detection", evidence: at(t, "YARA"), confidence: "high", ambiguity: [], page: 0 },
      ],
      education: [
        {
          degree: "Master of Science",
          institution: "Marchmont College",
          graduation: { precision: "year", value: "2018" },
          evidence: at(t, "Master of Science"),
          institutionEvidence: at(t, "Marchmont College"),
          confidence: "high",
          ambiguity: [],
          page: 0,
        },
      ],
      certifications: [{ name: "GIAC Certified Detection Analyst", evidence: at(t, "GIAC Certified Detection Analyst"), confidence: "high", ambiguity: [], page: 0 }],
      projects: [
        {
          name: "Threat Graph Explorer",
          description: "Maps technique coverage across a detection library.",
          technologies: ["Python", "NetworkX", "MITRE ATT&CK"],
          url: "github.com/example/threat-graph",
          start: null,
          end: null,
          evidence: at(t, "Threat Graph Explorer"),
          confidence: "high",
          ambiguity: [],
          page: 0,
        },
      ],
      refused: [],
      ...overrides,
    };
    return draft;
  }

  const factsOf = (draft: IntakeDraft): Array<{ kind: string; value: string; attributes: Record<string, unknown>; notes?: string; approvalStatus: string; source: { locator: string } }> => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    expect(runImport({ intakeDir: writeDrafts([draft]), out, candidateId: "c", force: false }, () => {})).toBe(0);
    return JSON.parse(readFileSync(out, "utf-8")).facts;
  };

  it("imports a skill with the group label the document printed, and no proficiency", () => {
    const facts = factsOf(draftWithReading());
    const skills = facts.filter((f) => f.kind === "skill");
    expect(skills.map((f) => f.value)).toEqual(["Sigma", "YARA"]);
    for (const skill of skills) {
      expect(skill.notes).toContain('Listed under "Detection"');
      expect(skill.notes).toContain("not evidence of years of use");
      expect(skill.attributes.matchTerms).toBeUndefined();
      expect(skill.attributes.experienceIds).toBeUndefined();
      expect(skill.approvalStatus).toBe("pending");
    }
  });

  it("says so when no group label was printed", () => {
    const draft = draftWithReading({
      skills: [{ value: "Sigma", canonical: null, category: null, evidence: { start: 0, end: 5, quote: "Ignat".slice(0, 5) }, confidence: "high", ambiguity: [], page: 0 }],
    });
    draft.reading.skills[0]!.evidence = { start: draft.text.indexOf("Sigma"), end: draft.text.indexOf("Sigma") + 5, quote: "Sigma" };
    const skill = factsOf(draft).find((f) => f.kind === "skill")!;
    expect(skill.notes).toContain("No group label was printed");
  });

  it("records the institution and graduation as printed, inventing neither", () => {
    const education = factsOf(draftWithReading()).find((f) => f.kind === "education")!;
    expect(education.value).toBe("Master of Science");
    expect(education.attributes.detail).toBe("institution: Marchmont College; graduation as printed: 2018");
    expect(education.notes).toContain("year-precision");
  });

  it("says when the document did not state an institution or a graduation date", () => {
    const draft = draftWithReading();
    draft.reading.education[0] = { ...draft.reading.education[0]!, institution: null, institutionEvidence: null, graduation: null };
    const education = factsOf(draft).find((f) => f.kind === "education")!;
    expect(education.attributes.detail).toBe("institution not stated separately on the document; no graduation date stated");
  });

  it("imports a certification name without inventing its date", () => {
    const certification = factsOf(draftWithReading()).find((f) => f.kind === "certification")!;
    expect(certification.value).toBe("GIAC Certified Detection Analyst");
    expect(certification.attributes.detail).toBeUndefined();
    expect(certification.notes).toContain("add it when approving");
  });

  it("imports a project with the technologies the document listed and its link", () => {
    const project = factsOf(draftWithReading()).find((f) => f.kind === "project")!;
    expect(project.value).toBe("Threat Graph Explorer");
    expect(project.attributes.technologies).toEqual(["Python", "NetworkX", "MITRE ATT&CK"]);
    expect(project.attributes.detail).toBe("link as printed: github.com/example/threat-graph");
    expect(project.notes).toContain("never counted as professional employment years");
  });

  it("leaves a project's technologies empty when the document listed none", () => {
    const draft = draftWithReading();
    draft.reading.projects[0] = { ...draft.reading.projects[0]!, technologies: [], url: null };
    const project = factsOf(draft).find((f) => f.kind === "project")!;
    expect(project.attributes.technologies).toBeUndefined();
    expect(project.notes).toContain("none were inferred");
  });

  it("gives every fact a locator that re-slices to its own evidence", () => {
    const draft = draftWithReading();
    const facts = factsOf(draft);
    expect(facts.length).toBeGreaterThanOrEqual(5);
    for (const fact of facts) {
      const match = /^page (\d+), chars (\d+)-(\d+)$/.exec(fact.source.locator);
      expect(match, `locator not traceable: ${fact.source.locator}`).not.toBeNull();
      const evidence = draft.text.slice(Number(match![2]), Number(match![3]));
      expect(evidence.includes(fact.value) || fact.value.includes(evidence)).toBe(true);
    }
  });

  it("carries the parser's doubt into the fact", () => {
    const draft = draftWithReading();
    draft.reading.skills[0] = { ...draft.reading.skills[0]!, confidence: "medium", ambiguity: ["Label glued to the previous item by Markdown; boundary uncertain."] };
    const skill = factsOf(draft).find((f) => f.value === "Sigma")!;
    expect(skill.notes).toContain("boundary uncertain");
    expect(skill.notes).toContain("Parser confidence medium");
  });

  it("stands the template line rules down so nothing is imported twice", () => {
    // The document has a "SKILLS" section the template rule would also read. With a reading
    // present, only the reading's values arrive.
    const facts = factsOf(draftWithReading());
    expect(facts.filter((f) => f.kind === "skill").map((f) => f.value)).toEqual(["Sigma", "YARA"]);
  });

  it("catches a skill, degree, certification or project name that is not inside its own evidence", () => {
    const draft = draftWithReading();
    draft.reading.skills[0] = { ...draft.reading.skills[0]!, value: "Fabricated Skill" };
    draft.reading.certifications[0] = { ...draft.reading.certifications[0]!, name: "Fabricated Certification" };
    const problems = verifyReadingSpans(draft).map((p) => p.detail);
    expect(problems.some((d) => d.includes("skill 0") && d.includes("not inside its own evidence"))).toBe(true);
    expect(problems.some((d) => d.includes("certification 0") && d.includes("not inside its own evidence"))).toBe(true);
    expect(loadIntakeDrafts(writeDrafts([draft]), { sha256 }).usable).toEqual([]);
  });

  it("catches an education institution quote that does not match the text", () => {
    const draft = draftWithReading();
    draft.reading.education[0] = { ...draft.reading.education[0]!, institutionEvidence: { start: 0, end: 8, quote: "Elsewhere" } };
    expect(verifyReadingSpans(draft).some((p) => p.detail.includes("education 0 institution"))).toBe(true);
  });

  it("refuses a draft whose graduation date smuggles a month into a year", () => {
    const draft = draftWithReading();
    draft.reading.education[0] = { ...draft.reading.education[0]!, graduation: { precision: "year", value: "2018-06" } };
    expect(intakeDraftSchema.safeParse(draft).success).toBe(false);
  });
});

describe("cross-candidate isolation", () => {
  // Two unrelated people whose resumes hold byte-identical employment, skills and education.
  // Nothing about one may appear in the other's profile, and the two must stay two candidates.
  const SHARED = [
    "PROFESSIONAL SUMMARY",
    "Platform engineer working on release tooling and shared infrastructure.",
    "TECHNICAL SKILLS",
    "Automation: Terraform, Kubernetes",
    "PROFESSIONAL EXPERIENCE",
    "Pallisade Cloudworks - Staff Platform Engineer January 2022 - Present",
    "EDUCATION",
    "Bachelor of Engineering - Marchmont College, 2019",
    "CERTIFICATIONS",
    "Certified Kubernetes Administrator - 2021",
  ];

  const twoCandidates = (): IntakeDraft[] => [
    makeDraft({ documentId: "doc-aaaa0000aaaa", candidateId: "cand-aaaa0000aaaa", sourceSha256: "1".repeat(64) }, [SHARED]),
    makeDraft({ documentId: "doc-bbbb0000bbbb", candidateId: "cand-bbbb0000bbbb", sourceSha256: "2".repeat(64) }, [SHARED]),
  ];

  function importPerCandidate(drafts: IntakeDraft[], force = false): { dir: string; profiles: Array<{ candidateId: string; facts: Array<{ factId: string; kind: string; value: string; notes?: string; source: { reference: string } }> }>; log: string; code: number } {
    const outDir = mkdtempSync(path.join(tmpdir(), "jh-candidates-"));
    const lines: string[] = [];
    const code = runImport(
      { intakeDir: writeDrafts(drafts), out: "unused", outDir, candidateId: "ignored", force, perCandidate: true },
      (l) => lines.push(l),
    );
    const profiles = readdirSync(outDir)
      .filter((f) => f.endsWith(".pending-facts.json")) // private-isolation: allow
      .map((f) => JSON.parse(readFileSync(path.join(outDir, f), "utf-8")));
    return { dir: outDir, profiles, log: lines.join("\n"), code };
  }

  it("keeps two candidates with identical employment as two separate records", () => {
    const { profiles, code } = importPerCandidate(twoCandidates());
    expect(code).toBe(0);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.candidateId).sort()).toEqual(["cand-aaaa0000aaaa", "cand-bbbb0000bbbb"]);

    for (const profile of profiles) {
      const employment = profile.facts.filter((f) => f.kind === "employment");
      expect(employment).toHaveLength(1);
      // Each candidate owns its own copy, sourced from its own document.
      expect(employment[0]!.value).toBe("Pallisade Cloudworks — Staff Platform Engineer");
    }
    const [first, second] = profiles;
    expect(first!.facts[0]!.source.reference).not.toBe(second!.facts[0]!.source.reference);
  });

  it("never merges a fact across two candidates", () => {
    const { profiles, log } = importPerCandidate(twoCandidates());
    // The merge note is how a within-candidate duplicate is recorded. It must not appear here.
    for (const profile of profiles) {
      for (const fact of profile.facts) expect(fact.notes ?? "").not.toContain("Also appears in");
    }
    expect(log).toContain("no fact is shared between two of them");
  });

  it("gives every fact exactly one candidate", () => {
    const { profiles } = importPerCandidate(twoCandidates());
    const owners = new Map<string, string[]>();
    for (const profile of profiles) {
      for (const fact of profile.facts) {
        const key = `${profile.candidateId}|${fact.factId}`;
        owners.set(key, [...(owners.get(key) ?? []), profile.candidateId]);
      }
    }
    expect([...owners.values()].every((list) => list.length === 1)).toBe(true);
    // The same factId exists under both candidates, and that is correct: they are different facts.
    const ids = profiles.map((p) => p.facts.map((f) => f.factId).sort());
    expect(ids[0]).toEqual(ids[1]);
    expect(profiles[0]!.candidateId).not.toBe(profiles[1]!.candidateId);
  });

  it("keeps deduplication working inside one candidate", () => {
    // The same skill printed twice in one document is still one fact for that candidate.
    const twice = makeDraft({ documentId: "doc-cccc0000cccc", candidateId: "cand-cccc0000cccc" }, [[
      ...SHARED,
      "TECHNICAL SKILLS",
      "Automation: Terraform, Kubernetes",
    ]]);
    const { profiles } = importPerCandidate([twice]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.facts.filter((f) => f.value === "Terraform")).toHaveLength(1);
  });

  it("refuses to overwrite a candidate's existing profile without --force", () => {
    const drafts = twoCandidates();
    const outDir = mkdtempSync(path.join(tmpdir(), "jh-candidates-"));
    const intake = writeDrafts(drafts);
    const first: string[] = [];
    expect(runImport({ intakeDir: intake, out: "unused", outDir, candidateId: "x", force: false, perCandidate: true }, (l) => first.push(l))).toBe(0);
    writeFileSync(path.join(outDir, "cand-aaaa0000aaaa.pending-facts.json"), "REVIEWED APPROVALS", "utf-8"); // private-isolation: allow
    const second: string[] = [];
    runImport({ intakeDir: intake, out: "unused", outDir, candidateId: "x", force: false, perCandidate: true }, (l) => second.push(l));
    expect(readFileSync(path.join(outDir, "cand-aaaa0000aaaa.pending-facts.json"), "utf-8")).toBe("REVIEWED APPROVALS"); // private-isolation: allow
    expect(second.join("\n")).toContain("refusing to overwrite an existing profile");
  });

  it("needs an output directory", () => {
    const lines: string[] = [];
    expect(runImport({ intakeDir: writeDrafts(twoCandidates()), out: "x.json", candidateId: "x", force: false, perCandidate: true }, (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toContain("--out-dir");
  });

  it("still collects one person's several documents into one profile by default", () => {
    // The default behaviour is unchanged: two documents of the SAME candidate share a profile,
    // and a fact found in both is one fact that says where else it appeared.
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    expect(runImport({ intakeDir: writeDrafts(twoCandidates()), out, candidateId: "cand-one-person", force: false, perCandidate: false }, () => {})).toBe(0);
    const profile = JSON.parse(readFileSync(out, "utf-8")) as { candidateId: string; facts: Array<{ kind: string; notes?: string }> };
    expect(profile.candidateId).toBe("cand-one-person");
    expect(profile.facts.filter((f) => f.kind === "employment")).toHaveLength(1);
    expect(profile.facts.some((f) => (f.notes ?? "").includes("Also appears in"))).toBe(true);
  });
});

describe("private path rules", () => {
  it("refuses a target inside a Git checkout", () => {
    const codes = checkPrivateTarget(path.join(process.cwd(), "private-runtime", "x.json")).map((p) => p.code);
    expect(codes).toContain("INSIDE_GIT_CHECKOUT");
  });

  it("accepts a target under the configured private root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jh-private-"));
    const problems = checkPrivateTarget(path.join(root, "facts", "pending.json"), { requirePrivateRoot: true, env: { JH_PRIVATE_ROOT: root } });
    expect(problems).toEqual([]);
  });

  it("refuses a target outside the configured private root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jh-private-"));
    const elsewhere = mkdtempSync(path.join(tmpdir(), "jh-elsewhere-"));
    const codes = checkPrivateTarget(path.join(elsewhere, "pending.json"), { env: { JH_PRIVATE_ROOT: root } }).map((p) => p.code);
    expect(codes).toEqual(["OUTSIDE_PRIVATE_ROOT"]);
  });

  it("treats a path as inside its own root and not inside a sibling", () => {
    expect(isInside("F:/JobHunterPrivate", "F:/JobHunterPrivate/drafts/a.json")).toBe(true);
    expect(isInside("F:/JobHunterPrivate", "F:/JobHunterPrivateOther/a.json")).toBe(false);
  });
});

describe("candidate:import with PDFs", () => {
  function sourceDirWithPdf(bytes = Buffer.from("%PDF-1.4 synthetic bytes, never parsed by TypeScript")) {
    const dir = mkdtempSync(path.join(tmpdir(), "jh-src-"));
    writeFileSync(path.join(dir, "Synthetic Profile (3).pdf"), bytes);
    return { dir, sha: createHash("sha256").update(bytes).digest("hex") };
  }

  it("refuses to read a PDF itself and names the worker command instead", () => {
    const { dir } = sourceDirWithPdf();
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const lines: string[] = [];
    expect(runImport({ resumesDir: dir, out, candidateId: "c", force: false }, (l) => lines.push(l))).toBe(3);
    expect(existsSync(out)).toBe(false);
    expect(lines.join("\n")).toContain("local_intake_cli.py");
  });

  it("imports the draft that matches the PDF and ignores a draft for another document", () => {
    const { dir, sha } = sourceDirWithPdf();
    const matching = makeDraft({ sourceSha256: sha });
    const unrelated = makeDraft({ documentId: "doc-cccccccccccc", sourceSha256: "d".repeat(64) });
    const intake = writeDrafts([matching, unrelated]);
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const lines: string[] = [];
    expect(runImport({ resumesDir: dir, intakeDir: intake, out, candidateId: "c", force: false }, (l) => lines.push(l))).toBe(0);
    const profile = JSON.parse(readFileSync(out, "utf-8"));
    expect(profile.facts.every((f: { source: { reference: string } }) => f.source.reference === "doc-0123456789ab")).toBe(true);
    expect(lines.join("\n")).not.toContain("Synthetic Profile");
  });

  it("refuses to write PDF-derived facts inside a Git checkout", () => {
    const intake = writeDrafts([makeDraft()]);
    const out = path.join(process.cwd(), "private-runtime", "intake-test", "pending.json");
    const lines: string[] = [];
    expect(runImport({ intakeDir: intake, out, candidateId: "c", force: false }, (l) => lines.push(l))).toBe(4);
    expect(existsSync(out)).toBe(false);
    expect(lines.join("\n")).toContain("INSIDE_GIT_CHECKOUT");
  });

  it("reports a low-confidence draft loudly and still imports nothing as approved", () => {
    const draft = makeDraft({ status: "LOW_TEXT_CONFIDENCE", warnings: ["POSSIBLE_MULTI_COLUMN"] });
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const lines: string[] = [];
    expect(runImport({ intakeDir: writeDrafts([draft]), out, candidateId: "c", force: false }, (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("LOW_TEXT_CONFIDENCE");
    expect(lines.join("\n")).toContain("POSSIBLE_MULTI_COLUMN");
    expect(JSON.parse(readFileSync(out, "utf-8")).facts.every((f: { approvalStatus: string }) => f.approvalStatus === "pending")).toBe(true);
  });

  it("stops when no draft is importable rather than writing an empty profile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jh-drafts-"));
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const log = vi.fn();
    expect(runImport({ intakeDir: dir, out, candidateId: "c", force: false }, log)).toBe(2);
    expect(existsSync(out)).toBe(false);
  });

  it("combines .docx resumes and PDF drafts in one pending file, each keeping its own locator shape", () => {
    const resumeDir = mkdtempSync(path.join(tmpdir(), "jh-src-"));
    mkdirSync(path.join(resumeDir, "SDET"), { recursive: true });
    writeFileSync(
      path.join(resumeDir, "SDET", "Resume_SDET.docx"),
      buildDocx(["TECHNICAL SKILLS", "Languages: Kotlin, Groovy", "PROFESSIONAL EXPERIENCE", "Fernbrook Systems — QA Analyst\tJune 2018 – February 2021"]),
    );
    const out = path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "pending.json");
    const lines: string[] = [];
    expect(runImport({ resumesDir: resumeDir, intakeDir: writeDrafts([makeDraft()]), out, candidateId: "c", force: false }, (l) => lines.push(l))).toBe(0);

    const profile = JSON.parse(readFileSync(out, "utf-8")) as { facts: Array<{ kind: string; value: string; source: { reference: string; locator: string } }> };
    const fromDocx = profile.facts.filter((f) => f.source.reference === "Resume_SDET.docx");
    const fromPdf = profile.facts.filter((f) => f.source.reference === "doc-0123456789ab");
    expect(fromDocx.length).toBeGreaterThan(0);
    expect(fromPdf.length).toBeGreaterThan(0);
    // The .docx path is untouched: paragraph numbers, as before.
    expect(fromDocx.every((f) => /^paragraph \d+$/.test(f.source.locator))).toBe(true);
    expect(fromPdf.every((f) => /^page \d+, line \d+, chars \d+-\d+$/.test(f.source.locator))).toBe(true);
    expect(profile.facts.some((f) => f.value === "Kotlin")).toBe(true);
    expect(profile.facts.some((f) => f.value === "Playwright")).toBe(true);
  });
});

describe("worker invocation", () => {
  it("passes Windows paths with spaces and parentheses as argv, with no shell quoting", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcome = runIntakeWorker(
      {
        python: "F:\\repo\\services\\ai\\.venv\\Scripts\\python.exe",
        script: "services/ai/local_intake_cli.py",
        inputDir: "F:\\My Documents\\Profiles (private)",
        outDir: "F:\\JobHunterPrivate\\drafts",
        force: true,
      },
      (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: "STATUS EXTRACTED=1\n", stderr: "" };
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "-I",
      "services/ai/local_intake_cli.py",
      "--out-dir",
      "F:\\JobHunterPrivate\\drafts",
      "--input-dir",
      "F:\\My Documents\\Profiles (private)",
      "--force",
    ]);
    expect(outcome).toEqual({ status: 0, lines: ["STATUS EXTRACTED=1"] });
  });

  it("reports a non-zero worker exit", () => {
    const outcome = runIntakeWorker(
      { python: "python", script: "s.py", outDir: "F:\\JobHunterPrivate\\drafts", files: ["a.pdf", "b.pdf"] },
      () => ({ status: 3, stdout: "", stderr: "DEPENDENCY_UNAVAILABLE missing=pdfplumber\n" }),
    );
    expect(outcome.status).toBe(3);
    expect(outcome.lines).toEqual(["DEPENDENCY_UNAVAILABLE missing=pdfplumber"]);
  });
});

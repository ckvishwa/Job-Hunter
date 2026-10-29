import { inflateRawSync } from "node:zlib";
import {
  CANDIDATE_PROFILE_SCHEMA_VERSION,
  parseCandidateProfile,
  type CandidateFact,
  type CandidateProfile,
} from "../domain/candidate-profile.js";

// Resume import: turns the candidate's own .docx resumes into a REVIEWABLE file of PENDING facts.
//
// Intended use of those resumes (checked before importing): they are the finished, per-profile application
// documents (one resume and one cover letter per profile), not a fact database, and several fields are still
// template placeholders ([FULL NAME], [Degree], [Month Year]). So the importer:
//   - reads resumes only (never cover letters), and keeps no contact details, summary text or bullet claims;
//   - emits facts as `pending` with null verification: nothing it produces can satisfy a requirement until a
//     person approves each fact (see docs/STATUS.md for the review steps);
//   - copies wording verbatim (skills, employer, title, project names, technologies) and never fabricates a
//     year count, a role tag, a proficiency or a sensitive answer;
//   - skips (and reports) anything containing an unfilled [placeholder] or an unparseable date.
// It is deterministic and local: no model, no network.

// ---------------------------------------------------------------------------
// .docx reading (zip central directory + raw DEFLATE; no dependency)
// ---------------------------------------------------------------------------

function readZipEntry(zip: Buffer, wanted: string): Buffer | null {
  // End of central directory record.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip/docx file (no end-of-central-directory record)");
  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf-8", offset + 46, offset + 46 + nameLen);
    if (name === wanted) {
      const localNameLen = zip.readUInt16LE(localOffset + 26);
      const localExtraLen = zip.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Paragraph texts of a .docx, in order. Tabs inside a paragraph are kept as "\t". */
export function readDocxParagraphs(bytes: Buffer): string[] {
  const xml = readZipEntry(bytes, "word/document.xml");
  if (!xml) throw new Error("word/document.xml not found in the .docx");
  const paragraphs = xml.toString("utf-8").match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragraphs.map((p) => {
    let text = "";
    // `<w:t` must not match `<w:tab`, `<w:tabs>`, `<w:tbl>`: the element name is followed by whitespace or `>`.
    const tokens = p.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:tab\/>/g) ?? [];
    for (const token of tokens) {
      text += token === "<w:tab/>" ? "\t" : decodeXml(token.replace(/^<w:t(?:\s[^>]*)?>/, "").replace(/<\/w:t>$/, ""));
    }
    return text;
  });
}

// ---------------------------------------------------------------------------
// Pending-fact extraction
// ---------------------------------------------------------------------------

/** A date as precise as the document was: a year-only date never carries a month. */
export interface EmploymentDate {
  precision: "year" | "month" | "present";
  value: string | null;
}

export interface EvidenceSpan {
  /** UTF-16 code units into the document's canonical extracted text. */
  start: number;
  end: number;
  quote: string;
}

/**
 * One employment entry proposed by the deterministic resume parser
 * (`services/ai/app/parse_markdown.py`), which groups an entry spread over several lines and
 * decides which side is the title from its keywords. Every field quotes the document.
 */
export interface EmploymentCandidate {
  employer: string;
  title: string;
  start: EmploymentDate;
  end: EmploymentDate;
  evidence: EvidenceSpan;
  employerEvidence: EvidenceSpan;
  titleEvidence: EvidenceSpan;
  confidence: "high" | "medium" | "low";
  /** Why the reader should check this record, in the parser's own words. Empty when there is nothing to flag. */
  ambiguity: string[];
  page: number | null;
}

/** An entry the parser would not import. Reported so a refusal is visible, not missing. */
export interface RefusedEmployment {
  code: string;
  message: string;
  start: number | null;
  end: number | null;
  page: number | null;
}

export interface SkillCandidate {
  value: string;
  /** The parser's normalized spelling where it knows one. Never a substitute for the source text. */
  canonical: string | null;
  /** The group label printed above or beside the item, when the document had one. */
  category: string | null;
  evidence: EvidenceSpan;
  confidence: "high" | "medium" | "low";
  ambiguity: string[];
  page: number | null;
}

export interface EducationCandidate {
  degree: string;
  institution: string | null;
  graduation: EmploymentDate | null;
  evidence: EvidenceSpan;
  institutionEvidence: EvidenceSpan | null;
  confidence: "high" | "medium" | "low";
  ambiguity: string[];
  page: number | null;
}

export interface CertificationCandidate {
  name: string;
  evidence: EvidenceSpan;
  confidence: "high" | "medium" | "low";
  ambiguity: string[];
  page: number | null;
}

export interface ProjectCandidate {
  name: string;
  description: string | null;
  technologies: string[];
  url: string | null;
  start: EmploymentDate | null;
  end: EmploymentDate | null;
  evidence: EvidenceSpan;
  confidence: "high" | "medium" | "low";
  ambiguity: string[];
  page: number | null;
}

/** Everything the deterministic parser proposes for one document, plus what it refused. */
export interface ResumeReading {
  parserRevision: string;
  employment: EmploymentCandidate[];
  skills: SkillCandidate[];
  education: EducationCandidate[];
  certifications: CertificationCandidate[];
  projects: ProjectCandidate[];
  refused: RefusedEmployment[];
}

export interface ResumeDocument {
  /** File name, or a pseudonymous document id for a privately extracted document. Never a directory path. */
  name: string;
  paragraphs: string[];
  /**
   * What the deterministic parser read from this document's text. When present it replaces the
   * line rules below for this document: those read the owner's own resume template, and running
   * both would import the same value twice over, once per set of rules.
   */
  reading?: ResumeReading;
  /**
   * Where paragraph `i` sits in the source document: page index and the UTF-16 span of the
   * canonical extracted text. Supplied by PDF intake; a .docx has neither, and its facts keep
   * the paragraph-number locator they have always had.
   */
  provenance?: ReadonlyArray<{ page: number | null; start: number; end: number }>;
}

export interface ImportIssue {
  file: string;
  paragraph: number | null;
  message: string;
}

export interface ImportResult {
  profile: CandidateProfile;
  issues: ImportIssue[];
  counts: Record<string, number>;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

function parseMonthYear(text: string): string | null | "invalid" {
  const t = text.trim().toLowerCase();
  if (/^(present|current|now)$/.test(t)) return null;
  const m = t.match(/^([a-z]+)\.?\s+(\d{4})$/);
  const month = m ? MONTHS[m[1]!] : undefined;
  return m && month ? `${m[2]}-${month}` : "invalid";
}

/** "Month YYYY" exactly as a resume prints it; no other date shape is accepted. */
const MONTH_YEAR = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.? \\d{4}";
/** "<Employer> — <Title> <Month YYYY> – <Month YYYY|Present>" on one line, which is how a PDF extracts it. */
const EMPLOYMENT_WITH_DATES = new RegExp(`^(.+?) [—-] (.+?) (${MONTH_YEAR}) [–-] (Present|Current|Now|${MONTH_YEAR})$`, "i");

const isHeading = (line: string): boolean => /^[A-Z][A-Z &/-]{2,}$/.test(line.trim());
const hasPlaceholder = (line: string): boolean => /\[[^\]]+\]/.test(line);
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

type AddFact = (draft: {
  kind: CandidateFact["kind"];
  value: string;
  attributes?: CandidateFact["attributes"];
  dedupeKey: string;
  file: string;
  paragraph: number;
  locator?: string;
  notes?: string;
}) => void;

/** The YYYY-MM the profile schema accepts, or undefined for any less precise date. */
const monthValue = (date: EmploymentDate): string | undefined => (date.precision === "month" && date.value ? date.value : undefined);

const printedDate = (date: EmploymentDate): string => (date.precision === "present" ? "present" : (date.value ?? "not stated"));

/**
 * Turn the parser's employment reading into pending facts.
 *
 * Dates are carried only at the precision the document stated. A year-only range cannot be
 * written as the YYYY-MM the profile schema requires, so no month is invented: the dates are
 * recorded verbatim in `detail` for the reviewer and the date attributes stay unset, which
 * keeps the fact out of any years-of-experience calculation until a person fills them in.
 */
function addEmploymentFromReading(doc: ResumeDocument, reading: ResumeReading, add: AddFact, issues: ImportIssue[]): void {
  const where = (page: number | null, start: number | null, end: number | null): string =>
    `${page === null ? "page unknown" : `page ${page + 1}`}, chars ${start ?? "?"}-${end ?? "?"}`;

  for (const refused of reading.refused) {
    // The parser considered this entry and would not import it. Saying so is the point.
    issues.push({
      file: doc.name,
      paragraph: null,
      message: `employment entry not imported (${refused.code}) at ${where(refused.page, refused.start, refused.end)}: ${refused.message}`,
    });
  }

  for (const candidate of reading.employment) {
    const start = monthValue(candidate.start);
    const end = monthValue(candidate.end);
    if (start && end && end < start) {
      // The parser compares years only, so an inverted range inside one year reaches here.
      // The profile schema would reject it and fail the whole import, so it stops at this fact.
      issues.push({
        file: doc.name,
        paragraph: null,
        message: `employment "${candidate.employer} — ${candidate.title}" is dated ${start} to ${end}, which ends before it starts; not imported, and neither date was altered`,
      });
      continue;
    }

    if (!start) {
      // An employment fact must carry a YYYY-MM start (candidate-profile.ts), and the document
      // stated only a year. Inventing a month is the one thing that must not happen, so the
      // entry is reported with its dates verbatim and a person decides what the month is.
      issues.push({
        file: doc.name,
        paragraph: null,
        message:
          `employment "${candidate.employer} — ${candidate.title}" at ${where(candidate.page, candidate.evidence.start, candidate.evidence.end)} ` +
          `is dated ${printedDate(candidate.start)} to ${printedDate(candidate.end)}, which the document gives to the year only; ` +
          "a pending employment fact needs a start month, so it was not imported and no month was invented",
      });
      continue;
    }

    const attributes: CandidateFact["attributes"] = { employer: candidate.employer, title: candidate.title, startDate: start };
    if (candidate.end.precision === "present") attributes.endDate = null;
    else if (end) attributes.endDate = end;
    else {
      // A year-only end with a month start: the end stays unset rather than rounded to a month.
      attributes.detail = `End date as printed: ${printedDate(candidate.end)} (year precision; no month is recorded)`.slice(0, 300);
    }

    const notes = [
      `Grouped by ${reading.parserRevision} from the document's own lines; employer, title and dates are quoted from it.`,
      ...candidate.ambiguity,
      candidate.confidence === "high" ? "" : `Parser confidence ${candidate.confidence}: check the employer and title are the right way round.`,
      candidate.end.precision === "year" ? "The end date is year-precision in the document and is not stored as a month; add it when approving if the document supports it." : "",
      "roleTags not set: role-years requirements cannot use this job until the candidate approves what it counts as.",
    ]
      .filter(Boolean)
      .join(" ");

    add({
      kind: "employment",
      value: `${candidate.employer} — ${candidate.title}`,
      attributes,
      dedupeKey: `${candidate.employer.toLowerCase()}|${candidate.start.value ?? candidate.start.precision}`,
      file: doc.name,
      paragraph: 0,
      locator: where(candidate.page, candidate.evidence.start, candidate.evidence.end),
      notes: notes.slice(0, 500),
    });
  }
}

/** `page N, chars A-B`, or the chars alone when the record could not be attributed to a page. */
const locatorFor = (page: number | null, span: EvidenceSpan): string =>
  `${page === null ? "page unknown" : `page ${page + 1}`}, chars ${span.start}-${span.end}`;

const printedGraduation = (date: EmploymentDate | null): string | null =>
  date === null ? null : date.precision === "present" ? "present" : date.value;

/** The parser's doubt, carried into the fact rather than dropped. */
function readingNotes(parserRevision: string, confidence: string, ambiguity: string[], extra: string[] = []): string {
  return [
    `Read by ${parserRevision} from the document's own text; the value is quoted from it.`,
    ...ambiguity,
    confidence === "high" ? "" : `Parser confidence ${confidence}: check this against the page before approving.`,
    ...extra,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 500);
}

/**
 * Every category the parser read, as pending facts.
 *
 * Each kind keeps only what the document stated. A skill carries the group label it was printed
 * under, not a proficiency; an education fact carries the institution and graduation as printed,
 * and nothing is derived when they are absent; a project carries the technologies the document
 * listed, and an empty list stays empty. Years of experience are never computed here.
 */
function addFactsFromReading(doc: ResumeDocument, reading: ResumeReading, add: AddFact, issues: ImportIssue[]): void {
  addEmploymentFromReading(doc, reading, add, issues);

  for (const skill of reading.skills) {
    add({
      kind: "skill",
      value: skill.value,
      dedupeKey: skill.value.toLowerCase(),
      file: doc.name,
      paragraph: 0,
      locator: locatorFor(skill.page, skill.evidence),
      notes: readingNotes(reading.parserRevision, skill.confidence, skill.ambiguity, [
        skill.category ? `Listed under "${skill.category}" on the document.` : "No group label was printed for this item.",
        skill.canonical && skill.canonical !== skill.value ? `The parser knows this spelling as "${skill.canonical}"; the source wording is kept.` : "",
        "No proficiency or duration is implied: a skill mention is not evidence of years of use.",
      ]),
    });
  }

  for (const record of reading.education) {
    // The schema has no institution or graduation field for an education fact, so both go into
    // `detail` exactly as printed. Neither is invented when the document did not state it.
    const printed = [
      record.institution ? `institution: ${record.institution}` : "institution not stated separately on the document",
      printedGraduation(record.graduation) ? `graduation as printed: ${printedGraduation(record.graduation)}` : "no graduation date stated",
    ].join("; ");
    add({
      kind: "education",
      value: record.degree,
      attributes: { detail: printed.slice(0, 300) },
      dedupeKey: `${record.degree.toLowerCase()}|${(record.institution ?? "").toLowerCase()}`,
      file: doc.name,
      paragraph: 0,
      locator: locatorFor(record.page, record.evidence),
      notes: readingNotes(reading.parserRevision, record.confidence, record.ambiguity, [
        record.graduation?.precision === "year" ? "The graduation date is year-precision in the document; no month is recorded." : "",
      ]),
    });
  }

  for (const record of reading.certifications) {
    add({
      kind: "certification",
      value: record.name,
      dedupeKey: record.name.toLowerCase(),
      file: doc.name,
      paragraph: 0,
      locator: locatorFor(record.page, record.evidence),
      notes: readingNotes(reading.parserRevision, record.confidence, record.ambiguity, [
        "Any issue or expiry date on the document was not kept with the name; add it when approving.",
      ]),
    });
  }

  for (const record of reading.projects) {
    const technologies = record.technologies.filter((t) => t.trim().length > 0).slice(0, 40);
    add({
      kind: "project",
      value: record.name,
      attributes: {
        ...(technologies.length ? { technologies } : {}),
        ...(record.url ? { detail: `link as printed: ${record.url}`.slice(0, 300) } : {}),
      },
      dedupeKey: record.name.toLowerCase(),
      file: doc.name,
      paragraph: 0,
      locator: locatorFor(record.page, record.evidence),
      notes: readingNotes(reading.parserRevision, record.confidence, record.ambiguity, [
        technologies.length ? "" : "The document listed no technologies for this project; none were inferred from its description.",
        "A project is never counted as professional employment years.",
      ]),
    });
  }
}

export function buildPendingFacts(documents: ResumeDocument[], options: { candidateId: string; importedAt: string }): ImportResult {
  const issues: ImportIssue[] = [];
  const facts: CandidateFact[] = [];
  const byKey = new Map<string, CandidateFact>();
  const usedIds = new Set<string>();

  const add = (draft: { kind: CandidateFact["kind"]; value: string; attributes?: CandidateFact["attributes"]; dedupeKey: string; file: string; paragraph: number; locator?: string; notes?: string }): void => {
    const existing = byKey.get(`${draft.kind}|${draft.dedupeKey}`);
    if (existing) {
      existing.notes = `${existing.notes ?? ""}${existing.notes ? " " : ""}Also appears in ${draft.file}.`.slice(0, 500);
      return;
    }
    let factId = `f-${draft.kind}-${slugify(draft.value)}`;
    for (let n = 2; usedIds.has(factId); n += 1) factId = `f-${draft.kind}-${slugify(draft.value)}-${n}`;
    usedIds.add(factId);
    const fact: CandidateFact = {
      factId,
      kind: draft.kind,
      value: draft.value,
      polarity: "has",
      attributes: draft.attributes ?? {},
      source: { kind: "resume-import", reference: draft.file, locator: (draft.locator ?? `paragraph ${draft.paragraph + 1}`).slice(0, 200) },
      verification: { verifiedBy: null, verifiedAt: null, validUntil: null },
      approvalStatus: "pending",
      sensitivity: "normal",
      ...(draft.notes ? { notes: draft.notes } : {}),
    };
    facts.push(fact);
    byKey.set(`${draft.kind}|${draft.dedupeKey}`, fact);
  };

  for (const doc of documents) {
    let section = "";
    let lastProject: { value: string; paragraph: number } | null = null;
    // A PDF-extracted document knows the page and character span each line came from; a .docx
    // has neither, and its facts keep the paragraph locator they have always had.
    const locate = (i: number): string | undefined => {
      const at = doc.provenance?.[i];
      if (!at) return undefined;
      const page = at.page === null ? "page unknown" : `page ${at.page + 1}`;
      return `${page}, line ${i + 1}, chars ${at.start}-${at.end}`;
    };
    doc.paragraphs.forEach((raw, i) => {
      const line = raw.replace(/[  ]+/g, " ").trim();
      if (!line) return;
      if (isHeading(line)) {
        section = line;
        lastProject = null;
        return;
      }

      if (section === "TECHNICAL SKILLS") {
        if (doc.reading) return;
        const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
        if (!m) return;
        for (const item of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (hasPlaceholder(item)) continue;
          add({ kind: "skill", value: item, dedupeKey: item.toLowerCase(), file: doc.name, paragraph: i, locator: locate(i), notes: `Listed under "${m[1]!.trim()}" on the resume. Comma-split verbatim: reject fragments that are not a skill on their own.` });
        }
        return;
      }

      if (section === "PROFESSIONAL EXPERIENCE") {
        // A document that brought its own reading uses that instead: running both would
        // import the same job twice over, once per set of rules.
        if (doc.reading) return;
        // Tab-separated is the .docx shape. A PDF text layer has no tab character, so the second
        // form anchors on an explicit "Month YYYY - Month YYYY|Present" range. A line whose dates
        // are not stated in that form is left for the reviewer, never guessed.
        const m = line.match(/^(.+?) [—-] (.+?)\t(.+?) [–-] (.+)$/) ?? line.match(EMPLOYMENT_WITH_DATES);
        if (!m) return; // bullets and wrapped text are not imported
        if (hasPlaceholder(line)) {
          issues.push({ file: doc.name, paragraph: i + 1, message: "employment line has an unfilled placeholder; not imported" });
          return;
        }
        const start = parseMonthYear(m[3]!);
        const end = parseMonthYear(m[4]!);
        if (start === null || start === "invalid" || end === "invalid") {
          issues.push({ file: doc.name, paragraph: i + 1, message: `employment dates "${m[3]} - ${m[4]}" could not be parsed; not imported` });
          return;
        }
        // A range that ends before it starts is a contradiction the profile schema refuses, and
        // refusing it one fact at a time beats failing the whole import. Which of the two dates
        // is wrong is not guessable, so neither is changed: the line is reported for the reviewer.
        if (end !== null && end < start) {
          issues.push({ file: doc.name, paragraph: i + 1, message: `employment dates "${m[3]} - ${m[4]}" end before they start; not imported, and neither date was altered` });
          return;
        }
        add({
          kind: "employment",
          value: `${m[1]!.trim()} — ${m[2]!.trim()}`,
          attributes: { employer: m[1]!.trim(), title: m[2]!.trim(), startDate: start, endDate: end },
          dedupeKey: `${m[1]!.trim().toLowerCase()}|${start}`,
          file: doc.name,
          paragraph: i,
          locator: locate(i),
          notes: "roleTags not set: role-years requirements cannot use this job until the candidate approves what it counts as.",
        });
        return;
      }

      if (section === "PERSONAL PROJECTS") {
        if (doc.reading) return;
        const head = line.match(/^Personal Project [—-] (.+)$/);
        if (head) {
          lastProject = { value: head[1]!.trim(), paragraph: i };
          add({ kind: "project", value: head[1]!.trim(), dedupeKey: head[1]!.trim().toLowerCase(), file: doc.name, paragraph: i, locator: locate(i), notes: "Personal project (undated): never counted as professional years." });
          return;
        }
        if (lastProject && !line.endsWith(".") && line.includes(",") && line.split(",").length >= 3) {
          const project = byKey.get(`project|${lastProject.value.toLowerCase()}`);
          if (project && !project.attributes.technologies) project.attributes = { ...project.attributes, technologies: line.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40) };
          lastProject = null;
        }
        return;
      }

      if (section === "CERTIFICATION" || section === "CERTIFICATIONS") {
        if (doc.reading) return;
        const name = line.split(/ [—-] /)[0]!.trim();
        if (hasPlaceholder(name)) {
          issues.push({ file: doc.name, paragraph: i + 1, message: "certification name is a placeholder; not imported" });
          return;
        }
        if (hasPlaceholder(line)) issues.push({ file: doc.name, paragraph: i + 1, message: `certification "${name}" has an unfilled date placeholder; imported without a date` });
        add({ kind: "certification", value: name, dedupeKey: name.toLowerCase(), file: doc.name, paragraph: i, locator: locate(i), notes: "Issue date not stated on the resume; add it when approving." });
        return;
      }

      if (section === "EDUCATION" && hasPlaceholder(line)) {
        issues.push({ file: doc.name, paragraph: i + 1, message: "education line is an unfilled template placeholder; not imported" });
      }
    });

    if (doc.reading) addFactsFromReading(doc, doc.reading, add, issues);
  }

  const unreadable = documents.length === 0 ? [{ file: "(none)", paragraph: null, message: "no resume documents were provided" }] : [];
  const profile = parseCandidateProfile({
    schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
    candidateId: options.candidateId,
    profileVersion: `pending-import-${options.importedAt.slice(0, 10)}`,
    updatedAt: options.importedAt.slice(0, 10),
    facts,
    preferences: {},
    employmentHistoryComplete: null,
  });
  const counts: Record<string, number> = {};
  for (const f of profile.facts) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  return { profile, issues: [...unreadable, ...issues], counts };
}

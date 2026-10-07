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

export interface ResumeDocument {
  /** File name only (never a directory path). */
  name: string;
  paragraphs: string[];
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

const isHeading = (line: string): boolean => /^[A-Z][A-Z &/-]{2,}$/.test(line.trim());
const hasPlaceholder = (line: string): boolean => /\[[^\]]+\]/.test(line);
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

export function buildPendingFacts(documents: ResumeDocument[], options: { candidateId: string; importedAt: string }): ImportResult {
  const issues: ImportIssue[] = [];
  const facts: CandidateFact[] = [];
  const byKey = new Map<string, CandidateFact>();
  const usedIds = new Set<string>();

  const add = (draft: { kind: CandidateFact["kind"]; value: string; attributes?: CandidateFact["attributes"]; dedupeKey: string; file: string; paragraph: number; notes?: string }): void => {
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
      source: { kind: "resume-import", reference: draft.file, locator: `paragraph ${draft.paragraph + 1}` },
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
    doc.paragraphs.forEach((raw, i) => {
      const line = raw.replace(/[  ]+/g, " ").trim();
      if (!line) return;
      if (isHeading(line)) {
        section = line;
        lastProject = null;
        return;
      }

      if (section === "TECHNICAL SKILLS") {
        const m = line.match(/^([^:]{2,40}):\s*(.+)$/);
        if (!m) return;
        for (const item of m[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (hasPlaceholder(item)) continue;
          add({ kind: "skill", value: item, dedupeKey: item.toLowerCase(), file: doc.name, paragraph: i, notes: `Listed under "${m[1]!.trim()}" on the resume. Comma-split verbatim: reject fragments that are not a skill on their own.` });
        }
        return;
      }

      if (section === "PROFESSIONAL EXPERIENCE") {
        const m = line.match(/^(.+?) [—-] (.+?)\t(.+?) [–-] (.+)$/);
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
        add({
          kind: "employment",
          value: `${m[1]!.trim()} — ${m[2]!.trim()}`,
          attributes: { employer: m[1]!.trim(), title: m[2]!.trim(), startDate: start, endDate: end },
          dedupeKey: `${m[1]!.trim().toLowerCase()}|${start}`,
          file: doc.name,
          paragraph: i,
          notes: "roleTags not set: role-years requirements cannot use this job until the candidate approves what it counts as.",
        });
        return;
      }

      if (section === "PERSONAL PROJECTS") {
        const head = line.match(/^Personal Project [—-] (.+)$/);
        if (head) {
          lastProject = { value: head[1]!.trim(), paragraph: i };
          add({ kind: "project", value: head[1]!.trim(), dedupeKey: head[1]!.trim().toLowerCase(), file: doc.name, paragraph: i, notes: "Personal project (undated): never counted as professional years." });
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
        const name = line.split(/ [—-] /)[0]!.trim();
        if (hasPlaceholder(name)) {
          issues.push({ file: doc.name, paragraph: i + 1, message: "certification name is a placeholder; not imported" });
          return;
        }
        if (hasPlaceholder(line)) issues.push({ file: doc.name, paragraph: i + 1, message: `certification "${name}" has an unfilled date placeholder; imported without a date` });
        add({ kind: "certification", value: name, dedupeKey: name.toLowerCase(), file: doc.name, paragraph: i, notes: "Issue date not stated on the resume; add it when approving." });
        return;
      }

      if (section === "EDUCATION" && hasPlaceholder(line)) {
        issues.push({ file: doc.name, paragraph: i + 1, message: "education line is an unfilled template placeholder; not imported" });
      }
    });
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

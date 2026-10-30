import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { classifyDocument, type DocumentClassification } from "./document-type.js";
import type { ResumeDocument } from "./resume-import.js";

// The TypeScript side of local PDF/DOCX intake.
//
// Division of labour, and why: the bytes of a candidate document are read only by
// services/ai (pdfplumber, the same extractor the HTTP service uses). This module never
// opens a PDF. It consumes the private draft that `services/ai/local_intake_cli.py` wrote,
// re-verifies it, and turns it into the `ResumeDocument` that the existing
// `buildPendingFacts` already knows how to read. So there is one extractor, one
// fact-extraction rule set, and one review lifecycle - not a second pipeline.
//
// Offsets cross the boundary as UTF-16 code units (docs/ard/00-SHARED-CONTRACTS.md), which
// is what a JavaScript string index already is. Every span is re-sliced here before it is
// trusted: the worker computed it from Python code points, so this check is an independent
// oracle rather than a restatement.
//
// A draft is evidence for review. Nothing in this file approves anything.

export const INTAKE_DRAFT_SCHEMA = "local-intake-draft/4";

/** Extraction conditions the worker can report. Only the first two carry usable text. */
export const INTAKE_STATUSES = ["EXTRACTED", "LOW_TEXT_CONFIDENCE", "NEEDS_LOCAL_OCR", "EXTRACTION_FAILED"] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** `native` = the extractor's own order. `columns` = rebuilt around a column gutter. */
export const READING_ORDERS = ["native", "columns"] as const;
export type ReadingOrder = (typeof READING_ORDERS)[number];

const lineSchema = z
  .object({
    index: z.number().int().nonnegative(),
    page: z.number().int().nonnegative().nullable(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string(),
    // Where the line sat before any reading-order rebuild, and the box it occupied on the
    // page (x0, top, x1, bottom in PDF points). Both are null when nothing was rebuilt.
    native_index: z.number().int().nonnegative().nullable().default(null),
    column: z.number().int().nonnegative().nullable().default(null),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().default(null),
  })
  .strict();

const pageSchema = z
  .object({
    index: z.number().int().nonnegative(),
    start: z.number().int().nonnegative().nullable(),
    end: z.number().int().nonnegative().nullable(),
    char_count: z.number().int().nonnegative(),
    non_whitespace: z.number().int().nonnegative(),
    image_count: z.number().int().nonnegative(),
    resolved: z.boolean(),
    column_gutter: z.number().nullable(),
    reading_order: z.enum(READING_ORDERS).default("native"),
  })
  .strict();

const evidenceSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().positive(), quote: z.string().min(1) })
  .strict();

const employmentDateSchema = z
  .object({ precision: z.enum(["year", "month", "present"]), value: z.string().nullable() })
  .strict()
  // The parser's own invariant, re-checked here: a year-only date never carries a month, and
  // "present" carries nothing at all. A draft that breaks it is not a draft this will import.
  .refine((d) => (d.precision === "present" ? d.value === null : /^\d{4}(-\d{2})?$/.test(d.value ?? "")), "a date must match its stated precision")
  .refine((d) => d.precision !== "year" || /^\d{4}$/.test(d.value ?? ""), "year precision must not carry a month");

const employmentCandidateSchema = z
  .object({
    employer: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    start: employmentDateSchema,
    end: employmentDateSchema,
    evidence: evidenceSchema,
    employerEvidence: evidenceSchema,
    titleEvidence: evidenceSchema,
    confidence: z.enum(["high", "medium", "low"]),
    ambiguity: z.array(z.string()),
    page: z.number().int().nonnegative().nullable(),
  })
  .strict();

const confidence = z.enum(["high", "medium", "low"]);
const page = z.number().int().nonnegative().nullable();

const skillCandidateSchema = z
  .object({
    value: z.string().min(1).max(300),
    canonical: z.string().max(300).nullable(),
    category: z.string().max(300).nullable(),
    evidence: evidenceSchema,
    confidence,
    ambiguity: z.array(z.string()),
    page,
  })
  .strict();

const educationCandidateSchema = z
  .object({
    degree: z.string().min(1).max(300),
    institution: z.string().max(300).nullable(),
    graduation: employmentDateSchema.nullable(),
    evidence: evidenceSchema,
    institutionEvidence: evidenceSchema.nullable(),
    confidence,
    ambiguity: z.array(z.string()),
    page,
  })
  .strict();

const certificationCandidateSchema = z
  .object({
    name: z.string().min(1).max(300),
    evidence: evidenceSchema,
    confidence,
    ambiguity: z.array(z.string()),
    page,
  })
  .strict();

const projectCandidateSchema = z
  .object({
    name: z.string().min(1).max(300),
    description: z.string().max(1000).nullable(),
    technologies: z.array(z.string().min(1).max(300)).max(80),
    url: z.string().max(500).nullable(),
    start: employmentDateSchema.nullable(),
    end: employmentDateSchema.nullable(),
    evidence: evidenceSchema,
    confidence,
    ambiguity: z.array(z.string()),
    page,
  })
  .strict();

const readingSchema = z
  .object({
    parserRevision: z.string().min(1),
    employment: z.array(employmentCandidateSchema),
    skills: z.array(skillCandidateSchema),
    education: z.array(educationCandidateSchema),
    certifications: z.array(certificationCandidateSchema),
    projects: z.array(projectCandidateSchema),
    refused: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
          start: z.number().int().nonnegative().nullable(),
          end: z.number().int().nonnegative().nullable(),
          page,
        })
        .strict(),
    ),
  })
  .strict();

/** A draft from before this contract, or a document the parser read nothing from. */
export const emptyReading = () => ({
  parserRevision: "none",
  employment: [],
  skills: [],
  education: [],
  certifications: [],
  projects: [],
  refused: [],
});

export const intakeDraftSchema = z
  .object({
    schema: z.literal(INTAKE_DRAFT_SCHEMA),
    intakeRevision: z.string().min(1),
    documentId: z.string().regex(/^doc-[0-9a-f]{12}$/),
    candidateId: z.string().regex(/^cand-[0-9a-f]{12}$/),
    fileName: z.string().min(1),
    fileType: z.enum(["pdf", "docx"]),
    byteSize: z.number().int().positive(),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    extractedAt: z.string().min(8),
    status: z.enum(INTAKE_STATUSES),
    readingOrder: z.enum(READING_ORDERS).default("native"),
    failure: z.object({ code: z.string(), message: z.string().nullable() }).strict().nullable(),
    pageCount: z.number().int().nonnegative(),
    pages: z.array(pageSchema),
    warnings: z.array(z.string()),
    metrics: z.record(z.string(), z.union([z.number(), z.boolean()])),
    textSha256: z.string().regex(/^[0-9a-f]{64}$/).or(z.literal("")),
    text: z.string(),
    lines: z.array(lineSchema),
    reading: readingSchema.default(emptyReading),
    // The worker writes these two and never anything else: a draft is unreviewed by construction.
    reviewStatus: z.literal("PENDING_REVIEW"),
    approval: z.object({ approvedBy: z.null(), approvedAt: z.null() }).strict(),
  })
  .strict();
export type IntakeDraft = z.infer<typeof intakeDraftSchema>;

export interface DraftProblem {
  /** Pseudonymous id, or the draft file name when the draft could not even be parsed. */
  documentId: string;
  code:
    | "NOT_A_DRAFT"
    | "SPAN_MISMATCH"
    | "TEXT_DIGEST_MISMATCH"
    | "PAGE_RANGE_INVALID"
    | "NO_USABLE_TEXT"
    | "NOT_A_RESUME";
  detail: string;
}

/** Re-slice every line span against the draft's own text. The worker's word is not taken for it. */
export function verifyDraftSpans(draft: IntakeDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  for (const line of draft.lines) {
    if (line.end <= line.start || line.end > draft.text.length) {
      problems.push({ documentId: draft.documentId, code: "SPAN_MISMATCH", detail: `line ${line.index}: span ${line.start}-${line.end} is outside the text (length ${draft.text.length})` });
      continue;
    }
    if (draft.text.slice(line.start, line.end) !== line.text) {
      problems.push({ documentId: draft.documentId, code: "SPAN_MISMATCH", detail: `line ${line.index}: the span does not reproduce its text` });
    }
  }
  for (const page of draft.pages) {
    if (!page.resolved) continue;
    if (page.start === null || page.end === null || page.end <= page.start || page.end > draft.text.length) {
      problems.push({ documentId: draft.documentId, code: "PAGE_RANGE_INVALID", detail: `page ${page.index}: resolved but its range ${page.start}-${page.end} is not usable` });
    }
  }
  return problems;
}

/** SHA-256 of the text, recomputed here so an edited draft cannot pass as the extracted one. */
export function verifyTextDigest(draft: IntakeDraft, sha256: (text: string) => string): DraftProblem[] {
  if (!draft.text) return [];
  const actual = sha256(draft.text);
  return actual === draft.textSha256
    ? []
    : [{ documentId: draft.documentId, code: "TEXT_DIGEST_MISMATCH", detail: "the draft text does not match its recorded digest; the file was changed after extraction" }];
}

export interface LoadedDraft {
  draft: IntakeDraft;
  classification: DocumentClassification;
}

export interface LoadResult {
  usable: LoadedDraft[];
  /** Drafts that were read but cannot be imported, with the reason. */
  rejected: Array<{ draft: IntakeDraft | null; file: string; problems: DraftProblem[] }>;
}

export interface LoadOptions {
  sha256: (text: string) => string;
  /** Import only these source hashes (the files the caller asked for). */
  onlySourceSha256?: ReadonlySet<string>;
  /** Treat a REVIEW classification as usable (the reviewer is the one who decides). */
  allowUnclassified?: boolean;
}

/**
 * Read every `*.draft.json` in a private directory and keep the ones that can be imported.
 *
 * A draft is usable only when it carries text (EXTRACTED or LOW_TEXT_CONFIDENCE), every
 * span re-slices correctly, the digest matches, and the text classifies as a resume. A scan
 * (NEEDS_LOCAL_OCR) and a failure are reported, never silently dropped.
 */
export function loadIntakeDrafts(directory: string, options: LoadOptions): LoadResult {
  const usable: LoadedDraft[] = [];
  const rejected: LoadResult["rejected"] = [];
  const files = existsSync(directory)
    ? readdirSync(directory).filter((f) => f.endsWith(".draft.json")).sort()
    : [];

  for (const file of files) {
    const full = path.join(directory, file);
    const parsed = intakeDraftSchema.safeParse(JSON.parse(readFileSync(full, "utf-8")));
    if (!parsed.success) {
      rejected.push({ draft: null, file, problems: [{ documentId: file, code: "NOT_A_DRAFT", detail: `${parsed.error.issues[0]?.path.join(".") || "(root)"}: ${parsed.error.issues[0]?.message}` }] });
      continue;
    }
    const draft = parsed.data;
    if (options.onlySourceSha256 && !options.onlySourceSha256.has(draft.sourceSha256)) continue;

    const problems = [...verifyDraftSpans(draft), ...verifyReadingSpans(draft), ...verifyTextDigest(draft, options.sha256)];
    if (draft.status === "NEEDS_LOCAL_OCR" || draft.status === "EXTRACTION_FAILED") {
      problems.push({ documentId: draft.documentId, code: "NO_USABLE_TEXT", detail: `status ${draft.status}${draft.failure ? ` (${draft.failure.code})` : ""}` });
    }
    const classification = classifyDocument(draft.text);
    if (classification.type !== "RESUME" && !(options.allowUnclassified && classification.status === "REVIEW")) {
      problems.push({ documentId: draft.documentId, code: "NOT_A_RESUME", detail: `classified ${classification.type} (${classification.status}): ${classification.reasons.join(", ") || "no resume structure"}` });
    }
    if (problems.length) rejected.push({ draft, file, problems });
    else usable.push({ draft, classification });
  }
  return { usable, rejected };
}

/**
 * The draft as the existing importer wants it: one paragraph per extracted line.
 *
 * `reference` is the pseudonymous document id, not the file name: a fact carries where it
 * came from without carrying whatever the file was called.
 */
const hasRecords = (reading: IntakeDraft["reading"]): boolean =>
  reading.employment.length > 0 ||
  reading.skills.length > 0 ||
  reading.education.length > 0 ||
  reading.certifications.length > 0 ||
  reading.projects.length > 0 ||
  reading.refused.length > 0;

export function draftToDocument(draft: IntakeDraft): ResumeDocument {
  return {
    name: draft.documentId,
    paragraphs: draft.lines.map((line) => line.text),
    provenance: draft.lines.map((line) => ({ page: line.page, start: line.start, end: line.end })),
    // A reading is attached only when the parser actually produced or refused something. An
    // empty reading must not stand down the template line rules: there would be nothing to
    // import twice, and the line rules are then the document's only chance of a fact.
    ...(hasRecords(draft.reading) ? { reading: draft.reading } : {}),
  };
}

/**
 * Re-slice every span the parser produced against the draft's own text.
 *
 * The parser quoted the text it was given; this checks the quote still is that text, in the
 * same way `verifyDraftSpans` checks a line, and that each value appears inside the evidence
 * it claims. A skill or an employer that is not at the offsets it names is not evidence.
 */
export function verifyReadingSpans(draft: IntakeDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const bad = (detail: string): void => void problems.push({ documentId: draft.documentId, code: "SPAN_MISMATCH", detail });

  const check = (label: string, span: { start: number; end: number; quote: string } | null): void => {
    if (span === null) return;
    if (span.end > draft.text.length || draft.text.slice(span.start, span.end) !== span.quote) {
      bad(`${label}: the span ${span.start}-${span.end} does not reproduce its quote`);
    }
  };
  /** A value must appear inside the text it claims as its evidence. */
  const inside = (label: string, value: string, span: { quote: string } | null): void => {
    if (span !== null && !span.quote.includes(value)) bad(`${label}: "${value}" is not inside its own evidence`);
  };

  const reading = draft.reading;
  for (const [i, record] of reading.employment.entries()) {
    check(`employment ${i} record`, record.evidence);
    check(`employment ${i} employer`, record.employerEvidence);
    check(`employment ${i} title`, record.titleEvidence);
    inside(`employment ${i} employer`, record.employer, record.employerEvidence);
    inside(`employment ${i} title`, record.title, record.titleEvidence);
  }
  for (const [i, record] of reading.skills.entries()) {
    check(`skill ${i}`, record.evidence);
    inside(`skill ${i}`, record.value, record.evidence);
  }
  for (const [i, record] of reading.education.entries()) {
    check(`education ${i}`, record.evidence);
    check(`education ${i} institution`, record.institutionEvidence);
    inside(`education ${i} degree`, record.degree, record.evidence);
    if (record.institution) inside(`education ${i} institution`, record.institution, record.institutionEvidence);
  }
  for (const [i, record] of reading.certifications.entries()) {
    check(`certification ${i}`, record.evidence);
    inside(`certification ${i}`, record.name, record.evidence);
  }
  for (const [i, record] of reading.projects.entries()) {
    check(`project ${i}`, record.evidence);
    inside(`project ${i}`, record.name, record.evidence);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Running the worker (optional convenience; the worker can also be run directly)
// ---------------------------------------------------------------------------

export interface WorkerRequest {
  /** Python executable of the services/ai virtual environment. */
  python: string;
  script: string;
  inputDir?: string;
  files?: readonly string[];
  outDir: string;
  force?: boolean;
}

export interface WorkerOutcome {
  status: number;
  /** Sanitized worker output: status codes, counts, timings. No document content. */
  lines: string[];
}

export type WorkerRunner = (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: WorkerRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf-8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * Invoke the extraction worker. Arguments are passed as an argv array, never through a
 * shell, so a Windows path with spaces and parentheses needs no quoting of its own.
 */
export function runIntakeWorker(request: WorkerRequest, runner: WorkerRunner = defaultRunner): WorkerOutcome {
  const args = ["-I", request.script, "--out-dir", request.outDir];
  if (request.inputDir) args.push("--input-dir", request.inputDir);
  for (const file of request.files ?? []) args.push("--file", file);
  if (request.force) args.push("--force");
  const result = runner(request.python, args);
  const lines = [...result.stdout.split(/\r?\n/), ...result.stderr.split(/\r?\n/)].filter((l) => l.trim().length > 0);
  return { status: result.status ?? 1, lines };
}

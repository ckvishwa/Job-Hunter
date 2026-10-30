import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { draftToDocument, loadIntakeDrafts, type LoadResult } from "./pdf-intake.js";
import { checkPrivateTarget } from "./private-paths.js";
import { buildPendingFacts, readDocxParagraphs, type ResumeDocument } from "./resume-import.js";

// npm run candidate:import -- --resumes-dir <dir> --out private-runtime/candidate/pending-facts.json [--candidate-id <id>] [--force]
// npm run candidate:import -- --intake-dir "F:\JobHunterPrivate\drafts" --out "F:\JobHunterPrivate\facts\pending-facts.json"
//
// Reads every Resume*.docx under the directory (cover letters are never read) and writes a REVIEWABLE file of
// PENDING candidate facts. It approves nothing. It refuses to overwrite an existing file (which may already
// hold reviewed approvals) unless --force is given. The output belongs under private-runtime/ (gitignored).
//
// A PDF is never parsed here. `services/ai/local_intake_cli.py` extracts it locally into a private draft, and
// this command imports that draft: one extractor, one set of fact rules, one review lifecycle. Because a draft
// comes from a PDF that may hold real contact details, importing drafts requires an output path outside every
// Git checkout and logs pseudonymous document ids instead of file names.

export interface ImportArgs {
  resumesDir?: string;
  /** Private directory holding `*.draft.json` files written by the extraction worker. */
  intakeDir?: string;
  out: string;
  candidateId: string;
  force: boolean;
  /**
   * One profile per document, each under the document's own pseudonymous candidate id.
   *
   * The default collects every document into one profile, which is right for one person's own
   * several resumes: the same skill found twice is one fact that notes where else it appeared.
   * It is wrong for a corpus of unrelated people - two candidates who worked for the same
   * employer would have that employment merged into a single fact. With this flag each
   * document gets its own profile and its own deduplication scope, so no fact can span two
   * candidates. `outDir` holds the files.
   */
  perCandidate?: boolean;
  outDir?: string;
}

export function parseImportArgs(argv: string[]): ImportArgs {
  const result: ImportArgs = { out: "private-runtime/candidate/pending-facts.json", candidateId: "candidate-1", force: false, perCandidate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--resumes-dir") result.resumesDir = argv[++i];
    else if (arg === "--intake-dir") result.intakeDir = argv[++i];
    else if (arg === "--out") result.out = argv[++i] ?? result.out;
    else if (arg === "--out-dir") result.outDir = argv[++i];
    else if (arg === "--candidate-id") result.candidateId = argv[++i] ?? result.candidateId;
    else if (arg === "--force") result.force = true;
    else if (arg === "--per-candidate") result.perCandidate = true;
  }
  return result;
}

interface Found {
  docx: string[];
  pdf: string[];
}

function findResumes(dir: string): Found {
  const found: Found = { docx: [], pdf: [] };
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      const nested = findResumes(full);
      found.docx.push(...nested.docx);
      found.pdf.push(...nested.pdf);
    } else if (/^Resume.*\.docx$/i.test(entry)) found.docx.push(full);
    // A PDF has no "Resume*" naming convention to rely on, so every PDF is a candidate and
    // classifyDocument() decides from the extracted text whether it is a resume at all.
    else if (/\.pdf$/i.test(entry)) found.pdf.push(full);
  }
  found.docx.sort();
  found.pdf.sort();
  return found;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

/** A file-name-safe id that also satisfies the profile schema's id pattern. */
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";

/** Digest of a file's bytes. Used to match a PDF to the draft that was extracted from it. */
function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const WORKER_HINT = [
  "A PDF is extracted by the local worker, not by this command. Run, from the repository root:",
  '  services\\ai\\.venv\\Scripts\\python.exe -I services/ai/local_intake_cli.py --input-dir "<folder>" --out-dir "%JH_PRIVATE_ROOT%\\drafts"',
  "then re-run this command with --intake-dir pointing at that folder.",
];

export function runImport(args: ImportArgs, log: (line: string) => void = console.log): number {
  if (!args.resumesDir && !args.intakeDir) {
    log("usage: candidate:import (--resumes-dir <dir> | --intake-dir <private drafts dir>) [--out <file>] [--candidate-id <id>] [--force]");
    return 2;
  }
  if (args.perCandidate && !args.outDir) {
    log("--per-candidate writes one profile per document, so it needs --out-dir <private directory>.");
    return 2;
  }
  const out = path.resolve(args.perCandidate ? args.outDir! : args.out);
  if (!args.perCandidate && existsSync(out) && !args.force) {
    log(`Refusing to overwrite ${out}: it may contain reviewed approvals. Move it or pass --force.`);
    return 2;
  }

  const found = args.resumesDir ? findResumes(path.resolve(args.resumesDir)) : { docx: [], pdf: [] };
  const documents: ResumeDocument[] = found.docx.map((f) => ({ name: path.basename(f), paragraphs: readDocxParagraphs(readFileSync(f)) }));
  const readNames = found.docx.map((f) => path.basename(f));

  let drafts: LoadResult | null = null;
  if (args.intakeDir) {
    // Everything here derives from a document that may hold real contact details.
    const problems = checkPrivateTarget(out);
    if (problems.length) {
      for (const problem of problems) log(`Refusing to write candidate-PDF facts: ${problem.code}: ${problem.detail}`);
      log("Choose an output path outside every Git checkout (for example under %JH_PRIVATE_ROOT%).");
      return 4;
    }
    drafts = loadIntakeDrafts(path.resolve(args.intakeDir), {
      sha256,
      onlySourceSha256: found.pdf.length ? new Set(found.pdf.map(sha256File)) : undefined,
    });
    for (const { draft, file, problems: issues } of drafts.rejected) {
      const id = draft?.documentId ?? file;
      log(`  skipped ${id}: ${issues.map((p) => `${p.code} (${p.detail})`).join("; ")}`);
    }
    for (const { draft } of drafts.usable) {
      documents.push(draftToDocument(draft));
      readNames.push(draft.documentId);
    }
  } else if (found.pdf.length) {
    log(`Found ${found.pdf.length} PDF(s) but no --intake-dir, so none were read.`);
    for (const line of WORKER_HINT) log(line);
    return 3;
  }

  if (documents.length === 0) {
    log(args.intakeDir ? "No importable drafts found (see the skipped lines above)." : "No Resume*.docx or *.pdf files found.");
    return 2;
  }

  if (args.perCandidate) {
    return runPerCandidate(documents, drafts, out, args, log);
  }

  const result = buildPendingFacts(documents, { candidateId: args.candidateId, importedAt: new Date().toISOString() });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result.profile, null, 2) + "\n", "utf-8");

  log(`Read ${documents.length} resume(s): ${readNames.join(", ")}`);
  if (drafts) {
    log(`  from drafts: ${drafts.usable.length} usable, ${drafts.rejected.length} skipped (ids are pseudonymous; the private manifest holds the file names)`);
    const lowConfidence = drafts.usable.filter((d) => d.draft.status === "LOW_TEXT_CONFIDENCE");
    if (lowConfidence.length) {
      log(`  ${lowConfidence.length} draft(s) are LOW_TEXT_CONFIDENCE: check these against the source page before approving anything from them.`);
      for (const { draft } of lowConfidence) log(`    ${draft.documentId}: ${draft.warnings.join(", ") || "no warning recorded"}`);
    }
  }
  log(`Wrote ${result.profile.facts.length} PENDING fact(s) to ${out}`);
  log(`  by kind: ${Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  log("Nothing is approved. Every fact has approvalStatus \"pending\", so none can satisfy a requirement yet.");
  for (const issue of result.issues) log(`  note: ${issue.file}${issue.paragraph ? ` paragraph ${issue.paragraph}` : ""}: ${issue.message}`);
  log("Review: open the file, and for each fact you confirm set approvalStatus to \"approved\" and fill verification.verifiedBy / verifiedAt");
  log("(and validUntil if it can expire). Add roleTags to employment facts, experienceIds to skills used in a job, and");
  log("explicit work_authorization / clearance facts yourself. Delete or set \"rejected\" for fragments that are not skills.");
  return 0;
}

/**
 * One profile per document, each in its own deduplication scope.
 *
 * Two unrelated candidates can hold byte-identical employment, and merging those would invent
 * a single person who worked both jobs. `buildPendingFacts` is therefore called once per
 * document: the dedupe map it keeps lives inside that call, so nothing can cross between two
 * candidates. Identity comes from the draft's own pseudonymous candidate id, which is derived
 * from the source document hash and the private salt, never from the file name.
 */
function runPerCandidate(
  documents: ResumeDocument[],
  drafts: LoadResult | null,
  outDir: string,
  args: ImportArgs,
  log: (line: string) => void,
): number {
  const byDocumentId = new Map(drafts?.usable.map(({ draft }) => [draft.documentId, draft]) ?? []);
  mkdirSync(outDir, { recursive: true });

  let written = 0;
  let skipped = 0;
  let totalFacts = 0;
  const totals: Record<string, number> = {};
  const identities = new Set<string>();
  const notes: string[] = [];

  for (const document of documents) {
    const draft = byDocumentId.get(document.name);
    // A .docx has no pseudonymous identity of its own, so its file name becomes the id. A draft
    // brings the id the worker assigned it.
    const candidateId = draft?.candidateId ?? slugify(document.name);
    const target = path.join(outDir, `${candidateId}.pending-facts.json`);
    if (existsSync(target) && !args.force) {
      log(`  ${candidateId}: refusing to overwrite an existing profile (it may hold reviewed approvals); pass --force to replace it`);
      skipped += 1;
      continue;
    }
    const result = buildPendingFacts([document], { candidateId, importedAt: new Date().toISOString() });
    writeFileSync(target, JSON.stringify(result.profile, null, 2) + "\n", "utf-8");
    written += 1;
    totalFacts += result.profile.facts.length;
    identities.add(candidateId);
    for (const [kind, count] of Object.entries(result.counts)) totals[kind] = (totals[kind] ?? 0) + count;
    const warnings = draft?.warnings.length ? ` warnings=${draft.warnings.join(",")}` : "";
    log(`  ${candidateId}: ${result.profile.facts.length} pending fact(s) [${Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}] status=${draft?.status ?? "docx"}${warnings}`);
    for (const issue of result.issues) notes.push(`  note: ${candidateId}: ${issue.message}`);
  }

  log(`Wrote ${written} profile(s) to ${outDir}${skipped ? `, skipped ${skipped} existing` : ""}`);
  log(`Distinct candidate identities: ${identities.size} (one per document; no fact is shared between two of them)`);
  log(`Total PENDING facts: ${totalFacts} by kind: ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  log("Nothing is approved. Every fact has approvalStatus \"pending\", so none can satisfy a requirement yet.");
  for (const note of notes) log(note);
  return written > 0 ? 0 : 2;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.exitCode = runImport(parseImportArgs(process.argv.slice(2)));
}

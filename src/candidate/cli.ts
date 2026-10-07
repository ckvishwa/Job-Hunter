import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPendingFacts, readDocxParagraphs, type ResumeDocument } from "./resume-import.js";

// npm run candidate:import -- --resumes-dir <dir> --out private-runtime/candidate/pending-facts.json [--candidate-id <id>] [--force]
//
// Reads every Resume*.docx under the directory (cover letters are never read) and writes a REVIEWABLE file of
// PENDING candidate facts. It approves nothing. It refuses to overwrite an existing file (which may already
// hold reviewed approvals) unless --force is given. The output belongs under private-runtime/ (gitignored).

export interface ImportArgs {
  resumesDir?: string;
  out: string;
  candidateId: string;
  force: boolean;
}

export function parseImportArgs(argv: string[]): ImportArgs {
  const result: ImportArgs = { out: "private-runtime/candidate/pending-facts.json", candidateId: "candidate-1", force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--resumes-dir") result.resumesDir = argv[++i];
    else if (arg === "--out") result.out = argv[++i] ?? result.out;
    else if (arg === "--candidate-id") result.candidateId = argv[++i] ?? result.candidateId;
    else if (arg === "--force") result.force = true;
  }
  return result;
}

function findResumes(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findResumes(full));
    else if (/^Resume.*\.docx$/i.test(entry)) found.push(full);
  }
  return found.sort();
}

export function runImport(args: ImportArgs, log: (line: string) => void = console.log): number {
  if (!args.resumesDir) {
    log("usage: candidate:import --resumes-dir <dir> [--out <file>] [--candidate-id <id>] [--force]");
    return 2;
  }
  const out = path.resolve(args.out);
  if (existsSync(out) && !args.force) {
    log(`Refusing to overwrite ${out}: it may contain reviewed approvals. Move it or pass --force.`);
    return 2;
  }
  const files = findResumes(path.resolve(args.resumesDir));
  if (files.length === 0) {
    log("No Resume*.docx files found.");
    return 2;
  }
  const documents: ResumeDocument[] = files.map((f) => ({ name: path.basename(f), paragraphs: readDocxParagraphs(readFileSync(f)) }));
  const result = buildPendingFacts(documents, { candidateId: args.candidateId, importedAt: new Date().toISOString() });
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result.profile, null, 2) + "\n", "utf-8");

  log(`Read ${documents.length} resume(s): ${documents.map((d) => d.name).join(", ")}`);
  log(`Wrote ${result.profile.facts.length} PENDING fact(s) to ${out}`);
  log(`  by kind: ${Object.entries(result.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  log("Nothing is approved. Every fact has approvalStatus \"pending\", so none can satisfy a requirement yet.");
  for (const issue of result.issues) log(`  note: ${issue.file}${issue.paragraph ? ` paragraph ${issue.paragraph}` : ""}: ${issue.message}`);
  log("Review: open the file, and for each fact you confirm set approvalStatus to \"approved\" and fill verification.verifiedBy / verifiedAt");
  log("(and validUntil if it can expire). Add roleTags to employment facts, experienceIds to skills used in a job, and");
  log("explicit work_authorization / clearance facts yourself. Delete or set \"rejected\" for fragments that are not skills.");
  return 0;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  process.exitCode = runImport(parseImportArgs(process.argv.slice(2)));
}

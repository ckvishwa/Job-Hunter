import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// A guard against the one mistake that cannot be undone quietly: committing candidate data.
//
// `src/ci/private-isolation.ts` proves no *test* reads private data. This file checks what is
// about to be *committed*, so it is useful both in CI (against the index of a merge commit)
// and as a pre-commit hook. It reports paths and rule names only, never file contents.
//
// Two severities, because a false block on a legitimate document would teach someone to pass
// --no-verify:
//   BLOCK - a path that is private by construction, or a file forced past .gitignore.
//   WARN  - a document format that is usually fine but is worth a second look.
//
// It is a safety net, not the control. The controls are: private data lives outside every
// checkout (see src/candidate/private-paths.ts), and .gitignore covers the directories that
// must stay inside one.

export type Severity = "BLOCK" | "WARN";

export interface StagedFinding {
  path: string;
  rule: string;
  severity: Severity;
}

const BLOCK_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: "candidate profile directory", re: /(^|\/)(HIGH_CONFIDENT|PROFILES)(\/|$)/ },
  { rule: "resume corpus directory", re: /(^|\/)(data\/Resumes|resumes|generated-resumes)(\/)/i },
  { rule: "private runtime directory", re: /(^|\/)private-runtime(\/)/ },
  { rule: "extraction draft or manifest", re: /(^|\/)[^/]*\.(draft|intake)\.json$|(^|\/)intake-manifest\.json$/i },
  { rule: "candidate fact file", re: /(^|\/)(pending-facts|candidate-profile\.reviewed|canonical-resume-registry|candidate-answer-observations)[^/]*\.json$/i },
  { rule: "document in a candidate-shaped directory", re: /(^|\/)[^/]*(profile|resume|candidate|\bcv\b)[^/]*\/[^/]+\.(pdf|docx|doc|rtf|odt)$/i },
  { rule: "intake salt", re: /(^|\/)\.intake-salt$/ },
  { rule: "resume-named document outside a fixtures directory", re: /^(?!.*\/fixtures\/)(?:.*\/)?[^/]*(?:resume|\bcv\b)[^/]*\.(?:pdf|docx|doc|rtf|odt)$/i },
  { rule: "environment file (only .env.example may be tracked)", re: /(^|\/)\.env(\.(?!example$)[^/]+)?$/ },
  { rule: "key or certificate material", re: /\.(?:pem|key|p12|pfx)$/i },
  { rule: "database or dump file", re: /\.(?:sqlite3?|db|dump)$/i },
  { rule: "model weights", re: /\.(?:safetensors|gguf|onnx)$/i },
  { rule: "browser profile or private-root directory", re: /(^|\/)(?:JobHunterPrivate|\.?chrome-profile[^/]*|User Data)(\/)/i },
];

/** Largest blob that may be committed (JH-REPO-001 R4.3). */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;

/** BLOCK finding for each entry over the size cap. Pure, so the rule is testable without Git. */
export function sizeFindings(entries: ReadonlyArray<{ path: string; size: number }>): StagedFinding[] {
  return entries
    .filter((e) => e.size > MAX_BLOB_BYTES)
    .map((e) => ({ path: e.path.replace(/\\/g, "/"), rule: `file over ${MAX_BLOB_BYTES / (1024 * 1024)} MB (${e.size} bytes)`, severity: "BLOCK" as const }));
}

const WARN_RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: "document format that can carry personal data", re: /\.(pdf|docx|doc|rtf|odt)$/i },
  { rule: "spreadsheet that can carry personal data", re: /\.(xlsx|xls|csv)$/i },
];

/** Classify one staged path. `ignored` marks a path that .gitignore covers, i.e. it was forced in. */
export function classifyStagedPath(file: string, ignored: boolean): StagedFinding[] {
  const normalized = file.replace(/\\/g, "/");
  const findings: StagedFinding[] = [];
  if (ignored) findings.push({ path: normalized, rule: "forced past .gitignore (git add -f)", severity: "BLOCK" });
  for (const { rule, re } of BLOCK_RULES) if (re.test(normalized)) findings.push({ path: normalized, rule, severity: "BLOCK" });
  if (!findings.length) {
    for (const { rule, re } of WARN_RULES) if (re.test(normalized)) findings.push({ path: normalized, rule, severity: "WARN" });
  }
  return findings;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
}

/** Staged paths (added, copied, modified, renamed), never deletions. */
export function stagedPaths(root: string): string[] {
  const out = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
  return out.split("\0").filter((p) => p.length > 0);
}

/** Of `paths`, the ones .gitignore matches: staged anyway means someone forced them. */
export function ignoredAmong(root: string, paths: readonly string[]): Set<string> {
  if (!paths.length) return new Set();
  try {
    // check-ignore exits 1 when nothing matches, which execFileSync turns into a throw.
    const out = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, encoding: "utf-8", input: paths.join("\n") });
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return new Set(stdout.split(/\r?\n/).filter(Boolean));
  }
}

function stagedSizes(root: string, paths: readonly string[]): Array<{ path: string; size: number }> {
  return paths.map((path) => {
    try {
      return { path, size: Number(git(root, ["cat-file", "-s", `:${path}`]).trim()) };
    } catch {
      return { path, size: 0 };
    }
  });
}

export function scanStaged(root: string): StagedFinding[] {
  const paths = stagedPaths(root);
  const ignored = ignoredAmong(root, paths);
  return [...paths.flatMap((file) => classifyStagedPath(file, ignored.has(file))), ...sizeFindings(stagedSizes(root, paths))];
}

/** Every file in the HEAD tree, for CI: the same rules, applied to what is committed rather than what is staged. */
export function scanTree(root: string): StagedFinding[] {
  const entries = git(root, ["ls-tree", "-r", "-l", "-z", "HEAD"])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const size = Number(line.slice(0, tab).trim().split(/\s+/)[3]);
      return { path: line.slice(tab + 1), size: Number.isFinite(size) ? size : 0 };
    });
  return [...entries.flatMap((e) => classifyStagedPath(e.path, false)), ...sizeFindings(entries)];
}

export function report(findings: readonly StagedFinding[], log: (line: string) => void): number {
  const blocks = findings.filter((f) => f.severity === "BLOCK");
  const warns = findings.filter((f) => f.severity === "WARN");
  for (const finding of warns) log(`WARN  ${finding.path}: ${finding.rule}`);
  for (const finding of blocks) log(`BLOCK ${finding.path}: ${finding.rule}`);
  if (blocks.length) {
    log("");
    log(`${blocks.length} staged path(s) look like private candidate data. Nothing was changed; unstage them:`);
    log("  git restore --staged <path>");
    log("Candidate documents and anything derived from them belong outside every Git checkout (%JH_PRIVATE_ROOT%).");
    return 1;
  }
  log(warns.length ? `private-staged: no private paths staged (${warns.length} document(s) worth a look).` : "private-staged: no private paths staged.");
  return 0;
}

export function main(root = process.cwd(), log: (line: string) => void = console.log, mode: "staged" | "tree" = "staged"): number {
  return report(mode === "tree" ? scanTree(root) : scanStaged(root), log);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) process.exitCode = main(process.cwd(), console.log, process.argv.includes("--tree") ? "tree" : "staged");

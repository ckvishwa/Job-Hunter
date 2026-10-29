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
  { rule: "candidate profile directory", re: /(^|\/)(HIGH_CONFIDENT|PROFILES)(\/|$)/i },
  { rule: "resume corpus directory", re: /(^|\/)(data\/Resumes|resumes|generated-resumes)(\/)/i },
  { rule: "private runtime directory", re: /(^|\/)private-runtime(\/)/ },
  { rule: "extraction draft or manifest", re: /(^|\/)[^/]*\.(draft|intake)\.json$|(^|\/)intake-manifest\.json$/i },
  { rule: "candidate fact file", re: /(^|\/)(pending-facts|candidate-profile\.reviewed|canonical-resume-registry|candidate-answer-observations)[^/]*\.json$/i },
  { rule: "document in a candidate-shaped directory", re: /(^|\/)[^/]*(profile|resume|candidate|\bcv\b)[^/]*\/[^/]+\.(pdf|docx|doc|rtf|odt)$/i },
  { rule: "intake salt", re: /(^|\/)\.intake-salt$/ },
];

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

export function scanStaged(root: string): StagedFinding[] {
  const paths = stagedPaths(root);
  const ignored = ignoredAmong(root, paths);
  return paths.flatMap((file) => classifyStagedPath(file, ignored.has(file)));
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

export function main(root = process.cwd(), log: (line: string) => void = console.log): number {
  return report(scanStaged(root), log);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) process.exitCode = main();

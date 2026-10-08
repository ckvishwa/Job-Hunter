import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// CI proof that no automated test depends on private candidate data (SDLC-T01).
//   static : no test source reads reserved private paths, real candidate files, the user's real Chrome profile or
//            home-directory state. Tests must build synthetic inputs in temporary directories.
//   before : the checkout has no private-runtime directory (CI never receives candidate data).
//   after  : the test run left no private-runtime directory and no tracked or untracked change in the checkout.
// Matches are reported by file and line only, never by content.

export interface Violation {
  file: string;
  line: number;
  rule: string;
}

const RULES: Array<{ rule: string; re: RegExp }> = [
  { rule: "reads private-runtime candidate data", re: /private-runtime[\\/]+(candidate|pipeline|job-specific|v1-close|standalone|browser-profiles)/i },
  { rule: "reads a reviewed candidate profile or registry file", re: /candidate-profile\.reviewed|(?<![\w-])canonical-resume-registry\.json|(?<![\w-])pending-facts\.json/i },
  { rule: "reads the real browser or user profile", re: /process\.env\.(LOCALAPPDATA|APPDATA|USERPROFILE|HOME|HOMEPATH)\b|\bos\.homedir\(\)/ },
  { rule: "reads a real credential variable", re: /process\.env\.(JOBHUNTER_GATEWAY_KEY|GITHUB_TOKEN|NPM_TOKEN|AWS_[A-Z_]+|OPENAI_API_KEY|ANTHROPIC_API_KEY)/ },
];

/** Lines that only describe the guard itself (test names about the guard) can opt out with this exact marker. */
export const ALLOW_MARKER = "private-isolation: allow";

export function scanSource(file: string, text: string): Violation[] {
  const found: Violation[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const { rule, re } of RULES) if (re.test(line)) found.push({ file, line: i + 1, rule });
  });
  return found;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

export function scanTests(root: string): Violation[] {
  const testsDir = path.join(root, "tests");
  if (!existsSync(testsDir)) return [];
  return listFiles(testsDir).flatMap((f) => scanSource(path.relative(root, f).split(path.sep).join("/"), readFileSync(f, "utf8")));
}

function gitStatus(root: string): string[] {
  const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  return out.split(/\r?\n/).filter(Boolean);
}

export function main(mode: string, root = process.cwd()): number {
  if (mode === "static") {
    const violations = scanTests(root);
    for (const v of violations) console.error(`VIOLATION ${v.file}:${v.line} ${v.rule}`);
    console.log(`private-isolation static: ${violations.length} violation(s)`);
    return violations.length === 0 ? 0 : 1;
  }
  if (mode === "before" || mode === "after") {
    const problems: string[] = [];
    if (existsSync(path.join(root, "private-runtime"))) problems.push(mode === "before" ? "private-runtime exists in the CI checkout" : "the test run created private-runtime");
    if (mode === "after") for (const line of gitStatus(root)) problems.push(`the test run changed the checkout: ${line.slice(0, 3).trim()} ${line.slice(3)}`);
    for (const p of problems) console.error(`VIOLATION ${p}`);
    console.log(`private-isolation ${mode}: ${problems.length} problem(s)`);
    return problems.length === 0 ? 0 : 1;
  }
  console.error("usage: private-isolation <static|before|after>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv[2] ?? "");

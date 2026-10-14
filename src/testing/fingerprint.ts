import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Smart-test fingerprints. A test file's receipt is reusable only if EVERYTHING it can observe is byte-identical to when it passed:
//   self      the test file
//   closure   every local module it (transitively) imports, found by a static import scan
//   data      files named by string literals in the test or its closure (fixtures, config, SQL, JSON ...)
//   global    package versions (lock file), vitest config, tsconfig, node and vitest versions
//   classes   db (migrations), python (services/ai), browser (Chrome version), web (Astro sources), tree (tests that walk the repo)
// Git HEAD is never used. When the scan cannot see everything (a dynamic import with a computed specifier) the test is UNCERTAIN and always reruns.

export type Policy = "cache" | "never";
export type DepClass = "db" | "python" | "browser" | "web" | "tree";

export interface Fingerprint {
  unit: string;
  hash: string;
  components: Record<string, string>;
  closure: string[];
  classes: DepClass[];
  uncertain: string | null;
}

export interface Context {
  root: string;
  chromeVersion: string | null;
  vitestVersion: string;
  nodeVersion: string;
  neverCache: RegExp[];
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const fileHashCache = new Map<string, string>();
export const resetFileHashCache = (): void => fileHashCache.clear();
function hashFile(abs: string): string {
  let h = fileHashCache.get(abs);
  if (h === undefined) {
    h = existsSync(abs) ? sha(readFileSync(abs)) : "missing";
    fileHashCache.set(abs, h);
  }
  return h;
}
const rel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join("/");

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[^"'`;]*?\sfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\bvi\.(?:mock|doMock|importActual)\(\s*["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];
const DYNAMIC_IMPORT = /\bimport\(\s*(?!["'])[^)]/;

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare specifier: covered by the lock file
  const base = path.resolve(path.dirname(from), spec);
  const tries = [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), `${base}.ts`, path.join(base, "index.ts"), base];
  return tries.find((t) => existsSync(t) && statSync(t).isFile()) ?? null;
}

const DATA_EXT = /\.(?:json|jsonl|ya?ml|md|sql|csv|txt|html|py|pdf|docx|ps1|toml|env)$/i;
const DATA_DIRS = /^(?:config|db|docs|profiles|services|scripts|infra|tests\/fixtures|src)\b/;

/** Files a source text names with string literals (fixtures, config, SQL...). Only paths that exist inside the repo are returned. */
function dataRefs(root: string, from: string, text: string): string[] {
  const out = new Set<string>();
  const consider = (candidate: string): void => {
    const norm = candidate.replace(/\\/g, "/");
    if (!(DATA_EXT.test(norm) || DATA_DIRS.test(norm))) return;
    // private-runtime holds mutable run state (this runner's own checkpoint, caches, logs). It is never a test input, and counting it would
    // change a unit's fingerprint every time the runner writes it, so the full gate could never pass.
    for (const base of [root, path.dirname(from)]) {
      const abs = path.resolve(base, norm);
      if (path.relative(root, abs).split(path.sep)[0] === "private-runtime") continue;
      if (abs.startsWith(root) && existsSync(abs) && statSync(abs).isFile()) out.add(abs);
    }
  };
  for (const m of text.matchAll(/["'`]([^"'`\n]{3,200})["'`]/g)) consider(m[1]!);
  for (const m of text.matchAll(/\b(?:path\.)?(?:resolve|join)\(([^()]{3,300})\)/g)) {
    const args = [...m[1]!.matchAll(/["'`]([^"'`]*)["'`]/g)].map((a) => a[1]!);
    if (args.length >= 2) consider(path.join(...args));
  }
  return [...out];
}

function walkFiles(dir: string, accept: (name: string) => boolean, skip: Set<string> = new Set(["node_modules", ".git", ".venv", "dist", "__pycache__", ".pytest_cache", "private-runtime", "output", "data", "tmp", ".chrome-profile", ".claude"])): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, accept, skip));
    else if (accept(e.name)) out.push(p);
  }
  return out.sort();
}

const treeHash = (root: string, dirs: string[], accept: (n: string) => boolean): string => sha(dirs.flatMap((d) => walkFiles(path.join(root, d), accept)).map((f) => `${rel(root, f)}:${hashFile(f)}`).join("\n"));

export function globalComponents(ctx: Context): Record<string, string> {
  const pkg = existsSync(path.join(ctx.root, "package.json")) ? JSON.parse(readFileSync(path.join(ctx.root, "package.json"), "utf8")) : {};
  return {
    lock: hashFile(path.join(ctx.root, "package-lock.json")),
    deps: sha(JSON.stringify([pkg.dependencies ?? {}, pkg.devDependencies ?? {}])),
    vitestConfig: hashFile(path.join(ctx.root, "vitest.config.ts")),
    tsconfig: hashFile(path.join(ctx.root, "tsconfig.json")),
    runtime: `node ${ctx.nodeVersion}; vitest ${ctx.vitestVersion}`,
  };
}

export function classComponents(ctx: Context, cls: DepClass): string {
  const { root } = ctx;
  switch (cls) {
    case "db": return treeHash(root, ["db"], (n) => n.endsWith(".sql"));
    case "python": return treeHash(root, ["services/ai", "services/ml"], (n) => /\.(?:py|txt|json|ini|in|lock)$/.test(n));
    case "browser": return `chrome ${ctx.chromeVersion ?? "unknown"}; ${treeHash(root, ["src/browser"], (n) => n.endsWith(".ts"))}`;
    case "web": return treeHash(root, ["web/src", "web/public"], () => true) + hashFile(path.join(root, "web/package.json")) + hashFile(path.join(root, "web/astro.config.mjs"));
    case "tree": return treeHash(root, ["src", "tests", "config", "docs", "db", "scripts", "profiles"], (n) => !n.endsWith(".png"));
  }
}

const CLASS_SIGNS: Array<[DepClass, RegExp]> = [
  ["db", /startHarness|dbAvailable|pgSettingsFromEnv|createPool|migrate\(|db[\\/"']+migrations/],
  ["python", /services[\\/"', ]+ai|pythonAvailable|AI_DIR|ML_SERVICE_DIR|defaultPython|\.venv/],
  ["browser", /from "playwright"|launchPersistentChrome|launchManagedChrome|chromium|channel:\s*"chrome"/],
  ["web", /ensureWebBuild|web[\\/"']+dist|astro/i],
  ["tree", /readdirSync|walk\(|globSync|process\.cwd\(\)\)\s*\)\.toEqual/],
];

export function fingerprintTest(ctx: Context, testAbs: string): Fingerprint {
  const closure = new Set<string>();
  const data = new Set<string>();
  const texts: string[] = [];
  let uncertain: string | null = null;
  const visit = (file: string): void => {
    if (closure.has(file)) return;
    closure.add(file);
    const text = readFileSync(file, "utf8");
    texts.push(text);
    if (DYNAMIC_IMPORT.test(text)) uncertain ??= `dynamic import with a computed specifier in ${rel(ctx.root, file)}`;
    for (const re of IMPORT_PATTERNS) for (const m of text.matchAll(re)) {
      const target = resolveLocal(file, m[1]!);
      if (target) visit(target);
    }
    for (const d of dataRefs(ctx.root, file, text)) if (!closure.has(d)) data.add(d);
  };
  visit(testAbs);
  const all = texts.join("\n");
  // Only code that walks the repository counts as a tree dependency: the test itself and the repo scanners under src/ci. A harness listing its own upload directory does not.
  const scanText = [readFileSync(testAbs, "utf8"), ...[...closure].filter((f) => rel(ctx.root, f).startsWith("src/ci/")).map((f) => readFileSync(f, "utf8"))].join("\n");
  const classes = CLASS_SIGNS.filter(([c, re]) => re.test(c === "tree" ? scanText : all)).map(([c]) => c);
  const closureList = [...closure].sort();
  const dataList = [...data].filter((d) => !closure.has(d)).sort();
  const components: Record<string, string> = {
    self: hashFile(testAbs),
    closure: sha(closureList.map((f) => `${rel(ctx.root, f)}:${hashFile(f)}`).join("\n")),
    data: sha(dataList.map((f) => `${rel(ctx.root, f)}:${hashFile(f)}`).join("\n")),
    ...Object.fromEntries(Object.entries(globalComponents(ctx)).map(([k, v]) => [`global.${k}`, v])),
    ...Object.fromEntries(classes.map((c) => [`class.${c}`, classComponents(ctx, c)])),
  };
  const unit = rel(ctx.root, testAbs);
  if (ctx.neverCache.some((re) => re.test(unit))) uncertain ??= "policy: never cached";
  return { unit, hash: sha(JSON.stringify(components)), components, closure: closureList.map((f) => rel(ctx.root, f)), classes, uncertain };
}

/** Names the components that differ, plus which closure files changed (names only). */
export function explainChange(prev: { components: Record<string, string>; closureFiles?: Record<string, string> } | null, now: Fingerprint, root: string): string[] {
  if (!prev) return ["no receipt"];
  const reasons: string[] = [];
  for (const key of new Set([...Object.keys(prev.components), ...Object.keys(now.components)])) {
    if (prev.components[key] !== now.components[key]) reasons.push(key);
  }
  if (prev.closureFiles && reasons.includes("closure")) {
    const changed = now.closure.filter((f) => prev.closureFiles![f] !== hashFile(path.join(root, f)));
    const gone = Object.keys(prev.closureFiles).filter((f) => !now.closure.includes(f));
    reasons.push(...changed.slice(0, 6).map((f) => `changed: ${f}`), ...gone.slice(0, 3).map((f) => `no longer imported: ${f}`));
  }
  return reasons;
}

export const closureHashes = (root: string, closure: string[]): Record<string, string> => Object.fromEntries(closure.map((f) => [f, hashFile(path.join(root, f))]));

/** Whole-tree fingerprint used by the full regression gate: any edit to any relevant file stales it. */
export function treeFingerprint(ctx: Context): string {
  resetFileHashCache(); // always from the bytes on disk now
  const files = [
    ...["src", "tests", "config", "db", "services/ai", "services/ml", "scripts", "web/src"].flatMap((d) => walkFiles(path.join(ctx.root, d), (n) => !/\.(?:png|jpg|pyc)$/.test(n))),
    ...["package.json", "package-lock.json", "vitest.config.ts", "tsconfig.json"].map((f) => path.join(ctx.root, f)),
  ];
  return sha([...files.map((f) => `${rel(ctx.root, f)}:${hashFile(f)}`), `node ${ctx.nodeVersion}`, `vitest ${ctx.vitestVersion}`].join("\n"));
}

export function discoverTests(root: string): string[] {
  return walkFiles(path.join(root, "tests"), (n) => n.endsWith(".test.ts"));
}

export const unitFingerprint = (root: string, unit: string, dirs: string[], accept: (n: string) => boolean, files: string[] = [], tokens: string[] = []): { hash: string; components: Record<string, string> } => {
  const components: Record<string, string> = { tree: treeHash(root, dirs, accept), runtime: tokens.join("; "), ...Object.fromEntries(files.map((f) => [f, hashFile(path.join(root, f))])) };
  return { hash: sha(JSON.stringify([unit, components])), components };
};

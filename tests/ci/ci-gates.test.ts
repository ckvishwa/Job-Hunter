import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateAudit, extractAdvisories, parseAllowlist, type AllowEntry } from "../../src/ci/audit-gate.js";
import { main as isolationMain, scanSource, scanTests } from "../../src/ci/private-isolation.js";

const P = ["private", "runtime"].join("-"); // built at run time so this file does not trip its own guard

// Pure, offline tests for the CI gate logic. Synthetic reports only; no registry or network access.

const adv = (source: number, severity: string, name = "pkg") => ({ source, name, severity, title: `t${source}`, url: "u", range: "*" });
const report = (vulns: Record<string, unknown[]>) => ({ auditReportVersion: 2, vulnerabilities: Object.fromEntries(Object.entries(vulns).map(([k, via]) => [k, { name: k, severity: "low", via }])) });
const allow = (over: Partial<AllowEntry> = {}): AllowEntry => ({ id: 1, package: "pkg", severity: "critical", reason: "dev-only test runner", owner: "repo owner", remediation: "upgrade the test runner", expires: "2026-12-01", ...over });
const NOW = new Date("2026-10-09T00:00:00Z");
const clean = report({});

describe("audit gate policy", () => {
  it("passes when there are no advisories", () => {
    const r = evaluateAudit({ all: clean, prod: clean, allowlist: [], now: NOW });
    expect(r).toEqual({ failures: [], warnings: [], accepted: [] });
  });

  it("fails an untriaged critical or high advisory in development tooling", () => {
    const all = report({ a: [adv(10, "critical", "a")], b: [adv(11, "high", "b")], c: [adv(12, "moderate", "c")] });
    const r = evaluateAudit({ all, prod: clean, allowlist: [], now: NOW });
    expect(r.failures).toHaveLength(2);
    expect(r.failures.join(" ")).toContain("not triaged");
    expect(r.warnings).toHaveLength(1); // the moderate one is reported, not hidden
  });

  it("accepts a triaged advisory only until its entry expires", () => {
    const all = report({ a: [adv(1, "critical", "a")] });
    expect(evaluateAudit({ all, prod: clean, allowlist: [allow()], now: NOW }).failures).toEqual([]);
    expect(evaluateAudit({ all, prod: clean, allowlist: [allow()], now: NOW }).accepted).toHaveLength(1);
    const expired = evaluateAudit({ all, prod: clean, allowlist: [allow({ expires: "2026-10-01" })], now: NOW });
    expect(expired.failures.join(" ")).toContain("expired");
  });

  it("never allowlists a production advisory of moderate or higher severity", () => {
    const bad = report({ p: [adv(1, "moderate", "p")] });
    const r = evaluateAudit({ all: bad, prod: bad, allowlist: [allow({ severity: "moderate" })], now: NOW });
    expect(r.failures.join(" ")).toContain("never allowlisted");
  });

  it("warns about allowlist entries that no longer match anything", () => {
    const r = evaluateAudit({ all: clean, prod: clean, allowlist: [allow()], now: NOW });
    expect(r.warnings.join(" ")).toContain("no longer matches");
  });

  it("refuses output that is not an audit report, so a failed audit can never pass", () => {
    expect(() => extractAdvisories({ error: { code: "ENOAUDIT" } })).toThrow();
    expect(() => extractAdvisories(null)).toThrow();
    expect(() => extractAdvisories({})).toThrow();
  });

  it("requires every allowlist entry to carry a reason, an owner, a remediation and an expiry", () => {
    expect(parseAllowlist({ entries: [allow()] })).toHaveLength(1);
    expect(() => parseAllowlist({ entries: [{ ...allow(), reason: "" }] })).toThrow(/incomplete/);
    expect(() => parseAllowlist({ entries: [{ ...allow(), expires: "soon" }] })).toThrow(/incomplete/);
    expect(() => parseAllowlist({})).toThrow();
  });

  it("deduplicates the same advisory reached through several packages", () => {
    const all = report({ a: [adv(5, "high", "a")], b: [adv(5, "high", "a")] });
    expect(extractAdvisories(all)).toHaveLength(1);
  });
});

describe("private-isolation guard", () => {
  it("flags tests that read private candidate paths, reviewed profiles, home state or credentials, by location only", () => {
    const text = [
      'const a = "ok";',
      `readFileSync("${P}/candidate/x.json")`,
      `const p = "candidate-profile.${"reviewed"}-2.json";`,
      `const h = process.env.LOCAL${"APPDATA"};`,
      `const k = process.env.GITHUB_${"TOKEN"};`,
    ].join("\n");
    const found = scanSource("tests/x.test.ts", text);
    expect(found.map((v) => v.line)).toEqual([2, 3, 4, 5]);
    expect(JSON.stringify(found)).not.toContain("x.json");
  });

  it("does not flag synthetic names or the documented opt-out marker", () => {
    expect(scanSource("t.ts", 'const f = "synthetic-pending-facts.json";')).toEqual([]);
    expect(scanSource("t.ts", 'path.join(dir, "private-runtime", "run-events.jsonl")')).toEqual([]);
    expect(scanSource("t.ts", 'const s = "private-runtime/candidate/a"; // private-isolation: allow')).toEqual([]);
  });

  it("scans a tests directory tree and the real repository tests are clean", () => {
    const root = mkdtempSync(path.join(tmpdir(), "job-hunter-iso-"));
    mkdirSync(path.join(root, "tests", "sub"), { recursive: true });
    writeFileSync(path.join(root, "tests", "sub", "bad.test.ts"), `x("${P}/pipeline/y")\n`);
    expect(scanTests(root)).toEqual([{ file: "tests/sub/bad.test.ts", line: 1, rule: "reads private-runtime candidate data" }]);
    expect(scanTests(process.cwd())).toEqual([]);
  });

  it("before/after modes fail when private-runtime exists or the run dirtied the checkout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "job-hunter-iso-git-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    expect(isolationMain("before", root)).toBe(0);
    expect(isolationMain("after", root)).toBe(0);
    writeFileSync(path.join(root, "stray.txt"), "x");
    expect(isolationMain("after", root)).toBe(1);
    mkdirSync(path.join(root, "private-runtime"));
    expect(isolationMain("before", root)).toBe(1);
    expect(isolationMain("bogus", root)).toBe(2);
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyStagedPath, main, report, scanStaged } from "../../src/ci/private-staged.js";

// The integration tests build a throwaway repository in a temporary directory. They never
// read, stage or inspect anything in this checkout. private-isolation: allow

describe("classifyStagedPath", () => {
  const codes = (file: string, ignored = false) => classifyStagedPath(file, ignored).map((f) => `${f.severity}:${f.rule}`);

  it("blocks the candidate profile directory", () => {
    expect(codes("HIGH_CONFIDENT/PROFILES/Profile (1).pdf")).toContain("BLOCK:candidate profile directory");
    expect(codes("some/nested/PROFILES/x.pdf")).toContain("BLOCK:candidate profile directory");
  });

  it("blocks extraction drafts, manifests and the salt", () => {
    expect(codes("drafts/doc-0123456789ab.draft.json")).toContain("BLOCK:extraction draft or manifest");
    expect(codes("intake-manifest.json")).toContain("BLOCK:extraction draft or manifest");
    expect(codes(".intake-salt")).toContain("BLOCK:intake salt");
  });

  it("blocks candidate fact files wherever they are", () => {
    expect(codes("pending-facts.json")).toContain("BLOCK:candidate fact file"); // private-isolation: allow
    expect(codes("somewhere/candidate-profile.reviewed.json")).toContain("BLOCK:candidate fact file"); // private-isolation: allow
  });

  it("blocks private-runtime and the resume corpus", () => {
    expect(codes("private-runtime/candidate/pending.json")).toContain("BLOCK:private runtime directory"); // private-isolation: allow
    expect(codes("data/Resumes/whatever.pdf")).toContain("BLOCK:resume corpus directory");
  });

  it("blocks a document sitting in a candidate-shaped directory", () => {
    expect(codes("my profiles/Something.pdf")).toContain("BLOCK:document in a candidate-shaped directory");
    expect(codes("Candidate_Docs/cv.docx")).toContain("BLOCK:document in a candidate-shaped directory");
  });

  it("blocks anything forced past .gitignore", () => {
    expect(codes("src/index.ts", true)).toContain("BLOCK:forced past .gitignore (git add -f)");
  });

  it("warns, but does not block, an ordinary document or spreadsheet", () => {
    const pdf = classifyStagedPath("docs/architecture/diagram.pdf", false);
    expect(pdf.map((f) => f.severity)).toEqual(["WARN"]);
    expect(classifyStagedPath("docs/report.xlsx", false).map((f) => f.severity)).toEqual(["WARN"]);
  });

  it("says nothing about ordinary source files", () => {
    expect(classifyStagedPath("src/candidate/pdf-intake.ts", false)).toEqual([]);
    expect(classifyStagedPath("tests/candidate/pdf-intake.test.ts", false)).toEqual([]);
  });

  it("treats Windows separators the same as POSIX ones", () => {
    expect(codes("HIGH_CONFIDENT\\PROFILES\\Profile (1).pdf")).toContain("BLOCK:candidate profile directory");
  });
});

describe("report", () => {
  it("fails with instructions when anything is blocked", () => {
    const lines: string[] = [];
    const code = report([{ path: "HIGH_CONFIDENT/PROFILES/Profile (1).pdf", rule: "candidate profile directory", severity: "BLOCK" }], (l) => lines.push(l));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("git restore --staged");
  });

  it("passes with warnings alone", () => {
    const lines: string[] = [];
    expect(report([{ path: "docs/x.pdf", rule: "document format that can carry personal data", severity: "WARN" }], (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toContain("worth a look");
  });

  it("passes on an empty index", () => {
    expect(report([], () => {})).toBe(0);
  });
});

describe("against a real index", () => {
  function repo(): string {
    const root = mkdtempSync(path.join(tmpdir(), "jh-staged-"));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" });
    run("init", "-q");
    run("config", "user.email", "test@example.invalid");
    run("config", "user.name", "Test");
    writeFileSync(path.join(root, ".gitignore"), "private-runtime/\nHIGH_CONFIDENT/\n", "utf-8");
    return root;
  }
  const stage = (root: string, ...files: string[]) => execFileSync("git", ["add", "--", ...files], { cwd: root, encoding: "utf-8" });

  it("finds a staged candidate PDF and fails", () => {
    const root = repo();
    mkdirSync(path.join(root, "PROFILES"));
    writeFileSync(path.join(root, "PROFILES", "Profile (1).pdf"), "%PDF-1.4 synthetic");
    stage(root, ".gitignore", "PROFILES/Profile (1).pdf");
    const lines: string[] = [];
    expect(main(root, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("BLOCK PROFILES/Profile (1).pdf");
  });

  it("finds a file forced past .gitignore", () => {
    const root = repo();
    mkdirSync(path.join(root, "private-runtime"));
    writeFileSync(path.join(root, "private-runtime", "notes.txt"), "derived candidate data");
    execFileSync("git", ["add", "-f", "--", "private-runtime/notes.txt"], { cwd: root, encoding: "utf-8" });
    const findings = scanStaged(root);
    expect(findings.map((f) => f.rule)).toContain("forced past .gitignore (git add -f)");
    expect(main(root, () => {})).toBe(1);
  });

  it("passes a commit of ordinary source files", () => {
    const root = repo();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "index.ts"), "export const x = 1;\n");
    stage(root, ".gitignore", "src/index.ts");
    expect(main(root, () => {})).toBe(0);
  });

  it("ignores a deletion", () => {
    const root = repo();
    writeFileSync(path.join(root, "keep.txt"), "hello");
    mkdirSync(path.join(root, "PROFILES"));
    writeFileSync(path.join(root, "PROFILES", "old.pdf"), "%PDF-1.4");
    execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf-8" });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: root, encoding: "utf-8" });
    execFileSync("git", ["rm", "-q", "--", "PROFILES/old.pdf"], { cwd: root, encoding: "utf-8" });
    // Removing private data from the tree must not be blocked.
    expect(main(root, () => {})).toBe(0);
  });
});

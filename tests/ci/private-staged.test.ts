import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BLOB_BYTES, classifyStagedPath, main, report, scanStaged, scanTree, sizeFindings } from "../../src/ci/private-staged.js";

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

describe("JH-REPO-001 R4.3 rules", () => {
  const codes = (file: string) => classifyStagedPath(file, false).map((f) => `${f.severity}:${f.rule}`);

  it("blocks a resume-named document outside a fixtures directory but not inside one", () => {
    expect(codes("tests/tmp/resume-test.pdf")).toContain("BLOCK:resume-named document outside a fixtures directory");
    expect(codes("docs/My CV.docx")).toContain("BLOCK:resume-named document outside a fixtures directory");
    expect(codes("services/ai/tests/fixtures/resume_sample.pdf")).not.toContain("BLOCK:resume-named document outside a fixtures directory");
  });

  it("blocks env files, key material, databases, model weights and browser profiles, but allows .env.example", () => {
    expect(codes("infra/.env").some((c) => c.startsWith("BLOCK"))).toBe(true);
    expect(codes(".env.local").some((c) => c.startsWith("BLOCK"))).toBe(true);
    expect(codes("infra/.env.example")).toEqual([]);
    for (const p of ["certs/server.pem", "id.key", "data/app.sqlite", "x.db", "backup.dump", "m/model.safetensors", "m/model.gguf", "m/model.onnx", ".chrome-profile/Default/Cookies", "JobHunterPrivate/a.txt", "User Data/x"]) {
      expect(codes(p).some((c) => c.startsWith("BLOCK")), p).toBe(true);
    }
  });

  it("keeps the tracked role profile notes (profiles/*.md) out of the candidate-directory rule", () => {
    expect(codes("profiles/sdet.md")).toEqual([]);
  });

  it("blocks any file over 5 MB and passes one at the limit", () => {
    expect(sizeFindings([{ path: "big.bin", size: MAX_BLOB_BYTES + 1 }]).map((f) => f.severity)).toEqual(["BLOCK"]);
    expect(sizeFindings([{ path: "ok.bin", size: MAX_BLOB_BYTES }])).toEqual([]);
  });
});

describe("tree mode and staged size in a throwaway repository", () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "jh-guard-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@example.test"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    return dir;
  }

  it("blocks a staged resume-named pdf and an oversize staged file, then passes once they are unstaged", () => {
    const dir = repo();
    mkdirSync(path.join(dir, "tests", "tmp"), { recursive: true });
    writeFileSync(path.join(dir, "tests", "tmp", "resume-test.pdf"), "%PDF-1.4\n");
    writeFileSync(path.join(dir, "big.dat"), Buffer.alloc(MAX_BLOB_BYTES + 1));
    execFileSync("git", ["add", "--", "tests/tmp/resume-test.pdf", "big.dat"], { cwd: dir });
    const lines: string[] = [];
    expect(main(dir, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("tests/tmp/resume-test.pdf");
    expect(lines.join("\n")).toContain("big.dat");
    execFileSync("git", ["rm", "-q", "--cached", "--", "tests/tmp/resume-test.pdf", "big.dat"], { cwd: dir });
    expect(main(dir, () => undefined)).toBe(0);
  });

  it("tree mode applies the same rules to committed files", () => {
    const dir = repo();
    writeFileSync(path.join(dir, "model.safetensors"), "x");
    writeFileSync(path.join(dir, "README.md"), "# ok\n");
    execFileSync("git", ["add", "--", "model.safetensors", "README.md"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "t"], { cwd: dir });
    expect(scanTree(dir).map((f) => f.path)).toEqual(["model.safetensors"]);
    expect(scanStaged(dir)).toEqual([]);
  });
});

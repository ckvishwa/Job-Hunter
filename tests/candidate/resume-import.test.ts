import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runImport } from "../../src/candidate/cli.js";
import { buildPendingFacts, readDocxParagraphs } from "../../src/candidate/resume-import.js";
import { buildDocx } from "../helpers/docx.js";

// Boundary: real (synthetic) .docx bytes, real parser, real temp files. Resume text below is invented.

const RESUME = [
  "[FULL NAME]",
  "QA Engineer | Java, Python",
  "[Phone]  |  someone@example.test  |  [City, State]",
  "PROFESSIONAL SUMMARY",
  "SECRET-SUMMARY-CLAIM Seasoned engineer with 12 years of everything.",
  "TECHNICAL SKILLS",
  "Languages: Java, Python, TypeScript",
  "Testing: Unit, integration, API & database testing",
  "Cloud: AWS [Month Year]",
  "PROFESSIONAL EXPERIENCE",
  "Acme Corp — QA Engineer\tJanuary 2020 – March 2022",
  "SECRET-BULLET-CLAIM Reduced defects by 400 percent.",
  "Globex — Platform Engineer\tApril 2022 – Present",
  "Initech — Intern\tSometime 2019 – 2020",
  "PERSONAL PROJECTS",
  "Personal Project — Quality Platform",
  "Java 21, Spring Boot, JUnit, Docker",
  "Built the thing and tested it thoroughly.",
  "CERTIFICATION",
  "CompTIA Security+ — [Month Year]",
  "EDUCATION",
  "[Degree], [University] — [Graduation Year]",
];

describe("readDocxParagraphs", () => {
  it("reads paragraph text, keeps tabs, decodes entities and ignores <w:tab>/<w:tabs> property elements", () => {
    const docx = buildDocx(["Plain", "A & B < C\tright side", "", "Last"]);
    expect(readDocxParagraphs(docx)).toEqual(["Plain", "A & B < C\tright side", "", "Last"]);
  });

  it("rejects bytes that are not a docx", () => {
    expect(() => readDocxParagraphs(Buffer.from("not a zip at all, just text bytes"))).toThrow(/zip/);
  });
});

describe("buildPendingFacts", () => {
  const result = buildPendingFacts([{ name: "Resume_A.docx", paragraphs: readDocxParagraphs(buildDocx(RESUME)) }], { candidateId: "cand-1", importedAt: "2026-10-07T10:00:00.000Z" });
  const byKind = (k: string) => result.profile.facts.filter((f) => f.kind === k);

  it("emits only pending, unverified, non-sensitive facts and approves nothing", () => {
    expect(result.profile.facts.length).toBeGreaterThan(5);
    for (const f of result.profile.facts) {
      expect(f.approvalStatus).toBe("pending");
      expect(f.verification).toEqual({ verifiedBy: null, verifiedAt: null, validUntil: null });
      expect(f.sensitivity).toBe("normal");
      expect(f.source).toMatchObject({ kind: "resume-import", reference: "Resume_A.docx" });
      expect(f.source.locator).toMatch(/^paragraph \d+$/);
    }
    expect(result.profile.profileVersion).toBe("pending-import-2026-10-07");
    expect(result.profile.employmentHistoryComplete).toBeNull();
    expect(result.profile.preferences).toEqual({});
  });

  it("imports skills verbatim and skips an item that contains an unfilled placeholder", () => {
    const skills = byKind("skill").map((f) => f.value);
    expect(skills).toEqual(expect.arrayContaining(["Java", "Python", "TypeScript", "Unit", "API & database testing"]));
    expect(skills.some((s) => s.includes("["))).toBe(false);
  });

  it("imports employment with parsed month dates, 'Present' as a null end, and no role tags or years", () => {
    const jobs = byKind("employment");
    expect(jobs.map((j) => [j.attributes.employer, j.attributes.title, j.attributes.startDate, j.attributes.endDate])).toEqual([
      ["Acme Corp", "QA Engineer", "2020-01", "2022-03"],
      ["Globex", "Platform Engineer", "2022-04", null],
    ]);
    expect(jobs.every((j) => j.attributes.roleTags === undefined)).toBe(true);
    // The line with an unparseable date is reported, never guessed.
    expect(result.issues.some((i) => i.message.includes("could not be parsed"))).toBe(true);
    expect(jobs.some((j) => j.attributes.employer === "Initech")).toBe(false);
  });

  it("imports projects with their technology list and flags them as never professional years", () => {
    const [project] = byKind("project");
    expect(project).toMatchObject({ value: "Quality Platform" });
    expect(project!.attributes.technologies).toEqual(["Java 21", "Spring Boot", "JUnit", "Docker"]);
    expect(project!.notes).toContain("never counted as professional years");
  });

  it("imports a certification without inventing its date, and reports placeholder education", () => {
    const [cert] = byKind("certification");
    expect(cert!.value).toBe("CompTIA Security+");
    expect(cert!.notes).toContain("Issue date not stated");
    expect(result.issues.map((i) => i.message).join("|")).toMatch(/unfilled date placeholder/);
    expect(result.issues.map((i) => i.message).join("|")).toMatch(/education line is an unfilled template placeholder/);
    expect(byKind("education")).toHaveLength(0);
  });

  it("keeps no contact details, summary text or bullet claims, and creates no sensitive-kind facts", () => {
    const json = JSON.stringify(result.profile);
    for (const absent of ["someone@example.test", "[FULL NAME]", "SECRET-SUMMARY-CLAIM", "SECRET-BULLET-CLAIM", "400 percent", "12 years"]) expect(json).not.toContain(absent);
    for (const kind of ["clearance", "work_authorization", "sponsorship_need"]) expect(byKind(kind)).toHaveLength(0);
  });

  it("merges the same fact found in several resumes into one pending fact that notes where else it appears", () => {
    const docs = ["Resume_A.docx", "Resume_B.docx"].map((name) => ({ name, paragraphs: readDocxParagraphs(buildDocx(RESUME)) }));
    const merged = buildPendingFacts(docs, { candidateId: "cand-1", importedAt: "2026-10-07T10:00:00.000Z" });
    expect(merged.profile.facts.filter((f) => f.value === "Python")).toHaveLength(1);
    expect(merged.profile.facts.filter((f) => f.kind === "employment")).toHaveLength(2);
    const python = merged.profile.facts.find((f) => f.value === "Python")!;
    expect(python.notes).toContain("Also appears in Resume_B.docx");
    expect(new Set(merged.profile.facts.map((f) => f.factId)).size).toBe(merged.profile.facts.length);
  });
});

describe("candidate:import command", () => {
  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), "jh-resumes-"));
    mkdirSync(path.join(root, "SDET", "Resume"), { recursive: true });
    mkdirSync(path.join(root, "SDET", "Coverletters"), { recursive: true });
    writeFileSync(path.join(root, "SDET", "Resume", "Resume_SDET.docx"), buildDocx(RESUME));
    writeFileSync(path.join(root, "SDET", "Coverletters", "CoverLetter_SDET.docx"), buildDocx(["TECHNICAL SKILLS", "Languages: COVER-LETTER-ONLY-SKILL"]));
    return { root, out: path.join(mkdtempSync(path.join(tmpdir(), "jh-out-")), "nested", "pending.json") };
  }

  it("reads resumes only (never cover letters), writes a valid pending file and says nothing was approved", () => {
    const { root, out } = setup();
    const lines: string[] = [];
    const code = runImport({ resumesDir: root, out, candidateId: "cand-1", force: false }, (l) => lines.push(l));
    expect(code).toBe(0);
    const written = readFileSync(out, "utf-8");
    expect(written).not.toContain("COVER-LETTER-ONLY-SKILL");
    expect(JSON.parse(written).facts.every((f: { approvalStatus: string }) => f.approvalStatus === "pending")).toBe(true);
    expect(lines.join("\n")).toContain("Nothing is approved");
    expect(lines.join("\n")).toContain("Resume_SDET.docx");
    expect(lines.join("\n")).not.toContain("CoverLetter_SDET");
  });

  it("refuses to overwrite an existing file (it may hold reviewed approvals) unless --force", () => {
    const { root, out } = setup();
    const log = vi.fn();
    expect(runImport({ resumesDir: root, out, candidateId: "c", force: false }, log)).toBe(0);
    writeFileSync(out, "REVIEWED APPROVALS");
    expect(runImport({ resumesDir: root, out, candidateId: "c", force: false }, log)).toBe(2);
    expect(readFileSync(out, "utf-8")).toBe("REVIEWED APPROVALS");
    expect(runImport({ resumesDir: root, out, candidateId: "c", force: true }, log)).toBe(0);
    expect(readFileSync(out, "utf-8")).not.toBe("REVIEWED APPROVALS");
  });

  it("fails clearly with no directory or no resumes", () => {
    const log = vi.fn();
    expect(runImport({ out: "x.json", candidateId: "c", force: false }, log)).toBe(2);
    const empty = mkdtempSync(path.join(tmpdir(), "jh-empty-"));
    expect(runImport({ resumesDir: empty, out: path.join(empty, "o.json"), candidateId: "c", force: false }, log)).toBe(2);
    expect(existsSync(path.join(empty, "o.json"))).toBe(false);
  });
});

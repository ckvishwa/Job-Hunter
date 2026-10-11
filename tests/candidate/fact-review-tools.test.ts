import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assessFactQuality, uncoveredLineCount } from "../../src/candidate/fact-quality.js";
import { maskValue, readReviewFile, reviewFileSchema, writeReviewFile, buildReviewFile, type ReviewFile } from "../../src/candidate/fact-review-file.js";
import { runReviewSession, type ReviewIo } from "../../src/candidate/fact-review-session.js";
import type { FactView } from "../../src/db/candidate-repo.js";

// Pure tests with synthetic data only (no database, no real résumé).

const TEXT = "SKILLS\nSplunk, event corre-\nlation, orchestration, splunk\nEXPERIENCE\nCognizant SOC Intern Jun 2021 - Aug 2021 built detections for the analyst team";
const span = (quote: string, from = 0) => ({ start: TEXT.indexOf(quote, from), end: TEXT.indexOf(quote, from) + quote.length, quote });
const RESUME_ID = "11111111-1111-4111-8111-111111111111";

function fv(over: Partial<FactView> & Pick<FactView, "factId" | "kind" | "value">): FactView {
  return {
    resumeVersionId: "22222222-2222-4222-8222-222222222222", polarity: "has", attributes: {}, source: { kind: "resume-import", reference: "r", locator: "chars 0-1" },
    span: null, proposedBy: "rules", approvalStatus: "pending", sensitivity: "normal", verification: { verifiedBy: null, verifiedAt: null, validUntil: null },
    contentDigest: "a".repeat(64), headRevision: 1, notes: null, ...over,
  };
}

const FACTS: FactView[] = [
  fv({ factId: "f-skill-1", kind: "skill", value: "Splunk", span: span("Splunk") }),
  fv({ factId: "f-skill-2", kind: "skill", value: "event corre-", span: span("event corre-") }),
  fv({ factId: "f-skill-3", kind: "skill", value: "lation", span: span("lation") }),
  fv({ factId: "f-skill-4", kind: "skill", value: "orchestration", span: span("orchestration") }),
  fv({ factId: "f-skill-5", kind: "skill", value: "splunk", span: span("splunk") }),
  fv({ factId: "f-emp-1", kind: "employment", value: "Cognizant SOC Intern", attributes: { startDate: "2021-06", endDate: "2021-08" }, span: span("Cognizant SOC Intern Jun 2021 - Aug 2021") }),
  fv({ factId: "f-email-1", kind: "email", value: "pat@example.com", sensitivity: "sensitive", span: null }),
];
const codes = (id: string, text: string | null = TEXT) => assessFactQuality(FACTS.find((f) => f.factId === id)!, FACTS, text).map((w) => w.code);

describe("extraction-quality warnings (non-destructive)", () => {
  it("flags a word split by a line wrap on both fragments", () => {
    expect(codes("f-skill-2")).toContain("BROKEN_LINE");
    expect(codes("f-skill-3")).toContain("BROKEN_LINE"); // starts right after "corre-\n"
    expect(codes("f-skill-1")).not.toContain("BROKEN_LINE");
  });
  it("flags duplicates ignoring case", () => {
    expect(codes("f-skill-1")).toContain("POSSIBLE_DUPLICATE");
    expect(codes("f-skill-5")).toContain("POSSIBLE_DUPLICATE");
    expect(codes("f-skill-4")).not.toContain("POSSIBLE_DUPLICATE");
  });
  it("flags a lone generic term but not a specific tool", () => {
    expect(codes("f-skill-4")).toContain("INSUFFICIENT_CONTEXT");
    expect(codes("f-skill-1")).not.toContain("INSUFFICIENT_CONTEXT");
  });
  it("asks for employment verification when employer/title are missing or it is an internship", () => {
    const w = assessFactQuality(FACTS.find((f) => f.factId === "f-emp-1")!, FACTS, TEXT).find((x) => x.code === "EMPLOYMENT_REVIEW")!;
    expect(w.message).toMatch(/missing/);
    expect(w.message).toMatch(/internship/);
  });
  it("flags a quotation that no longer matches the text, or a value absent from its quote", () => {
    const moved = fv({ factId: "x", kind: "skill", value: "Splunk", span: { start: 0, end: 6, quote: "Splunk" } });
    expect(assessFactQuality(moved, [moved], TEXT).map((w) => w.code)).toContain("SOURCE_MISMATCH");
    const absent = fv({ factId: "y", kind: "skill", value: "Kubernetes", span: span("Splunk") });
    expect(assessFactQuality(absent, [absent], TEXT).map((w) => w.code)).toContain("SOURCE_MISMATCH");
  });
  it("counts long text lines no fact covers, without returning their text", () => {
    expect(uncoveredLineCount(TEXT, FACTS)).toBe(0);
    expect(uncoveredLineCount(TEXT + "\nReduced mean time to respond by forty percent across the whole SOC", FACTS)).toBe(1);
  });
});

function exported(reveal = false): ReviewFile {
  return buildReviewFile({ userHandle: "local", resumeId: RESUME_ID, resumeVersionId: "22222222-2222-4222-8222-222222222222", sourceTextSha256: "b".repeat(64), text: TEXT, facts: FACTS, reveal, now: new Date("2026-10-09T00:00:00Z") });
}

describe("review file", () => {
  it("starts with decision null for every fact, whatever the status", () => {
    const withApproved = buildReviewFile({ userHandle: "local", resumeId: RESUME_ID, resumeVersionId: "22222222-2222-4222-8222-222222222222", sourceTextSha256: "b".repeat(64), text: TEXT, facts: [fv({ factId: "f-a", kind: "skill", value: "Python", approvalStatus: "approved", span: span("Splunk") })], reveal: false, now: new Date() });
    expect(withApproved.facts[0]).toMatchObject({ status: "approved", decision: null });
    expect(exported().facts.every((f) => f.decision === null)).toBe(true);
  });
  it("masks sensitive values by default and reveals only on request", () => {
    expect(JSON.stringify(exported())).not.toContain("pat@example.com");
    expect(exported().facts.find((f) => f.kind === "email")).toMatchObject({ valueMasked: true, value: maskValue("pat@example.com") });
    expect(exported(true).facts.find((f) => f.kind === "email")).toMatchObject({ valueMasked: false, value: "pat@example.com" });
  });
  it("preserves the original quotation and value exactly", () => {
    expect(exported().facts.find((f) => f.factId === "f-skill-2")).toMatchObject({ value: "event corre-", quote: "event corre-" });
  });
  it("accepts only approve, reject or null and rejects unknown fields", () => {
    const base = exported();
    for (const bad of ["skip", "APPROVE", "edit", true, 1]) {
      const copy = structuredClone(base) as any;
      copy.facts[0].decision = bad;
      expect(reviewFileSchema.safeParse(copy).success, String(bad)).toBe(false);
    }
    const extra = structuredClone(base) as any;
    extra.facts[0].approvalStatus = "approved";
    expect(reviewFileSchema.safeParse(extra).success).toBe(false);
    const ok = structuredClone(base) as any;
    ok.facts[0].decision = "approve";
    ok.facts[1].decision = "reject";
    ok.facts[1].reason = "fragment";
    expect(reviewFileSchema.safeParse(ok).success).toBe(true);
  });
});

describe("interactive reviewer", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jh-facts-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const scripted = (answers: string[]): { io: ReviewIo; out: string[] } => {
    const out: string[] = [];
    return { out, io: { ask: async () => answers.shift() ?? "q", out: (t) => void out.push(t) } };
  };
  const freshFile = (name: string): string => {
    const f = path.join(dir, name);
    writeReviewFile(f, exported(), { overwrite: false });
    return f;
  };

  it("records A and R, leaves Enter untouched, and saves progress when quitting", async () => {
    const f = freshFile("a.json");
    const { io, out } = scripted(["a", "", "r", "q"]);
    const s = await runReviewSession(f, { filter: "all", redo: false }, io);
    const file = readReviewFile(f);
    expect(file.facts.map((x) => x.decision)).toEqual(["approve", null, "reject", null, null, null, null]);
    expect(s).toMatchObject({ approve: 1, reject: 1, reviewedThisSession: 2, quit: true });
    expect(out.join("\n")).toContain("ORBITAL FACT REVIEW — 1 / 7");
    expect(out.join("\n")).toContain("WARNING: BROKEN_LINE");
  });

  it("resumes where it left off and never decides anything on its own", async () => {
    const f = freshFile("b.json");
    await runReviewSession(f, { filter: "all", redo: false }, scripted(["a", "q"]).io);
    const second = scripted(["", "", "", "", "", "", ""]); // skip everything that is left
    const s = await runReviewSession(f, { filter: "all", redo: false }, second.io);
    expect(second.out.join("\n")).toContain("1 / 6"); // the decided fact is not shown again
    expect(readReviewFile(f).facts.filter((x) => x.decision !== null)).toHaveLength(1);
    expect(s.reviewedThisSession).toBe(0);
  });

  it("filters to facts with warnings and ignores unknown keys", async () => {
    const f = freshFile("c.json");
    const { io, out } = scripted(["zz", "q"]);
    await runReviewSession(f, { filter: "warnings", redo: false }, io);
    expect(out.join("\n")).toContain("Unknown key");
    expect(out.join("\n")).toContain("1 / 6"); // 6 of the 7 facts carry a warning; the email has none
    expect(out.join("\n")).not.toContain("TYPE:    EMAIL");
  });

  it("keeps what the file already says when the file is hand-edited and reread", () => {
    const f = freshFile("d.json");
    const data = JSON.parse(readFileSync(f, "utf8"));
    data.facts[0].decision = "reject";
    writeFileSync(f, JSON.stringify(data));
    expect(readReviewFile(f).facts[0]!.decision).toBe("reject");
  });
});

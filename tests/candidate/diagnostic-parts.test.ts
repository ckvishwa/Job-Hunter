import { describe, expect, it } from "vitest";
import { extractQuantities, extractStatements, skillContexts, splitLines } from "../../src/candidate/achievements.js";
import { detectEmploymentConflicts, type EmploymentRecord } from "../../src/candidate/employment-conflicts.js";
import { evaluateIfPossible, notEvaluated, referenceSchema, scoreAgainstReference } from "../../src/candidate/extraction-metrics.js";

const rec = (over: Partial<EmploymentRecord> & { ref: string }): EmploymentRecord => ({
  origin: "resume-fact", factId: over.ref, resumeId: "r1", status: "approved", employer: null, title: null, text: "", startDate: null, endDate: undefined, employmentType: null, ...over,
});

describe("employment conflicts", () => {
  it("flags disagreeing title, dates and category for the same employer, even when one side never separated employer from title", () => {
    const a = rec({ ref: "f-a", text: "Security Operations Vulnerability Analyst Intern Acme Systems", startDate: "2022-09", endDate: "2023-05", employmentType: "internship" });
    const b = rec({ ref: "prior:x#1", origin: "prior-record", factId: null, resumeId: null, status: "prior-approved", employer: "Acme Systems", title: "Programmer Analyst", text: "Acme Systems — Programmer Analyst", startDate: "2022-01", endDate: "2023-07" });
    const [c] = detectEmploymentConflicts([a, b]);
    expect(c!.code).toBe("EMPLOYMENT_CONFLICT");
    expect(c!.differences.map((d) => d.field).sort()).toEqual(["endDate", "startDate", "title"]);
    expect(c!.required).toMatch(/Neither version is selected/);
  });

  it("does not call a promotion, an identical copy or a rejected record a conflict", () => {
    const iam = rec({ ref: "f1", employer: "Wingtip Corp", title: "IAM Analyst", text: "Wingtip Corp — IAM Analyst", startDate: "2022-11", endDate: null });
    const desk = rec({ ref: "f2", employer: "Wingtip Corp", title: "Service Desk Associate", text: "Wingtip Corp — Service Desk Associate", startDate: "2021-05", endDate: "2022-10" });
    const copy = rec({ ref: "f3", resumeId: "r2", employer: "Wingtip Corp", title: "IAM Analyst", text: "Wingtip Corp — IAM Analyst", startDate: "2022-11", endDate: null });
    const rejected = rec({ ref: "f4", status: "rejected", employer: "Wingtip Corp", title: "Janitor", text: "Wingtip Corp — Janitor", startDate: "2022-12", endDate: null });
    expect(detectEmploymentConflicts([iam, desk, copy, rejected])).toEqual([]);
  });

  it("an overlapping concurrent record with a different title is a conflict, an unknown date range cannot rule one out", () => {
    const a = rec({ ref: "a", employer: "Initech", title: "Analyst", text: "Initech Analyst", startDate: "2021-01", endDate: "2021-12" });
    const b = rec({ ref: "b", employer: "Initech", title: "Engineer", text: "Initech Engineer", startDate: "2021-06", endDate: "2022-03" });
    const c = rec({ ref: "c", employer: "Initech", title: "Engineer", text: "Initech Engineer", startDate: "2021-06", endDate: undefined });
    expect(detectEmploymentConflicts([a, b])).toHaveLength(1);
    expect(detectEmploymentConflicts([a, c])).toHaveLength(1);
  });
});

describe("achievement evidence", () => {
  const TEXT = [
    "Alex Sample", "Professional Summary", "Built 14 SPL detections across 8,000+ Windows/Sysmon events and mapped MITRE ATT&CK techniques.",
    "Experience", "Detection Analyst Acme Systems Sep 2022 – May 2023",
    "◦ Assessed 30+ enterprise web applications, identifying 20+ vulnerabilities including XSS, CSRF, and SQL", "Injection mapped to OWASP Top 10 risks.",
    "Security Engineering Projects", "MalTrace — Detection Platform 2026", "Python — Flask — SHAP •github.com/x/y",
    "◦ Validated 64 malware families, achieving F1 = 0.975 (±0.008), 98.5% recall and 0/75 false positives during stress testing.",
    "Technical Skills", "Detection: Splunk, Wireshark, Kali",
  ].join("\n");

  it("reads quantities exactly as written and leaves years, 'Top 10' and ranges alone", () => {
    const q = (s: string) => extractQuantities(s).map((x) => x.raw);
    expect(q("Authored 14 custom SPL detection rules for 9 tactics")).toEqual(["14 custom SPL detection", "9 tactics"]);
    expect(q("achieving F1 = 0.975 (±0.008), 98.5% recall and 0/75 false positives during stress testing")).toEqual(["F1 = 0.975 (±0.008)", "0/75 false positives", "98.5% recall"]);
    expect(q("mapped to OWASP Top 10 risks in 2026")).toEqual([]);
    expect(q("Assessed 30+ enterprise web applications")).toEqual(["30+ enterprise web applications"]);
  });

  it("anchors statements to the section and the nearest employment/project fact, and never produces a duration", () => {
    const lines = splitLines(TEXT);
    expect(lines.find((l) => l.text.startsWith("Security Engineering"))!.section).toBe("projects");
    const emp = { factId: "f-emp", kind: "employment", span: { start: TEXT.indexOf("Detection Analyst"), end: TEXT.indexOf("Detection Analyst") + 20 } };
    const proj = { factId: "f-proj", kind: "project", span: { start: TEXT.indexOf("MalTrace"), end: TEXT.indexOf("MalTrace") + 8 } };
    const st = extractStatements(TEXT, [emp, proj]);
    const kinds = st.map((s) => [s.kind, s.ownerFactId]);
    expect(kinds).toEqual([["summary_claim", null], ["employment_responsibility", "f-emp"], ["project_accomplishment", "f-proj"]]);
    // a wrapped bullet is one statement and its quote is verbatim source text
    expect(st[1]!.quote).toContain("SQL\nInjection mapped to OWASP Top 10 risks.");
    for (const s of st) expect(TEXT.slice(s.start, s.end)).toBe(s.quote);
    expect(JSON.stringify(st)).not.toMatch(/months|years/i);
  });

  it("separates skills used inside described work from skills that are only listed", () => {
    const st = extractStatements(TEXT, []);
    const ctx = skillContexts(TEXT, st, [
      { factId: "s1", value: "SPL" }, { factId: "s2", value: "Splunk" }, { factId: "s3", value: "Kali" }, { factId: "s4", value: "Rust" }, { factId: "s5", value: "Flask" }, { factId: "s6", value: "XSS" },
    ]);
    expect(Object.fromEntries(ctx.map((c) => [c.factId, c.context]))).toEqual({
      s1: "summary_only", s2: "skills_list_only", s3: "skills_list_only", s4: "not_found_in_text", s5: "skills_list_only", s6: "demonstrated_in_context",
    });
  });
});

describe("accuracy metrics", () => {
  const ref = referenceSchema.parse({
    schema: "orbital-extraction-reference/1", independent: true, labeledBy: "a person", labeledAt: "2026-10-09",
    facts: [
      { kind: "skill", value: "event correlation" }, { kind: "skill", value: "SPL" }, { kind: "skill", value: "Kubernetes" },
      { kind: "employment", value: "Acme — Analyst", employer: "Acme", title: "Analyst", startDate: "2022-01", endDate: "2023-07" },
    ],
  });

  it("is the literal string NOT_EVALUATED without an independent reference, and never a number", () => {
    expect(evaluateIfPossible([{ kind: "skill", value: "SPL" }], null, null)).toMatchObject({ status: "NOT_EVALUATED", precision: "NOT_EVALUATED", recall: "NOT_EVALUATED", f1: "NOT_EVALUATED" });
    expect(notEvaluated("x").status).toBe("NOT_EVALUATED");
    expect(referenceSchema.safeParse({ ...ref, independent: false }).success).toBe(false);
  });

  it("computes precision, recall, F1 and exact employment fields against the reference", () => {
    const e = scoreAgainstReference([
      { kind: "skill", value: "Event Correlation" }, { kind: "skill", value: "lation" }, { kind: "skill", value: "SPL" },
      { kind: "employment", value: "Acme — Analyst", attributes: { employer: "Acme", title: "Analyst", startDate: "2022-01", endDate: "2023-06" } },
    ], ref);
    if (e.status !== "EVALUATED") throw new Error("expected EVALUATED");
    expect(e).toMatchObject({ truePositives: 3, falsePositives: 1, falseNegatives: 1, precision: 0.75, recall: 0.75, f1: 0.75 });
    expect(e.perCategory.skill).toMatchObject({ proposed: 3, reference: 3, truePositives: 2 });
    expect(e.employmentExact).toMatchObject({ referenceRecords: 1, exactEmployer: 1, exactTitle: 1, exactStart: 1, exactEnd: 0, allFieldsExact: 0 });
  });

  it("refuses a reference written for different text", () => {
    const hashed = { ...ref, textSha256: "a".repeat(64) };
    expect(evaluateIfPossible([], hashed, "b".repeat(64))).toMatchObject({ status: "NOT_EVALUATED" });
  });
});

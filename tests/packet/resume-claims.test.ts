import { describe, expect, it } from "vitest";
import type { ResumePlan } from "../../src/pipeline/resume-plan.js";
import { buildClaimMap } from "../../src/packet/resume-claims.js";
import { fact, profile } from "../helpers/decision-fixtures.js";

// Synthetic applicant and a synthetic extracted-PDF text laid out like the real renderer's output.
const AS_OF = "2026-10-09";
const EMPLOYMENT = fact({ factId: "f-job", kind: "employment", value: "Example Corp — QA Tester", attributes: { employer: "Example Corp", title: "QA Tester", startDate: "2020-03", endDate: "2022-06", roleTags: ["QA"], detail: "Tested web applications and wrote regression suites." }, source: { kind: "user-statement", reference: "resume.docx", locator: "paragraph 3" } });
const PYTHON = fact({ factId: "f-py", kind: "skill", value: "Python", attributes: { detail: "Wrote Python test scripts for APIs." }, source: { kind: "user-statement", reference: "resume.docx", locator: "paragraph 9" } });
const PROFILE = profile([EMPLOYMENT, PYTHON, fact({ factId: "f-pending", kind: "skill", value: "Kubernetes", pending: true })]);
const plan = (selected: Array<{ factId: string; wording: string }>): ResumePlan => ({
  schemaVersion: 1, id: "p".repeat(64), jobId: "job-1", jdHash: "a".repeat(64), profileDigest: "b".repeat(64), lane: "cybersecurity", canonicalResumePath: "x", canonicalResumeHash: "C".repeat(64),
  selectedFacts: selected.map((s) => ({ ...s, sourceReference: "resume.docx", sourceLocator: null })), uncoveredRequirementIds: ["req:x"], decisionOutcome: "REVIEW", previewOnly: true,
});
const job = { company: "Acme", title: "Security Analyst" };
const PAGE = [
  "PREVIEW — REVIEW REQUIRED",
  "Candidate synthetic-candidate",
  "Target: Security Analyst · cybersecurity · Acme",
  "Plan aaaaaaaaaaaa · approved profile facts only",
  "This is a review preview, not an application-ready resume. Uncovered mandatory requirements: 1.",
  "APPROVED EVIDENCE",
  "Wrote Python test scripts for APIs.",
  "Evidence: resume.docx, paragraph 9 · f-py",
  "PROFESSIONAL EXPERIENCE",
  "Example Corp — QA Tester",
  "March 2020 – June 2022",
  "Tested web applications and wrote regression suites.",
  "role tags: QA · f-job",
].join("\n");
const SELECTED = [{ factId: "f-py", wording: "Wrote Python test scripts for APIs." }, { factId: "f-job", wording: "Tested web applications and wrote regression suites." }];
const run = (over: Partial<Parameters<typeof buildClaimMap>[0]> = {}) => buildClaimMap({ plan: plan(SELECTED), profile: PROFILE, asOf: AS_OF, decision: null, extractedText: PAGE, job, excludedTerms: [], ...over });

describe("resume claim map", () => {
  it("accepts a resume whose every claim is an approved fact quoted verbatim, with zero unsupported content", () => {
    const m = run();
    expect({ u: m.unsupportedText, c: m.claims.map((c) => c.problems) }).toEqual({ u: [], c: [[], []] });
    expect(m.unsupportedCount).toBe(0);
    expect(m.claims.map((c) => [c.factId, c.supported, c.source?.reference, c.approvedBy])).toEqual([["f-py", true, "resume.docx", "synthetic-reviewer"], ["f-job", true, "resume.docx", "synthetic-reviewer"]]);
    expect(m.unsupportedText).toEqual([]);
    expect(m.uncoveredRequirementIds).toEqual(["req:x"]); // stated, not hidden
  });

  it("flags a claim whose wording differs from the approved wording", () => {
    const m = run({ plan: plan([{ factId: "f-py", wording: "Expert Python engineer with 8 years of experience." }]) });
    expect(m.claims[0]).toMatchObject({ supported: false });
    expect(m.claims[0]!.problems.join(" ")).toContain("differs from the approved wording");
    expect(m.unsupportedCount).toBeGreaterThan(0);
  });

  it("flags a fact that is only pending, and a fact id that does not exist", () => {
    const pending = run({ plan: plan([{ factId: "f-pending", wording: "Kubernetes" }]) });
    expect(pending.claims[0]!.problems.join(" ")).toContain("not approved");
    const unknown = run({ plan: plan([{ factId: "f-missing", wording: "Invented skill" }]) });
    expect(unknown.claims[0]).toMatchObject({ supported: false, factKind: null });
  });

  it("flags text on the page that is neither an approved claim nor template furniture (an invented sentence)", () => {
    const m = run({ extractedText: `${PAGE}\nLed a team of ten engineers and holds a security clearance.` });
    expect(m.unsupportedText.join(" ")).toContain("Led a team of ten engineers");
    expect(m.unsupportedCount).toBeGreaterThan(0);
  });

  it("flags excluded experience wherever it appears, using only applicant-supplied terms", () => {
    const m = run({ extractedText: `${PAGE}\nPrior role in bridge construction inspection.`, excludedTerms: ["construction inspection", "civil engineering"] });
    expect(m.excludedTermHits).toEqual(["construction inspection"]);
    expect(m.unsupportedCount).toBeGreaterThan(0);
    expect(run({ excludedTerms: ["construction inspection"] }).excludedTermHits).toEqual([]);
  });

  it("links a claim to the mandatory requirements the deterministic decision matched it to", () => {
    const decision = { rules: [{ ruleId: "req:r1", subject: { kind: "requirement", id: "r1" }, label: "", mandatory: true, level: "required", status: "PASS", explanation: "", evidence: [], factIds: ["f-py"] }] } as never;
    expect(run({ decision }).claims.find((c) => c.factId === "f-py")!.supportsRequirements).toEqual(["req:r1"]);
  });
});

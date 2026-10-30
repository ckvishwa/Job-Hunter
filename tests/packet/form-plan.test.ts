import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApplicationInspection, ObservedControl } from "../../src/pipeline/application-form.js";
import { formFingerprint, planForm } from "../../src/packet/form-plan.js";
import { verifyFormTarget } from "../../src/packet/form-fill.js";
import { fact, profile } from "../helpers/decision-fixtures.js";

// Synthetic applicant (invented). The captured real form structure is public question text only.
const AS_OF = "2026-10-09";
const control = (over: Partial<ObservedControl> & { label: string }): ObservedControl => ({ id: over.label.toLowerCase().replace(/\W+/g, "_"), help: "", type: "text", required: true, disabled: false, options: [], accept: null, role: null, ...over });
const form = (...controls: ObservedControl[]): ApplicationInspection => ({ url: "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1", title: "Job Application for QA Analyst at Acme", controls, submitControls: 1, verificationDetected: false });

const NAME = fact({ factId: "f-name", kind: "legal_name", value: "Alex Q Example", attributes: { givenName: "Alex", familyName: "Example" } });
const EMAIL = fact({ factId: "f-email", kind: "email", value: "alex@example.test" });
const PHONE = fact({ factId: "f-phone", kind: "phone", value: "555-0100" });
const AUTH = fact({ factId: "f-auth", kind: "work_authorization", value: "Yes" });
const SPON = fact({ factId: "f-spon", kind: "sponsorship_need", value: "No" });
const JOB = fact({ factId: "f-job", kind: "employment", value: "Tester", attributes: { employer: "Example Corp", title: "QA Tester", startDate: "2020-01", endDate: "2021-06" } });
const FULL = profile([NAME, EMAIL, PHONE, AUTH, SPON, JOB]);
const resume = { approved: true, fileName: "resume.pdf", sha256: "b".repeat(64) };
const plan = (inspection: ApplicationInspection, p = FULL, r: typeof resume | null = resume) => planForm({ inspection, profile: p, asOf: AS_OF, resume: r });
const by = (p: ReturnType<typeof plan>, label: string) => p.entries.find((e) => e.label === label)!;

describe("form planning: field mapping", () => {
  it("maps first and last name from the approved given/family split, never by splitting the full name", () => {
    const p = plan(form(control({ label: "First Name*" }), control({ label: "Last Name*" })));
    expect(by(p, "First Name")).toMatchObject({ disposition: "ANSWER", expected: "Alex", factId: "f-name" });
    expect(by(p, "Last Name")).toMatchObject({ disposition: "ANSWER", expected: "Example" });
    const noSplit = plan(form(control({ label: "First Name*" })), profile([fact({ factId: "f-name", kind: "legal_name", value: "Alex Q Example" })]));
    expect(by(noSplit, "First Name")).toMatchObject({ disposition: "UNRESOLVED", category: "missing_fact" });
  });

  it("does not treat a preferred name as the legal first name", () => {
    const p = plan(form(control({ label: "Preferred First Name*" })));
    expect(by(p, "Preferred First Name")).toMatchObject({ disposition: "UNRESOLVED" });
    expect(by(p, "Preferred First Name").expected).toBeUndefined();
  });

  it("maps email and phone, and leaves them unresolved when no approved fact exists", () => {
    const withFacts = plan(form(control({ label: "Email*", type: "email" }), control({ label: "Phone*", type: "tel" })));
    expect(by(withFacts, "Email")).toMatchObject({ disposition: "ANSWER", expected: "alex@example.test", factId: "f-email" });
    expect(by(withFacts, "Phone")).toMatchObject({ disposition: "ANSWER", expected: "555-0100" });
    const none = plan(form(control({ label: "Email*" }), control({ label: "Phone*" })), profile([]));
    expect(none.entries.map((e) => e.disposition)).toEqual(["UNRESOLVED", "UNRESOLVED"]);
    expect(none.blockers).toHaveLength(2);
  });

  it("never uses a pending, rejected or expired fact", () => {
    const pending = fact({ factId: "f-p", kind: "email", value: "pending@example.test", pending: true });
    const expired = fact({ factId: "f-x", kind: "phone", value: "555-0199", verification: { validUntil: "2026-01-01" } });
    const p = plan(form(control({ label: "Email*" }), control({ label: "Phone*" })), profile([pending, expired]));
    expect(p.entries.every((e) => e.disposition === "UNRESOLVED")).toBe(true);
  });

  it("treats contradictory approved facts as unresolved rather than choosing one", () => {
    const p = plan(form(control({ label: "Email*" })), profile([EMAIL, fact({ factId: "f-email2", kind: "email", value: "other@example.test" })]));
    expect(by(p, "Email")).toMatchObject({ disposition: "UNRESOLVED", reason: expect.stringContaining("disagree") });
  });

  it("keeps current work authorization and future sponsorship separate and exact", () => {
    const q1 = control({ label: "Are you legally authorized to work in the United States?*", options: ["Yes", "No"] });
    const q2 = control({ label: "Will you now, or in the future, require sponsorship?*", options: ["Yes", "No"] });
    const p = plan(form(q1, q2));
    expect(p.entries[0]).toMatchObject({ disposition: "ANSWER", expected: "Yes", factId: "f-auth" });
    expect(p.entries[1]).toMatchObject({ disposition: "ANSWER", expected: "No", factId: "f-spon" });
    // Without the sponsorship fact, the authorization fact must not answer it.
    const onlyAuth = plan(form(q2), profile([AUTH]));
    expect(onlyAuth.entries[0]).toMatchObject({ disposition: "UNRESOLVED" });
  });

  it("refuses an approved value that is not one of the available options", () => {
    const q = control({ label: "Will you require sponsorship?*", options: ["Yes", "Maybe"] });
    expect(plan(form(q)).entries[0]).toMatchObject({ disposition: "UNRESOLVED", category: "unsupported" });
  });

  it("leaves attestations, consents and legal questions to the applicant", () => {
    const p = plan(form(control({ label: "I confirm that the information submitted in this application is true*", type: "checkbox" }), control({ label: "Are you a close relative of a government official?*" }), control({ label: "I understand that the company may use AI tools*" })));
    expect(p.entries.map((e) => e.disposition)).toEqual(["HUMAN_REVIEW", "HUMAN_REVIEW", "HUMAN_REVIEW"]);
  });

  it("never answers voluntary self-identification, and does not require it when optional", () => {
    const p = plan(form(control({ label: "Gender", required: false }), control({ label: "Veteran Status*" }), control({ label: "Are you Hispanic/Latino?", required: false })));
    expect(p.entries.map((e) => e.disposition)).toEqual(["SKIP", "HUMAN_REVIEW", "SKIP"]);
    expect(p.entries.every((e) => e.expected === undefined)).toBe(true);
  });

  it("maps the employer and job title text boxes from the one approved employment fact", () => {
    const p = plan(form(control({ label: "Company name*" }), control({ label: "Title*", id: "title-0" })));
    expect(p.entries.map((e) => e.expected)).toEqual(["Example Corp", "QA Tester"]);
  });

  it("uploads the resume only when it is approved", () => {
    const file = control({ label: "Attach", id: "resume", type: "file" });
    expect(plan(form(file)).entries[0]).toMatchObject({ disposition: "UPLOAD" });
    expect(plan(form(file), FULL, { ...resume, approved: false }).entries[0]).toMatchObject({ disposition: "HUMAN_REVIEW" });
    expect(plan(form(file), FULL, null).entries[0]).toMatchObject({ disposition: "HUMAN_REVIEW" });
  });

  it("skips unlabeled helper inputs, disabled and hidden controls, and reports unknown required questions as blockers", () => {
    const p = plan(form(control({ label: "", id: "control-5" }), control({ label: "Disabled*", disabled: true }), control({ label: "How did you hear about this job?*" })));
    expect(p.entries.map((e) => e.disposition)).toEqual(["SKIP", "SKIP", "UNRESOLVED"]);
    expect(p.blockers).toEqual(["How did you hear about this job?: required question with no approved answer source; the applicant answers it"]);
  });

  it("changes the form fingerprint when a question or option changes, and the answers digest when an answer changes", () => {
    const a = form(control({ label: "Email*" }));
    const b = form(control({ label: "Email address*" }));
    expect(formFingerprint(a)).not.toBe(formFingerprint(b));
    const other = profile([fact({ factId: "f-email", kind: "email", value: "different@example.test" })]);
    expect(plan(a).answersDigest).not.toBe(plan(a, other).answersDigest);
    expect(plan(a).answersDigest).toBe(plan(a).answersDigest);
  });
});

describe("form planning against the captured real Expel Greenhouse form (public structure only)", () => {
  const captured = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "expel-greenhouse-form.inspection.json"), "utf8")) as ApplicationInspection;

  it("with no approved candidate facts nothing is answerable and the unresolved required questions are listed", () => {
    const p = plan(captured, profile([]), null);
    expect(p.entries.filter((e) => e.disposition === "ANSWER")).toEqual([]);
    expect(p.blockers.length).toBe(17);
    expect(p.entries.filter((e) => e.category === "self_identification").every((e) => e.disposition === "HUMAN_REVIEW")).toBe(true);
    expect(by(p, "Preferred First Name").disposition).toBe("UNRESOLVED");
  });

  it("with approved contact facts only the contact fields become answers; legal, sponsorship and free-text questions stay with the applicant", () => {
    const p = plan(captured, profile([NAME, EMAIL, PHONE]), null);
    const answers = p.entries.filter((e) => e.disposition === "ANSWER").map((e) => e.label);
    expect(answers).toEqual(["First Name", "Last Name", "Email", "Phone"]);
    const sponsorship = p.entries.find((e) => /sponsorship/.test(e.label))!;
    expect(sponsorship.disposition).toBe("UNRESOLVED");
    expect(sponsorship.expected).toBeUndefined();
    expect(p.blockers.length).toBeGreaterThan(0);
  });

  it("identifies the intended employer application and rejects a look-alike", () => {
    const expected = { company: "Expel", title: "Associate SOC Analyst", board: "expel", jobId: 8588028002 };
    expect(verifyFormTarget(captured, expected)).toEqual({ ok: true, reasons: [] });
    expect(verifyFormTarget({ ...captured, url: captured.url.replace("for=expel", "for=other") }, expected).ok).toBe(false);
    expect(verifyFormTarget({ ...captured, url: captured.url.replace("8588028002", "1") }, expected).reasons.join(" ")).toContain("different job id");
    expect(verifyFormTarget({ ...captured, url: "https://evil.example/embed/job_app?for=expel&token=8588028002" }, expected).reasons.join(" ")).toContain("not a Greenhouse application host");
    expect(verifyFormTarget({ ...captured, url: captured.url.replace("https:", "http:") }, expected).ok).toBe(false);
    expect(verifyFormTarget({ ...captured, title: "Job Application for Senior Role at Expel" }, expected).reasons.join(" ")).toContain("job title");
  });
});

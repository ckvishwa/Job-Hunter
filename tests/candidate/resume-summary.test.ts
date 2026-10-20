import { describe, expect, it } from "vitest";
import { summarizeResumeFacts } from "../../src/candidate/resume-summary.js";

describe("pasted resume summary", () => {
  it("returns only contact details and distinct skills from pending facts", () => {
    const facts = [
      { kind: "legal_name", value: "Jordan Rivers", approvalStatus: "pending" },
      { kind: "email", value: "jordan@example.com", approvalStatus: "pending" },
      { kind: "phone", value: "(555) 010-1234", approvalStatus: "pending" },
      { kind: "skill", value: "Python", approvalStatus: "pending" },
      { kind: "skill", value: "python", approvalStatus: "pending" },
      { kind: "employment", value: "Northwind — Analyst", approvalStatus: "pending" },
      { kind: "skill", value: "Splunk", approvalStatus: "rejected" },
    ];
    expect(summarizeResumeFacts(facts)).toEqual({ name: "Jordan Rivers", phone: "(555) 010-1234", email: "jordan@example.com", skills: ["Python"] });
  });

  it("leaves absent details empty", () => {
    expect(summarizeResumeFacts([])).toEqual({ name: null, phone: null, email: null, skills: [] });
  });
});

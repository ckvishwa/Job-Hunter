import { describe, expect, it } from "vitest";
import { collectFactFeedback } from "../../src/ml/fact-feedback.js";

// SYNTHETIC review history (invented facts). Expected numbers are counted by hand from the rows below.
const fact = (pk: string, kind: string, status: string, extra: Record<string, unknown> = {}) => ({ pk, fact_id: `f-${pk}`, kind, value: `${kind}-${pk}`, approval_status: status, sensitivity: "none", attributes: {}, span: { quote: `${kind}-${pk}` }, notes: null, parser_revision: "resume-rules@2", resume_id: "r1", ...extra });
const rev = (pk: string, revision: number, action: string, value: string, attributes: Record<string, unknown> = {}) => ({ fact_pk: pk, revision, action, snapshot: { fact: { value, attributes, span: { quote: value } } } });

describe("résumé review feedback dataset", () => {
  const repo = {
    reviewHistoryForFeedback: async () => ({
      facts: [
        fact("1", "skill", "approved"), fact("2", "skill", "approved"), fact("3", "skill", "rejected"), fact("4", "skill", "pending"),
        fact("5", "employment", "approved", { notes: "Employer and title order could not be determined; set them when reviewing." }),
        fact("6", "email", "approved"), fact("7", "skill", "approved", { sensitivity: "sensitive" }),
      ],
      revisions: [
        rev("5", 1, "PROPOSED", "Programmer Analyst", {}), rev("5", 2, "EDIT", "Cognizant — Programmer Analyst", { employer: "Cognizant", title: "Programmer Analyst" }), rev("5", 3, "APPROVE", "Cognizant — Programmer Analyst", { employer: "Cognizant", title: "Programmer Analyst" }),
      ],
    }),
  };
  it("counts per kind, excludes contact/sensitive facts, and tracks edits as error classes", async () => {
    const fb = await collectFactFeedback(repo);
    expect(fb.totals).toEqual({ facts: 5, approved: 3, rejected: 1, pending: 1, edited: 1 });
    expect(fb.byKind.skill).toEqual({ proposed: 4, approved: 2, rejected: 1, pending: 1, edited: 0, acceptanceRate: 0.667 });
    expect(fb.byKind.email).toBeUndefined();
    expect(fb.errorClasses.employer_title_confusion).toBeGreaterThanOrEqual(1);
    expect(fb.errorClasses.rejected_skill).toBe(1);
  });
  it("never claims a challenger result and lists bulk candidates only for exact, already-approved skills", async () => {
    const fb = await collectFactFeedback(repo);
    expect(fb.challenger.status).toBe("NOT_EVALUATED");
    expect(fb.bulkApprovalCandidates).toEqual([]); // no pending skill has an approved twin here
    const twin = await collectFactFeedback({ reviewHistoryForFeedback: async () => ({ facts: [fact("a", "skill", "approved", { value: "Splunk", span: { quote: "Splunk, SPL" } }), fact("b", "skill", "pending", { value: "Splunk", span: { quote: "Splunk, SPL" }, resume_id: "r2" })], revisions: [] }) });
    expect(twin.bulkApprovalCandidates.map((c) => c.factId)).toEqual(["f-b"]);
  });
});

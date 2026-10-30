import { describe, expect, it } from "vitest";
import { applyFactReview, reviewRows } from "../../src/candidate/review.js";
import { fact, profile } from "../helpers/decision-fixtures.js";
import { factUsability } from "../../src/domain/candidate-profile.js";

describe("individual candidate fact review", () => {
  const pending = profile([fact({ factId: "skill-1", kind: "skill", value: "Python", pending: true })]);

  it("lists redacted pending facts with provenance and restrictions", () => {
    const rows = reviewRows(pending, "2026-10-08");
    expect(rows[0]).toMatchObject({ factId: "skill-1", approvalStatus: "pending", confidence: "unrated", usable: false });
    expect(rows[0]?.source.kind).toBe("user-statement");
    expect(rows[0]?.value).toBe("[redacted]");
    expect(rows[0]?.usageRestriction).toContain("approval");
  });

  it("approves one fact with a bound digest and invalidates an edited claim", () => {
    const approved = applyFactReview(pending, { factId: "skill-1", action: "approve", reviewer: "candidate", reviewedAt: "2026-10-08" });
    expect(factUsability(approved.facts[0]!, "2026-10-08")).toEqual({ usable: true });
    expect(approved.facts[0]?.verification.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    const changed = { ...approved.facts[0]!, value: "Rust" };
    expect(factUsability(changed, "2026-10-08")).toMatchObject({ usable: false, reason: "STALE_APPROVAL" });
  });

  it("edits and rejects facts individually without granting approval", () => {
    const edited = applyFactReview(pending, { factId: "skill-1", action: "edit", value: "Go", reviewer: "candidate", reviewedAt: "2026-10-08" });
    expect(edited.facts[0]).toMatchObject({ value: "Go", approvalStatus: "pending" });
    const rejected = applyFactReview(edited, { factId: "skill-1", action: "reject", reviewer: "candidate", reviewedAt: "2026-10-08" });
    expect(rejected.facts[0]?.approvalStatus).toBe("rejected");
    expect(() => applyFactReview(pending, { factId: "missing", action: "approve", reviewer: "candidate", reviewedAt: "2026-10-08" })).toThrow();
  });
});

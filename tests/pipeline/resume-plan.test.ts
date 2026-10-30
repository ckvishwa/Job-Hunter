import { describe, expect, it } from "vitest";
import { normalizeExtractedPdfText, resumeFactAllowed, resumeSourceFacts } from "../../src/pipeline/resume-plan.js";
import { fact } from "../helpers/decision-fixtures.js";
import { profile } from "../helpers/decision-fixtures.js";

describe("PDF text comparison normalization", () => {
  it("joins letter hyphen wraps while preserving actual dash separators", () => {
    expect(normalizeExtractedPdfText("admin- reachable identities")).toBe("admin-reachable identities");
    expect(normalizeExtractedPdfText("March 2020 – June 2022")).toBe("March 2020 – June 2022");
    expect(normalizeExtractedPdfText("role - remote")).toBe("role - remote");
  });
});

it("excludes sensitive and inspection-track claims from a resume plan", () => {
  expect(resumeFactAllowed(fact({ factId: "s", kind: "skill", value: "Python" }))).toBe(true);
  expect(resumeFactAllowed(fact({ factId: "q", kind: "skill", value: "QCL construction inspection" }))).toBe(false);
  expect(resumeFactAllowed(fact({ factId: "a", kind: "work_authorization", value: "synthetic" }))).toBe(false);
});

it("takes resume facts from the parsed profile and never from a caller's unapproved candidate list", () => {
  const approved = fact({ factId: "approved", kind: "skill", value: "Python" });
  const pending = fact({ factId: "pending", kind: "skill", value: "Go", pending: true });
  expect([...resumeSourceFacts(profile([approved, pending]), "2026-10-08").keys()]).toEqual(["approved"]);
});

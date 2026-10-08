import { describe, expect, it } from "vitest";
import { normalizeExtractedPdfText } from "../../src/pipeline/resume-plan.js";

describe("PDF text comparison normalization", () => {
  it("joins letter hyphen wraps while preserving actual dash separators", () => {
    expect(normalizeExtractedPdfText("admin- reachable identities")).toBe("admin-reachable identities");
    expect(normalizeExtractedPdfText("March 2020 – June 2022")).toBe("March 2020 – June 2022");
    expect(normalizeExtractedPdfText("role - remote")).toBe("role - remote");
  });
});

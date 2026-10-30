import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractResponseSchema, type ExtractResponse } from "../../src/ai/contracts.js";
import { buildPendingFacts } from "../../src/candidate/fact-lifecycle.js";

const text = "B.S. Computer Science | Lakeshore State College | May 2026";
const span = (quote: string) => ({ start: text.indexOf(quote), end: text.indexOf(quote) + quote.length, quote });
const response = (institutionSpan = span("Lakeshore State College")) => ({
  schemaRevision: 1,
  parserRevision: "resume-rules@3",
  fileType: "pdf",
  text,
  textSha256: createHash("sha256").update(text).digest("hex"),
  warnings: [],
  facts: [{ kind: "education", value: "B.S. Computer Science", span: span("B.S. Computer Science"), proposedBy: "rules",
    attributes: { institution: "Lakeshore State College", graduationDate: "2026-05",
      fieldSpans: { institution: institutionSpan, graduationDate: span("May 2026") } } }],
  stats: { pageCount: 1, characterCount: text.length, deterministicFacts: 1, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
});

describe("M2 field-level evidence contract", () => {
  it("accepts an additive v1 response and preserves structured education in pending review data", () => {
    const parsed = extractResponseSchema.parse(response());
    const { drafts, dropped } = buildPendingFacts(parsed as ExtractResponse, { resumeReference: "resume-example.pdf", scope: "m2" });
    expect(dropped).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.fact.approvalStatus).toBe("pending");
    expect(drafts[0]!.fact.attributes).toMatchObject({ institution: "Lakeshore State College", graduationDate: "2026-05",
      fieldSpans: { institution: span("Lakeshore State College"), graduationDate: span("May 2026") } });
  });

  it("drops a proposal when an attribute's evidence does not match the exact text", () => {
    const wrong = { ...span("Lakeshore State College"), start: 0, end: 10 };
    const parsed = extractResponseSchema.parse(response(wrong));
    const { drafts, dropped } = buildPendingFacts(parsed as ExtractResponse, { resumeReference: "resume-example.pdf", scope: "m2" });
    expect(drafts).toEqual([]);
    expect(dropped.map((d) => d.code)).toEqual(["PROPOSAL_SPAN_MISMATCH"]);
  });
});

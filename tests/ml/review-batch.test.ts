import { expect, it } from "vitest";
import { renderReviewBatch, validateDecisions } from "../../src/ml/review-batch.js";
import type { ReviewItem } from "../../src/ml/llm-workflows.js";

const pass = (over: object) => ({ reasoning: "r", evidence: ["q"], jdTruncated: false, ...over });
const withState = (A: object, B: object): ReviewItem => ({ ...item(false), state: { A, B, consensus: { status: "AGREED", relevance: "relevant" } } } as unknown as ReviewItem);
const proposalIn = (html: string): string | null => { const start = html.indexOf("const batch=") + "const batch=".length; return JSON.parse(html.slice(start, html.indexOf(";", html.indexOf("}]}", start)))).items[0].proposal; };
const item = (blind: boolean): ReviewItem => ({ posting: { id: "p", textSha256: "hash", title: "Title", company: "Company", description: "full description </script><script>bad()</script>" }, roleSlug: "soc", blind, stream: blind ? "eval" : "active", state: { A: { reasoning: "SECRET PROPOSAL", evidence: ["SECRET QUOTE"] }, consensus: { status: "AGREED", relevance: "relevant" } } } as ReviewItem);
it("never embeds evaluation proposals, including hidden HTML or script data", () => {
  const html = renderReviewBatch("batch", [item(true)]);
  expect(html).not.toContain("SECRET");
  expect(html).not.toContain("<script>bad()");
  expect(renderReviewBatch("batch", [item(false)])).toContain("SECRET PROPOSAL");
});
it("requires explicit per-item review and blind independence, with no bulk evaluation approval", () => {
  const base = { version: 1, batchId: "batch", decisions: [{ index: 0, value: "relevant", reviewed: true, independent: true }] };
  expect(validateDecisions(base, "batch", [item(true)])).toHaveLength(1);
  expect(() => validateDecisions({ ...base, decisions: [{ ...base.decisions[0], independent: false }] }, "batch", [item(true)])).toThrow();
  expect(() => validateDecisions({ ...base, decisions: [{ ...base.decisions[0], reviewed: false }] }, "batch", [item(false)])).toThrow();
  expect(() => validateDecisions(base, "other", [item(true)])).toThrow();
  expect(() => validateDecisions({ ...base, decisions: [...base.decisions, ...base.decisions] }, "batch", [item(true)])).toThrow();
});

it("offers a bulk-approvable proposal only when both passes carry evidence from an untruncated description", () => {
  expect(proposalIn(renderReviewBatch("b", [withState(pass({}), pass({}))]))).toBe("relevant");
  expect(proposalIn(renderReviewBatch("b", [withState(pass({ evidence: [] }), pass({}))]))).toBeNull();
  expect(proposalIn(renderReviewBatch("b", [withState(pass({}), pass({ jdTruncated: true }))]))).toBeNull();
  expect(proposalIn(renderReviewBatch("b", [withState(pass({}), undefined as never)]))).toBeNull();
});

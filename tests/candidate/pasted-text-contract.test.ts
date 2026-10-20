import { expect, it } from "vitest";
import { extractResponseSchema } from "../../src/ai/contracts.js";
import { sampleResponse } from "../helpers/s1-harness.js";

it("accepts a text resume from the existing extraction service", () => {
  expect(extractResponseSchema.safeParse(sampleResponse({ fileType: "text" })).success).toBe(true);
});

import { expect, it } from "vitest";
import { admissionIssues, INDEPENDENT_REVIEW } from "../../src/ml/admission.js";
import type { MlRepo } from "../../src/ml/repo.js";
import type { DatasetItem } from "../../src/ml/split.js";

it("rechecks current text and refuses historical human_verified defaults as proof of independence", async () => {
  const item = { postingId: "p", roleSlug: "r", textSha256: "hash", company: "company", relevance: "relevant", split: "heldout", labelIds: [1] } as DatasetItem;
  let note: string | null = null;
  let text = "hash";
  const repo = { posting: async () => ({ textSha256: text }), allLabelRows: async () => [{ id: 1, task: "relevance", ...item, value: "relevant", note }], humanOrigins: async () => new Map([[1, { origin: "human_verified", llm: false }]]) } as unknown as MlRepo;
  expect((await admissionIssues(repo, [item])).join(" ")).toMatch(/independence is unverified/);
  note = INDEPENDENT_REVIEW;
  expect((await admissionIssues(repo, [item])).join(" ")).not.toMatch(/independence is unverified/);
  text = "changed";
  expect((await admissionIssues(repo, [item])).join(" ")).toMatch(/changed or missing/);
});

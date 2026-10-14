import { expect, it } from "vitest";
import { routePrediction } from "../../src/ml/router.js";
import type { LlmProvider } from "../../src/ml/llm-label.js";

const role = { slug: "soc", title: "SOC Analyst", description: "Security alert triage", aliases: [], coreSkills: [] };
const description = "Monitor security alerts and investigate incidents. Document findings and escalate confirmed threats. " + "Work with teammates to maintain systems and write clear daily reports. ".repeat(12);
const posting = { title: "Analyst", company: "Synthetic", description };
let calls = 0;
const provider: LlmProvider = { identity: async () => ({ model: "scripted", provider: "test", digest: null }), complete: async () => { calls++; return { latencyMs: 1, content: JSON.stringify({ relevance: "relevant", seniority: "mid", work_mode: "unclear", confidence: 0.9, evidence: ["Monitor security alerts and investigate incidents"], reasoning: "Daily alert investigation" }) }; } };
it("uses validated calibrated ML acceptance without a Qwen call", async () => {
  calls = 0;
  expect(await routePrediction(posting, role, { score: 0.97, calibrated: true, acceptanceValidated: true, band: [0.1, 0.9] }, provider)).toMatchObject({ path: "ML", decision: "relevant" });
  expect(calls).toBe(0);
});
it("routes abstention and unvalidated scores to evidence-checked Qwen", async () => {
  expect(await routePrediction(posting, role, { score: 0.99, calibrated: true, acceptanceValidated: false, band: [0.1, 0.9] }, provider)).toMatchObject({ path: "QWEN", decision: "relevant" });
  expect(await routePrediction(posting, role, { score: 0.5, calibrated: true, acceptanceValidated: true, band: [0.1, 0.9] }, provider)).toMatchObject({ path: "QWEN" });
});
it("returns REVIEW for insufficient text or failed evidence instead of forcing an answer", async () => {
  calls = 0;
  expect(await routePrediction({ ...posting, description: "short" }, role, null, provider)).toMatchObject({ path: "REVIEW", decision: "unknown" });
  expect(calls).toBe(0);
  const invalid = { ...provider, complete: async () => { throw new Error("offline"); } };
  expect(await routePrediction(posting, role, null, invalid)).toMatchObject({ path: "REVIEW", decision: "unknown" });
});

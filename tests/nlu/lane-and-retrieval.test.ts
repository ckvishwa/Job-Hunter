import { describe, expect, it } from "vitest";
import { parseCandidateProfile, type CandidateProfile } from "../../src/domain/candidate-profile.js";
import { proposeLane, retrieveFactCandidates } from "../../src/nlu/lane-and-retrieval.js";
import type { EmbeddingEncoder, EmbeddingResult } from "../../src/nlu/local-transformer.js";

class ConstantEncoder implements EmbeddingEncoder {
  async embed(text: string): Promise<EmbeddingResult> {
    return { vector: [1, 0], chunks: [{ text, start: 0, end: text.length, section: null, tokenCount: 5 }], model: { modelId: "test", revision: "test", maxSequenceLength: 256, embeddingDimensions: 2, cacheVersion: "test" }, runtime: "test", device: "test", hardware: "test", elapsedMs: 0 };
  }
}

function profile(): CandidateProfile {
  return parseCandidateProfile({
    schemaVersion: 1,
    candidateId: "candidate-test",
    profileVersion: "test-1",
    updatedAt: "2026-10-07",
    facts: [
      { factId: "approved-python", kind: "skill", value: "Python", source: { kind: "user-statement", reference: "test" }, verification: { verifiedBy: "test-user", verifiedAt: "2026-10-07", validUntil: null }, approvalStatus: "approved", sensitivity: "normal", attributes: {} },
      { factId: "pending-python", kind: "skill", value: "Python security automation", source: { kind: "resume-import", reference: "test" }, verification: { verifiedBy: null, verifiedAt: null, validUntil: null }, approvalStatus: "pending", sensitivity: "normal", attributes: {} },
      { factId: "approved-email", kind: "email", value: "candidate@example.test", source: { kind: "user-statement", reference: "test" }, verification: { verifiedBy: "test-user", verifiedAt: "2026-10-07", validUntil: null }, approvalStatus: "approved", sensitivity: "sensitive", attributes: {} },
    ],
    preferences: {},
    employmentHistoryComplete: null,
  });
}

describe("local NLU lane proposal and evidence retrieval", () => {
  it("abstains when lane similarities tie, instead of presenting a calibrated probability", async () => {
    const result = await proposeLane({ title: "Engineer", descriptionText: "Build and support technical systems." }, new ConstantEncoder());
    expect(result.proposal.status).toBe("UNKNOWN_REVIEW");
    expect(result.proposal.lane).toBeNull();
  });

  it("retrieves approved current fact IDs only and labels similarity as non-authoritative", async () => {
    const facts = await retrieveFactCandidates({ query: "Python security automation", profile: profile(), asOf: "2026-10-07", encoder: new ConstantEncoder() });
    expect(facts.map((fact) => fact.factId)).toEqual(["approved-python"]);
    expect(facts[0]?.interpretation).toContain("does not prove proficiency");
  });
});

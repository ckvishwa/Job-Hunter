import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { factContentDigest, factDigestCompatible, factUsability, type CandidateFact } from "../../src/domain/candidate-profile.js";
import { reviewFact } from "../../src/candidate/fact-lifecycle.js";

const fact = (attributes: CandidateFact["attributes"]): CandidateFact => ({
  factId: "m3-example", kind: "employment", value: "Example Labs — Engineer", polarity: "has", attributes,
  source: { kind: "resume-import", reference: "fixture.pdf", locator: "chars 0-50" },
  verification: { verifiedBy: null, verifiedAt: null, validUntil: null }, approvalStatus: "pending", sensitivity: "normal",
});

describe("M3 persisted fact digest", () => {
  it("keeps the same digest when PostgreSQL JSONB reorders field-level evidence keys", () => {
    const before = fact({ employer: "Example Labs", title: "Engineer", startDate: "2022-01", endDate: null,
      fieldSpans: { employer: { start: 0, end: 12, quote: "Example Labs" }, title: { start: 15, end: 23, quote: "Engineer" } } });
    const after = fact({ fieldSpans: { title: { quote: "Engineer", end: 23, start: 15 }, employer: { quote: "Example Labs", end: 12, start: 0 } },
      endDate: null, startDate: "2022-01", title: "Engineer", employer: "Example Labs" });
    expect(factContentDigest(before)).toBe(factContentDigest(after));
  });

  it("accepts a historical digest for an unchanged fact and rejects it after a real change", () => {
    const old = fact({ startDate: "2022-01", employer: "Example Labs", title: "Engineer", endDate: null });
    const material = { kind: old.kind, value: old.value, polarity: old.polarity, attributes: old.attributes, source: old.source, sensitivity: old.sensitivity };
    const legacy = createHash("sha256").update(JSON.stringify(material)).digest("hex");
    expect(factDigestCompatible(old, legacy)).toBe(true);
    expect(factDigestCompatible(old, factContentDigest(old))).toBe(true);
    const changed = fact({ ...old.attributes, title: "Senior Engineer" });
    expect(factContentDigest(changed)).not.toBe(factContentDigest(old));
    expect(factDigestCompatible(changed, legacy)).toBe(false);
  });

  it("treats different evidence spans and technology order as different facts", () => {
    const left = fact({ employer: "Example Labs", title: "Engineer", startDate: "2022-01", endDate: null,
      fieldSpans: { employer: { start: 0, end: 12, quote: "Example Labs" } } });
    const moved = fact({ employer: "Example Labs", title: "Engineer", startDate: "2022-01", endDate: null,
      fieldSpans: { employer: { start: 4, end: 16, quote: "Example Labs" } } });
    const reordered = fact({ technologies: ["Zeek", "Splunk"] });
    const original = fact({ technologies: ["Splunk", "Zeek"] });
    expect(factContentDigest(left)).not.toBe(factContentDigest(moved));
    expect(factContentDigest(original)).not.toBe(factContentDigest(reordered));
  });

  it("rejects a stale review and keeps a historical approval usable", () => {
    const pending = fact({ employer: "Example Labs", title: "Engineer", startDate: "2022-01", endDate: null });
    expect(() => reviewFact(pending, { action: "approve", actor: "ada", today: "2026-10-20", expectedDigest: "ab".repeat(32) })).toThrow(/changed since it was loaded/);
    const legacyMaterial = { kind: pending.kind, value: pending.value, polarity: pending.polarity, attributes: pending.attributes, source: pending.source, sensitivity: pending.sensitivity };
    const legacy = createHash("sha256").update(JSON.stringify(legacyMaterial)).digest("hex");
    const approved = { ...pending, approvalStatus: "approved" as const, verification: { verifiedBy: "ada", verifiedAt: "2026-10-20", validUntil: null, contentDigest: legacy } };
    expect(factUsability(approved, "2026-10-20").usable).toBe(true);
    expect(reviewFact(approved, { action: "approve", actor: "ada", today: "2026-10-20", expectedDigest: legacy }).revisionAction).toBeNull();
  });
});

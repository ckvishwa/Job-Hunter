import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import { ExtractionIntegrityError, FactRuleError, assembleProfile, attestFact, buildPendingFacts, reviewFact } from "../../src/candidate/fact-lifecycle.js";
import { factContentDigest } from "../../src/domain/candidate-profile.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TEXT = "Jordan Rivers\njordan@example.com\nSKILLS\nPython, Splunk\nEXPERIENCE\nNorthwind | SOC Analyst | Jan 2022 – Present";

function response(facts: Partial<ExtractResponse["facts"][number]>[], text = TEXT): ExtractResponse {
  return {
    schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text, textSha256: sha(text), warnings: [],
    facts: facts as ExtractResponse["facts"],
    stats: { pageCount: 1, characterCount: text.length, deterministicFacts: facts.length, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
  };
}
const at = (quote: string) => ({ start: TEXT.indexOf(quote), end: TEXT.indexOf(quote) + quote.length, quote });
const skill = (quote: string) => ({ kind: "skill" as const, value: quote, attributes: {}, span: at(quote), proposedBy: "rules" as const });
const ctx = { resumeReference: "resume-abc.docx", scope: "version-1" };

describe("buildPendingFacts", () => {
  it("builds only PENDING, unverified facts with provenance and a span locator", () => {
    const { drafts, dropped } = buildPendingFacts(response([skill("Python"), skill("Splunk")]), ctx);
    expect(dropped).toEqual([]);
    expect(drafts).toHaveLength(2);
    for (const d of drafts) {
      expect(d.fact.approvalStatus).toBe("pending");
      expect(d.fact.verification).toEqual({ verifiedBy: null, verifiedAt: null, validUntil: null });
      expect(d.fact.source).toMatchObject({ kind: "resume-import", reference: "resume-abc.docx" });
      expect(d.fact.source.locator).toBe(`chars ${d.span!.start}-${d.span!.end}`);
      expect(d.proposedBy).toBe("rules");
    }
  });

  it("marks contact details sensitive", () => {
    const email = { kind: "email" as const, value: "jordan@example.com", attributes: {}, span: at("jordan@example.com"), proposedBy: "rules" as const };
    expect(buildPendingFacts(response([email]), ctx).drafts[0]!.fact.sensitivity).toBe("sensitive");
  });

  it("drops (never repairs) a proposal whose span does not match the text", () => {
    const wrong = { ...skill("Python"), span: { start: 0, end: 6, quote: "Python" } };
    const { drafts, dropped } = buildPendingFacts(response([wrong, skill("Splunk")]), ctx);
    expect(drafts.map((d) => d.fact.value)).toEqual(["Splunk"]);
    expect(dropped).toEqual([expect.objectContaining({ code: "PROPOSAL_SPAN_MISMATCH" })]);
  });

  it("refuses citizenship, clearance, work authorization and sponsorship even if the service emits them", () => {
    const forged = ["citizenship", "clearance", "work_authorization", "sponsorship_need"].map((kind) => ({ ...skill("Python"), kind: kind as never }));
    const { drafts, dropped } = buildPendingFacts(response(forged), ctx);
    expect(drafts).toEqual([]);
    expect(dropped.map((d) => d.code)).toEqual(Array(4).fill("PROPOSAL_FORBIDDEN_KIND"));
  });

  it("drops an employment proposal without a start date and a skill that carries employment attributes", () => {
    const noStart = { kind: "employment" as const, value: "Northwind — SOC Analyst", attributes: { employer: "Northwind" }, span: at("Northwind | SOC Analyst | Jan 2022 – Present"), proposedBy: "rules" as const };
    const skillWithDates = { ...skill("Python"), attributes: { startDate: "2022-01" } };
    expect(buildPendingFacts(response([noStart, skillWithDates]), ctx).drafts).toEqual([]);
  });

  it("maps 'current' to an open-ended employment and keeps the internship tag only when supplied", () => {
    const job = { kind: "employment" as const, value: "Northwind — SOC Analyst", attributes: { employer: "Northwind", title: "SOC Analyst", startDate: "2022-01", current: true }, span: at("Northwind | SOC Analyst | Jan 2022 – Present"), proposedBy: "rules" as const };
    const d = buildPendingFacts(response([job]), ctx).drafts[0]!;
    expect(d.fact.attributes).toEqual({ employer: "Northwind", title: "SOC Analyst", startDate: "2022-01", endDate: null });
    expect(d.fact.attributes.employmentType).toBeUndefined();
  });

  it("is deterministic and de-duplicates the same proposal; the scope separates two uploads", () => {
    const a = buildPendingFacts(response([skill("Python"), skill("Python")]), ctx);
    expect(a.drafts).toHaveLength(1);
    const b = buildPendingFacts(response([skill("Python")]), ctx);
    expect(b.drafts[0]!.fact.factId).toBe(a.drafts[0]!.fact.factId);
    expect(b.drafts[0]!.factKey).toBe(a.drafts[0]!.factKey);
    expect(buildPendingFacts(response([skill("Python")]), { ...ctx, scope: "version-2" }).drafts[0]!.fact.factId).not.toBe(a.drafts[0]!.fact.factId);
  });

  it("rejects a response whose text does not match its declared hash", () => {
    const bad = { ...response([skill("Python")]), textSha256: "0".repeat(64) };
    expect(() => buildPendingFacts(bad, ctx)).toThrow(ExtractionIntegrityError);
  });
});

describe("reviewFact", () => {
  const pendingSkill = () => buildPendingFacts(response([skill("Python")]), ctx).drafts[0]!.fact;
  const pendingEmail = () => buildPendingFacts(response([{ kind: "email", value: "jordan@example.com", attributes: {}, span: at("jordan@example.com"), proposedBy: "rules" }]), ctx).drafts[0]!.fact;
  const base = { actor: "local", today: "2026-10-09" };

  it("approval binds the exact content digest and records who and when", () => {
    const fact = pendingSkill();
    const out = reviewFact(fact, { ...base, action: "approve", expectedDigest: factContentDigest(fact) });
    expect(out.revisionAction).toBe("APPROVE");
    expect(out.fact.approvalStatus).toBe("approved");
    expect(out.fact.verification).toMatchObject({ verifiedBy: "local", verifiedAt: "2026-10-09", contentDigest: factContentDigest(fact) });
  });

  it("refuses a stale digest and changes nothing", () => {
    const fact = pendingSkill();
    expect(() => reviewFact(fact, { ...base, action: "approve", expectedDigest: "f".repeat(64) })).toThrowError(expect.objectContaining({ code: "STALE_FACT" }));
  });

  it("a sensitive fact cannot be approved without explicit confirmation", () => {
    const fact = pendingEmail();
    const input = { ...base, action: "approve" as const, expectedDigest: factContentDigest(fact) };
    expect(() => reviewFact(fact, input)).toThrowError(expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }));
    expect(() => reviewFact(fact, { ...input, confirmSensitive: false })).toThrowError(FactRuleError);
    const ok = reviewFact(fact, { ...input, confirmSensitive: true });
    expect(ok).toMatchObject({ revisionAction: "APPROVE", explicitConfirmation: true });
  });

  it("approving twice is an idempotent no-op", () => {
    const fact = pendingSkill();
    const first = reviewFact(fact, { ...base, action: "approve", expectedDigest: factContentDigest(fact) });
    const again = reviewFact(first.fact, { ...base, action: "approve", expectedDigest: factContentDigest(first.fact) });
    expect(again.revisionAction).toBeNull();
  });

  it("an edit returns the fact to PENDING, clears verification, keeps provenance and changes the digest", () => {
    const fact = pendingSkill();
    const approved = reviewFact(fact, { ...base, action: "approve", expectedDigest: factContentDigest(fact) }).fact;
    const edited = reviewFact(approved, { ...base, action: "edit", expectedDigest: factContentDigest(approved), edit: { value: "Python 3" } });
    expect(edited.revisionAction).toBe("EDIT");
    expect(edited.fact).toMatchObject({ value: "Python 3", approvalStatus: "pending", verification: { verifiedBy: null, verifiedAt: null } });
    expect(edited.fact.source).toEqual(fact.source);
    expect(factContentDigest(edited.fact)).not.toBe(factContentDigest(approved));
  });

  it("an employment edit must keep a start date; invalid attributes are refused", () => {
    const job = buildPendingFacts(response([{ kind: "employment", value: "Northwind — SOC Analyst", attributes: { employer: "Northwind", title: "SOC Analyst", startDate: "2022-01", current: true }, span: at("Northwind | SOC Analyst | Jan 2022 – Present"), proposedBy: "rules" }]), ctx).drafts[0]!.fact;
    const input = { ...base, action: "edit" as const, expectedDigest: factContentDigest(job) };
    expect(() => reviewFact(job, { ...input, edit: { attributes: { employer: "Northwind" } } })).toThrowError(expect.objectContaining({ code: "INVALID_EDIT" }));
    expect(() => reviewFact(job, { ...input, edit: { attributes: { startDate: "not-a-date" } } })).toThrowError(expect.objectContaining({ code: "INVALID_EDIT" }));
    expect(() => reviewFact(job, { ...input, edit: {} })).toThrowError(expect.objectContaining({ code: "INVALID_EDIT" }));
    const fixed = reviewFact(job, { ...input, edit: { attributes: { employer: "Northwind", title: "SOC Analyst", startDate: "2022-02", endDate: null, employmentType: "professional" } } });
    expect(fixed.fact.attributes).toMatchObject({ startDate: "2022-02", employmentType: "professional" });
  });

  it("a resume-sourced citizenship fact can never be approved, whatever its origin", () => {
    const forged = { ...pendingSkill(), kind: "citizenship" as const, sensitivity: "sensitive" as const };
    expect(() => reviewFact(forged, { ...base, action: "approve", expectedDigest: factContentDigest(forged), confirmSensitive: true })).toThrowError(expect.objectContaining({ code: "NOT_ALLOWED" }));
  });
});

describe("attestFact", () => {
  const input = { kind: "citizenship" as const, value: "U.S. citizen", polarity: "lacks" as const, actor: "local", today: "2026-10-09", confirm: true };
  it("requires explicit confirmation and creates a user-statement fact bound to its digest", () => {
    expect(() => attestFact({ ...input, confirm: false })).toThrowError(expect.objectContaining({ code: "CONFIRMATION_REQUIRED" }));
    const d = attestFact(input);
    expect(d.proposedBy).toBe("user");
    expect(d.fact).toMatchObject({ kind: "citizenship", polarity: "lacks", approvalStatus: "approved", sensitivity: "sensitive", source: { kind: "user-statement" } });
    expect(d.fact.verification.contentDigest).toBe(factContentDigest({ ...d.fact, verification: { verifiedBy: null, verifiedAt: null, validUntil: null } }));
    expect(attestFact(input).fact.factId).toBe(d.fact.factId);
  });
  it("only sensitive kinds can be attested this way", () => {
    expect(() => attestFact({ ...input, kind: "skill" })).toThrowError(expect.objectContaining({ code: "INVALID_ATTESTATION" }));
  });
});

describe("assembleProfile", () => {
  it("produces a valid profile whose digest changes when a fact changes", () => {
    const [a] = buildPendingFacts(response([skill("Python")]), ctx).drafts;
    const p1 = assembleProfile([a!.fact], "local", 1, "2026-10-09");
    const approved = reviewFact(a!.fact, { action: "approve", actor: "local", today: "2026-10-09", expectedDigest: factContentDigest(a!.fact) }).fact;
    const p2 = assembleProfile([approved], "local", 2, "2026-10-09");
    expect(p1.facts[0]!.approvalStatus).toBe("pending");
    expect(JSON.stringify(p1)).not.toBe(JSON.stringify(p2));
  });
});

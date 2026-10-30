import { factContentDigest, factUsability, parseCandidateProfile, type CandidateProfile } from "../domain/candidate-profile.js";
import { z } from "zod";

export type FactReviewDecision = {
  factId: string;
  action: "approve" | "reject" | "edit";
  reviewer: string;
  reviewedAt: string;
  value?: string;
};
export const factReviewDecisionSchema = z.object({ factId: z.string().min(1), action: z.enum(["approve", "reject", "edit"]), reviewer: z.string().min(1), reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), value: z.string().optional() }).strict();

/** Redacted inventory for review. The source locator stays private with the profile. */
export function reviewRows(profile: CandidateProfile, asOf: string) {
  return profile.facts.map((fact) => {
    const usability = factUsability(fact, asOf);
    return {
      factId: fact.factId,
      kind: fact.kind,
      value: "[redacted]",
      source: { kind: fact.source.kind, reference: fact.source.reference, locator: fact.source.locator ?? null },
      confidence: "unrated" as const,
      approvalStatus: fact.approvalStatus,
      sensitivity: fact.sensitivity,
      usable: usability.usable,
      usageRestriction: usability.usable
        ? fact.sensitivity === "sensitive" ? "private application answer only; explicit question match required" : "approved claim only; source mapping required"
        : `blocked until individual approval (${usability.reason})`,
      decision: null as null | "approve" | "reject" | "edit",
    };
  });
}

export function applyFactReview(profile: CandidateProfile, decision: FactReviewDecision): CandidateProfile {
  if (!decision.reviewer.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(decision.reviewedAt)) throw new Error("Reviewer and ISO review date are required.");
  if (!profile.facts.some((fact) => fact.factId === decision.factId)) throw new Error("Unknown fact ID.");
  const facts = profile.facts.map((fact) => {
    if (fact.factId !== decision.factId) return fact;
    if (decision.action === "edit") {
      if (!decision.value?.trim()) throw new Error("Edited fact needs a nonempty value.");
      return { ...fact, value: decision.value, approvalStatus: "pending" as const, verification: { verifiedBy: null, verifiedAt: null, validUntil: null } };
    }
    if (decision.value !== undefined) throw new Error("Only edit may change the fact value.");
    if (decision.action === "reject") return { ...fact, approvalStatus: "rejected" as const, verification: { verifiedBy: null, verifiedAt: null, validUntil: null } };
    return { ...fact, approvalStatus: "approved" as const, verification: { ...fact.verification, verifiedBy: decision.reviewer, verifiedAt: decision.reviewedAt, contentDigest: factContentDigest(fact) } };
  });
  return parseCandidateProfile({ ...profile, facts, updatedAt: decision.reviewedAt });
}

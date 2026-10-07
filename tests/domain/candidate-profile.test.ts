import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { candidateProfileSchema, factUsability, parseCandidateProfile, unionMonths } from "../../src/domain/candidate-profile.js";
import { fact, profile } from "../helpers/decision-fixtures.js";

const raw = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  candidateId: "c-1",
  profileVersion: "v1",
  updatedAt: "2026-09-01",
  facts: [],
  preferences: {},
  employmentHistoryComplete: null,
  ...over,
});
const baseFact = (over: Record<string, unknown> = {}) => ({
  factId: "f-1",
  kind: "skill",
  value: "Python",
  source: { kind: "user-statement", reference: "x" },
  verification: { verifiedBy: "me", verifiedAt: "2026-09-01", validUntil: null },
  approvalStatus: "approved",
  sensitivity: "normal",
  ...over,
});
const parses = (facts: unknown[], over: Record<string, unknown> = {}) => candidateProfileSchema.safeParse(raw({ facts, ...over }));

describe("candidate profile contract", () => {
  it("accepts approved facts with verification and pending facts without it", () => {
    expect(parses([baseFact(), baseFact({ factId: "f-2", approvalStatus: "pending", verification: { verifiedBy: null, verifiedAt: null, validUntil: null } })]).success).toBe(true);
  });

  it("rejects an approved fact with no verifier or no verification date", () => {
    expect(parses([baseFact({ verification: { verifiedBy: null, verifiedAt: "2026-09-01", validUntil: null } })]).success).toBe(false);
    expect(parses([baseFact({ verification: { verifiedBy: "me", verifiedAt: null, validUntil: null } })]).success).toBe(false);
  });

  it.each(["clearance", "work_authorization", "sponsorship_need"])("rejects a %s fact that is not marked sensitive", (kind) => {
    expect(parses([baseFact({ kind })]).success).toBe(false);
    expect(parses([baseFact({ kind, sensitivity: "sensitive" })]).success).toBe(true);
  });

  it("rejects duplicate fact ids, malformed ids and unknown fields", () => {
    expect(parses([baseFact(), baseFact()]).success).toBe(false);
    expect(parses([baseFact({ factId: "has space" })]).success).toBe(false);
    expect(parses([baseFact({ inferred: true })]).success).toBe(false);
    expect(candidateProfileSchema.safeParse(raw({ extra: 1 })).success).toBe(false);
  });

  it("employment facts need a start month, valid ordering, and skills may only link to employment facts", () => {
    const emp = (attributes: Record<string, unknown>) => baseFact({ factId: "e-1", kind: "employment", value: "Co", attributes });
    expect(parses([emp({})]).success).toBe(false);
    expect(parses([emp({ startDate: "2020-01", endDate: "2019-12" })]).success).toBe(false);
    expect(parses([emp({ startDate: "2020-13" })]).success).toBe(false);
    expect(parses([emp({ startDate: "2020-01", endDate: null })]).success).toBe(true);
    const linkOk = baseFact({ attributes: { experienceIds: ["e-1"] } });
    expect(parses([emp({ startDate: "2020-01" }), linkOk]).success).toBe(true);
    expect(parses([linkOk]).success).toBe(false); // dangling reference
    expect(parses([baseFact({ factId: "e-1" }), baseFact({ factId: "s-2", attributes: { experienceIds: ["e-1"] } })]).success).toBe(false); // links to a non-employment fact
  });

  it("parseCandidateProfile throws on invalid input and returns defaults for optional sections", () => {
    expect(() => parseCandidateProfile({})).toThrow();
    const p = parseCandidateProfile({ schemaVersion: 1, candidateId: "c", profileVersion: "v", updatedAt: "2026-09-01", facts: [] });
    expect(p.preferences).toEqual({});
    expect(p.employmentHistoryComplete).toBeNull();
  });

  it("the committed template and the synthetic demo profile are valid, and the template approves nothing", () => {
    const template = JSON.parse(readFileSync(path.resolve("config/candidate-profile.template.json"), "utf-8"));
    const parsed = parseCandidateProfile(template);
    expect(parsed.facts.length).toBeGreaterThan(0);
    expect(parsed.facts.every((f) => f.approvalStatus === "pending")).toBe(true);
    expect(parsed.employmentHistoryComplete).toBeNull();
    const synthetic = parseCandidateProfile(JSON.parse(readFileSync(path.resolve("docs/evidence/fixtures/synthetic-candidate.profile.json"), "utf-8")));
    expect(synthetic.candidateId).toBe("synthetic-candidate");
  });
});

describe("factUsability", () => {
  it("only approved, verified, unexpired facts are usable", () => {
    expect(factUsability(fact({ factId: "a", kind: "skill", value: "x" }), "2026-10-07")).toEqual({ usable: true });
    expect(factUsability(fact({ factId: "a", kind: "skill", value: "x", pending: true }), "2026-10-07")).toMatchObject({ usable: false, reason: "PENDING" });
    expect(factUsability(fact({ factId: "a", kind: "skill", value: "x", approvalStatus: "rejected" }), "2026-10-07")).toMatchObject({ usable: false, reason: "REJECTED" });
    expect(factUsability(fact({ factId: "a", kind: "skill", value: "x", verification: { validUntil: "2026-10-06" } }), "2026-10-07")).toMatchObject({ usable: false, reason: "EXPIRED" });
    expect(factUsability(fact({ factId: "a", kind: "skill", value: "x", verification: { validUntil: "2026-10-07" } }), "2026-10-07")).toEqual({ usable: true }); // valid through its last day
    const unverified = { ...fact({ factId: "a", kind: "skill", value: "x" }), verification: { verifiedBy: null, verifiedAt: null, validUntil: null } };
    expect(factUsability(unverified, "2026-10-07")).toMatchObject({ usable: false, reason: "UNVERIFIED" });
  });
});

describe("unionMonths (end minus start, overlap-safe)", () => {
  const emp = (id: string, startDate: string, endDate: string | null) => fact({ factId: id, kind: "employment", value: id, attributes: { startDate, endDate } });
  it("sums disjoint ranges, merges overlap and containment, and ends a current job at the as-of month", () => {
    expect(unionMonths([emp("a", "2020-01", "2021-01")], "2026-10-07")).toBe(12);
    expect(unionMonths([emp("a", "2020-01", "2021-01"), emp("b", "2022-01", "2022-07")], "2026-10-07")).toBe(18);
    expect(unionMonths([emp("a", "2020-01", "2022-01"), emp("b", "2021-01", "2021-06")], "2026-10-07")).toBe(24); // contained
    expect(unionMonths([emp("a", "2020-01", "2021-07"), emp("b", "2021-01", "2022-07")], "2026-10-07")).toBe(30); // overlap
    expect(unionMonths([emp("a", "2026-01", null)], "2026-10-07")).toBe(9);
    expect(unionMonths([], "2026-10-07")).toBe(0);
  });
  it("is independent of input order and ignores empty or inverted ranges", () => {
    const facts = [emp("b", "2021-01", "2022-07"), emp("a", "2020-01", "2021-07")];
    expect(unionMonths(facts, "2026-10-07")).toBe(unionMonths([...facts].reverse(), "2026-10-07"));
    expect(unionMonths([emp("z", "2020-05", "2020-05")], "2026-10-07")).toBe(0);
  });
  it("the helper profile builder validates (guards the other suites' fixtures)", () => {
    expect(profile([fact({ factId: "a", kind: "skill", value: "x" })]).facts).toHaveLength(1);
  });
});

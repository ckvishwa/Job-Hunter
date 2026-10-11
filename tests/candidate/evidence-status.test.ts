import { describe, expect, it } from "vitest";
import { classifyFacts, confirmedAwaitingResume, evidenceReadiness } from "../../src/candidate/evidence-status.js";
import { selectEvidence, type ConfirmedEmployment, type EvidenceRow, type ProfileRef, type SourceAuth } from "../../src/roles/profile-evidence.js";
import { makeFact } from "../roles/helpers.js";

// The taxonomy names the boundary's decisions. It never changes a fact, and only APPROVED_VALID counts as evidence.

const profile: ProfileRef = { id: "p1", kind: "personal", label: "Casey" };
const sources: SourceAuth[] = [{ resumeId: "r1", provenance: "personal", authorized: true }, { resumeId: "r2", provenance: "fixture", authorized: false }];
const quote = (v: string) => ({ start: 0, end: v.length, quote: v });
const row = (fact: ReturnType<typeof makeFact>, resumeId = "r1", text = fact.value): EvidenceRow => ({ fact, resumeId, resumeCreatedAt: new Date("2026-01-01"), span: quote(fact.value), sourceText: text });

const INTERN = { employer: "Cognizant Technology Solutions", title: "Security Operations Vulnerability Analyst Intern", startDate: "2022-09", endDate: "2023-05", employmentType: "internship" };
const CONFIRMED: ConfirmedEmployment = { employer: "Cognizant Technology Solutions", title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional" };

describe("evidence status taxonomy", () => {
  it("names every state and counts only approved, valid, authorized, source-backed facts as evidence", () => {
    const rows = [
      row(makeFact({ id: "ok", kind: "skill", value: "Splunk" })),
      row(makeFact({ id: "pend", kind: "skill", value: "Wireshark", status: "pending" })),
      row(makeFact({ id: "rej", kind: "skill", value: "Terraform", status: "rejected" })),
      { ...row(makeFact({ id: "weak", kind: "skill", value: "Kubernetes" })), span: quote("not the value") },
      row(makeFact({ id: "intern", kind: "employment", value: INTERN.employer, attributes: INTERN })),
      row(makeFact({ id: "fixture", kind: "skill", value: "Docker" }), "r2"),
    ];
    const scope = selectEvidence({ profile, sources, confirmed: [CONFIRMED], rows });
    const byId = Object.fromEntries(classifyFacts(scope).map((f) => [f.factId, f]));
    expect(byId.ok).toMatchObject({ status: "APPROVED_VALID", countsAsEvidence: true });
    expect(byId.pend).toMatchObject({ status: "PENDING", countsAsEvidence: false });
    expect(byId.rej).toMatchObject({ status: "REJECTED", countsAsEvidence: false });
    expect(byId.weak).toMatchObject({ status: "APPROVED_WEAK_SOURCE", countsAsEvidence: false });
    expect(byId.intern).toMatchObject({ status: "APPROVED_CONFLICTING", countsAsEvidence: false });
    expect(byId.fixture).toBeUndefined(); // an unauthorized source's facts are never listed, only counted
    const rd = evidenceReadiness(scope, [CONFIRMED]);
    expect(rd.counts).toMatchObject({ APPROVED_VALID: 1, PENDING: 1, REJECTED: 1, APPROVED_WEAK_SOURCE: 1, APPROVED_CONFLICTING: 1, UNAUTHORIZED_SOURCE: 1 });
  });

  it("a rejected internship stays out even when the parser proposes it again", () => {
    const first = row(makeFact({ id: "intern-1", kind: "employment", value: INTERN.employer, attributes: INTERN, status: "rejected" }));
    const again = row(makeFact({ id: "intern-2", kind: "employment", value: INTERN.employer, attributes: INTERN, status: "pending" }));
    const scope = selectEvidence({ profile, sources, confirmed: [CONFIRMED], rows: [first, again] });
    const s = Object.fromEntries(classifyFacts(scope).map((f) => [f.factId, f.status]));
    expect(s).toEqual({ "intern-1": "REJECTED", "intern-2": "PENDING" });
    expect(classifyFacts(scope).some((f) => f.countsAsEvidence)).toBe(false);
    // approving the re-proposed fact while it still contradicts the confirmed employment keeps it out
    const approved = selectEvidence({ profile, sources, confirmed: [CONFIRMED], rows: [first, row(makeFact({ id: "intern-2", kind: "employment", value: INTERN.employer, attributes: INTERN }))] });
    expect(classifyFacts(approved).find((f) => f.factId === "intern-2")).toMatchObject({ status: "APPROVED_CONFLICTING", countsAsEvidence: false });
  });

  it("a confirmed statement awaits a résumé and adds nothing until an agreeing fact is approved", () => {
    expect(confirmedAwaitingResume([CONFIRMED], [])).toHaveLength(1);
    expect(confirmedAwaitingResume([CONFIRMED], [makeFact({ id: "x", kind: "employment", value: CONFIRMED.employer, attributes: { employer: CONFIRMED.employer, title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional" }, status: "pending" })])).toHaveLength(1);
    const agreeing = makeFact({ id: "y", kind: "employment", value: CONFIRMED.employer, attributes: { employer: CONFIRMED.employer, title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional" } });
    expect(confirmedAwaitingResume([CONFIRMED], [agreeing])).toEqual([]);
  });
});

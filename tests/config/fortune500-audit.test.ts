import { describe, expect, it } from "vitest";
import { auditFortune500Registry, EXPECTED_TOTAL } from "../../src/config/fortune500-audit.js";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    company: "Acme",
    fortuneRank: 1,
    corporateDomain: "acme.com",
    careersUrl: "https://acme.com/careers",
    atsType: "greenhouse",
    atsTenantOrBoardId: "acme",
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    enabled: true,
    verificationStatus: "verified",
    verificationNote: null,
    sourceProvenance: ["test-fixture"],
    lastVerifiedAt: "2026-07-27",
    ...overrides,
  };
}

// A full, valid, exactly-500-entry registry -- 1 verified greenhouse entry (rank 1) plus 499
// honest "unknown" entries (ranks 2-500), each with a unique domain.
function validRegistry(): unknown[] {
  const entries: unknown[] = [entry()];
  for (let rank = 2; rank <= 500; rank++) {
    entries.push(
      entry({
        company: `Company${rank}`,
        fortuneRank: rank,
        corporateDomain: `company${rank}.com`,
        careersUrl: null,
        atsType: "unknown",
        atsTenantOrBoardId: null,
        verificationStatus: "pending",
        verificationNote: "ATS not yet verified",
      }),
    );
  }
  return entries;
}

describe("auditFortune500Registry", () => {
  it("passes a valid 500-entry registry", () => {
    const result = auditFortune500Registry(validRegistry());
    expect(result.ok).toBe(true);
    expect(result.failReasons).toEqual([]);
    expect(result.totalEntries).toBe(500);
    expect(result.missingRanks).toEqual([]);
    expect(result.duplicateRanks).toEqual([]);
    expect(result.schemaErrors).toEqual([]);
  });

  it("fails when a rank is missing", () => {
    const entries = validRegistry();
    entries.splice(1, 1); // remove rank 2 entirely -- 499 entries, gap at rank 2
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    expect(result.missingRanks).toContain(2);
    expect(result.failReasons.some((r) => /missing rank/i.test(r))).toBe(true);
  });

  it("fails when a rank is duplicated", () => {
    const entries = validRegistry();
    entries[1] = entry({ company: "Dup", fortuneRank: 1, corporateDomain: "dup.com" }); // rank 1 now twice
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    expect(result.duplicateRanks).toContain(1);
    expect(result.failReasons.some((r) => /duplicate rank/i.test(r))).toBe(true);
  });

  it("fails when a company+domain pair is duplicated", () => {
    const entries = validRegistry();
    entries[1] = entry({ company: "Acme", fortuneRank: 2, corporateDomain: "acme.com" }); // same company+domain as rank 1
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    expect(result.schemaErrors.length).toBeGreaterThan(0);
  });

  it("fails on an invalid (non-URL) career URL", () => {
    const entries = validRegistry();
    entries[0] = entry({ careersUrl: "not-a-url" });
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    expect(result.schemaErrors.some((e) => e.message.includes("http"))).toBe(true);
  });

  it("fails on an unsafe URL protocol (javascript:)", () => {
    const entries = validRegistry();
    entries[0] = entry({ careersUrl: "javascript:alert(1)" });
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    expect(result.unsafeUrlCount).toBeGreaterThan(0);
  });

  it("accepts an unknown-ATS entry as valid -- not a fatal error when represented honestly", () => {
    const entries = validRegistry(); // ranks 2-500 are all atsType: unknown
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(true);
    expect(result.atsCounts.unknown).toBe(499);
  });

  it("handles a workday entry without a verified site honestly -- valid, not fabricated", () => {
    const entries = validRegistry();
    entries[0] = entry({
      atsType: "workday",
      atsTenantOrBoardId: "acme",
      atsWorkdaySite: null,
      atsWorkdayHostname: null,
    });
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(true);
    expect(result.atsCounts.workday).toBe(1);
  });

  it("requires a board/tenant identifier for known greenhouse/lever/ashby/icims entries", () => {
    const entries = validRegistry();
    entries[0] = entry({ atsType: "ashby", atsTenantOrBoardId: null });
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    expect(result.schemaErrors.some((e) => e.path.includes("atsTenantOrBoardId"))).toBe(true);
  });

  it("computes correct counts", () => {
    const entries = validRegistry();
    const result = auditFortune500Registry(entries);
    expect(result.careerUrlsPresent).toBe(1);
    expect(result.careerUrlsMissing).toBe(499);
    expect(result.atsIdentified).toBe(1);
    expect(result.atsUnknown).toBe(499);
    expect(result.atsCounts.greenhouse).toBe(1);
    expect(result.verificationStatusCounts.verified).toBe(1);
    expect(result.verificationStatusCounts.pending).toBe(499);
  });

  it("is deterministic -- same input produces byte-identical output", () => {
    const entries = validRegistry();
    const a = auditFortune500Registry(entries);
    const b = auditFortune500Registry(entries);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("reports the exact rank and company of one malformed entry among otherwise-valid ones", () => {
    const entries = validRegistry();
    entries[249] = entry({ company: "BadCo", fortuneRank: 250, corporateDomain: "not a domain" });
    const result = auditFortune500Registry(entries);
    expect(result.ok).toBe(false);
    const issue = result.schemaErrors.find((e) => e.company === "BadCo");
    expect(issue).toBeDefined();
    expect(issue!.fortuneRank).toBe(250);
  });

  it("one malformed entry does not prevent the rest of the registry from being audited", () => {
    const entries = validRegistry();
    entries[249] = entry({ company: "BadCo", fortuneRank: 250, corporateDomain: "not a domain" });
    const result = auditFortune500Registry(entries);
    expect(result.totalEntries).toBe(500); // still counted, not dropped
    expect(result.schemaErrors.length).toBe(1); // isolated to just this one entry
  });

  it("EXPECTED_TOTAL constant is 500", () => {
    expect(EXPECTED_TOTAL).toBe(500);
  });
});

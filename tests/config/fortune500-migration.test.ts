import { describe, expect, it } from "vitest";
import { migrateFortune500Identity, normalizeCompanyIdentity } from "../../src/config/fortune500-migration.js";
import type { CompanyRegistryEntry } from "../../src/config/schema.js";

function oldEntry(overrides: Partial<CompanyRegistryEntry> = {}): CompanyRegistryEntry {
  return {
    company: "Acme",
    fortuneRank: 10,
    corporateDomain: "acme.com",
    careersUrl: null,
    atsType: "unknown",
    atsTenantOrBoardId: null,
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    enabled: true,
    verificationStatus: "pending",
    verificationNote: null,
    sourceProvenance: ["test-fixture"],
    lastVerifiedAt: null,
    ...overrides,
  };
}

describe("normalizeCompanyIdentity", () => {
  it("strips common legal-entity suffixes", () => {
    expect(normalizeCompanyIdentity("Acme Corporation")).toBe(normalizeCompanyIdentity("Acme"));
    expect(normalizeCompanyIdentity("Acme, Inc.")).toBe(normalizeCompanyIdentity("Acme"));
  });

  it("strips diacritics", () => {
    expect(normalizeCompanyIdentity("Mondelēz International")).toBe(normalizeCompanyIdentity("Mondelez International"));
  });

  it("strips a trailing .com without needing a word boundary workaround", () => {
    expect(normalizeCompanyIdentity("Amazon.com")).toBe(normalizeCompanyIdentity("Amazon"));
  });
});

describe("migrateFortune500Identity", () => {
  it("matches an unchanged company by name, never by rank", () => {
    const old = [oldEntry({ company: "Apple", fortuneRank: 3, corporateDomain: "apple.com" })];
    // Apple moved from rank 3 to rank 4 -- matching by rank would have found "whatever is at
    // rank 4 in the old registry" (nothing here) instead of the real Apple entry.
    const report = migrateFortune500Identity(old, [{ rank: 4, company: "Apple" }]);
    expect(report.totalRetained).toBe(1);
    expect(report.retained[0]).toMatchObject({ oldRank: 3, newRank: 4, oldCompany: "Apple", newCompany: "Apple" });
    expect(report.totalRankChanges).toBe(1);
    expect(report.rankChanges[0]).toMatchObject({ oldRank: 3, newRank: 4, delta: -1 });
  });

  it("does not report a rank change for a company whose rank stayed the same", () => {
    const old = [oldEntry({ company: "Acme", fortuneRank: 10 })];
    const report = migrateFortune500Identity(old, [{ rank: 10, company: "Acme" }]);
    expect(report.totalRankChanges).toBe(0);
  });

  it("detects a company present in both editions under a slightly different display name as renamed", () => {
    const old = [oldEntry({ company: "Exxon Mobil", fortuneRank: 3 })];
    const report = migrateFortune500Identity(old, [{ rank: 9, company: "ExxonMobil Holdings" }]);
    expect(report.totalRenamed).toBe(1);
    expect(report.renamed[0]).toMatchObject({ oldCompany: "Exxon Mobil", newCompany: "ExxonMobil Holdings" });
    expect(report.totalRetained).toBe(1); // still counted as retained, not added+removed
  });

  it("reports a company only in the old edition as removed", () => {
    const old = [oldEntry({ company: "Rite Aid", fortuneRank: 400 })];
    const report = migrateFortune500Identity(old, []);
    expect(report.totalRemoved).toBe(1);
    expect(report.removed[0]).toMatchObject({ company: "Rite Aid", oldRank: 400 });
  });

  it("reports a company only in the new edition as added", () => {
    const report = migrateFortune500Identity([], [{ rank: 1, company: "Brand New Co" }]);
    expect(report.totalAdded).toBe(1);
    expect(report.added[0]).toMatchObject({ newRank: 1, newCompany: "Brand New Co" });
  });

  it("does not silently merge two genuinely different companies (e.g. a real corporate split)", () => {
    // General Electric split into GE Aerospace / GE Vernova / GE HealthCare -- neither new name
    // should fuzzy-match the old "General Electric" entry; both must surface as distinct
    // added+removed, never silently treated as "General Electric renamed to GE Aerospace."
    const old = [oldEntry({ company: "General Electric", fortuneRank: 50 })];
    const report = migrateFortune500Identity(old, [
      { rank: 60, company: "GE Aerospace" },
      { rank: 200, company: "GE Vernova" },
    ]);
    expect(report.totalRetained).toBe(0);
    expect(report.totalRemoved).toBe(1);
    expect(report.totalAdded).toBe(2);
  });

  it("reports an ambiguous match (multiple old candidates for one new identity) instead of guessing", () => {
    const old = [
      oldEntry({ company: "Acme Holdings", fortuneRank: 10, corporateDomain: "acme1.com" }),
      oldEntry({ company: "Acme Group", fortuneRank: 20, corporateDomain: "acme2.com" }),
    ];
    const report = migrateFortune500Identity(old, [{ rank: 15, company: "Acme" }]);
    expect(report.totalUnresolved).toBe(1);
    expect(report.unresolvedIdentityMatches[0]!.candidates.sort()).toEqual(["Acme Group", "Acme Holdings"]);
    // Ambiguous -> treated as added, not silently attached to either candidate.
    expect(report.totalAdded).toBe(1);
  });

  it("is deterministic -- same input produces byte-identical output", () => {
    const old = [oldEntry({ company: "Acme", fortuneRank: 10 })];
    const newIdentity = [{ rank: 5, company: "Acme" }, { rank: 6, company: "Beta" }];
    const a = migrateFortune500Identity(old, newIdentity);
    const b = migrateFortune500Identity(old, newIdentity);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("carries the old corporateDomain into the retained entry, for the registry build step to reuse", () => {
    const old = [oldEntry({ company: "Acme", fortuneRank: 10, corporateDomain: "acme.com" })];
    const report = migrateFortune500Identity(old, [{ rank: 5, company: "Acme" }]);
    expect(report.retained[0]!.corporateDomain).toBe("acme.com");
  });
});

import { describe, expect, it } from "vitest";
import { coverageLedger, type RegistryEmployer } from "../../src/targets/employer-coverage.js";
import type { TargetRecord } from "../../src/targets/crosswalk.js";

function target(partial: Partial<TargetRecord> & Pick<TargetRecord, "id" | "displayName">): TargetRecord {
  return {
    aliases: [],
    parentCompany: null,
    sponsorshipHistoryStatus: "USER_SUPPLIED_UNVERIFIED",
    roleLevelSponsorshipStatus: "UNKNOWN",
    officialCareerUrlVerifiedCurrent: false,
    atsIdentityVerifiedCurrent: false,
    ...partial,
  };
}

describe("employer coverage ledger", () => {
  const registry: RegistryEmployer[] = [
    { company: "Alphabet", careersUrl: "https://www.google.com/about/careers/applications", atsType: "greenhouse", atsTenantOrBoardId: "google", atsWorkdaySite: null, atsWorkdayHostname: null, verificationStatus: "verified" },
    { company: "Walmart", careersUrl: "https://careers.walmart.com", atsType: "workday", atsTenantOrBoardId: "walmart", atsWorkdaySite: null, atsWorkdayHostname: null, verificationStatus: "verified" },
    { company: "Amazon", careersUrl: "https://www.amazon.jobs", atsType: "unknown", atsTenantOrBoardId: null, atsWorkdaySite: null, atsWorkdayHostname: null, verificationStatus: "verified" },
  ];

  it("does not guess a board id or infer visa eligibility", () => {
    const ledger = coverageLedger([
      target({ id: "google", displayName: "Google", existingFortune500RegistryMatch: "Alphabet", aliases: ["Mandiant"] }),
      target({ id: "walmart-associates", displayName: "Walmart Associates", existingFortune500RegistryMatch: "Walmart" }),
      target({ id: "amazon-aws", displayName: "Amazon / AWS", existingFortune500RegistryMatch: "Amazon" }),
      target({ id: "snyk", displayName: "Snyk" }),
    ], registry, "2026-10-21T17:00:00.000Z");
    expect(ledger.find((row) => row.canonicalId === "google")?.status).toBe("VERIFIED_SOURCE");
    expect(ledger.find((row) => row.canonicalId === "walmart-associates")?.status).toBe("UNSUPPORTED_ATS");
    expect(ledger.find((row) => row.canonicalId === "amazon-aws")?.status).toBe("NOT_STARTED");
    expect(ledger.find((row) => row.canonicalId === "snyk")?.status).toBe("NOT_STARTED");
    expect(ledger.every((row) => row.sponsorshipEligibilityInferred === false)).toBe(true);
    expect(ledger).toHaveLength(4);
  });
});

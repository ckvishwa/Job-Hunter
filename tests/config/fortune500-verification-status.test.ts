import { describe, expect, it } from "vitest";
import { companyRegistryEntrySchema } from "../../src/config/schema.js";
import { auditFortune500Registry } from "../../src/config/fortune500-audit.js";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    company: "Acme",
    fortuneRank: 1,
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

describe("verificationStatus -- 'no-parent-careers-page' and 'not-found' are distinct statuses", () => {
  // Reproduces the real gap: Berkshire Hathaway (a holding company with no single official
  // careers page) was being stored as verificationStatus: "verification-required" -- the SAME
  // status as a company whose site threw a CAPTCHA/challenge page. Both were also
  // indistinguishable from the 479 companies nobody had looked at yet ("verification-required"
  // was being reused as the default for "not yet attempted," which is what "pending" is for).
  it("accepts 'no-parent-careers-page' as a distinct verificationStatus", () => {
    const result = companyRegistryEntrySchema.safeParse(
      entry({ verificationStatus: "no-parent-careers-page", verificationNote: "Holding company, no centralized careers page" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts 'not-found' as a distinct verificationStatus", () => {
    const result = companyRegistryEntrySchema.safeParse(
      entry({ verificationStatus: "not-found", verificationNote: "Checked official site + targeted search, no career page found" }),
    );
    expect(result.success).toBe(true);
  });

  it("audit counts 'no-parent-careers-page' entries as documented exceptions, NOT as verified career URLs", () => {
    const entries = [
      entry({ fortuneRank: 1, careersUrl: "https://acme.com/careers", verificationStatus: "verified" }),
      entry({ fortuneRank: 2, company: "Holdco", corporateDomain: "holdco.com", careersUrl: null, verificationStatus: "no-parent-careers-page", verificationNote: "Holding company" }),
      ...Array.from({ length: 498 }, (_, i) => entry({ fortuneRank: i + 3, company: `Co${i + 3}`, corporateDomain: `co${i + 3}.com`, verificationStatus: "pending" })),
    ];
    const result = auditFortune500Registry(entries);
    expect(result.careerUrlsVerified).toBe(1); // Acme only -- Holdco's exception must never inflate this count
    expect(result.verificationStatusCounts["no-parent-careers-page"]).toBe(1);
    expect(result.verificationStatusCounts.pending).toBe(498);
  });

  it("audit distinguishes 'pending' (never attempted) from 'verification-required' (attempted, hit a challenge)", () => {
    const entries = [
      entry({ fortuneRank: 1, careersUrl: null, verificationStatus: "verification-required", verificationNote: "Site presented a CAPTCHA on the careers page" }),
      ...Array.from({ length: 499 }, (_, i) => entry({ fortuneRank: i + 2, company: `Co${i + 2}`, corporateDomain: `co${i + 2}.com`, verificationStatus: "pending" })),
    ];
    const result = auditFortune500Registry(entries);
    expect(result.verificationRequiredCount).toBe(1);
    expect(result.verificationStatusCounts.pending).toBe(499);
  });
});

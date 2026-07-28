import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadCompanyRegistry } from "../../src/config/loader.js";

function tempFile(name: string, contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-test-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, JSON.stringify(contents), "utf-8");
  return filePath;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    company: "Acme",
    fortuneRank: 100,
    corporateDomain: "acme.com",
    careersUrl: "https://acme.com/careers",
    atsType: "greenhouse",
    atsTenantOrBoardId: "acme",
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    verificationStatus: "verified",
    lastVerifiedDate: "2026-07-27",
    ...overrides,
  };
}

describe("loadCompanyRegistry", () => {
  it("rejects duplicate fortuneRank values across entries", () => {
    const filePath = tempFile("registry.json", [
      entry({ company: "Acme", fortuneRank: 5 }),
      entry({ company: "Beta", corporateDomain: "beta.com", fortuneRank: 5 }),
    ]);

    expect(() => loadCompanyRegistry(filePath)).toThrow(ConfigValidationError);
    try {
      loadCompanyRegistry(filePath);
      throw new Error("expected loadCompanyRegistry to throw");
    } catch (err) {
      expect((err as Error).message).toContain("Acme");
      expect((err as Error).message).toContain("Beta");
    }
  });

  it("rejects duplicate company+corporateDomain pairs (case-insensitive)", () => {
    const filePath = tempFile("registry.json", [
      entry({ company: "Acme", fortuneRank: 5, corporateDomain: "Acme.com" }),
      entry({ company: "acme", fortuneRank: 6, corporateDomain: "acme.com" }),
    ]);

    expect(() => loadCompanyRegistry(filePath)).toThrow(ConfigValidationError);
  });

  it("rejects an unknown atsType value", () => {
    const filePath = tempFile("registry.json", [entry({ atsType: "bamboohr" })]);

    expect(() => loadCompanyRegistry(filePath)).toThrow(ConfigValidationError);
  });

  it("does not false-positive on two entries both with fortuneRank: null", () => {
    const filePath = tempFile("registry.json", [
      entry({ company: "Acme", fortuneRank: null, corporateDomain: "acme.com" }),
      entry({ company: "Beta", fortuneRank: null, corporateDomain: "beta.com" }),
    ]);

    expect(() => loadCompanyRegistry(filePath)).not.toThrow();
    expect(loadCompanyRegistry(filePath)).toHaveLength(2);
  });

  it("loads the real config/fortune500-registry.json cleanly -- production, real ranked companies only", () => {
    const realPath = path.resolve("config/fortune500-registry.json");
    // Sanity-check the fixture itself parses as JSON before handing it to the loader.
    JSON.parse(readFileSync(realPath, "utf-8"));

    const registry = loadCompanyRegistry(realPath);
    expect(registry).toHaveLength(4);
    expect(registry.map((e) => e.company).sort()).toEqual(
      ["Amazon", "Apple", "Google", "Walmart"].sort(),
    );
    // Every production entry is a genuinely Fortune-ranked company -- validation-only
    // companies (fortuneRank: null) belong in config/fortune500-registry.validation.json,
    // never mixed into this file (see the sibling test below).
    for (const e of registry) {
      expect(e.fortuneRank).not.toBeNull();
      expect(e.atsWorkdaySite).toBeNull();
    }
  });

  it("loads the real config/fortune500-registry.validation.json cleanly -- validation-only companies, never mixed into production", () => {
    const validationPath = path.resolve("config/fortune500-registry.validation.json");
    JSON.parse(readFileSync(validationPath, "utf-8"));

    const registry = loadCompanyRegistry(validationPath);
    expect(registry).toHaveLength(4);
    expect(registry.map((e) => e.company).sort()).toEqual(["AHEAD", "Figma", "Stripe", "Target"].sort());
    // Every validation entry is deliberately NOT Fortune-ranked -- these exist only to give
    // controlled live-validation runs (Task 17) real, working companies per ATS type without
    // fabricating or guessing details about an actual Fortune 500 member. Target IS a genuine
    // Fortune 500 company with a real, verified Workday tenant (Task 2 restart) -- kept here
    // rather than in production because its exact current Fortune rank number was never
    // independently confirmed, and fabricating one would violate the same "never guess" rule
    // this file's own production/validation split exists to enforce.
    for (const e of registry) {
      expect(e.fortuneRank).toBeNull();
    }

    const productionCompanies = loadCompanyRegistry(path.resolve("config/fortune500-registry.json")).map(
      (e) => e.company,
    );
    const validationCompanies = registry.map((e) => e.company);
    const overlap = validationCompanies.filter((c) => productionCompanies.includes(c));
    expect(overlap).toEqual([]);
  });
});

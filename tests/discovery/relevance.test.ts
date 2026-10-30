import { describe, expect, it } from "vitest";
import { evaluateRelevance } from "../../src/discovery/relevance.js";
import type { RoleConfig } from "../../src/types.js";

const ROLES: RoleConfig[] = [
  { id: "sdet-qa", profile: "sdet", keywords: ["SDET", "QA Automation Engineer", "Software Development Engineer in Test", "Test Automation Engineer"] },
  { id: "security-soc", profile: "security", keywords: ["SOC Analyst", "Security Analyst", "Security Operations Center", "Incident Response Analyst"] },
  { id: "cloud-iam", profile: "cloud", keywords: ["IAM Engineer", "Cloud Security Engineer", "Identity and Access Management", "Cloud Engineer"] },
  { id: "network-noc", profile: "network", keywords: ["NOC Engineer", "Network Engineer", "Network Operations Center", "Network Administrator"] },
];

describe("evaluateRelevance", () => {
  it("matches sdet on an exact configured keyword phrase", () => {
    const result = evaluateRelevance({ title: "Senior SDET II" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toEqual(["sdet"]);
    expect(result.matchedKeywords).toContain("SDET");
    expect(result.matchedFields).toEqual(["title"]);
  });

  it("matches sdet via a domain-qualifier token even without the exact configured phrase", () => {
    const result = evaluateRelevance({ title: "Quality Automation Engineer II" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toContain("sdet");
    expect(result.matchedKeywords.some((k) => k === "quality" || k === "automation")).toBe(true);
  });

  it("matches security on SOC/incident-response related titles", () => {
    const result = evaluateRelevance({ title: "Incident Response Engineer" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toEqual(["security"]);
  });

  it("matches cloud on IAM/identity-related titles", () => {
    const result = evaluateRelevance({ title: "Senior IAM Engineer" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toEqual(["cloud"]);
  });

  it("matches network on NOC/networking-related titles", () => {
    const result = evaluateRelevance({ title: "Network Operations Center Technician" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toEqual(["network"]);
  });

  it("rejects a completely unrelated title (the real 'Account Executive' false-positive this whole phase exists to fix)", () => {
    const result = evaluateRelevance({ title: "Account Executive, Emerging Enterprise" }, ROLES);
    expect(result.matched).toBe(false);
    expect(result.matchedProfiles).toEqual([]);
  });

  it("never matches on a bare generic role word alone (engineer, analyst, specialist, manager)", () => {
    for (const title of ["Software Engineer", "Business Analyst", "Marketing Specialist", "Product Manager", "Sales Associate"]) {
      const result = evaluateRelevance({ title }, ROLES);
      expect(result.matched, `expected "${title}" to be rejected`).toBe(false);
    }
  });

  it("matches multiple profiles when a title genuinely spans two domains, with the first-in-config-order profile as primary", () => {
    const result = evaluateRelevance({ title: "Cloud Security Engineer" }, ROLES);
    expect(result.matched).toBe(true);
    // "Cloud Security Engineer" is security's own configured keyword AND matches cloud's
    // "cloud" domain qualifier -- security is declared before cloud in ROLES, so it's primary.
    expect(result.matchedProfiles[0]).toBe("security");
    expect(result.matchedProfiles).toContain("cloud");
    expect(result.relevanceReason).toContain("also matches");
  });

  it("evaluates the department field via domain-qualifier tokens, same as title", () => {
    const byDept = evaluateRelevance({ title: "Engineer II", department: "Quality Assurance" }, ROLES);
    expect(byDept.matched).toBe(true);
    expect(byDept.matchedProfiles).toEqual(["sdet"]);
    expect(byDept.matchedFields).toEqual(["department"]);
  });

  it("matches an exact configured keyword phrase appearing in the description snippet", () => {
    const bySnippet = evaluateRelevance(
      { title: "Engineer II", descriptionSnippet: "We are looking for a Security Analyst to join our growing team." },
      ROLES,
    );
    expect(bySnippet.matched).toBe(true);
    expect(bySnippet.matchedProfiles).toEqual(["security"]);
    expect(bySnippet.matchedFields).toEqual(["descriptionSnippet"]);
    expect(bySnippet.matchedKeywords).toContain("Security Analyst");
  });

  it("does NOT match a bare domain-qualifier word appearing only in the description snippet -- real false-positive fixed live: company boilerplate ('cloud infrastructure, automation and analytics') was matching every job at a company regardless of actual role", () => {
    const result = evaluateRelevance(
      {
        title: "AI Sales Specialist",
        department: "Artificial Intelligence",
        descriptionSnippet:
          "AHEAD builds platforms for digital business. By weaving together advances in cloud infrastructure, automation and analytics, and software delivery, we help enterprises deliver on the promise of digital transformation.",
      },
      ROLES,
    );
    expect(result.matched).toBe(false);
  });

  it("does NOT match a bare domain-qualifier word appearing only in location", () => {
    // Contrived, but locks in the same restriction for location as for descriptionSnippet.
    const result = evaluateRelevance({ title: "Engineer II", location: "Cloud City, Remote" }, ROLES);
    expect(result.matched).toBe(false);
  });

  // Regression coverage for a real false positive found and reproduced by independent review:
  // a WEAK domain-qualifier word (cloud/security/network/quality/...) appearing in a TITLE
  // alongside a non-technical role word (sales, guard, representative, inspector) is the exact
  // same false-positive class this whole module exists to prevent -- just triggered by a
  // domain word instead of a generic role word. Fixed by requiring a WEAK qualifier in TITLE
  // to co-occur with a real tech role word (engineer/developer/architect/administrator/
  // technician/analyst/specialist/consultant/scientist/programmer).
  it("rejects non-technical titles that merely contain a bare WEAK domain-qualifier word", () => {
    const cases = [
      "Account Executive, Cloud Platform Sales",
      "Corporate Security Guard",
      "Network Marketing Representative",
      "Quality Assurance Inspector",
    ];
    for (const title of cases) {
      const result = evaluateRelevance({ title }, ROLES);
      expect(result.matched, `expected "${title}" to be rejected`).toBe(false);
    }
  });

  it("still rejects a WEAK-qualifier title even with an unrelated department -- department alone doesn't rescue a bad title match", () => {
    const result = evaluateRelevance({ title: "Quality Assurance Inspector", department: "Manufacturing" }, ROLES);
    expect(result.matched).toBe(false);
  });

  it("a bare WEAK qualifier in DEPARTMENT (not title) still matches unpaired -- department is a curated category, not free prose", () => {
    const result = evaluateRelevance({ title: "Engineer II", department: "Security" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toEqual(["security"]);
  });

  it("a WEAK qualifier DOES match when genuinely paired with a tech role word in the title, even outside an exact configured phrase", () => {
    for (const [title, profile] of [
      ["Cloud Solutions Architect", "cloud"],
      ["Network Systems Administrator", "network"],
      ["Security Consultant", "security"],
    ] as const) {
      const result = evaluateRelevance({ title }, ROLES);
      expect(result.matched, `expected "${title}" to match`).toBe(true);
      expect(result.matchedProfiles).toContain(profile);
    }
  });

  it("a STRONG qualifier (sdet/soc/noc/iam/cybersecurity/infosec/pentest) still matches title alone, unpaired", () => {
    for (const [title, profile] of [
      ["SDET II", "sdet"],
      ["SOC Coordinator", "security"],
      ["NOC Associate", "network"],
      ["IAM Consultant", "cloud"],
    ] as const) {
      const result = evaluateRelevance({ title }, ROLES);
      expect(result.matched, `expected "${title}" to match`).toBe(true);
      expect(result.matchedProfiles).toContain(profile);
    }
  });

  it("produces a non-empty relevanceReason string for every match, and a clear rejection reason otherwise", () => {
    const matched = evaluateRelevance({ title: "SDET" }, ROLES);
    expect(matched.relevanceReason.length).toBeGreaterThan(0);

    const rejected = evaluateRelevance({ title: "Warehouse Associate" }, ROLES);
    expect(rejected.relevanceReason.length).toBeGreaterThan(0);
    expect(rejected.matched).toBe(false);
  });

  it("is case-insensitive", () => {
    const result = evaluateRelevance({ title: "senior sdet" }, ROLES);
    expect(result.matched).toBe(true);
    expect(result.matchedProfiles).toEqual(["sdet"]);
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRolesConfig } from "../../src/config/loader.js";
import { classifyResultTitle } from "../../src/discovery/title-targeting.js";

// Expected classifications are hand-reviewed against config/roles.yml (SDET, QA Automation Engineer,
// Software Development Engineer in Test, Test Automation Engineer, SOC/Security Analyst, IAM/Cloud
// Security Engineer, NOC/Network Engineer ...) and the documented qualifier rules in
// src/discovery/relevance.ts. Boundary: pure functions over the real roles file.
const roles = loadRolesConfig(path.resolve("config/roles.yml"));

describe("classifyResultTitle", () => {
  it.each([
    ["SDET II", "Engineering", "MATCH", "sdet"],
    ["Test Automation Engineer", null, "MATCH", "sdet"],
    ["Software Development Engineer in Test, Payments", null, "MATCH", "sdet"],
    ["Security Analyst", "Security", "MATCH", "security"],
    ["Offensive Security Engineer", "Security", "MATCH", "security"],
    ["Network Engineer", "IT", "MATCH", "network"],
    ["IAM Engineer", null, "MATCH", "cloud"],
  ])("MATCH: %s", (title, team, expected, profile) => {
    const d = classifyResultTitle({ title, team }, roles);
    expect(d.classification).toBe(expected);
    expect(d.profile).toBe(profile);
    expect(d.rule.length).toBeGreaterThan(10);
  });

  it("an individual-contributor title and a manager title in the same results classify differently, and the manager is not a MATCH", () => {
    // Same site, same team label: the IC title matches a configured role; the manager title does not.
    const ic = classifyResultTitle({ title: "Offensive Security Engineer", team: "Security" }, roles);
    const manager = classifyResultTitle({ title: "ARG Engineering Manager", team: "Security" }, roles);
    expect(ic.classification).toBe("MATCH");
    expect(manager.classification).not.toBe("MATCH");
    expect(manager.classification).toBe("REVIEW"); // only because its team label names the security domain
    expect(manager.reason).toContain("Needs a human decision");
  });

  it("a manager title whose words look like a role is still not a title match (no silent broadening)", () => {
    expect(classifyResultTitle({ title: "Security Engineering Manager", team: null }, roles).classification).toBe("NO_MATCH");
    expect(classifyResultTitle({ title: "Director of Cloud Operations", team: null }, roles).classification).toBe("NO_MATCH");
  });

  it("names the exact configured rule: a roles.yml role id and keyword, or the documented qualifier", () => {
    const byKeyword = classifyResultTitle({ title: "Network Engineer", team: null }, roles);
    expect(byKeyword.rule).toContain('config/roles.yml role "network-noc" keyword "Network Engineer"');
    const byQualifier = classifyResultTitle({ title: "Offensive Security Engineer", team: null }, roles);
    expect(byQualifier.rule).toContain('domain qualifier "security"');
    expect(byQualifier.rule).toContain("src/discovery/relevance.ts");
  });

  it("does not report the same keyword twice for case variants", () => {
    const d = classifyResultTitle({ title: "SDET II", team: null }, roles);
    const mentions = d.rule.split(";").filter((p) => p.toLowerCase().includes('keyword "sdet"'));
    expect(mentions).toHaveLength(1);
  });

  it("REVIEW when only the team label is in a profile domain; NO_MATCH when it is not", () => {
    const review = classifyResultTitle({ title: "Backend Engineer, Core Technology", team: "Security" }, roles);
    expect(review).toMatchObject({ classification: "REVIEW", profile: "security" });
    expect(review.rule).toContain('team label "Security"');
    expect(classifyResultTitle({ title: "Backend Engineer, Core Technology", team: "Payments" }, roles).classification).toBe("NO_MATCH");
  });

  it("reviewByTeam:false turns team-only evidence into NO_MATCH", () => {
    const d = classifyResultTitle({ title: "Abuse Research Engineer", team: "Security" }, roles, { reviewByTeam: false });
    expect(d.classification).toBe("NO_MATCH");
  });

  it("known false-positive guards from relevance.ts hold: sales / guard / marketing titles are NO_MATCH", () => {
    for (const title of ["Account Executive, Cloud Platform Sales", "Corporate Security Guard", "Network Marketing Representative"]) {
      expect(classifyResultTitle({ title, team: "Sales" }, roles).classification).toBe("NO_MATCH");
    }
  });

  it("every result NO_MATCH or REVIEW yields no MATCH at all", () => {
    const titles: [string, string | null][] = [
      ["ARG Engineering Manager", "Security"],
      ["Abuse Research Engineer", "Security"],
      ["Product Marketing Manager", "Marketing"],
      ["Account Executive", "Sales"],
    ];
    const decisions = titles.map(([title, team]) => classifyResultTitle({ title, team }, roles).classification);
    expect(decisions).toEqual(["REVIEW", "REVIEW", "NO_MATCH", "NO_MATCH"]);
    expect(decisions.includes("MATCH")).toBe(false);
  });
});

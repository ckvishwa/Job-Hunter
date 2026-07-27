import { describe, expect, it } from "vitest";
import { matchProfiles } from "../../src/adapters/match-profiles.js";

describe("matchProfiles", () => {
  it("returns profile ids whose keyword appears (case-insensitive)", () => {
    const result = matchProfiles("Senior SDET - Test Automation Engineer", [
      { keyword: "sdet", profileIds: ["sdet"] },
      { keyword: "network engineer", profileIds: ["network"] },
    ]);
    expect(result).toEqual(["sdet"]);
  });

  it("unions profile ids across multiple matching keywords", () => {
    const result = matchProfiles("Cloud Security Engineer (IAM)", [
      { keyword: "cloud", profileIds: ["cloud"] },
      { keyword: "security", profileIds: ["security"] },
      { keyword: "network", profileIds: ["network"] },
    ]);
    expect(result.sort()).toEqual(["cloud", "security"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchProfiles("Barista", [{ keyword: "sdet", profileIds: ["sdet"] }])).toEqual([]);
  });
});

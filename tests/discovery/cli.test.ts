import { describe, expect, it } from "vitest";
import { parseDiscoverArgs } from "../../src/discovery/cli.js";

describe("parseDiscoverArgs", () => {
  it("parses a valid positive integer --limit", () => {
    expect(parseDiscoverArgs(["--limit", "5"]).limit).toBe(5);
  });

  it("ignores --limit when given no value instead of producing NaN", () => {
    const result = parseDiscoverArgs(["--limit"]);
    expect(result.limit).toBeUndefined();
    expect(Number.isNaN(result.limit)).toBe(false);
  });

  it("ignores --limit when given a non-numeric or non-positive value", () => {
    expect(parseDiscoverArgs(["--limit", "abc"]).limit).toBeUndefined();
    expect(parseDiscoverArgs(["--limit", "0"]).limit).toBeUndefined();
    expect(parseDiscoverArgs(["--limit", "-3"]).limit).toBeUndefined();
    expect(parseDiscoverArgs(["--limit", "2.5"]).limit).toBeUndefined();
  });

  it("still parses --profile, --source, --location as before", () => {
    const result = parseDiscoverArgs(["--profile", "sdet,security", "--source", "indeed", "--location", "Austin"]);
    expect(result.profileIds).toEqual(["sdet", "security"]);
    expect(result.sources).toEqual(["indeed"]);
    expect(result.location).toBe("Austin");
  });

  it("parses --company with a value", () => {
    expect(parseDiscoverArgs(["--company", "Walmart"]).company).toBe("Walmart");
  });

  it("parses bare --resume as a boolean, no value consumed", () => {
    const result = parseDiscoverArgs(["--resume", "--company", "Walmart"]);
    expect(result.resume).toBe(true);
    expect(result.company).toBe("Walmart");
  });

  it("parses bare --dry-run as a boolean, no value consumed", () => {
    const result = parseDiscoverArgs(["--dry-run", "--limit", "5"]);
    expect(result.dryRun).toBe(true);
    expect(result.limit).toBe(5);
  });

  it("parses bare --reset-checkpoint (end of argv) as true", () => {
    expect(parseDiscoverArgs(["--reset-checkpoint"]).resetCheckpoint).toBe(true);
  });

  it("parses bare --reset-checkpoint (followed by another flag) as true, not consuming the flag", () => {
    const result = parseDiscoverArgs(["--reset-checkpoint", "--dry-run"]);
    expect(result.resetCheckpoint).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it("parses --reset-checkpoint <source> as the source string", () => {
    const result = parseDiscoverArgs(["--reset-checkpoint", "company-careers"]);
    expect(result.resetCheckpoint).toBe("company-careers");
  });

  it("combines all four new flags with existing flags", () => {
    const result = parseDiscoverArgs([
      "--profile",
      "sdet",
      "--company",
      "Meta",
      "--resume",
      "--dry-run",
      "--reset-checkpoint",
      "indeed",
    ]);
    expect(result).toEqual({
      profileIds: ["sdet"],
      company: "Meta",
      resume: true,
      dryRun: true,
      resetCheckpoint: "indeed",
    });
  });

  it("parses --registry with a path", () => {
    expect(parseDiscoverArgs(["--registry", "config/fortune500-registry.validation.json"]).registryPath).toBe(
      "config/fortune500-registry.validation.json",
    );
  });

  it("parses bare --isolated-profile as a boolean, no value consumed", () => {
    const result = parseDiscoverArgs(["--isolated-profile", "--company", "Figma"]);
    expect(result.isolatedProfile).toBe(true);
    expect(result.company).toBe("Figma");
  });

  it("parses --resolve-concurrency, --resolve-job-timeout-ms, --resolve-total-timeout-ms as positive integers", () => {
    const result = parseDiscoverArgs([
      "--resolve-concurrency",
      "5",
      "--resolve-job-timeout-ms",
      "30000",
      "--resolve-total-timeout-ms",
      "600000",
    ]);
    expect(result.resolveConcurrency).toBe(5);
    expect(result.resolveJobTimeoutMs).toBe(30000);
    expect(result.resolveTotalTimeoutMs).toBe(600000);
  });

  it("ignores invalid values for the resolution-tuning flags instead of producing NaN/negative/zero", () => {
    for (const flag of ["--resolve-concurrency", "--resolve-job-timeout-ms", "--resolve-total-timeout-ms"]) {
      for (const bad of ["abc", "0", "-1", "2.5"]) {
        const result = parseDiscoverArgs([flag, bad]);
        expect(Object.values(result).every((v) => v === undefined || typeof v !== "number" || !Number.isNaN(v))).toBe(true);
      }
    }
    expect(parseDiscoverArgs(["--resolve-concurrency", "abc"]).resolveConcurrency).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { parseHuntArgs } from "../../src/hunt/cli.js";

describe("parseHuntArgs", () => {
  it("parses --profile as a comma-split list", () => {
    expect(parseHuntArgs(["--profile", "sdet,security"]).profileIds).toEqual(["sdet", "security"]);
  });

  it("parses --location", () => {
    expect(parseHuntArgs(["--location", "United States"]).location).toBe("United States");
  });

  it("parses bare boolean flags", () => {
    const result = parseHuntArgs([
      "--remote-only", "--exclude-onsite", "--include-unknown-location",
      "--new-only", "--include-seen", "--include-stale", "--dry-run",
    ]);
    expect(result.remoteOnly).toBe(true);
    expect(result.excludeOnsite).toBe(true);
    expect(result.includeUnknownLocation).toBe(true);
    expect(result.newOnly).toBe(true);
    expect(result.includeSeen).toBe(true);
    expect(result.includeStale).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it("parses --states as a comma-split list", () => {
    expect(parseHuntArgs(["--states", "CT,NY,NJ,MA"]).states).toEqual(["CT", "NY", "NJ", "MA"]);
  });

  it("parses a valid positive integer --days", () => {
    expect(parseHuntArgs(["--days", "7"]).days).toBe(7);
  });

  it("ignores an invalid --days value instead of producing NaN", () => {
    const result = parseHuntArgs(["--days", "abc"]);
    expect(result.days).toBeUndefined();
    expect(Number.isNaN(result.days)).toBe(false);
  });

  it("parses a valid positive integer --limit", () => {
    expect(parseHuntArgs(["--limit", "10"]).limit).toBe(10);
  });

  it("ignores an invalid --limit value", () => {
    expect(parseHuntArgs(["--limit", "0"]).limit).toBeUndefined();
    expect(parseHuntArgs(["--limit", "-3"]).limit).toBeUndefined();
  });

  it("defaults every flag to undefined when not passed", () => {
    const result = parseHuntArgs([]);
    expect(result.profileIds).toBeUndefined();
    expect(result.remoteOnly).toBeUndefined();
    expect(result.states).toBeUndefined();
    expect(result.days).toBeUndefined();
  });
});

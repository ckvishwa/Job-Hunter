import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/runner/cli.js";

describe("parseArgs", () => {
  it("parses a valid positive integer --limit", () => {
    expect(parseArgs(["--limit", "5"])).toEqual({ limit: 5 });
  });

  it("ignores --limit when given no value instead of producing NaN", () => {
    const result = parseArgs(["--limit"]);
    expect(result.limit).toBeUndefined();
    expect(Number.isNaN(result.limit)).toBe(false);
  });

  it("ignores --limit when given a non-numeric value instead of producing NaN", () => {
    const result = parseArgs(["--limit", "abc"]);
    expect(result.limit).toBeUndefined();
  });

  it("ignores --limit when given zero or a negative value", () => {
    expect(parseArgs(["--limit", "0"]).limit).toBeUndefined();
    expect(parseArgs(["--limit", "-3"]).limit).toBeUndefined();
  });

  it("ignores --limit when given a non-integer value", () => {
    expect(parseArgs(["--limit", "2.5"]).limit).toBeUndefined();
  });

  it("still parses --site and --profile as before", () => {
    const result = parseArgs(["--site", "acme,other", "--profile", "sdet"]);
    expect(result.siteIds).toEqual(["acme", "other"]);
    expect(result.profileIds).toEqual(["sdet"]);
  });
});

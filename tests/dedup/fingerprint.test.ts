import { describe, expect, it } from "vitest";
import { fingerprintDescription } from "../../src/dedup/fingerprint.js";

describe("fingerprintDescription", () => {
  it("is stable across whitespace and case differences", () => {
    const a = fingerprintDescription("We need a  Senior  SDET.\n\nApply now!");
    const b = fingerprintDescription("we need a senior sdet. apply now!");
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const a = fingerprintDescription("We need a Senior SDET.");
    const b = fingerprintDescription("We need a Senior Network Engineer.");
    expect(a).not.toBe(b);
  });
});

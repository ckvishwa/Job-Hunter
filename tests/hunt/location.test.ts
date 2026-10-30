import { describe, expect, it } from "vitest";
import { parseLocation } from "../../src/hunt/location.js";

describe("parseLocation", () => {
  it("parses 'City, ST' as a US city/state", () => {
    const result = parseLocation("Austin, TX");
    expect(result.city).toBe("Austin");
    expect(result.state).toBe("TX");
    expect(result.country).toBe("United States");
    expect(result.locationKnown).toBe(true);
    expect(result.workArrangement).toBe("unknown");
  });

  it("parses 'City, Country' as a non-US city/country", () => {
    const result = parseLocation("Berlin, Germany");
    expect(result.city).toBe("Berlin");
    expect(result.state).toBeNull();
    expect(result.country).toBe("Germany");
    expect(result.locationKnown).toBe(true);
  });

  it("detects hybrid tagged onto a real city", () => {
    const result = parseLocation("New York, NY (Hybrid)");
    expect(result.city).toBe("New York");
    expect(result.state).toBe("NY");
    expect(result.workArrangement).toBe("hybrid");
  });

  it("parses bare 'Remote' with no country as remote + unknown location", () => {
    const result = parseLocation("Remote");
    expect(result.workArrangement).toBe("remote");
    expect(result.city).toBeNull();
    expect(result.state).toBeNull();
    expect(result.country).toBeNull();
    expect(result.locationKnown).toBe(false);
  });

  it("parses 'Remote - US' as remote AND country United States (independent fields)", () => {
    const result = parseLocation("Remote - US");
    expect(result.workArrangement).toBe("remote");
    expect(result.country).toBe("United States");
    expect(result.city).toBeNull();
  });

  it("parses 'Remote, Germany' as remote arrangement with a known non-US country", () => {
    const result = parseLocation("Remote, Germany");
    expect(result.workArrangement).toBe("remote");
    expect(result.country).toBe("Germany");
  });

  it("treats empty/null location as fully unknown, never defaulting to Remote", () => {
    for (const raw of [null, ""]) {
      const result = parseLocation(raw);
      expect(result.locationKnown).toBe(false);
      expect(result.workArrangement).toBe("unknown");
      expect(result.city).toBeNull();
      expect(result.state).toBeNull();
      expect(result.country).toBeNull();
    }
  });

  it("detects onsite from an explicit tag", () => {
    const result = parseLocation("Chicago, IL (Onsite)");
    expect(result.workArrangement).toBe("onsite");
  });

  it("falls back to a strict remote phrase in the description when the location field has no arrangement tag", () => {
    const result = parseLocation("Austin, TX", "This is a fully remote position open to candidates nationwide.");
    expect(result.workArrangement).toBe("remote");
    // JD-derived remote signal must never overwrite an already-known real city/state.
    expect(result.city).toBe("Austin");
    expect(result.state).toBe("TX");
  });

  it("does not treat a benign JD mention of 'remote' as a work-arrangement signal", () => {
    const result = parseLocation("Austin, TX", "We occasionally offer remote work options for some senior roles.");
    expect(result.workArrangement).toBe("unknown");
  });

  it("never lets a remote work arrangement fabricate a country", () => {
    const result = parseLocation("Remote");
    expect(result.workArrangement).toBe("remote");
    expect(result.country).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  careerOpsOfferSchema,
  careerOpsScanResultSchema,
  validateOffers,
} from "../../../src/sources/careerops/careerops-schema.js";

const FIXTURE_PATH = new URL("../../fixtures/careerops/scan-ats-full.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

describe("careerOpsOfferSchema", () => {
  test("accepts a valid offer", () => {
    const result = careerOpsOfferSchema.safeParse(fixture.offers[0]);
    expect(result.success).toBe(true);
  });

  test("accepts an offer with location/postedAt/note explicitly null", () => {
    const offer = fixture.offers.find((o: { location: unknown }) => o.location === null);
    const result = careerOpsOfferSchema.safeParse(offer);
    expect(result.success).toBe(true);
  });

  test("rejects an offer missing company", () => {
    const offer = fixture.offers.find((o: { title: string }) => o.title === "malformed-missing-company");
    const result = careerOpsOfferSchema.safeParse(offer);
    expect(result.success).toBe(false);
  });

  test("rejects an offer missing title", () => {
    const { title, ...offerWithoutTitle } = fixture.offers[0];
    const result = careerOpsOfferSchema.safeParse(offerWithoutTitle);
    expect(result.success).toBe(false);
  });

  test("rejects an offer missing url", () => {
    const { url, ...offerWithoutUrl } = fixture.offers[0];
    const result = careerOpsOfferSchema.safeParse(offerWithoutUrl);
    expect(result.success).toBe(false);
  });

  test("rejects a syntactically invalid url", () => {
    const offer = fixture.offers.find((o: { title: string }) => o.title === "not-a-url-offer");
    const result = careerOpsOfferSchema.safeParse(offer);
    expect(result.success).toBe(false);
  });

  test("rejects a javascript: url", () => {
    const offer = fixture.offers.find((o: { title: string }) => o.title === "javascript-url-offer");
    const result = careerOpsOfferSchema.safeParse(offer);
    expect(result.success).toBe(false);
  });

  test("has no description field on a valid offer (CareerOps' --json contract never supplies one)", () => {
    const parsed = careerOpsOfferSchema.parse(fixture.offers[0]);
    expect(parsed).not.toHaveProperty("description");
  });
});

describe("careerOpsScanResultSchema", () => {
  test("accepts the full fixture top-level object", () => {
    const result = careerOpsScanResultSchema.safeParse(fixture);
    expect(result.success).toBe(true);
  });

  test("is a single top-level object, not JSONL -- offers is a nested array field", () => {
    const parsed = careerOpsScanResultSchema.parse(fixture);
    expect(Array.isArray(parsed.offers)).toBe(true);
    expect(typeof parsed.date).toBe("string");
  });
});

describe("validateOffers", () => {
  test("keeps every structurally-valid offer and counts/reports the rest, without throwing", () => {
    const { valid, invalid } = validateOffers(fixture.offers);

    // Fixture has 13 offers; exactly 3 are invalid (missing url, invalid url, javascript: url,
    // missing company) -- wait, recount: not-a-url-offer, javascript-url-offer,
    // malformed-missing-company = 3 invalid, 10 valid.
    expect(valid.length + invalid.length).toBe(fixture.offers.length);
    expect(invalid.length).toBeGreaterThan(0);
    expect(valid.length).toBeGreaterThan(0);
  });

  test("one malformed record does not prevent the surrounding valid records from being returned", () => {
    const { valid } = validateOffers(fixture.offers);
    const validTitles = valid.map((o) => o.title);
    expect(validTitles).toContain("Cybersecurity Engineer");
    expect(validTitles).toContain("Corporate Security Guard");
    expect(validTitles).not.toContain("malformed-missing-company");
  });

  test("invalid entries report their index and a message", () => {
    const { invalid } = validateOffers(fixture.offers);
    for (const entry of invalid) {
      expect(typeof entry.index).toBe("number");
      expect(typeof entry.message).toBe("string");
      expect(entry.message.length).toBeGreaterThan(0);
    }
  });
});

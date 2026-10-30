import { describe, expect, it } from "vitest";
import { resolveDiscoveryAdapter } from "../../src/discovery/registry.js";

describe("resolveDiscoveryAdapter", () => {
  it.each([
    ["google-jobs", "google-jobs"],
    ["indeed", "indeed"],
    ["monster", "monster"],
    ["linkedin-public", "linkedin-public"],
    ["configurable-generic-portal", "configurable-generic-portal"],
    ["company-careers", "company-careers"],
  ])("resolves %s to the matching adapter", (sourceName, expectedSource) => {
    expect(resolveDiscoveryAdapter(sourceName).source).toBe(expectedSource);
  });

  it("matches case-insensitively", () => {
    expect(resolveDiscoveryAdapter("INDEED").source).toBe("indeed");
  });

  it("falls back to configurableGenericPortalAdapter for an unrecognized id", () => {
    expect(resolveDiscoveryAdapter("some-random-portal-id").source).toBe(
      "configurable-generic-portal",
    );
  });
});

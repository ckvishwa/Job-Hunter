import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadPortalsConfig } from "../../src/config/loader.js";

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-test-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

describe("loadPortalsConfig", () => {
  it("parses a minimal valid portals.yml and applies documented defaults", () => {
    const filePath = tempFile(
      "portals.yml",
      `
portals:
  - id: indeed
    type: indeed
    enabled: false
    baseUrl: "https://www.indeed.com/jobs"
    resultCardSelector: ".job_seen_beacon"
    titleSelector: "span[id^='jobTitle']"
    locationSelector: "[data-testid='text-location']"
`,
    );

    const portals = loadPortalsConfig(filePath);
    expect(portals).toEqual([
      {
        id: "indeed",
        type: "indeed",
        enabled: false,
        baseUrl: "https://www.indeed.com/jobs",
        resultCardSelector: ".job_seen_beacon",
        titleSelector: "span[id^='jobTitle']",
        locationSelector: "[data-testid='text-location']",
        maxPages: 10,
        maxDiscoveries: 500,
        navigationTimeoutMs: 30000,
        delayBetweenActionsMs: 1000,
        requiresLogin: false,
        onVerification: "pause",
      },
    ]);
  });

  it("throws on an invalid type enum value", () => {
    const filePath = tempFile(
      "portals.yml",
      `
portals:
  - id: bogus
    type: not-a-real-portal-type
    enabled: false
    baseUrl: "https://example.com/jobs"
    resultCardSelector: ".card"
    titleSelector: ".title"
    locationSelector: ".location"
`,
    );

    expect(() => loadPortalsConfig(filePath)).toThrow(ConfigValidationError);
  });

  it("throws when a required selector field is missing", () => {
    const filePath = tempFile(
      "portals.yml",
      `
portals:
  - id: indeed
    type: indeed
    enabled: false
    baseUrl: "https://www.indeed.com/jobs"
    titleSelector: "span[id^='jobTitle']"
    locationSelector: "[data-testid='text-location']"
`,
    );

    // resultCardSelector is required and omitted above.
    expect(() => loadPortalsConfig(filePath)).toThrow(ConfigValidationError);
  });

  it("throws when maxPages is zero", () => {
    const filePath = tempFile(
      "portals.yml",
      `
portals:
  - id: indeed
    type: indeed
    enabled: false
    baseUrl: "https://www.indeed.com/jobs"
    resultCardSelector: ".job_seen_beacon"
    titleSelector: "span[id^='jobTitle']"
    locationSelector: "[data-testid='text-location']"
    maxPages: 0
`,
    );

    expect(() => loadPortalsConfig(filePath)).toThrow(ConfigValidationError);
  });

  it("throws when maxDiscoveries is negative", () => {
    const filePath = tempFile(
      "portals.yml",
      `
portals:
  - id: indeed
    type: indeed
    enabled: false
    baseUrl: "https://www.indeed.com/jobs"
    resultCardSelector: ".job_seen_beacon"
    titleSelector: "span[id^='jobTitle']"
    locationSelector: "[data-testid='text-location']"
    maxDiscoveries: -5
`,
    );

    expect(() => loadPortalsConfig(filePath)).toThrow(ConfigValidationError);
  });
});

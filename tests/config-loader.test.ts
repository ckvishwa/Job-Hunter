import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, loadCollectSettings, loadRolesConfig, loadSitesConfig } from "../src/config/loader.js";

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-test-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

describe("loadSitesConfig", () => {
  it("parses a valid sites.yml", () => {
    const filePath = tempFile(
      "sites.yml",
      `
sites:
  - id: acme
    name: Acme Corp
    url: "https://acme.com/careers"
    adapter: greenhouse
    enabled: true
`,
    );

    const sites = loadSitesConfig(filePath);
    expect(sites).toEqual([
      {
        id: "acme",
        name: "Acme Corp",
        url: "https://acme.com/careers",
        adapter: "greenhouse",
        enabled: true,
      },
    ]);
  });

  it("throws when a required field is missing", () => {
    const filePath = tempFile(
      "sites.yml",
      `
sites:
  - id: acme
    name: Acme Corp
    adapter: greenhouse
    enabled: true
`,
    );

    expect(() => loadSitesConfig(filePath)).toThrow(ConfigValidationError);
  });

  it("throws on an invalid adapter enum value", () => {
    const filePath = tempFile(
      "sites.yml",
      `
sites:
  - id: acme
    name: Acme Corp
    url: "https://acme.com/careers"
    adapter: not-a-real-adapter
    enabled: true
`,
    );

    expect(() => loadSitesConfig(filePath)).toThrow(ConfigValidationError);
  });

  it("throws on a malformed url", () => {
    const filePath = tempFile(
      "sites.yml",
      `
sites:
  - id: acme
    name: Acme Corp
    url: "not-a-url"
    adapter: greenhouse
    enabled: true
`,
    );

    expect(() => loadSitesConfig(filePath)).toThrow(ConfigValidationError);
  });
});

describe("loadRolesConfig", () => {
  it("parses a valid roles.yml", () => {
    const filePath = tempFile(
      "roles.yml",
      `
roles:
  - id: sdet-qa
    profile: sdet
    keywords:
      - SDET
      - QA Automation Engineer
`,
    );

    const roles = loadRolesConfig(filePath);
    expect(roles).toEqual([
      {
        id: "sdet-qa",
        profile: "sdet",
        keywords: ["SDET", "QA Automation Engineer"],
      },
    ]);
  });

  it("throws on an invalid profile enum value", () => {
    const filePath = tempFile(
      "roles.yml",
      `
roles:
  - id: sdet-qa
    profile: not-a-real-profile
    keywords:
      - SDET
`,
    );

    expect(() => loadRolesConfig(filePath)).toThrow(ConfigValidationError);
  });

  it("throws when keywords is empty", () => {
    const filePath = tempFile(
      "roles.yml",
      `
roles:
  - id: sdet-qa
    profile: sdet
    keywords: []
`,
    );

    expect(() => loadRolesConfig(filePath)).toThrow(ConfigValidationError);
  });
});

describe("loadCollectSettings", () => {
  it("applies defaults when settings block is omitted", () => {
    const filePath = tempFile(
      "sites.yml",
      `
sites:
  - id: acme
    name: Acme Corp
    url: "https://acme.com/careers"
    adapter: greenhouse
    enabled: true
`,
    );

    expect(loadCollectSettings(filePath)).toEqual({
      maxPagesPerSource: 100,
      maxJobsPerSource: 5000,
      navigationTimeoutMs: 30000,
      delayBetweenRequestsMs: 500,
    });
  });

  it("respects an explicit settings block", () => {
    const filePath = tempFile(
      "sites.yml",
      `
settings:
  maxPagesPerSource: 5
  maxJobsPerSource: 10
  navigationTimeoutMs: 1000
  delayBetweenRequestsMs: 0
sites:
  - id: acme
    name: Acme Corp
    url: "https://acme.com/careers"
    adapter: greenhouse
    enabled: true
`,
    );

    expect(loadCollectSettings(filePath)).toEqual({
      maxPagesPerSource: 5,
      maxJobsPerSource: 10,
      navigationTimeoutMs: 1000,
      delayBetweenRequestsMs: 0,
    });
  });
});

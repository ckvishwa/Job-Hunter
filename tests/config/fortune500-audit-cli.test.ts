import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFortune500Audit } from "../../src/config/fortune500-audit-cli.js";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    company: "Acme",
    fortuneRank: 1,
    corporateDomain: "acme.com",
    careersUrl: "https://acme.com/careers",
    atsType: "greenhouse",
    atsTenantOrBoardId: "acme",
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    enabled: true,
    verificationStatus: "verified",
    verificationNote: null,
    sourceProvenance: ["test-fixture"],
    lastVerifiedAt: "2026-07-27",
    ...overrides,
  };
}

function validRegistry(): unknown[] {
  const entries: unknown[] = [entry()];
  for (let rank = 2; rank <= 500; rank++) {
    entries.push(
      entry({
        company: `Company${rank}`,
        fortuneRank: rank,
        corporateDomain: `company${rank}.com`,
        careersUrl: null,
        atsType: "unknown",
        atsTenantOrBoardId: null,
        verificationStatus: "pending",
        verificationNote: "ATS not yet verified",
      }),
    );
  }
  return entries;
}

let dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "fortune500-audit-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("runFortune500Audit", () => {
  it("writes both JSON and CSV output files", () => {
    const dir = tmpDir();
    const registryPath = path.join(dir, "registry.json");
    writeFileSync(registryPath, JSON.stringify(validRegistry()), "utf-8");
    const jsonOut = path.join(dir, "out", "audit.json");
    const csvOut = path.join(dir, "out", "audit.csv");

    const result = runFortune500Audit(registryPath, jsonOut, csvOut);

    expect(result.ok).toBe(true);
    const json = JSON.parse(readFileSync(jsonOut, "utf-8"));
    expect(json.totalEntries).toBe(500);
    const csv = readFileSync(csvOut, "utf-8");
    expect(csv).toContain("totalEntries,500");
    expect(csv.split("\n")[0]).toBe("metric,value");
  });

  it("produces deterministic output across repeated runs on the same input", () => {
    const dir = tmpDir();
    const registryPath = path.join(dir, "registry.json");
    writeFileSync(registryPath, JSON.stringify(validRegistry()), "utf-8");
    const jsonOut = path.join(dir, "audit.json");
    const csvOut = path.join(dir, "audit.csv");

    runFortune500Audit(registryPath, jsonOut, csvOut);
    const firstJson = readFileSync(jsonOut, "utf-8");
    const firstCsv = readFileSync(csvOut, "utf-8");

    runFortune500Audit(registryPath, jsonOut, csvOut);
    const secondJson = readFileSync(jsonOut, "utf-8");
    const secondCsv = readFileSync(csvOut, "utf-8");

    expect(secondJson).toBe(firstJson);
    expect(secondCsv).toBe(firstCsv);
  });

  it("never modifies or truncates the registry file, even when validation fails", () => {
    const dir = tmpDir();
    const registryPath = path.join(dir, "registry.json");
    const invalidRegistry = validRegistry();
    invalidRegistry.splice(5, 3); // introduce missing ranks -> guaranteed audit failure
    const originalContent = JSON.stringify(invalidRegistry);
    writeFileSync(registryPath, originalContent, "utf-8");
    const beforeMtime = statSync(registryPath).mtimeMs;
    const beforeSize = statSync(registryPath).size;

    const jsonOut = path.join(dir, "out", "audit.json");
    const csvOut = path.join(dir, "out", "audit.csv");
    const result = runFortune500Audit(registryPath, jsonOut, csvOut);

    expect(result.ok).toBe(false);
    expect(readFileSync(registryPath, "utf-8")).toBe(originalContent);
    expect(statSync(registryPath).mtimeMs).toBe(beforeMtime);
    expect(statSync(registryPath).size).toBe(beforeSize);
  });

  it("still writes output files (describing the failure) when the registry is invalid", () => {
    const dir = tmpDir();
    const registryPath = path.join(dir, "registry.json");
    const invalidRegistry = validRegistry().slice(0, 400); // wrong total
    writeFileSync(registryPath, JSON.stringify(invalidRegistry), "utf-8");
    const jsonOut = path.join(dir, "audit.json");
    const csvOut = path.join(dir, "audit.csv");

    const result = runFortune500Audit(registryPath, jsonOut, csvOut);

    expect(result.ok).toBe(false);
    const json = JSON.parse(readFileSync(jsonOut, "utf-8"));
    expect(json.ok).toBe(false);
    expect(json.totalEntries).toBe(400);
  });
});

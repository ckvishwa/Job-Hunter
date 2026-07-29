import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { auditFortune500Registry, type Fortune500AuditResult } from "./fortune500-audit.js";

function toCsv(result: Fortune500AuditResult): string {
  const rows: [string, string | number][] = [
    ["totalEntries", result.totalEntries],
    ["missingRanks", result.missingRanks.length],
    ["duplicateRanks", result.duplicateRanks.length],
    ["duplicateCompanies", result.duplicateCompanies.length],
    ["careerUrlsPresent", result.careerUrlsPresent],
    ["careerUrlsMissing", result.careerUrlsMissing],
    ["atsIdentified", result.atsIdentified],
    ["atsUnknown", result.atsUnknown],
    ["greenhouseCount", result.atsCounts.greenhouse],
    ["leverCount", result.atsCounts.lever],
    ["ashbyCount", result.atsCounts.ashby],
    ["workdayCount", result.atsCounts.workday],
    ["icimsCount", result.atsCounts.icims],
    ["genericCount", result.atsCounts.generic],
    ["verifiedCount", result.verificationStatusCounts.verified],
    ["pendingCount", result.verificationStatusCounts.pending],
    ["unreachableCount", result.verificationStatusCounts.unreachable],
    ["verificationRequiredCount", result.verificationStatusCounts["verification-required"]],
    ["unsupportedCount", result.verificationStatusCounts.unsupported],
    ["schemaErrors", result.schemaErrors.length],
    ["unsafeUrlCount", result.unsafeUrlCount],
    ["ok", String(result.ok)],
  ];
  const header = "metric,value";
  const lines = rows.map(([metric, value]) => `${metric},${value}`);
  return [header, ...lines].join("\n") + "\n";
}

// Never writes to registryPath -- reads it once, writes only to jsonOutPath/csvOutPath. A
// failed audit produces the same output files as a passing one (the reports themselves, not
// the registry, describe the failure); the registry file is never opened for writing here.
export function runFortune500Audit(
  registryPath: string,
  jsonOutPath: string,
  csvOutPath: string,
): Fortune500AuditResult {
  const raw = JSON.parse(readFileSync(registryPath, "utf-8"));
  if (!Array.isArray(raw)) {
    throw new Error(`${registryPath} does not contain a JSON array`);
  }

  const result = auditFortune500Registry(raw);

  mkdirSync(dirname(jsonOutPath), { recursive: true });
  writeFileSync(jsonOutPath, JSON.stringify(result, null, 2) + "\n", "utf-8");
  writeFileSync(csvOutPath, toCsv(result), "utf-8");

  return result;
}

function printSummary(result: Fortune500AuditResult): void {
  console.log("\n=== Fortune 500 Registry Audit ===");
  console.log(`Total entries: ${result.totalEntries}`);
  console.log(`Missing ranks: ${result.missingRanks.length}`);
  console.log(`Duplicate ranks: ${result.duplicateRanks.length}`);
  console.log(`Duplicate companies: ${result.duplicateCompanies.length}`);
  console.log(`Career URLs present: ${result.careerUrlsPresent}`);
  console.log(`Career URLs missing: ${result.careerUrlsMissing}`);
  console.log(`ATS identified: ${result.atsIdentified}`);
  console.log(`ATS unknown: ${result.atsUnknown}`);
  console.log(
    `  greenhouse=${result.atsCounts.greenhouse} lever=${result.atsCounts.lever} ashby=${result.atsCounts.ashby} ` +
      `workday=${result.atsCounts.workday} icims=${result.atsCounts.icims} generic=${result.atsCounts.generic}`,
  );
  console.log(
    `Verification: verified=${result.verificationStatusCounts.verified} pending=${result.verificationStatusCounts.pending} ` +
      `unreachable=${result.verificationStatusCounts.unreachable} verification-required=${result.verificationStatusCounts["verification-required"]} ` +
      `unsupported=${result.verificationStatusCounts.unsupported}`,
  );
  console.log(`Unsafe URLs: ${result.unsafeUrlCount}`);
  console.log(`Schema errors: ${result.schemaErrors.length}`);
  if (result.schemaErrors.length > 0) {
    for (const issue of result.schemaErrors.slice(0, 20)) {
      console.log(`  - rank ${issue.fortuneRank ?? "?"} (${issue.company ?? "?"}) ${issue.path}: ${issue.message}`);
    }
    if (result.schemaErrors.length > 20) console.log(`  ... and ${result.schemaErrors.length - 20} more`);
  }
  console.log(result.ok ? "RESULT: OK" : `RESULT: FAILED -- ${result.failReasons.join("; ")}`);
  console.log("===================================\n");
}

function main(): void {
  const result = runFortune500Audit(
    "config/fortune500-registry.json",
    "output/fortune500-registry-audit.json",
    "output/fortune500-registry-audit.csv",
  );
  printSummary(result);
  process.exitCode = result.ok ? 0 : 1;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main();
}

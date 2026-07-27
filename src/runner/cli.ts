import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCollect, type CollectFilters, type CollectSummary } from "./source-runner.js";

export function parseArgs(argv: string[]): CollectFilters {
  const result: CollectFilters = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--site") {
      const value = argv[++i] ?? "";
      result.siteIds = (result.siteIds ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--profile") {
      const value = argv[++i] ?? "";
      result.profileIds = (result.profileIds ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--limit") {
      const value = argv[++i];
      const parsed = Number(value);
      // Number(undefined) and Number("abc") both produce NaN, which passes a naive
      // `typeof === "number"` guard downstream and silently caps results at 0 (see
      // Array.prototype.slice(0, NaN) === []). Require a genuine positive integer;
      // otherwise ignore the flag entirely rather than risk silent data loss.
      if (Number.isInteger(parsed) && parsed > 0) {
        result.limit = parsed;
      } else {
        console.error(
          `Ignoring invalid --limit value "${value ?? ""}" - must be a positive integer. Running without a limit.`,
        );
      }
    }
  }
  return result;
}

function printSummary(summary: CollectSummary): void {
  console.log("\n=== Collection summary ===");
  console.log(`Sites attempted: ${summary.sitesAttempted}`);
  console.log(`Sites succeeded: ${summary.sitesSucceeded}`);
  console.log(`Sites failed: ${summary.sitesFailed}`);
  console.log(`Listings discovered: ${summary.listingsDiscovered}`);
  console.log(`Full JDs extracted: ${summary.jdsExtracted}`);
  console.log(`Duplicates removed: ${summary.duplicatesRemoved}`);
  console.log(`Verification pauses: ${summary.verificationPauses}`);
  console.log(`Jobs written: ${summary.jobsWritten}`);
  console.log("Totals by matched profile:");
  for (const [profile, count] of Object.entries(summary.totalsByProfile)) {
    console.log(`  ${profile}: ${count}`);
  }
  if (summary.errors.length) {
    console.log("Errors:");
    for (const err of summary.errors) {
      console.log(`  ${err.site}: ${err.message}`);
    }
  }
  console.log("===========================\n");
}

async function main(): Promise<void> {
  const filters = parseArgs(process.argv.slice(2));
  const summary = await runCollect(
    {
      sitesConfigPath: path.resolve("config/sites.yml"),
      rolesConfigPath: path.resolve("config/roles.yml"),
      jobsStorePath: path.resolve("data/jobs.jsonl"),
    },
    filters,
  );
  printSummary(summary);
}

// Only run when this file is executed directly (`npm run collect` / `tsx src/runner/cli.ts`),
// never as a side effect of another module importing it (e.g. tests importing parseArgs) --
// otherwise every test import would trigger a real collect run against real config/data paths.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

import path from "node:path";
import { runCollect, type CollectFilters, type CollectSummary } from "./source-runner.js";

function parseArgs(argv: string[]): CollectFilters {
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
      result.limit = Number(value);
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import path from "node:path";
import { pathToFileURL } from "node:url";
import { runDiscover, type DiscoverFilters, type DiscoverSummary } from "./orchestrator.js";

export function parseDiscoverArgs(argv: string[]): DiscoverFilters {
  const result: DiscoverFilters = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[++i] ?? "";
      result.profileIds = (result.profileIds ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--source") {
      const value = argv[++i] ?? "";
      result.sources = (result.sources ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--location") {
      result.location = argv[++i];
    } else if (arg === "--company") {
      result.company = argv[++i];
    } else if (arg === "--resume") {
      // Checkpoints are always consulted/retried every run already -- this flag is accepted
      // as an explicit-intent marker but doesn't change behavior (see DiscoverFilters).
      result.resume = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--reset-checkpoint") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        result.resetCheckpoint = next;
        i += 1;
      } else {
        result.resetCheckpoint = true;
      }
    } else if (arg === "--limit") {
      const value = argv[++i];
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.limit = parsed;
      } else {
        console.error(
          `Ignoring invalid --limit value "${value ?? ""}" - must be a positive integer.`,
        );
      }
    }
  }
  return result;
}

function printDiscoverSummary(summary: DiscoverSummary): void {
  console.log("\n=== Discovery & Orchestration Summary ===");
  console.log(`Sources attempted: ${summary.sourcesAttempted}`);
  console.log(`Sources succeeded: ${summary.sourcesSucceeded}`);
  console.log(`Sources failed: ${summary.sourcesFailed}`);
  console.log(`Listings discovered: ${summary.listingsDiscovered}`);
  console.log(`Full JDs extracted/resolved: ${summary.jdsExtracted}`);
  console.log(`Duplicates removed: ${summary.duplicatesRemoved}`);
  console.log(`Jobs written to jobs.jsonl: ${summary.jobsWritten}`);
  console.log("Totals by matched profile:");
  for (const [profile, count] of Object.entries(summary.totalsByProfile)) {
    console.log(`  ${profile}: ${count}`);
  }
  if (summary.errors.length) {
    console.log("Errors:");
    for (const err of summary.errors) {
      console.log(`  ${err.source}: ${err.message}`);
    }
  }
  console.log("=========================================\n");
}

async function main(): Promise<void> {
  const filters = parseDiscoverArgs(process.argv.slice(2));
  const summary = await runDiscover(
    {
      sitesConfigPath: path.resolve("config/sites.yml"),
      rolesConfigPath: path.resolve("config/roles.yml"),
      portalsConfigPath: path.resolve("config/portals.yml"),
      discoveredJobsPath: path.resolve("data/discovered-jobs.jsonl"),
      jobsStorePath: path.resolve("data/jobs.jsonl"),
      checkpointsPath: path.resolve("data/checkpoints.json"),
    },
    filters,
  );
  printDiscoverSummary(summary);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

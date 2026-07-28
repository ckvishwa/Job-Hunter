import path from "node:path";
import { pathToFileURL } from "node:url";
import { runDiscover, type DiscoverFilters } from "./orchestrator.js";
import type { DiscoveryRunSummary } from "./report.js";

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
    } else if (arg === "--registry") {
      result.registryPath = argv[++i];
    } else if (arg === "--isolated-profile") {
      result.isolatedProfile = true;
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
    } else if (arg === "--resolve-concurrency") {
      const value = argv[++i];
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.resolveConcurrency = parsed;
      } else {
        console.error(`Ignoring invalid --resolve-concurrency value "${value ?? ""}" - must be a positive integer.`);
      }
    } else if (arg === "--resolve-job-timeout-ms") {
      const value = argv[++i];
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.resolveJobTimeoutMs = parsed;
      } else {
        console.error(`Ignoring invalid --resolve-job-timeout-ms value "${value ?? ""}" - must be a positive integer.`);
      }
    } else if (arg === "--resolve-total-timeout-ms") {
      const value = argv[++i];
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.resolveTotalTimeoutMs = parsed;
      } else {
        console.error(`Ignoring invalid --resolve-total-timeout-ms value "${value ?? ""}" - must be a positive integer.`);
      }
    }
  }
  return result;
}

function printDiscoverSummary(summary: DiscoveryRunSummary): void {
  console.log("\n=== Discovery & Orchestration Summary ===");
  console.log(`Sources attempted: ${summary.sourcesAttempted}`);
  console.log(`Sources succeeded: ${summary.sourcesSucceeded}`);
  console.log(`Sources failed: ${summary.sourcesFailed}`);
  console.log(`Companies attempted: ${summary.companiesAttempted}`);
  console.log(`Keywords searched: ${summary.keywordsSearched}`);
  console.log(`Pages processed: ${summary.pagesProcessed}`);
  console.log(`Listings discovered: ${summary.listingsDiscovered}`);
  console.log(`Listings evaluated: ${summary.listingsEvaluated}`);
  console.log(`Irrelevant listings rejected: ${summary.discoveriesRejected}`);
  console.log(`Relevant listings retained: ${summary.relevantRetained}`);
  console.log("Retained by profile:");
  for (const [profile, count] of Object.entries(summary.retainedByProfile)) {
    console.log(`  ${profile}: ${count}`);
  }
  console.log(`Resolutions attempted: ${summary.resolutionsAttempted}`);
  console.log(`Resolutions succeeded: ${summary.resolutionsSucceeded}`);
  console.log(`Resolutions timed out: ${summary.resolutionsTimedOut}`);
  console.log(`Unresolved: ${summary.unresolvedDiscoveries}`);
  console.log(`Duplicates merged: ${summary.duplicatesMerged}`);
  console.log(`Full JDs extracted/resolved: ${summary.jdsExtracted}`);
  console.log(`Verification pauses: ${summary.verificationPauses}`);
  console.log(`Jobs written to jobs.jsonl: ${summary.jobsWritten}`);
  console.log(`Total discovery time: ${summary.discoveryTimeMs}ms`);
  console.log(`Total resolution time: ${summary.resolutionTimeMs}ms`);
  console.log("Jobs by matched profile:");
  for (const [profile, count] of Object.entries(summary.jobsByProfile)) {
    console.log(`  ${profile}: ${count}`);
  }
  console.log("Jobs by source:");
  for (const [source, count] of Object.entries(summary.jobsBySource)) {
    console.log(`  ${source}: ${count}`);
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

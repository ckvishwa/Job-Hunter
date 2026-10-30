import path from "node:path";
import { pathToFileURL } from "node:url";
import { runHunt, type HuntFilters } from "./run-hunt.js";
import type { HuntSummary } from "./run-hunt.js";

export function parseHuntArgs(argv: string[]): HuntFilters {
  const result: HuntFilters = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[++i] ?? "";
      result.profileIds = (result.profileIds ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--location") {
      result.location = argv[++i];
    } else if (arg === "--remote-only") {
      result.remoteOnly = true;
    } else if (arg === "--exclude-onsite") {
      result.excludeOnsite = true;
    } else if (arg === "--states") {
      const value = argv[++i] ?? "";
      result.states = (result.states ?? []).concat(value.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (arg === "--include-unknown-location") {
      result.includeUnknownLocation = true;
    } else if (arg === "--new-only") {
      result.newOnly = true;
    } else if (arg === "--days") {
      const value = argv[++i];
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.days = parsed;
      } else {
        console.error(`Ignoring invalid --days value "${value ?? ""}" - must be a positive integer.`);
      }
    } else if (arg === "--include-seen") {
      result.includeSeen = true;
    } else if (arg === "--include-stale") {
      result.includeStale = true;
    } else if (arg === "--limit") {
      const value = argv[++i];
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed > 0) {
        result.limit = parsed;
      } else {
        console.error(`Ignoring invalid --limit value "${value ?? ""}" - must be a positive integer.`);
      }
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--source") {
      const value = argv[++i];
      if (value === "native" || value === "careerops") {
        result.source = value;
      } else {
        console.error(`Ignoring invalid --source value "${value ?? ""}" - must be "native" or "careerops".`);
      }
    } else if (arg === "--careerops-home") {
      result.careerOpsHome = argv[++i];
    }
  }
  return result;
}

function printHuntSummary(summary: HuntSummary): void {
  console.log("\n=== Daily Job Hunt Summary ===");
  console.log(`Total discovered (in jobs.jsonl for this profile filter): ${summary.totalDiscovered}`);
  console.log(`Senior/staff/etc roles rejected: ${summary.ineligibleSeniority}`);
  console.log(`Location mismatches rejected: ${summary.locationMismatch}`);
  console.log(`Eligible retained: ${summary.eligibleRetained}`);
  console.log(`New since previous hunt: ${summary.newJobs}`);
  console.log(`Resolution time (this discovery run): ${summary.resolutionTimeMs}ms`);
  console.log(`Reports: ${summary.reportPaths.json}, ${summary.reportPaths.csv}, ${summary.reportPaths.html}`);
  console.log("\nTop opportunities:");
  for (const row of summary.top10) {
    console.log(
      `  #${row.rank} [${row.score}] ${row.title} @ ${row.company} (${row.location}) - ${row.seniority}, ` +
        `${row.workArrangement} - ${row.applyUrl}`,
    );
  }
  console.log("===============================\n");
}

async function main(): Promise<void> {
  const filters = parseHuntArgs(process.argv.slice(2));
  const summary = await runHunt(
    {
      sitesConfigPath: path.resolve("config/sites.yml"),
      rolesConfigPath: path.resolve("config/roles.yml"),
      portalsConfigPath: path.resolve("config/portals.yml"),
      discoveredJobsPath: path.resolve("data/discovered-jobs.jsonl"),
      jobsStorePath: path.resolve("data/jobs.jsonl"),
      checkpointsPath: path.resolve("data/checkpoints.json"),
      huntStatePath: path.resolve("data/hunt-state.json"),
      outputDir: path.resolve("output"),
    },
    filters,
  );
  printHuntSummary(summary);
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

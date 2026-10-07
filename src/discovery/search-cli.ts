import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadSearchInput, resolveSearchTarget } from "../config/search-input.js";
import { JobStoreError } from "../storage/job-store.js";
import { runSearchDiscovery, type SearchRunSummary } from "./browser-search.js";

// npm run search -- --input config/job-search-inputs.example.json [--company Stripe]
//   [--max-jobs 1] [--typing-delay-ms 90] [--hold-ms 1500] [--data-dir data] [--evidence-dir <dir>]
//
// Opens a VISIBLE Chrome, types each query into the company's real search field, runs the search,
// opens real results and saves the posting extracted from the rendered DOM. Exit code: 0 = at least
// one job saved, or searches ran and the site genuinely had no matches; 1 = typed failure; 2 = usage,
// input or storage error.

export interface SearchCliArgs {
  input?: string;
  company?: string;
  maxJobs?: number;
  typingDelayMs: number;
  holdMs: number;
  dataDir: string;
  evidenceDir?: string;
}

function positiveInt(value: string | undefined, name: string, allowZero = false): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0)) return parsed;
  console.error(`Ignoring invalid ${name} value "${value ?? ""}" - must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  return undefined;
}

export function parseSearchArgs(argv: string[]): SearchCliArgs {
  const result: SearchCliArgs = { typingDelayMs: 90, holdMs: 1500, dataDir: "data" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") result.input = argv[++i];
    else if (arg === "--company") result.company = argv[++i];
    else if (arg === "--data-dir") result.dataDir = argv[++i] ?? result.dataDir;
    else if (arg === "--evidence-dir") result.evidenceDir = argv[++i];
    else if (arg === "--max-jobs") result.maxJobs = positiveInt(argv[++i], "--max-jobs");
    else if (arg === "--typing-delay-ms") result.typingDelayMs = positiveInt(argv[++i], "--typing-delay-ms", true) ?? result.typingDelayMs;
    else if (arg === "--hold-ms") result.holdMs = positiveInt(argv[++i], "--hold-ms", true) ?? result.holdMs;
  }
  return result;
}

export function printSearchSummary(summary: SearchRunSummary, log: (line: string) => void = console.log): void {
  log("\n=== Search discovery summary ===");
  log(`Company: ${summary.company}   Page: ${summary.careersUrl}`);
  for (const q of summary.queries) {
    log(`Query "${q.query}": ${q.status}${q.status === "results" ? ` (${q.resultCount} result(s))` : ""}${q.typedValue !== null ? `   typed value in field: "${q.typedValue}"` : ""}`);
  }
  for (const job of summary.jobs) {
    log(`\n[${job.status.toUpperCase()}] ${job.title ?? "(no title)"}`);
    log(`  Employer: ${job.employer}${job.employerSeenOnPage ? " (name seen on the posting page)" : " (from registry; name not found in page text)"}`);
    log(`  Location: ${job.location ?? "(not shown on the page)"}`);
    log(`  URL:      ${job.url}`);
    log(`  JD:       ${job.jdChars} characters from the rendered page (extractionMethod: ${job.extractionMethod})`);
    if (job.atsIdentity) log(`  Identity: ${job.atsIdentity}   job id ${job.jobId}`);
    if (job.failure) log(`  Rejected: ${job.failure.category}/${job.failure.code} - ${job.failure.detail}`);
  }
  log(`\nOutcome: ${summary.outcome}   saved this run: ${summary.persistedCount}   failures: ${summary.failures.length}`);
  log(`Store: ${summary.jobsPath}`);
  if (summary.failures.length > 0) log(`Failure log: ${summary.failuresPath}`);
  log(`Browser closed: ${summary.browserClosed}`);
  log("================================\n");
}

export async function runSearchCli(args: SearchCliArgs): Promise<number> {
  if (!args.input) {
    console.error("usage: search --input <file.json> [--company <name>] [--max-jobs n] [--typing-delay-ms n] [--hold-ms n] [--data-dir dir] [--evidence-dir dir]");
    return 2;
  }
  let exit = 0;
  try {
    const input = loadSearchInput(path.resolve(args.input));
    const targets = input.searches.filter((s) => !args.company || s.company.toLowerCase() === args.company.toLowerCase());
    if (targets.length === 0) {
      console.error(`No search target named "${args.company}" in ${args.input}.`);
      return 2;
    }
    // Validate every target (company in registry, careers host belongs to it) before opening any browser.
    const resolved = targets.map((t) => resolveSearchTarget(t));
    for (const r of resolved) {
      const summary = await runSearchDiscovery(r, {
        dataDir: path.resolve(args.dataDir),
        typingDelayMs: args.typingDelayMs,
        holdMs: args.holdMs,
        settleTimeoutMs: 15_000,
        navigationTimeoutMs: 30_000,
        evidenceDir: args.evidenceDir ? path.resolve(args.evidenceDir) : undefined,
        maxJobs: args.maxJobs,
      });
      printSearchSummary(summary);
      if (summary.outcome === "FAILED") exit = 1;
    }
  } catch (err) {
    if (err instanceof JobStoreError) console.error(`${err.message} ${JSON.stringify(err.diagnostics)}`);
    else console.error(err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
    return 2;
  }
  return exit;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runSearchCli(parseSearchArgs(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}

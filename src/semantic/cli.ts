import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadJobs } from "../storage/jsonl-store.js";
import { FixtureJobSemanticProvider } from "./provider.js";
import { parseCanonicalJob } from "./parse-job.js";

// npm run parse-jd -- --data-dir <dir> --job <job id | atsIdentity> --fixtures <fixture.json>
//
// Reads an existing canonical job from <dir>/jobs.jsonl (read-only; jobs.jsonl is never written),
// asks the FIXTURE provider for a proposal, validates it with the production validator and, on
// success, stores it in <dir>/structured-jobs.jsonl. Failures go to <dir>/structured-failures.jsonl.
// Exit code 0 = accepted, 1 = SEMANTIC_PARSE_FAILED, 2 = usage / storage error.

export interface ParseJdArgs {
  dataDir: string;
  job?: string;
  fixtures?: string;
}

export function parseParseJdArgs(argv: string[]): ParseJdArgs {
  const result: ParseJdArgs = { dataDir: "data" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") result.dataDir = argv[++i] ?? result.dataDir;
    else if (arg === "--job") result.job = argv[++i];
    else if (arg === "--fixtures") result.fixtures = argv[++i];
  }
  return result;
}

export async function runParseJd(args: ParseJdArgs, log: (line: string) => void = console.log): Promise<number> {
  if (!args.job || !args.fixtures) {
    log("usage: parse-jd --data-dir <dir> --job <job id | atsIdentity> --fixtures <fixture.json>");
    return 2;
  }
  const jobs = loadJobs(path.resolve(args.dataDir, "jobs.jsonl"));
  const matches = jobs.filter((j) => j.id === args.job || j.atsIdentity === args.job);
  if (matches.length !== 1) {
    log(`Expected exactly one canonical job for "${args.job}", found ${matches.length}.`);
    return 2;
  }
  const job = matches[0]!;
  const provider = FixtureJobSemanticProvider.fromFile(path.resolve(args.fixtures));
  const result = await parseCanonicalJob(job, provider, {
    structuredPath: path.resolve(args.dataDir, "structured-jobs.jsonl"),
    failuresPath: path.resolve(args.dataDir, "structured-failures.jsonl"),
  });

  log(`Provenance: ${provider.provenance} / FIXTURE_PROVIDER (not live model accuracy)`);
  log(`Job: ${job.id} (${job.atsIdentity ?? "no ats identity"}) jdHash=${job.jdContentHash}`);
  if (!result.ok) {
    log(`SEMANTIC_PARSE_FAILED ${result.failure.code}`);
    for (const issue of result.failure.issues) log(`  ${issue.code} ${issue.path}: ${issue.message}`);
    return 1;
  }
  const s = result.structured;
  const members = s.requirements.filter((r) => r.groupId !== null).length;
  log(`ACCEPTED ${s.id}`);
  log(`  requirements=${s.requirements.length} (required=${s.requirements.filter((r) => r.level === "required").length}, preferred=${s.requirements.filter((r) => r.level === "preferred").length}) alternativeGroups=${s.alternativeGroups.length} groupedMembers=${members}`);
  log(`  responsibilities=${s.responsibilities.length} constraints=${s.constraints.length} (unknown=${s.constraints.filter((c) => c.status === "unknown").length}) warnings=${s.warnings.length}`);
  log(`  evidenceSpans=${[...s.requirements, ...s.responsibilities, ...s.constraints].reduce((n, x) => n + x.evidence.length, 0)} all verified as exact slices`);
  log(`  persisted=${result.persisted} providerRevision=${s.providerRevision}`);
  return 0;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runParseJd(parseParseJdArgs(process.argv.slice(2))).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : "unknown error");
      process.exitCode = 2;
    },
  );
}

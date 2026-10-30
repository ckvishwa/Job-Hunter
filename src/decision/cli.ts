import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCandidateProfile, profileDigest } from "../domain/candidate-profile.js";
import { loadJobs } from "../storage/job-store.js";
import { loadDecisions, upsertDecision } from "../storage/decision-store.js";
import { loadStructuredJobs } from "../storage/structured-store.js";
import { POLICY_V1, decisionStaleness, evaluateJob, extractionReviewSchema, type Decision } from "./evaluate.js";

// npm run decide -- --data-dir <dir> --job <job id | atsIdentity> --profile <candidate-profile.json>
//                   [--review <extraction-review.json>] [--as-of YYYY-MM-DD] [--json]
//
// Reads one saved job (read-only), its validated StructuredJob for the SAME JD revision, and an approved
// candidate profile; writes the derived decision to <dir>/decisions.jsonl (locked, atomic). Never writes
// jobs.jsonl and never changes the profile. Exit 0 = a decision was produced (ELIGIBLE, REJECT or REVIEW),
// 2 = usage, input, missing/stale extraction or storage error.

export interface DecideArgs {
  dataDir: string;
  job?: string;
  profile?: string;
  review?: string;
  asOf?: string;
  json: boolean;
}

export function parseDecideArgs(argv: string[]): DecideArgs {
  const result: DecideArgs = { dataDir: "data", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") result.dataDir = argv[++i] ?? result.dataDir;
    else if (arg === "--job") result.job = argv[++i];
    else if (arg === "--profile") result.profile = argv[++i];
    else if (arg === "--review") result.review = argv[++i];
    else if (arg === "--as-of") result.asOf = argv[++i];
    else if (arg === "--json") result.json = true;
  }
  return result;
}

export function formatDecision(d: Decision): string[] {
  const lines: string[] = [];
  lines.push(`Decision: ${d.outcome}   (title targeting and MATCH results play no part in this decision)`);
  lines.push(`  job ${d.jobId}  jdHash ${d.jdHash.slice(0, 12)}...  structured ${d.extraction.providerRevision}`);
  lines.push(`  extraction provenance: ${d.extraction.provenance}   coverage: ${d.extraction.coverage}${d.extraction.reviewedBy ? ` (reviewed by ${d.extraction.reviewedBy})` : ""}`);
  lines.push(`  profile ${d.candidateId} v${d.profileVersion} (digest ${d.profileDigest.slice(0, 12)}...)   policy ${d.policyVersion}   as of ${d.asOf}`);
  lines.push(`  mandatory: ${d.counts.mandatory.pass} pass, ${d.counts.mandatory.fail} fail, ${d.counts.mandatory.unknown} unknown   preferred: ${d.counts.preferred.pass} pass, ${d.counts.preferred.fail} fail, ${d.counts.preferred.unknown} unknown`);
  for (const reason of d.reasons) lines.push(`  reason: ${reason}`);
  lines.push("  Rules:");
  for (const r of d.rules) {
    const tag = r.mandatory ? "MANDATORY" : r.level === "n/a" ? "" : r.level.toUpperCase();
    lines.push(`    [${r.status}] ${tag ? `${tag} ` : ""}${r.label}`);
    lines.push(`        ${r.explanation}`);
    if (r.factIds.length > 0) lines.push(`        facts: ${r.factIds.join(", ")}`);
    for (const e of r.evidence.slice(0, 2)) lines.push(`        evidence [${e.start}-${e.end}]: "${e.quote.length > 140 ? `${e.quote.slice(0, 137)}...` : e.quote}"`);
  }
  if (d.recordedStatements.length > 0) {
    lines.push("  Recorded from the JD (not used to reject):");
    for (const s of d.recordedStatements) lines.push(`    ${s.type}/${s.status}${s.value ? ` "${s.value}"` : ""}: ${s.handling}`);
  }
  if (d.unresolvedQuestions.length > 0) {
    lines.push("  Unresolved questions:");
    for (const q of d.unresolvedQuestions) lines.push(`    - ${q}`);
  }
  return lines;
}

export async function runDecide(args: DecideArgs, log: (line: string) => void = console.log): Promise<number> {
  if (!args.job || !args.profile) {
    log("usage: decide --data-dir <dir> --job <job id | atsIdentity> --profile <candidate-profile.json> [--review <extraction-review.json>] [--as-of YYYY-MM-DD] [--json]");
    return 2;
  }
  const dir = path.resolve(args.dataDir);
  const jobs = loadJobs(path.join(dir, "jobs.jsonl"));
  const matches = jobs.filter((j) => j.id === args.job || j.atsIdentity === args.job);
  if (matches.length !== 1) {
    log(`Expected exactly one saved job for "${args.job}", found ${matches.length}.`);
    return 2;
  }
  const job = matches[0]!;
  if (!job.jdContentHash) {
    log("The saved job has no jdContentHash; it is not a canonical job.");
    return 2;
  }

  // A decision is only valid for the exact JD revision it was computed from.
  const structuredAll = loadStructuredJobs(path.join(dir, "structured-jobs.jsonl")).filter((s) => s.jobId === job.id);
  const forThisJd = structuredAll.filter((s) => s.jdHash === job.jdContentHash);
  if (forThisJd.length === 0) {
    log(
      structuredAll.length > 0
        ? `Structured extractions exist for this job, but none for its current JD revision (${job.jdContentHash.slice(0, 12)}...). Re-parse before deciding.`
        : "No validated structured extraction exists for this job. Run parse-jd first.",
    );
    return 2;
  }
  const structured = [...forThisJd].sort((a, b) => b.validatedAt.localeCompare(a.validatedAt))[0]!;

  let profile;
  try {
    profile = parseCandidateProfile(JSON.parse(readFileSync(path.resolve(args.profile), "utf-8")));
  } catch (err) {
    log(`The candidate profile is not valid: ${err instanceof Error ? err.message.slice(0, 600) : "unreadable"}`);
    return 2;
  }
  let review = null;
  if (args.review) {
    const parsed = extractionReviewSchema.safeParse(JSON.parse(readFileSync(path.resolve(args.review), "utf-8")));
    if (!parsed.success) {
      log(`The extraction review is not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      return 2;
    }
    review = parsed.data;
  }

  const asOf = args.asOf ?? new Date().toISOString().slice(0, 10);
  const decision = evaluateJob({ structured, profile, review, asOf });

  // Report any earlier decision for this job and THIS candidate that no longer applies, without deleting it.
  const earlier = loadDecisions(path.join(dir, "decisions.jsonl")).filter((d) => d.jobId === job.id && d.candidateId === profile.candidateId && d.id !== decision.id);
  for (const old of earlier) {
    const why = decisionStaleness(old, { jdHash: decision.jdHash, structuredId: decision.structuredId, profileDigest: profileDigest(profile), policyVersion: POLICY_V1.policyVersion });
    if (why.length > 0) log(`Earlier decision ${old.outcome} (${old.id.slice(0, 40)}...) is stale: ${why.join("; ")}.`);
  }

  await upsertDecision(path.join(dir, "decisions.jsonl"), decision);
  if (args.json) log(JSON.stringify(decision, null, 2));
  else for (const line of formatDecision(decision)) log(line);
  log(`Stored: ${path.join(dir, "decisions.jsonl")}`);
  return 0;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runDecide(parseDecideArgs(process.argv.slice(2))).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? `${err.name}: ${err.message.slice(0, 600)}` : "unknown error");
      process.exitCode = 2;
    },
  );
}

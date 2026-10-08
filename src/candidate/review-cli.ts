import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCandidateProfile } from "../domain/candidate-profile.js";
import { applyFactReview, factReviewDecisionSchema, reviewRows } from "./review.js";

export interface CandidateReviewArgs {
  profilePath: string;
  packetPath?: string;
  decisionPath?: string;
  outputPath?: string;
  asOf: string;
}

export function runCandidateReview(args: CandidateReviewArgs): number {
  const profile = parseCandidateProfile(JSON.parse(readFileSync(path.resolve(args.profilePath), "utf8")));
  if (args.packetPath) {
    const packet = { schemaVersion: 1, profileVersion: profile.profileVersion, asOf: args.asOf, instructions: "Review each fact in the private source profile. Supply one decision JSON at a time. Edit resets approval to pending. Sensitive answers require an explicit user statement and must stay private.", rows: reviewRows(profile, args.asOf) };
    mkdirSync(path.dirname(path.resolve(args.packetPath)), { recursive: true });
    writeFileSync(path.resolve(args.packetPath), JSON.stringify(packet, null, 2) + "\n", { flag: "wx" });
  }
  if (args.decisionPath) {
    if (!args.outputPath) throw new Error("--out is required for a decision.");
    const decision = factReviewDecisionSchema.parse(JSON.parse(readFileSync(path.resolve(args.decisionPath), "utf8")));
    const reviewed = applyFactReview(profile, decision);
    mkdirSync(path.dirname(path.resolve(args.outputPath)), { recursive: true });
    writeFileSync(path.resolve(args.outputPath), JSON.stringify(reviewed, null, 2) + "\n", { flag: "wx" });
  }
  if (!args.packetPath && !args.decisionPath) throw new Error("Specify --packet or --decision.");
  return 0;
}

function parseArgs(argv: string[]): CandidateReviewArgs {
  const args: CandidateReviewArgs = { profilePath: "private-runtime/candidate/candidate-profile.reviewed-2.json", asOf: new Date().toISOString().slice(0, 10) };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i] ?? "";
    if (flag === "--profile") args.profilePath = next();
    else if (flag === "--packet") args.packetPath = next();
    else if (flag === "--decision") args.decisionPath = next();
    else if (flag === "--out") args.outputPath = next();
    else if (flag === "--as-of") args.asOf = next();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runCandidateReview(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : "Candidate review failed."); process.exitCode = 2; }
}

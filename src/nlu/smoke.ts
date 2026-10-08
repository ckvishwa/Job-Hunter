import path from "node:path";
import { loadJobs } from "../storage/job-store.js";
import { loadVerifiedInputs } from "../pipeline/trust.js";
import { proposeLane, retrieveFactCandidates } from "./lane-and-retrieval.js";
import { LocalTransformerEncoder } from "./local-transformer.js";

async function main(): Promise<void> {
  const dataDir = path.resolve(process.argv[2] ?? "data/search-demo");
  const profilePath = path.resolve(process.argv[3] ?? "private-runtime/candidate/candidate-profile.reviewed-2.json");
  const registryPath = path.resolve(process.argv[4] ?? "private-runtime/candidate/canonical-resume-registry.json");
  const asOf = new Date().toISOString().slice(0, 10);
  const verified = loadVerifiedInputs({ registryPath, profilePath, asOf });
  const job = loadJobs(path.join(dataDir, "jobs.jsonl"))[0];
  if (!job?.jdContentHash) throw new Error(`No canonical job with an intact JD hash in ${dataDir}.`);
  const encoder = new LocalTransformerEncoder();
  const lane = await proposeLane({ title: job.title, descriptionText: job.descriptionText }, encoder);
  const retrieval = await retrieveFactCandidates({ query: `${job.title}\n${job.descriptionText}`, profile: verified.profile, asOf, encoder });
  const reconstructed = lane.run.chunks.map((chunk) => chunk.text).join(" ").replace(/\s+/g, " ").trim();
  const expected = `${job.title}\n${job.descriptionText}`.replace(/\s+/g, " ").trim();
  if (reconstructed !== expected) throw new Error("Tokenizer chunk boundaries did not reconstruct the complete source text.");
  console.log(JSON.stringify({
    job: { id: job.id, company: job.company, title: job.title, jdHash: job.jdContentHash },
    proposal: lane.proposal,
    encoder: lane.run.model,
    runtime: lane.run.runtime,
    device: lane.run.device,
    hardware: lane.run.hardware,
    elapsedMs: lane.run.elapsedMs,
    chunkCount: lane.run.chunks.length,
    maxChunkTokens: Math.max(...lane.run.chunks.map((chunk) => chunk.tokenCount)),
    completeSourceReconstructed: true,
    approvedFactCandidates: retrieval.slice(0, 8),
    candidateEmbeddingsPersisted: false,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "NLU smoke failed.");
  process.exitCode = 1;
});

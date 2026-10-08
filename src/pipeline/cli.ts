import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadSearchInput, resolveSearchTarget } from "../config/search-input.js";
import { loadJobs } from "../storage/job-store.js";
import { runSearchDiscovery } from "../discovery/browser-search.js";
import { createRunEventLog, type RunEventLog } from "../events/run-events.js";
import { runPipeline, type PipelineArgs } from "./run.js";

export function parsePipelineArgs(argv: string[]): PipelineArgs {
  const args: PipelineArgs = {
    mode: "live",
    maxJobs: 1,
    dataDir: "private-runtime/pipeline-data",
    evidenceDir: "private-runtime/pipeline-evidence",
    outputDir: "private-runtime/job-specific",
    profilePath: "private-runtime/candidate/candidate-profile.reviewed-2.json",
    registryPath: "private-runtime/candidate/canonical-resume-registry.json",
    provider: "traceroute",
    jsonModeVerified: false,
    headed: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => argv[++index] ?? "";
    if (arg === "--mode") args.mode = next() === "offline" ? "offline" : "live";
    else if (arg === "--search-input") args.searchInput = next();
    else if (arg === "--company") args.company = next();
    else if (arg === "--job-id") args.jobId = next();
    else if (arg === "--data-dir") args.dataDir = next();
    else if (arg === "--evidence-dir") args.evidenceDir = next();
    else if (arg === "--output-dir") args.outputDir = next();
    else if (arg === "--profile") args.profilePath = next();
    else if (arg === "--registry") args.registryPath = next();
    else if (arg === "--provider") {
      const selected = next();
      if (selected === "fixture" || selected === "ollama" || selected === "traceroute") args.provider = selected;
      else throw new Error(`Unsupported provider: ${selected}`);
    }
    else if (arg === "--fixtures") args.fixturePath = next();
    else if (arg === "--review") args.reviewPath = next();
    else if (arg === "--gateway-url") args.gatewayUrl = next();
    else if (arg === "--model") args.providerModel = next();
    else if (arg === "--context-tokens") args.providerContextTokens = Number(next());
    else if (arg === "--timeout-ms") args.providerTimeoutMs = Number(next());
    else if (arg === "--ollama-url") args.ollamaUrl = next();
    else if (arg === "--output-tokens") args.providerOutputTokens = Number(next());
    else if (arg === "--encoder-model-dir") args.encoderModelDir = next();
    else if (arg === "--browser-profile") args.browserProfileDir = next();
    else if (arg === "--max-jobs") args.maxJobs = Math.max(1, Math.min(1, Number(next())));
    else if (arg === "--json-mode-verified") args.jsonModeVerified = true;
  }
  return args;
}

function compactResult(result: Awaited<ReturnType<typeof runPipeline>>): string[] {
  return [
    `Outcome: ${result.outcome}`,
    `Job: ${result.job.company} — ${result.job.title}`,
    `Canonical URL: ${result.job.canonicalUrl}`,
    `JD SHA-256: ${result.job.jdHash}`,
    `Lane: ${result.lane?.status === "PROPOSED" ? `${result.lane.lane} (prototype; similarity is a ranking signal)` : `UNKNOWN/REVIEW (${result.lane?.status === "UNKNOWN_REVIEW" ? result.lane.reason : "source evidence and NLU did not agree"})`}`,
    `Extraction: ${result.extraction.status}${result.extraction.errorCode ? ` (${result.extraction.errorCode})` : ""} ${result.extraction.providerRevision ?? ""}`,
    result.extraction.served ? `Served model: ${result.extraction.served.servedModel ?? "unknown"}; ${result.extraction.served.provider === "ollama" ? `digest ${result.extraction.served.modelDigest ?? "unknown"}; ${result.extraction.served.quantization ?? "unknown quantization"}; ` : `route ${result.extraction.served.routeVersion ?? "unknown"}; `}${result.extraction.served.latencyMs}ms; usage ${result.extraction.served.inputTokens ?? "?"}/${result.extraction.served.outputTokens ?? "?"} tokens` : "Served model: not established (no live provider response).",
    `Fact candidates: ${result.factCandidates.map((fact) => `${fact.factId} (semantic=${fact.semanticScore.toFixed(3)}, lexical=${fact.lexicalScore.toFixed(3)})`).join(", ") || "none"}`,
    `Decision: ${result.decision?.outcome ?? "not run; no validated structured extraction"}`,
    ...(result.decision?.reasons.map((reason) => `  - ${reason}`) ?? []),
    `Artifact: ${result.artifact?.pdfPath ?? "not created"}${result.artifact ? ` (${result.artifact.pageCount} pages, sha256 ${result.artifact.sha256}, ${result.artifact.inspection})` : ""}`,
    `Application form: ${result.application?.state ?? "not opened/not admitted"}`,
    ...(result.application?.state === "WAITING_FOR_USER" ? result.application.unresolved.map((reason) => `  - ${reason}`) : []),
    `Checkpoint: ${result.checkpointPath}`,
    `Application record: ${result.applicationRecordPath}`,
    "Submit requests: 0 (submitting is never an automated action).",
  ];
}

export async function runPipelineCli(args: PipelineArgs, log: (line: string) => void = console.log, signal?: AbortSignal, events?: RunEventLog): Promise<number> {
  if (args.maxJobs !== 1) throw new Error("This first pipeline path is bounded to --max-jobs 1.");
  if (args.mode === "offline" && (!args.jobId || args.provider !== "fixture" || !args.fixturePath)) throw new Error("Offline mode requires a saved --job-id, --provider fixture and --fixtures; it makes no external search or model requests.");
  const deps = args.jobId ? {} : {
    discover: async (pipelineArgs: PipelineArgs) => {
      const targets = loadSearchInput(path.resolve(pipelineArgs.searchInput!)).searches.filter((target) => !pipelineArgs.company || target.company.toLowerCase() === pipelineArgs.company.toLowerCase());
      if (targets.length !== 1) throw new Error(`Expected one search target for ${pipelineArgs.company ?? "input"}; found ${targets.length}.`);
      const resolved = resolveSearchTarget(targets[0]!);
      const summary = await runSearchDiscovery(resolved, {
        dataDir: path.resolve(pipelineArgs.dataDir),
        evidenceDir: path.resolve(pipelineArgs.evidenceDir),
        typingDelayMs: 80,
        holdMs: 500,
        settleTimeoutMs: 15_000,
        navigationTimeoutMs: 30_000,
        maxJobs: 1,
      });
      if (summary.persistedCount < 1) throw new Error(`Headed search did not persist a canonical job (outcome=${summary.outcome}, failures=${summary.failures.map((failure) => failure.code).join(",") || "none"}).`);
      const extracted = summary.jobs.find((item) => item.status === "persisted" && item.jobId);
      if (!extracted?.jobId) throw new Error("Search summary reports saved count without a canonical job id.");
      const job = loadJobs(summary.jobsPath).find((item) => item.id === extracted.jobId);
      if (!job) throw new Error("Persisted canonical job could not be reloaded from the protected store.");
      return { job, searchRunId: summary.runId, browserClosed: summary.browserClosed, evidencePaths: [summary.shortlistPath, summary.jobsPath, summary.failuresPath] };
    },
  };
  const result = await runPipeline(args, { ...deps, signal, events });
  for (const line of compactResult(result)) log(line);
  return result.outcome === "READY_TO_SUBMIT" ? 0 : result.outcome === "REJECT" ? 3 : result.outcome === "BLOCKED" ? 4 : 5;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  runPipelineCli(parsePipelineArgs(process.argv.slice(2)), console.log, controller.signal, createRunEventLog("pipeline"))
    .then(code => { process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message.slice(0, 500)}` : "Pipeline failed.");
      process.exitCode = 2;
    }).finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
}

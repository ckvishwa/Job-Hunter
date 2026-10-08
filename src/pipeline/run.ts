import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobPosting } from "../adapters/types.js";
import { loadJobs } from "../storage/job-store.js";
import { loadStructuredJobs } from "../storage/structured-store.js";
import { parseCanonicalJob } from "../semantic/parse-job.js";
import { FixtureJobSemanticProvider, type JobSemanticProvider } from "../semantic/provider.js";
import { TraceRouteJobSemanticProvider, type ServedModelMetadata } from "../semantic/traceroute-provider.js";
import { OllamaJobSemanticProvider } from "../semantic/ollama-provider.js";
import { buildExtractionCoverage } from "../semantic/source-coverage.js";
import { evaluateJob, extractionReviewSchema, POLICY_V1, type Decision } from "../decision/evaluate.js";
import { profileDigest } from "../domain/candidate-profile.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { proposeLane, retrieveFactCandidates, type FactCandidate, type Lane, type LaneProposal } from "../nlu/lane-and-retrieval.js";
import { buildAndRenderResumePlan, type RenderedResumeArtifact } from "./resume-plan.js";
import { loadVerifiedInputs, type CanonicalLane, type VerifiedInputs } from "./trust.js";
import { inspectAndFillApplication, type FormResult } from "./application-form.js";
import { closePersistentChrome, launchPersistentChrome, uniqueChromeProfileDir } from "../browser/launcher.js";
import { errorCodeOf, noopRunEventLog, type RunEventLog } from "../events/run-events.js";

export interface PipelineArgs {
  mode: "live" | "offline";
  searchInput?: string;
  company?: string;
  jobId?: string;
  maxJobs: number;
  dataDir: string;
  evidenceDir: string;
  outputDir: string;
  profilePath: string;
  registryPath: string;
  provider: "traceroute" | "fixture" | "ollama";
  fixturePath?: string;
  reviewPath?: string;
  gatewayUrl?: string;
  providerModel?: string;
  providerContextTokens?: number;
  providerTimeoutMs?: number;
  ollamaUrl?: string;
  providerOutputTokens?: number;
  jsonModeVerified: boolean;
  encoderModelDir?: string;
  browserProfileDir?: string;
  headed?: boolean;
}

export interface PipelineDependencies {
  signal?: AbortSignal;
  discover?: (args: PipelineArgs) => Promise<{ job: JobPosting; searchRunId: string; browserClosed: boolean; evidencePaths: string[] }>;
  provider?: JobSemanticProvider;
  encoder?: LocalTransformerEncoder;
  formPage?: (url: string, profileDir: string) => Promise<{ page: import("playwright").Page; close: () => Promise<void> }>;
  render?: typeof buildAndRenderResumePlan;
  now?: () => string;
  /** Append-only run events (run start/end, one stage per pipeline stage). Defaults to recording nothing. */
  events?: RunEventLog;
}

export interface PipelineRunResult {
  outcome: "READY_TO_SUBMIT" | "WAITING_FOR_USER" | "REJECT" | "BLOCKED";
  job: { id: string; company: string; title: string; canonicalUrl: string; applyUrl: string; jdHash: string };
  lane: LaneProposal | null;
  extraction: { status: "VALIDATED" | "BLOCKED" | "FAILED" | "REUSED"; providerRevision: string | null; served: ServedModelMetadata | null; errorCode?: string };
  factCandidates: FactCandidate[];
  decision: Decision | null;
  artifact: RenderedResumeArtifact | null;
  application: FormResult | null;
  checkpointPath: string;
  applicationRecordPath: string;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const handle = await open(tempPath, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  const { rename } = await import("node:fs/promises");
  await rename(tempPath, filePath);
}

function canonicalLane(value: string | null): CanonicalLane | null {
  return value === "cybersecurity" || value === "sdet" || value === "cloud" || value === "network" ? value : null;
}

const DIRECT_TERMS: Record<CanonicalLane, string[]> = {
  cybersecurity: ["security engineer", "security analyst", "soc analyst", "detection engineer", "dfir", "incident response", "security operations", "vulnerability analyst", "malware"],
  sdet: ["sdet", "qa automation", "quality engineer", "test automation", "software test engineer", "test engineer"],
  cloud: ["cloud engineer", "cloud security", "devops", "platform engineer", "infrastructure automation"],
  network: ["network engineer", "network security", "network analyst", "noc engineer", "network operations"],
};

function pickLane(job: JobPosting, proposal: LaneProposal): CanonicalLane | null {
  if (proposal.status !== "PROPOSED") return null;
  const text = `${job.title}\n${job.descriptionText}`.toLocaleLowerCase("en-US");
  const title = job.title.toLocaleLowerCase("en-US");
  const scores = (Object.keys(DIRECT_TERMS) as CanonicalLane[]).map((lane) => {
    const titleHits = DIRECT_TERMS[lane].filter((term) => title.includes(term)).length;
    const bodyHits = DIRECT_TERMS[lane].filter((term) => text.includes(term)).length;
    return { lane, titleHits, score: bodyHits + titleHits * 4 };
  }).sort((a, b) => b.score - a.score);
  const best = scores[0]!;
  const second = scores[1]!;
  if (best.score === 0 || (best.score === second.score && best.titleHits === 0)) return null;
  return best.lane === proposal.lane ? best.lane : null;
}

function collectRequirementQueries(job: JobPosting, structured: { requirements: Array<{ value: string; level: string }>; responsibilities: Array<{ value: string }> }): string[] {
  return structured.requirements.filter((requirement) => requirement.level !== "unknown").map((requirement) => requirement.value).concat(structured.responsibilities.map((responsibility) => responsibility.value)).slice(0, 30);
}

async function loadReview(reviewPath: string | undefined): Promise<ReturnType<typeof extractionReviewSchema.parse> | null> {
  if (!reviewPath) return null;
  const review = extractionReviewSchema.parse(JSON.parse(await readFile(path.resolve(reviewPath), "utf8")));
  return review;
}

function makeProvider(args: PipelineArgs): JobSemanticProvider | null {
  if (args.provider === "fixture") {
    if (!args.fixturePath) return null;
    return FixtureJobSemanticProvider.fromFile(path.resolve(args.fixturePath));
  }
  if (args.provider === "ollama") {
    const model = args.providerModel ?? process.env.JOBHUNTER_OLLAMA_MODEL;
    if (!model?.trim()) return null;
    const contextTokens = args.providerContextTokens ?? Number(process.env.JOBHUNTER_OLLAMA_CONTEXT_TOKENS ?? 8_192);
    const outputTokens = args.providerOutputTokens ?? Number(process.env.JOBHUNTER_OLLAMA_OUTPUT_TOKENS ?? 2_048);
    return new OllamaJobSemanticProvider({
      baseUrl: args.ollamaUrl ?? process.env.JOBHUNTER_OLLAMA_URL ?? "http://127.0.0.1:11434",
      model,
      contextTokens,
      outputTokens,
      timeoutMs: args.providerTimeoutMs ?? Number(process.env.JOBHUNTER_OLLAMA_TIMEOUT_MS ?? 240_000),
    });
  }
  const key = process.env.JOBHUNTER_GATEWAY_KEY;
  const route = args.providerModel ?? process.env.JOBHUNTER_GATEWAY_MODEL;
  const contextTokens = args.providerContextTokens ?? Number(process.env.JOBHUNTER_PROVIDER_CONTEXT_TOKENS);
  const baseUrl = args.gatewayUrl ?? process.env.JOBHUNTER_GATEWAY_URL ?? "http://127.0.0.1:8000/v1/chat/completions";
  if (!key || !route || !Number.isInteger(contextTokens) || contextTokens <= 0 || !args.jsonModeVerified) return null;
  return new TraceRouteJobSemanticProvider({ baseUrl, routeAlias: route, gatewayKey: key, contextTokens, timeoutMs: args.providerTimeoutMs });
}

function providerBlockReason(args: PipelineArgs): string {
  if (args.provider === "fixture") return args.fixturePath ? "FIXTURE_OUTPUT_NOT_FOUND_OR_NOT_VALIDATED" : "FIXTURE_PROVIDER_NOT_CONFIGURED";
  if (args.provider === "ollama") return (args.providerModel ?? process.env.JOBHUNTER_OLLAMA_MODEL ?? "").trim() ? "OLLAMA_PROVIDER_NOT_CONFIGURED" : "OLLAMA_MODEL_NOT_CONFIGURED";
  if (!(process.env.JOBHUNTER_GATEWAY_KEY ?? "").trim()) return "PROVIDER_CREDENTIAL_MISSING";
  if (!(args.providerModel ?? process.env.JOBHUNTER_GATEWAY_MODEL ?? "").trim()) return "PROVIDER_MODEL_NOT_CONFIGURED";
  const contextTokens = args.providerContextTokens ?? Number(process.env.JOBHUNTER_PROVIDER_CONTEXT_TOKENS);
  if (!Number.isInteger(contextTokens) || contextTokens < 2_000) return "PROVIDER_CONTEXT_LIMIT_NOT_VERIFIED";
  if (!args.jsonModeVerified) return "STRUCTURED_OUTPUT_CAPABILITY_UNVERIFIED";
  return "PROVIDER_NOT_CONFIGURED";
}

async function openOwnedForm(url: string, profileDir: string): Promise<{ page: import("playwright").Page; close: () => Promise<void> }> {
  const context = await launchPersistentChrome(profileDir, { headless: false, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  let done = false;
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { page, close: async () => { if (done) return; done = true; await closePersistentChrome(context, profileDir); } };
  } catch (error) {
    await closePersistentChrome(context, profileDir);
    throw error;
  }
}

async function saveApplicationRecord(filePath: string, record: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const handle = await open(filePath, "wx");
    try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(filePath, "utf8")) as { outcome?: string };
    if (previous.outcome === "READY_TO_SUBMIT") return;
    await writeJsonAtomic(filePath, record);
  }
}

async function readReadyApplicationRecord(filePath: string, current: { applicationKey: string; jdHash: string; profileDigest: string; decisionId: string; artifactSha256: string }): Promise<FormResult | null> {
  try {
    const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    if (record.applicationKey !== current.applicationKey || record.jdHash !== current.jdHash || record.profileDigest !== current.profileDigest || record.decisionId !== current.decisionId || record.artifactSha256 !== current.artifactSha256 || record.outcome !== "READY_TO_SUBMIT" || !record.application || typeof record.application !== "object") return null;
    const application = record.application as FormResult;
    return application.state === "READY_TO_SUBMIT" ? application : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function processCanonicalJob(input: {
  args: PipelineArgs;
  job: JobPosting;
  searchRunId: string;
  searchBrowserClosed: boolean;
  searchEvidencePaths: string[];
  verifiedInputs: VerifiedInputs;
  dependencies?: PipelineDependencies;
}): Promise<PipelineRunResult> {
  const deps = input.dependencies ?? {};
  const nowDate = (deps.now?.() ?? new Date().toISOString()).slice(0, 10);
  const job = input.job;
  if (!job.jdContentHash || !job.atsIdentity || job.resolutionStatus !== "resolved") throw new Error("Pipeline requires a resolved canonical job with stable ATS identity and JD hash.");
  const digest = profileDigest(input.verifiedInputs.profile);
  const encoder = deps.encoder ?? new LocalTransformerEncoder(input.args.encoderModelDir);
  const events = deps.events ?? noopRunEventLog("pipeline");
  const ctx = { company: job.company, jobId: job.id };
  const nlu = await events.stage("lane", ctx, () => proposeLane({ title: job.title, descriptionText: job.descriptionText }, encoder));
  const proposedLane = nlu.proposal;
  const picked = pickLane(job, proposedLane);
  const provider = deps.provider ?? makeProvider(input.args);
  let providerInitError: string | null = null;
  if (provider instanceof OllamaJobSemanticProvider) {
    try { await provider.prepare(); }
    catch (error) { providerInitError = error instanceof Error ? error.name : "OllamaInitializationError"; }
  }
  const providerRevision = provider?.revision ?? null;
  const outRoot = path.resolve(input.args.outputDir, job.id, job.jdContentHash);
  await mkdir(outRoot, { recursive: true });
  const checkpointPath = path.join(outRoot, "pipeline-checkpoint.json");
  const extractionMetadataPath = path.join(outRoot, "extraction-provider-metadata.json");
  const applicationKey = hashText(`${input.verifiedInputs.profile.candidateId}|${job.atsIdentity}|${job.jdContentHash}`);
  const applicationRecordPath = path.join(outRoot, `application-${applicationKey.slice(0, 20)}.json`);
  const jdTokens = nlu.run.chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.tokenCount - 2), 0);
  let extraction: PipelineRunResult["extraction"] = providerInitError
    ? { status: "FAILED", providerRevision, served: null, errorCode: providerInitError }
    : { status: "BLOCKED", providerRevision, served: null, errorCode: providerBlockReason(input.args) };
  let decision: Decision | null = null;
  let artifact: RenderedResumeArtifact | null = null;
  let application: FormResult | null = null;
  let factCandidates: FactCandidate[] = [];
  let finalOutcome: PipelineRunResult["outcome"] = "BLOCKED";
  let extractionReview = await loadReview(input.args.reviewPath);
  const stageLog: Record<string, unknown> = {
    search: { status: "DONE", runId: input.searchRunId, browserClosed: input.searchBrowserClosed, evidence: input.searchEvidencePaths },
    canonicalJob: { status: "DONE", id: job.id, atsIdentity: job.atsIdentity, jdHash: job.jdContentHash, url: job.canonicalUrl },
    registry: { path: input.verifiedInputs.registryPath, sha256: input.verifiedInputs.registryHash },
    profile: { path: input.verifiedInputs.profilePath, sha256: input.verifiedInputs.profileHash, digest, approvedCurrentFactCount: input.verifiedInputs.approvedFacts.length, pendingFactsHash: input.verifiedInputs.pendingFactsHash },
    nlu: { status: proposedLane.status, proposal: proposedLane, model: nlu.run.model, runtime: nlu.run.runtime, device: nlu.run.device, hardware: nlu.run.hardware, cacheVersion: nlu.run.model.cacheVersion, jdTokenCount: jdTokens, chunks: nlu.run.chunks.map(({ start, end, tokenCount, section }) => ({ start, end, tokenCount, section })), elapsedMs: nlu.run.elapsedMs },
    extraction: { status: extraction.status, providerRevision, code: extraction.errorCode },
    providerConfiguration: { provider: input.args.provider, credentialConfigured: input.args.provider === "fixture" || input.args.provider === "ollama" || !!process.env.JOBHUNTER_GATEWAY_KEY, modelConfigured: input.args.provider === "fixture" || !!(input.args.providerModel ?? (input.args.provider === "ollama" ? process.env.JOBHUNTER_OLLAMA_MODEL : process.env.JOBHUNTER_GATEWAY_MODEL)), contextLimitConfigured: input.args.provider === "fixture" || Number.isInteger(input.args.providerContextTokens ?? Number(input.args.provider === "ollama" ? process.env.JOBHUNTER_OLLAMA_CONTEXT_TOKENS ?? 8_192 : process.env.JOBHUNTER_PROVIDER_CONTEXT_TOKENS)), structuredOutputBehaviorVerified: input.args.provider === "fixture" || input.args.provider === "ollama" || input.args.jsonModeVerified },
  };

  const extractionStage = events.stageStart("extraction", ctx);
  if (provider) {
    const neededTokens = jdTokens + 1_500 + (provider instanceof OllamaJobSemanticProvider ? provider.outputTokens : 6_000);
    const contextLimit = provider instanceof TraceRouteJobSemanticProvider || provider instanceof OllamaJobSemanticProvider ? provider.contextTokens : Number.POSITIVE_INFINITY;
    if (providerInitError) {
      // Keep the typed local provider initialization failure; no extraction request was sent.
    } else if (!(provider instanceof OllamaJobSemanticProvider) && neededTokens > contextLimit) {
      extraction = { status: "BLOCKED", providerRevision, served: null, errorCode: "CONTEXT_LIMIT_UNVERIFIED_OR_EXCEEDED" };
    } else {
      const existing = loadStructuredJobs(path.resolve(input.args.dataDir, "structured-jobs.jsonl")).find((record) => record.jobId === job.id && record.jdHash === job.jdContentHash && record.providerRevision === provider.revision);
      if (existing) {
        let served: ServedModelMetadata | null = null;
        try {
          const cached = JSON.parse(await readFile(extractionMetadataPath, "utf8")) as { jdHash?: string; providerRevision?: string; served?: ServedModelMetadata | null };
          if (cached.jdHash === job.jdContentHash && cached.providerRevision === provider.revision) served = cached.served ?? null;
        } catch { /* older structured cache without metadata remains valid; metadata stays unknown */ }
        extraction = { status: "REUSED", providerRevision: provider.revision, served };
      }
      else {
        const parsed = await parseCanonicalJob(job, provider, { signal: deps.signal, structuredPath: path.resolve(input.args.dataDir, "structured-jobs.jsonl"), failuresPath: path.resolve(input.args.dataDir, "structured-failures.jsonl") });
        const served = provider instanceof TraceRouteJobSemanticProvider || provider instanceof OllamaJobSemanticProvider ? provider.metadata() : null;
        extraction = parsed.ok ? { status: "VALIDATED", providerRevision: parsed.structured.providerRevision, served } : { status: "FAILED", providerRevision, served, errorCode: parsed.failure.code };
        if (parsed.ok) await writeJsonAtomic(extractionMetadataPath, { schemaVersion: 1, jdHash: job.jdContentHash, providerRevision: provider.revision, served: extraction.served, savedAt: new Date().toISOString() });
      }
    }
  }
  stageLog.extraction = extraction;
  extractionStage.end(extraction.status, extraction.errorCode);

  const decisionStage = events.stageStart("decision", ctx);
  const structure = loadStructuredJobs(path.resolve(input.args.dataDir, "structured-jobs.jsonl")).filter((record) => record.jobId === job.id && record.jdHash === job.jdContentHash && record.providerRevision === extraction.providerRevision).sort((a, b) => b.validatedAt.localeCompare(a.validatedAt))[0];
  if (structure && (extraction.status === "VALIDATED" || extraction.status === "REUSED")) {
    const coverage = buildExtractionCoverage({ rawJd: job.descriptionText, jdHash: job.jdContentHash, structured: structure });
    const coveragePath = path.join(outRoot, "extraction-coverage-review.json");
    await writeJsonAtomic(coveragePath, { ...coverage, computedAt: new Date().toISOString(), source: "deterministic-diagnostic-no-human-attestation" });
    stageLog.extractionCoverage = { status: coverage.status, parserValidation: coverage.parserValidation, humanAttestation: coverage.humanAttestation, coveragePath, minimumQualifications: coverage.sections.minimumQualifications, preferredQualifications: coverage.sections.preferredQualifications, experienceThresholds: coverage.experienceThresholds, alternativeClauses: coverage.alternativeClauses, workArrangement: coverage.workArrangement };
    const requirements = collectRequirementQueries(job, structure);
    const ranked = await Promise.all(requirements.map((query) => retrieveFactCandidates({ query, profile: input.verifiedInputs.profile, asOf: nowDate, encoder })));
    const unique = new Map<string, FactCandidate>();
    for (const list of ranked) for (const candidate of list.slice(0, 3)) if (!unique.has(candidate.factId)) unique.set(candidate.factId, candidate);
    factCandidates = [...unique.values()].sort((a, b) => b.semanticScore - a.semanticScore);
    decision = evaluateJob({ structured: structure, profile: input.verifiedInputs.profile, review: extractionReview, asOf: nowDate });
    stageLog.factRetrieval = { status: "DONE", candidates: factCandidates, note: "similarity ranks candidates only; deterministic requirement rules decide PASS/FAIL/UNKNOWN" };
    stageLog.decision = { status: "DONE", outcome: decision.outcome, decision, policyVersion: POLICY_V1.policyVersion };
  }

  decisionStage.end(decision ? decision.outcome : "SKIPPED");

  if (picked) {
    const proposalFactCandidates = structure ? factCandidates : await retrieveFactCandidates({ query: `${job.title}\n${job.descriptionText}`, profile: input.verifiedInputs.profile, asOf: nowDate, encoder });
    if (decision) {
      artifact = await events.stage("resume_plan", ctx, () => (deps.render ?? buildAndRenderResumePlan)({ job, lane: picked, decision, profileDigest: digest, verifiedInputs: input.verifiedInputs, factCandidates: proposalFactCandidates, outputDir: input.args.outputDir }));
      stageLog.resumePlan = { status: artifact.plan.previewOnly ? "PREVIEW" : "VALIDATED", planPath: artifact.planPath, pdfPath: artifact.pdfPath, artifactSha256: artifact.sha256, pageCount: artifact.pageCount, inspection: artifact.inspection, canonicalResumePath: artifact.plan.canonicalResumePath, canonicalResumeHash: artifact.plan.canonicalResumeHash };
      if (decision.outcome !== "ELIGIBLE") {
        const reviewPath = path.resolve(input.args.outputDir, job.id, job.jdContentHash, "application-review.json");
        await saveApplicationRecord(applicationRecordPath, { applicationKey, jobId: job.id, atsIdentity: job.atsIdentity, jdHash: job.jdContentHash, profileDigest: digest, outcome: "WAITING_FOR_USER", reason: decision.reasons, artifactPath: artifact.pdfPath, artifactSha256: artifact.sha256, createdAt: new Date().toISOString(), submitCount: 0 });
        finalOutcome = "WAITING_FOR_USER";
        stageLog.application = { status: "NOT_ADMITTED", reason: "Decision is not ELIGIBLE; no fields filled and no upload attempted.", reviewPath };
      } else {
        application = await readReadyApplicationRecord(applicationRecordPath, { applicationKey, jdHash: job.jdContentHash, profileDigest: digest, decisionId: decision.id, artifactSha256: artifact.sha256 });
        if (application) {
          finalOutcome = "READY_TO_SUBMIT";
          stageLog.application = { ...application, status: "REUSED_VALID_READY_RECORD", browserOpened: false };
        } else {
          const profileDir = path.resolve(input.args.browserProfileDir ?? uniqueChromeProfileDir(".chrome-profile-pipeline"));
          const opened = await (deps.formPage ?? openOwnedForm)(job.applyUrl, profileDir);
          try {
            application = await events.stage("application", ctx, () => inspectAndFillApplication({ page: opened.page, profile: input.verifiedInputs.profile, artifactPath: artifact!.pdfPath, asOf: nowDate, admitted: true }));
            finalOutcome = application.state;
            stageLog.application = { ...application, browserClosed: true };
          } finally { await opened.close(); }
        }
        await saveApplicationRecord(applicationRecordPath, { applicationKey, jobId: job.id, atsIdentity: job.atsIdentity, jdHash: job.jdContentHash, profileDigest: digest, outcome: finalOutcome, decisionId: decision.id, artifactPath: artifact.pdfPath, artifactSha256: artifact.sha256, application, createdAt: new Date().toISOString(), submitCount: 0 });
      }
    } else {
      finalOutcome = "WAITING_FOR_USER";
      stageLog.resumePlan = { status: "NOT_CREATED", reason: "No schema-valid structured extraction and deterministic decision; plan/artifact generation is withheld." };
      stageLog.application = { status: "NOT_ADMITTED", reason: "Live extraction is blocked or invalid; no application fields filled or uploaded." };
      await saveApplicationRecord(applicationRecordPath, { applicationKey, jobId: job.id, atsIdentity: job.atsIdentity, jdHash: job.jdContentHash, profileDigest: digest, outcome: finalOutcome, reason: extraction.errorCode ?? "NO_VALIDATED_STRUCTURED_JOB", submitCount: 0, createdAt: new Date().toISOString() });
    }
  } else {
    finalOutcome = "WAITING_FOR_USER";
    stageLog.resumePlan = { status: "NOT_CREATED", reason: proposedLane.status === "UNKNOWN_REVIEW" ? proposedLane.reason : "Lane proposal conflicts with direct JD evidence; explicit review required." };
    await saveApplicationRecord(applicationRecordPath, { applicationKey, jobId: job.id, atsIdentity: job.atsIdentity, jdHash: job.jdContentHash, profileDigest: digest, outcome: finalOutcome, reason: "LANE_UNKNOWN_OR_CONFLICT", submitCount: 0, createdAt: new Date().toISOString() });
  }

  const result: PipelineRunResult = {
    outcome: finalOutcome,
    job: { id: job.id, company: job.company, title: job.title, canonicalUrl: job.canonicalUrl, applyUrl: job.applyUrl, jdHash: job.jdContentHash },
    lane: proposedLane,
    extraction,
    factCandidates,
    decision,
    artifact,
    application,
    checkpointPath,
    applicationRecordPath,
  };
  stageLog.final = { outcome: finalOutcome, submitCount: 0, idempotencyKey: applicationKey, localCandidateEmbeddingsOnly: true };
  await writeJsonAtomic(checkpointPath, { schemaVersion: 1, runKey: hashText(`${job.id}|${job.jdContentHash}|${digest}|${providerRevision ?? "none"}`), jobId: job.id, atsIdentity: job.atsIdentity, jdHash: job.jdContentHash, profilePath: input.verifiedInputs.profilePath, profileDigest: digest, registryPath: input.verifiedInputs.registryPath, registryHash: input.verifiedInputs.registryHash, parserRevision: providerRevision, nluRevision: nlu.run.model, policyVersion: POLICY_V1.policyVersion, searchRunId: input.searchRunId, stages: stageLog, outcome: finalOutcome, updatedAt: new Date().toISOString() });
  return result;
}

export async function runPipeline(args: PipelineArgs, deps: PipelineDependencies = {}): Promise<PipelineRunResult> {
  const events = deps.events ?? noopRunEventLog("pipeline");
  events.runStart({ jobId: args.jobId });
  try {
    const result = await runPipelineInner(args, deps);
    events.runEnd(result.outcome);
    return result;
  } catch (error) {
    events.runEnd("ERROR", errorCodeOf(error));
    throw error;
  }
}

async function runPipelineInner(args: PipelineArgs, deps: PipelineDependencies): Promise<PipelineRunResult> {
  const asOf = (deps.now?.() ?? new Date().toISOString()).slice(0, 10);
  const verifiedInputs = loadVerifiedInputs({ registryPath: args.registryPath, profilePath: args.profilePath, asOf });
  let job: JobPosting;
  let searchRunId = "saved-job";
  let browserClosed = true;
  let evidencePaths: string[] = [];
  if (args.jobId) {
    const matches = loadJobs(path.resolve(args.dataDir, "jobs.jsonl")).filter((record) => record.id === args.jobId || record.atsIdentity === args.jobId);
    if (matches.length !== 1) throw new Error(`Expected exactly one canonical saved job for ${args.jobId}; found ${matches.length}.`);
    job = matches[0]!;
  } else {
    if (!args.searchInput || !args.company) throw new Error("Supply --job-id or both --search-input and --company.");
    if (!deps.discover) throw new Error("No discovery dependency is configured.");
    const discovered = await deps.discover(args);
    job = discovered.job;
    searchRunId = discovered.searchRunId;
    browserClosed = discovered.browserClosed;
    evidencePaths = discovered.evidencePaths;
  }
  return processCanonicalJob({ args, job, searchRunId, searchBrowserClosed: browserClosed, searchEvidencePaths: evidencePaths, verifiedInputs, dependencies: deps });
}

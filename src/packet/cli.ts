import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCandidateProfile } from "../domain/candidate-profile.js";
import { closePersistentChrome } from "../browser/launcher.js";
import { launchManagedChrome, resolveBrowserProfileDir } from "../browser/managed.js";
import { createRunEventLog } from "../events/run-events.js";
import { parsePipelineArgs } from "../pipeline/cli.js";
import { runPipeline } from "../pipeline/run.js";
import { loadJobs, saveJobs } from "../storage/job-store.js";
import { appendApproval } from "./approvals.js";
import { buildPacket, packetDirFor, type FormEvidenceFile, type OfficialVerificationFile, type Packet } from "./build.js";
import { greenhouseFormUrl } from "./form-fill.js";
import { installNetworkGuard, prepareApplicationForm } from "./form-session.js";
import { fetchGreenhouseJob, OfficialJobError, parseGreenhouseIdentity, refreshJobFromOfficial } from "./official-job.js";
import type { ApprovalKind } from "./readiness.js";

// npm run packet -- <command> [options]
//   verify-job    re-verify the posting against the employer's board API and refresh the saved job (read-only network)
//   inspect-form  open the real application form in headed Chrome, verify it, inspect and plan it; writes nothing
//   fill-form     as above, then write ONLY approved answers and read them back (needs the approval gates; never submits)
//   build         (re)build the evidence packet from what exists
//   approve       record YOUR review decision for the current exact hashes
//   status        print readiness
//   run           verify-job, pipeline, inspect-form, build
// Nothing in this tool submits an application.

interface Args {
  command: string;
  jobId?: string;
  ats?: string;
  sourceStore?: string;
  dataDir: string;
  outputDir: string;
  packetRoot: string;
  profilePath: string;
  registryPath: string;
  policyPath: string;
  browserProfileDir?: string;
  kind?: ApprovalKind;
  reviewer?: string;
  note?: string;
  confirm?: string;
  allowWrite: string[];
  ollamaUrl: string;
  model: string;
}

export function parsePacketArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? "",
    dataDir: "private-runtime/application-data",
    outputDir: "private-runtime/job-specific",
    packetRoot: "private-runtime/application-packets",
    profilePath: "private-runtime/candidate/candidate-profile.reviewed-2.json",
    registryPath: "private-runtime/candidate/canonical-resume-registry.json",
    policyPath: "private-runtime/candidate/resume-policy.json",
    allowWrite: [],
    ollamaUrl: "http://127.0.0.1:11435",
    model: "qwen2.5:3b-instruct-q4_K_M",
  };
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = (): string => argv[++i] ?? "";
    if (flag === "--job-id") a.jobId = next();
    else if (flag === "--ats") a.ats = next();
    else if (flag === "--source-store") a.sourceStore = next();
    else if (flag === "--data-dir") a.dataDir = next();
    else if (flag === "--output-dir") a.outputDir = next();
    else if (flag === "--packet-root") a.packetRoot = next();
    else if (flag === "--profile") a.profilePath = next();
    else if (flag === "--registry") a.registryPath = next();
    else if (flag === "--policy") a.policyPath = next();
    else if (flag === "--browser-profile") a.browserProfileDir = next();
    else if (flag === "--kind") a.kind = next() as ApprovalKind;
    else if (flag === "--reviewer") a.reviewer = next();
    else if (flag === "--note") a.note = next();
    else if (flag === "--confirm") a.confirm = next();
    else if (flag === "--allow-write-url") a.allowWrite.push(next());
    else if (flag === "--ollama-url") a.ollamaUrl = next();
    else if (flag === "--model") a.model = next();
  }
  return a;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function verifyJob(a: Args): Promise<{ jobId: string; verification: OfficialVerificationFile }> {
  const now = new Date().toISOString();
  let saved = a.jobId ? loadJobs(path.join(a.dataDir, "jobs.jsonl")).find((j) => j.id === a.jobId) : undefined;
  if (!saved && a.ats && a.sourceStore) saved = loadJobs(a.sourceStore).find((j) => j.atsIdentity === a.ats);
  if (!saved) throw new Error("The job was not found. Give --job-id for a job already in --data-dir, or --ats with --source-store.");
  const { board, jobId } = parseGreenhouseIdentity(saved.atsIdentity);
  const packetDir = packetDirFor(a.packetRoot, saved.id);
  const evidenceFile = path.join(packetDir, "evidence", "official-job-verification.json");
  try {
    const fetched = await fetchGreenhouseJob(board, jobId);
    const refreshed = refreshJobFromOfficial(saved, fetched);
    const others = loadJobs(path.join(a.dataDir, "jobs.jsonl")).filter((j) => j.id !== saved!.id);
    saveJobs(path.join(a.dataDir, "jobs.jsonl"), [...others, refreshed.job]);
    const verification: OfficialJobFile = { verifiedAt: now, apiUrl: refreshed.evidence.apiUrl, responseSha256: refreshed.evidence.responseSha256, officialUpdatedAt: refreshed.evidence.officialUpdatedAt, officialUrl: refreshed.evidence.officialUrl, postingLive: true, jdHash: refreshed.job.jdContentHash!, jdChanged: refreshed.jdChanged, previousJdHash: refreshed.previousJdHash };
    writeJson(evidenceFile, verification);
    return { jobId: saved.id, verification };
  } catch (error) {
    if (error instanceof OfficialJobError && error.code === "POSTING_CLOSED") {
      const verification: OfficialJobFile = { verifiedAt: now, apiUrl: "", responseSha256: "", officialUpdatedAt: null, officialUrl: saved.canonicalUrl, postingLive: false, jdHash: saved.jdContentHash ?? "", jdChanged: false, previousJdHash: saved.jdContentHash ?? null };
      writeJson(evidenceFile, verification);
      return { jobId: saved.id, verification };
    }
    throw error;
  }
}
type OfficialJobFile = OfficialVerificationFile;

async function withForm(a: Args, write: boolean): Promise<FormEvidenceFile> {
  if (!a.jobId) throw new Error("--job-id is required");
  const job = loadJobs(path.join(a.dataDir, "jobs.jsonl")).find((j) => j.id === a.jobId);
  if (!job || !job.jdContentHash) throw new Error("The job is not in the data directory.");
  const { board, jobId } = parseGreenhouseIdentity(job.atsIdentity);
  const packetDir = packetDirFor(a.packetRoot, job.id);
  const profile = parseCandidateProfile(JSON.parse(readFileSync(a.profilePath, "utf8")));
  const asOf = new Date().toISOString().slice(0, 10);

  // Gates are read from the packet as built from current evidence, never from the command line.
  const before: Packet = await buildPacket({ jobId: job.id, dataDir: a.dataDir, outputDir: a.outputDir, packetRoot: a.packetRoot, profilePath: a.profilePath, asOf, resumePolicyPath: a.policyPath });
  const valid = new Set(before.readiness.validApprovals);
  const decisionOutcome = JSON.parse(readFileSync(path.join(packetDir, "eligibility.json"), "utf8")).outcome as string | null;
  const verified = before.readiness.satisfied.includes("JD_VERIFIED");
  const resumeReady = !!before.hashes.resumeSha256 && before.counts.unsupportedClaims === 0;
  const gatesToWrite = write && verified && decisionOutcome !== null && decisionOutcome !== "REJECT" && (decisionOutcome === "ELIGIBLE" || valid.has("eligibility")) && before.readiness.state !== "BLOCKED";
  const pdfPath = (() => { try { return JSON.parse(readFileSync(path.join(packetDir, "resume-claim-map.json"), "utf8")).resume?.path as string | undefined; } catch { return undefined; } })();
  const resume = resumeReady && pdfPath && before.hashes.resumeSha256 ? { sha256: before.hashes.resumeSha256, fileName: path.basename(pdfPath), path: pdfPath, approved: valid.has("resume") } : null;
  if (write && !gatesToWrite) console.log("Write gates are not satisfied (JD verified, eligibility ELIGIBLE or applicant-approved, no hard blocker); inspecting read-only.");

  const profileDir = path.resolve(a.browserProfileDir ?? resolveBrowserProfileDir());
  const context = await launchManagedChrome(profileDir, { headless: false, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  try {
    const guard = await installNetworkGuard(context, a.allowWrite);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(greenhouseFormUrl(board, jobId), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.locator("input, select, textarea").first().waitFor({ timeout: 15_000 });
    mkdirSync(path.join(packetDir, "evidence"), { recursive: true });
    const evidence = await prepareApplicationForm({ page, expected: { company: job.company, title: job.title, board, jobId }, profile, asOf, jdHash: job.jdContentHash, resume, write: gatesToWrite });
    if (!evidence.fill) await page.screenshot({ path: path.join(packetDir, "evidence", "form-blank.png"), fullPage: true });
    writeJson(path.join(packetDir, "evidence", "form-evidence.json"), { ...evidence, networkGuard: { blockedWrites: guard.blockedWrites.length, allowedWritePatterns: guard.allowedWritePatterns } });
    return evidence;
  } finally {
    await closePersistentChrome(context, profileDir);
  }
}

function boundFor(kind: ApprovalKind, p: Packet): Record<string, string> | { error: string } {
  const h = p.hashes;
  const need = (pairs: Record<string, string | null>): Record<string, string> | { error: string } => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pairs)) { if (!v) return { error: `Nothing to approve yet: ${k} does not exist.` }; out[k] = v; }
    return out;
  };
  if (kind === "eligibility") return need({ jdHash: h.jdHash, profileDigest: h.profileDigest });
  if (kind === "resume") return p.counts.unsupportedClaims === 0 ? need({ jdHash: h.jdHash, resumeSha256: h.resumeSha256 }) : { error: "The resume has unsupported claims or was not checked; it cannot be approved." };
  if (kind === "form") return need({ jdHash: h.jdHash, formFingerprint: h.formFingerprint, answersDigest: h.answersDigest, resumeSha256: h.resumeSha256 });
  return need({ jdHash: h.jdHash, profileDigest: h.profileDigest, resumeSha256: h.resumeSha256, formFingerprint: h.formFingerprint, answersDigest: h.answersDigest });
}

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const a = parsePacketArgs(argv);
  const asOf = new Date().toISOString().slice(0, 10);
  const build = (jobId: string) => buildPacket({ jobId, dataDir: a.dataDir, outputDir: a.outputDir, packetRoot: a.packetRoot, profilePath: a.profilePath, asOf, resumePolicyPath: a.policyPath });
  const summary = (p: Packet) => log(`Readiness: ${p.readiness.state}${p.readiness.blockers.length ? ` | ${p.readiness.blockers.length} blocker(s)` : ""} | submitted: no | packet: ${p.packetDir}`);
  try {
    if (a.command === "verify-job") {
      const r = await verifyJob(a);
      log(`Posting live: ${r.verification.postingLive}; JD ${r.verification.jdHash.slice(0, 12)}…; changed since stored: ${r.verification.jdChanged}; job id ${r.jobId}`);
      return r.verification.postingLive ? 0 : 3;
    }
    if (a.command === "inspect-form" || a.command === "fill-form") {
      const e = await withForm(a, a.command === "fill-form");
      log(`Target check: ${e.target.ok ? "OK" : `FAILED (${e.target.reasons.join("; ")})`}; controls planned: ${e.plan.entries.length}; answerable: ${e.plan.entries.filter((x) => x.disposition === "ANSWER" || x.disposition === "UPLOAD").length}; required but unresolved: ${e.plan.blockers.length}; fill: ${e.fill ? e.fill.state : "not performed"}`);
      summary(await build(a.jobId!));
      return e.target.ok ? 0 : 4;
    }
    if (a.command === "build" || a.command === "status") {
      if (!a.jobId) throw new Error("--job-id is required");
      const p = await build(a.jobId);
      summary(p);
      if (a.command === "status") for (const b of p.readiness.blockers) log(`  - ${b}`);
      return 0;
    }
    if (a.command === "approve") {
      if (!a.jobId || !a.kind || !a.reviewer) throw new Error("--job-id, --kind (eligibility|resume|form|final) and --reviewer are required");
      if (a.confirm !== "I-HAVE-REVIEWED-THIS") throw new Error('Approval records your own decision. Review packet files first, then pass --confirm I-HAVE-REVIEWED-THIS.');
      const p = await build(a.jobId);
      const bound = boundFor(a.kind, p);
      if ("error" in bound) throw new Error(bound.error);
      appendApproval(p.packetDir, { kind: a.kind, reviewer: a.reviewer, reviewedAt: new Date().toISOString(), bound, ...(a.note ? { note: a.note } : {}) });
      summary(await build(a.jobId));
      return 0;
    }
    if (a.command === "run") {
      if (!a.ats || !a.sourceStore) throw new Error("run needs --ats <greenhouse:board:id> and --source-store <jobs.jsonl>");
      const v = await verifyJob(a);
      log(`Posting live: ${v.verification.postingLive}`);
      if (!v.verification.postingLive) { summary(await build(v.jobId)); return 3; }
      const args = parsePipelineArgs(["--mode", "live", "--job-id", v.jobId, "--provider", "ollama", "--ollama-url", a.ollamaUrl, "--model", a.model, "--context-tokens", "8192", "--output-tokens", "2048", "--timeout-ms", "240000", "--data-dir", a.dataDir, "--evidence-dir", path.join(a.packetRoot, v.jobId, "pipeline-evidence"), "--output-dir", a.outputDir, "--profile", a.profilePath, "--registry", a.registryPath]);
      const result = await runPipeline(args, { events: createRunEventLog("pipeline") });
      log(`Pipeline outcome: ${result.outcome}; decision: ${result.decision?.outcome ?? "none"}`);
      a.jobId = v.jobId;
      const e = await withForm(a, false);
      log(`Form target OK: ${e.target.ok}; controls: ${e.plan.entries.length}; unresolved required: ${e.plan.blockers.length}`);
      summary(await build(v.jobId));
      return 0;
    }
    log("usage: packet <verify-job|inspect-form|fill-form|build|status|approve|run> [options]  (see docs/V1-GOLDEN-PATH.md)");
    return 2;
  } catch (error) {
    console.error(`packet ${a.command} failed: ${error instanceof Error ? error.name + ": " + error.message.slice(0, 300) : "error"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}


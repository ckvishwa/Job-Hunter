import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JobPosting } from "../adapters/types.js";
import type { Decision } from "../decision/evaluate.js";
import { parseCandidateProfile, profileDigest, type CandidateProfile } from "../domain/candidate-profile.js";
import type { StructuredJob } from "../domain/structured-job.js";
import type { ResumePlan } from "../pipeline/resume-plan.js";
import { loadJobs } from "../storage/job-store.js";
import { loadStructuredJobs } from "../storage/structured-store.js";
import { loadApprovals } from "./approvals.js";
import type { FillResult } from "./form-fill.js";
import type { FormPlan } from "./form-plan.js";
import type { ApplicationInspection } from "../pipeline/application-form.js";
import { findJdClauses, type JdClause } from "./jd-clauses.js";
import { extractPdfText } from "./pdf-text.js";
import { evaluateReadiness, type ReadinessEvidence, type ReadinessResult } from "./readiness.js";
import { buildClaimMap, type ClaimMap } from "./resume-claims.js";

// Builds the application evidence packet for one job from artifacts that already exist (saved job, pipeline run,
// resume plan and PDF, form inspection/plan/fill, human approvals). It reads, derives and writes the packet; it
// performs no browser action and no network request. Every statement carries a basis: VERIFIED (matches source
// text or an approved record), INFERENCE (model- or heuristic-derived) or UNKNOWN (nothing supports it).

export type Basis = "VERIFIED" | "INFERENCE" | "UNKNOWN";

export interface BuildPacketInput {
  jobId: string;
  dataDir: string;
  /** Pipeline output root: <outputDir>/<jobId>/<jdHash>/ */
  outputDir: string;
  packetRoot: string;
  profilePath: string;
  asOf: string;
  now?: () => string;
  /** Private JSON file {"excludedTerms": string[]} naming experience that must never appear on the resume. */
  resumePolicyPath?: string;
}

export interface FormEvidenceFile {
  capturedAt: string;
  /** The observed controls (form structure only: labels, types, options; never applicant data). */
  inspection: ApplicationInspection;
  jdHash: string;
  plan: FormPlan;
  resume: { sha256: string; fileName: string; approved: boolean } | null;
  target: { ok: boolean; reasons: string[]; url: string };
  fill: FillResult | null;
}

export interface OfficialVerificationFile {
  verifiedAt: string;
  apiUrl: string;
  responseSha256: string;
  officialUpdatedAt: string | null;
  officialUrl: string;
  postingLive: boolean;
  jdHash: string;
  jdChanged: boolean;
  previousJdHash: string | null;
}

export interface Packet {
  schemaVersion: 1;
  generatedAt: string;
  packetDir: string;
  job: { id: string; company: string; title: string; location: string | null; atsIdentity: string | null; officialUrl: string; applyUrl: string; jdHash: string | null; descriptionChars: number };
  readiness: ReadinessResult;
  submission: { status: "NOT_SUBMITTED"; submitCount: 0; note: string };
  hashes: { jdHash: string | null; profileDigest: string; resumeSha256: string | null; formFingerprint: string | null; answersDigest: string | null; structuredId: string | null };
  files: Record<string, string>;
  counts: { requiredRequirements: number; preferredRequirements: number; eligibilityRulesUnknown: number; formQuestionsUnresolved: number; resumeClaims: number; unsupportedClaims: number | null };
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function packetDirFor(packetRoot: string, jobId: string): string {
  return path.join(packetRoot, jobId);
}

function requirementsFile(job: JobPosting, structured: StructuredJob | null, clauses: JdClause[], decision: Decision | null) {
  const reqs = structured?.requirements ?? [];
  const rule = (id: string) => decision?.rules.find((r) => r.subject.kind === "requirement" && r.subject.id === id);
  const view = (r: StructuredJob["requirements"][number]) => ({
    id: r.id,
    type: r.type,
    value: r.value,
    level: r.level,
    minimumYears: r.minimumYears,
    scope: r.scope,
    groupId: r.groupId,
    evidence: r.evidence,
    basis: "INFERENCE" as Basis,
    basisNote: "Model-extracted; the quote and offsets were validated as an exact substring of the saved JD, the interpretation was not independently reviewed.",
    decision: rule(r.id) ? { status: rule(r.id)!.status, factIds: rule(r.id)!.factIds } : null,
  });
  return {
    schemaVersion: 1,
    jobId: job.id,
    jdHash: job.jdContentHash,
    structuredId: structured?.id ?? null,
    extraction: structured ? { providerRevision: structured.providerRevision, parserVersion: structured.parserVersion, validationStatus: structured.validationStatus, warnings: structured.warnings } : null,
    required: reqs.filter((r) => r.level === "required").map(view),
    preferred: reqs.filter((r) => r.level === "preferred").map(view),
    unclearLevel: reqs.filter((r) => r.level !== "required" && r.level !== "preferred").map(view),
    constraints: structured?.constraints ?? [],
    alternativeGroups: structured?.alternativeGroups ?? [],
    jdTextClauses: clauses.map((c) => ({ ...c, basis: "VERIFIED" as Basis, basisNote: "Exact substring of the saved JD located by a deterministic text rule." })),
  };
}

function eligibilityFile(job: JobPosting, decision: Decision | null, clauses: JdClause[], coverage: unknown) {
  return {
    schemaVersion: 1,
    jobId: job.id,
    jdHash: job.jdContentHash,
    outcome: decision?.outcome ?? null,
    decisionId: decision?.id ?? null,
    policyVersion: decision?.policyVersion ?? null,
    profileDigest: decision?.profileDigest ?? null,
    coverage: decision ? decision.extraction : null,
    extractionCoverageDiagnostic: coverage,
    rules: (decision?.rules ?? []).map((r) => ({
      ruleId: r.ruleId,
      subject: r.subject,
      mandatory: r.mandatory,
      status: r.status,
      explanation: r.explanation,
      factIds: r.factIds,
      evidence: r.evidence,
      basis: (r.status === "PASS" && r.factIds.length > 0 ? "VERIFIED" : r.status === "UNKNOWN" ? "UNKNOWN" : "VERIFIED") as Basis,
    })),
    jdStatedClausesNeedingApplicantFacts: clauses
      .filter((c) => c.kind === "work_authorization_required" || c.kind === "sponsorship_unavailable" || c.kind === "clearance_required" || c.kind === "export_control_authorization")
      .map((c) => ({ kind: c.kind, quote: c.quote, start: c.start, end: c.end, candidateFactStatus: "UNKNOWN" as Basis, note: "The JD states this; whether the applicant satisfies it is established only by an approved candidate fact. None is assumed." })),
    unresolvedQuestions: decision?.unresolvedQuestions ?? [],
    recordedStatements: decision?.recordedStatements ?? [],
  };
}

export async function buildPacket(input: BuildPacketInput): Promise<Packet> {
  const now = input.now ?? (() => new Date().toISOString());
  const job = loadJobs(path.join(input.dataDir, "jobs.jsonl")).find((j) => j.id === input.jobId);
  if (!job) throw new Error("The job is not in the data directory's jobs.jsonl.");
  const packetDir = packetDirFor(input.packetRoot, job.id);
  mkdirSync(path.join(packetDir, "evidence"), { recursive: true });
  const profile: CandidateProfile = parseCandidateProfile(JSON.parse(readFileSync(input.profilePath, "utf8")));
  const digest = profileDigest(profile);
  const jdHash = job.jdContentHash ?? null;

  const verification = readJson<OfficialVerificationFile>(path.join(packetDir, "evidence", "official-job-verification.json"));
  const formEvidence = readJson<FormEvidenceFile>(path.join(packetDir, "evidence", "form-evidence.json"));
  const runDir = jdHash ? path.join(input.outputDir, job.id, jdHash) : null;
  const checkpoint = runDir ? readJson<{ stages: Record<string, any>; outcome: string }>(path.join(runDir, "pipeline-checkpoint.json")) : null;
  const decision: Decision | null = checkpoint?.stages.decision?.decision ?? null;
  const structured = decision ? (loadStructuredJobs(path.join(input.dataDir, "structured-jobs.jsonl")).find((s) => s.id === decision.structuredId) ?? null) : null;
  const plan = runDir ? readJson<ResumePlan>(path.join(runDir, "resume-plan.json")) : null;
  const pdfPath = checkpoint?.stages.resumePlan?.pdfPath as string | undefined;
  const coverage = runDir ? readJson<unknown>(path.join(runDir, "extraction-coverage-review.json")) : null;
  const clauses = findJdClauses(job.descriptionText, job.location);

  // Resume artifact: the file on disk is the authority for its hash; the checkpoint's claim must agree.
  let resumeSha: string | null = null;
  let claimMap: ClaimMap | null = null;
  let artifactNote: string | null = null;
  if (plan && pdfPath && existsSync(pdfPath)) {
    resumeSha = sha256(readFileSync(pdfPath));
    if (checkpoint?.stages.resumePlan?.artifactSha256 !== resumeSha) artifactNote = "The resume file on disk does not match the hash recorded by the pipeline; it was changed after rendering.";
    const policy = input.resumePolicyPath && existsSync(input.resumePolicyPath) ? (readJson<{ excludedTerms?: string[] }>(input.resumePolicyPath)?.excludedTerms ?? []) : [];
    const text = (await extractPdfText(pdfPath)).text;
    claimMap = buildClaimMap({ plan, profile, asOf: input.asOf, decision, extractedText: text, job: { company: job.company, title: job.title }, excludedTerms: policy });
    if (artifactNote) claimMap.unsupportedCount += 1;
  }

  const approvals = loadApprovals(packetDir);
  const fill = formEvidence?.fill ?? null;
  const evidence: ReadinessEvidence = {
    job: { discovered: true, postingLive: verification ? verification.postingLive : null, jdHash, jdVerified: !!verification && verification.jdHash === jdHash },
    eligibility: {
      outcome: decision?.outcome ?? null,
      decidedForJdHash: decision?.jdHash ?? null,
      profileDigest: decision?.profileDigest ?? null,
      currentProfileDigest: digest,
      coverageAttested: decision?.extraction.coverage === "complete" && !!decision.extraction.reviewedBy,
    },
    resume: { prepared: !!plan && !!resumeSha, sha256: resumeSha, preparedForJdHash: plan?.jdHash ?? null, unsupportedClaims: claimMap ? claimMap.unsupportedCount : null, previewOnly: plan?.previewOnly ?? true },
    form: {
      prepared: !!formEvidence && formEvidence.target.ok,
      verified: !!fill && fill.state !== "BLOCKED" && fill.mismatches.length === 0 && (fill.fields.length > 0 || !!fill.upload),
      formFingerprint: formEvidence?.plan.formFingerprint ?? null,
      answersDigest: formEvidence?.plan.answersDigest ?? null,
      requiredUnresolved: formEvidence?.plan.blockers.length ?? 0,
      mismatches: fill ? fill.mismatches.length : 0,
      preparedForJdHash: formEvidence?.jdHash ?? null,
      resumeSha256: formEvidence?.resume?.sha256 ?? null,
    },
    approvals,
    submission: { independentEvidence: false },
  };
  const readiness = evaluateReadiness(evidence);

  // ---- files
  const files = {
    job: "job.json",
    requirements: "requirements.json",
    eligibility: "eligibility.json",
    resumeClaimMap: "resume-claim-map.json",
    formAnswers: "form-answers.json",
    reviewQuestions: "review-questions.json",
    packet: "application-packet.json",
    report: "application-packet.md",
    evidence: "evidence/",
  };
  writeJson(path.join(packetDir, files.job), {
    schemaVersion: 1,
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    atsIdentity: job.atsIdentity,
    requisitionId: job.requisitionId,
    officialUrl: job.canonicalUrl,
    applyUrl: job.applyUrl,
    jdHash,
    descriptionChars: job.descriptionText.length,
    jdVerification: verification ? { ...verification, basis: "VERIFIED" } : { basis: "UNKNOWN", note: "The posting has not been re-verified against the official source." },
    sourceObservations: job.sourceObservations ?? [],
  });
  writeFileSync(path.join(packetDir, "evidence", "job-description.txt"), job.descriptionText, "utf8");
  writeJson(path.join(packetDir, files.requirements), requirementsFile(job, structured, clauses, decision));
  writeJson(path.join(packetDir, files.eligibility), eligibilityFile(job, decision, clauses, coverage));
  writeJson(path.join(packetDir, files.resumeClaimMap), claimMap ? { ...claimMap, artifactNote, resume: { path: pdfPath ?? null, sha256: resumeSha, previewOnly: plan?.previewOnly ?? true } } : { schemaVersion: 1, note: "No resume has been prepared for the current job description." });
  if (pdfPath && existsSync(pdfPath)) copyFileSync(pdfPath, path.join(packetDir, "evidence", path.basename(pdfPath)));
  const answers = formEvidence?.plan.entries.filter((e) => e.disposition === "ANSWER" || e.disposition === "UPLOAD").map((e) => {
    const proof = fill?.fields.find((f) => f.controlId === e.controlId);
    return { controlId: e.controlId, label: e.label, disposition: e.disposition, category: e.category, expected: e.disposition === "ANSWER" ? e.expected : `resume file ${e.expected}`, factId: e.factId ?? null, basis: "VERIFIED" as Basis, basisNote: "Supplied by an approved, current candidate fact or the approved resume.", browser: proof ? { before: proof.before, actual: proof.actual, verified: proof.verified } : fill?.upload && e.disposition === "UPLOAD" ? { verified: fill.upload.verified, pageFileName: fill.upload.pageFileName, pageBytes: fill.upload.pageBytes } : null };
  }) ?? [];
  writeJson(path.join(packetDir, files.formAnswers), { schemaVersion: 1, formFingerprint: evidence.form.formFingerprint, answersDigest: evidence.form.answersDigest, formTarget: formEvidence?.target ?? null, answers, browserFill: fill, note: formEvidence ? undefined : "The application form has not been inspected." });
  const review = [
    ...(decision?.unresolvedQuestions ?? []).map((q) => ({ source: "eligibility", question: q, owner: "applicant" })),
    ...(formEvidence?.plan.entries.filter((e) => e.required && (e.disposition === "HUMAN_REVIEW" || e.disposition === "UNRESOLVED")).map((e) => ({ source: "form", question: `${e.label || e.controlId}`, reason: e.reason ?? "", category: e.category, owner: "applicant" })) ?? []),
    ...clauses.filter((c) => c.kind === "work_authorization_required" || c.kind === "sponsorship_unavailable").map((c) => ({ source: "jd", question: `The job description states: "${c.quote}" Does an approved fact establish that you satisfy this?`, owner: "applicant" })),
    ...readiness.reviewsOutstanding.map((k) => ({ source: "approval", question: `Review and approve: ${k}`, owner: "applicant" })),
  ];
  writeJson(path.join(packetDir, files.reviewQuestions), { schemaVersion: 1, questions: review });

  const unknownRules = decision?.rules.filter((r) => r.status === "UNKNOWN").length ?? 0;
  const packet: Packet = {
    schemaVersion: 1,
    generatedAt: now(),
    packetDir,
    job: { id: job.id, company: job.company, title: job.title, location: job.location, atsIdentity: job.atsIdentity ?? null, officialUrl: job.canonicalUrl, applyUrl: job.applyUrl, jdHash, descriptionChars: job.descriptionText.length },
    readiness,
    submission: { status: "NOT_SUBMITTED", submitCount: 0, note: "Nothing in this workflow submits an application. Only you press Submit, after reviewing the live form." },
    hashes: { jdHash, profileDigest: digest, resumeSha256: resumeSha, formFingerprint: evidence.form.formFingerprint, answersDigest: evidence.form.answersDigest, structuredId: decision?.structuredId ?? null },
    files,
    counts: { requiredRequirements: structured?.requirements.filter((r) => r.level === "required").length ?? 0, preferredRequirements: structured?.requirements.filter((r) => r.level === "preferred").length ?? 0, eligibilityRulesUnknown: unknownRules, formQuestionsUnresolved: evidence.form.requiredUnresolved, resumeClaims: claimMap?.claims.length ?? 0, unsupportedClaims: claimMap ? claimMap.unsupportedCount : null },
  };
  writeJson(path.join(packetDir, files.packet), packet);
  writeFileSync(path.join(packetDir, files.report), renderReport(packet, { decision, claimMap, formEvidence, verification, review, clauses, approvalsInvalid: readiness.invalidatedApprovals }), "utf8");
  return packet;
}

function renderReport(packet: Packet, ctx: { decision: Decision | null; claimMap: ClaimMap | null; formEvidence: FormEvidenceFile | null; verification: OfficialVerificationFile | null; review: Array<{ question: string; source: string }>; clauses: JdClause[]; approvalsInvalid: string[] }): string {
  const r = packet.readiness;
  const lines: string[] = [];
  lines.push(`# Application packet: ${packet.job.company} — ${packet.job.title}`, "");
  lines.push(`**Readiness: \`${r.state}\`.** Submission status: **NOT SUBMITTED** (submit count 0). Only you press Submit.`, "");
  lines.push("Basis legend: **VERIFIED** (matches source text or an approved record), **INFERENCE** (model or heuristic derived), **UNKNOWN** (nothing supports it).", "");
  lines.push("## 1. Official employer and job reference", `- Job: ${packet.job.title} at ${packet.job.company}; location: ${packet.job.location ?? "not stated"}`, `- ATS identity: \`${packet.job.atsIdentity}\``, `- Official posting: ${packet.job.officialUrl}`, `- Apply URL: ${packet.job.applyUrl}`, "");
  lines.push("## 2. Job description source and version", `- JD SHA-256: \`${packet.job.jdHash}\` (${packet.job.descriptionChars} characters)`);
  lines.push(ctx.verification ? `- **VERIFIED** against the employer's board API at ${ctx.verification.verifiedAt}: posting live = ${ctx.verification.postingLive}; response sha256 \`${ctx.verification.responseSha256.slice(0, 16)}…\`; JD changed since stored: ${ctx.verification.jdChanged}` : "- **UNKNOWN**: not re-verified against the official source.", "");
  lines.push("## 3. Requirements", `- Required: ${packet.counts.requiredRequirements}; preferred: ${packet.counts.preferredRequirements} (**INFERENCE**: model-extracted, quotes validated against the JD; see \`requirements.json\`).`, "");
  lines.push("## 4. Eligibility decision", `- Deterministic outcome: **${ctx.decision?.outcome ?? "none"}** (rules unknown: ${packet.counts.eligibilityRulesUnknown}). Coverage review: ${ctx.decision?.extraction.coverage ?? "n/a"}.`);
  for (const c of ctx.clauses.filter((x) => x.kind === "work_authorization_required" || x.kind === "sponsorship_unavailable" || x.kind === "clearance_required")) lines.push(`- The JD states (**VERIFIED** text): "${c.quote}" — whether you satisfy it is **UNKNOWN** until an approved fact says so.`);
  lines.push("");
  lines.push("## 5. Candidate facts used", ...(ctx.claimMap?.claims.length ? ctx.claimMap.claims.map((c) => `- \`${c.factId}\` (${c.factKind}) approved by ${c.approvedBy ?? "?"} on ${c.approvedAt ?? "?"}`) : ["- none"]), "");
  lines.push("## 6. Tailored resume", ctx.claimMap ? `- SHA-256 \`${packet.hashes.resumeSha256}\`; unsupported claims: **${packet.counts.unsupportedClaims}**; status: ${packet.readiness.blockers.some((b) => /review preview/.test(b)) ? "review preview only (not application-ready)" : "application-ready candidate"}.` : "- none prepared", "");
  lines.push("## 7. Resume claim provenance", ...(ctx.claimMap?.claims.map((c) => `- ${c.claimId}: fact \`${c.factId}\` — source ${c.source?.reference ?? "?"}${c.source?.locator ? `, ${c.source.locator}` : ""}; supported: ${c.supported}`) ?? ["- n/a"]), "");
  lines.push("## 8. Proposed form answers", ...(ctx.formEvidence ? [`- ${ctx.formEvidence.plan.entries.filter((e) => e.disposition === "ANSWER" || e.disposition === "UPLOAD").length} answerable control(s) of ${ctx.formEvidence.plan.entries.length} observed (see \`form-answers.json\`).`] : ["- form not inspected"]), "");
  lines.push("## 9. Missing or uncertain answers", ...(ctx.review.length ? ctx.review.map((q) => `- [${q.source}] ${q.question}`) : ["- none"]), "");
  lines.push("## 10. Browser execution and readback", ctx.formEvidence?.fill ? `- State \`${ctx.formEvidence.fill.state}\`; fields verified ${ctx.formEvidence.fill.fields.filter((f) => f.verified).length}/${ctx.formEvidence.fill.fields.length}; mismatches ${ctx.formEvidence.fill.mismatches.length}.` : ctx.formEvidence ? `- Read-only inspection done; target check ${ctx.formEvidence.target.ok ? "passed" : "FAILED"}; no field was written.` : "- no browser run recorded", "");
  lines.push("## 11. Final review readiness", `- State: **${r.state}**`, ...r.blockers.map((b) => `- Blocker: ${b}`), ...r.reviewsOutstanding.map((k) => `- Review outstanding: ${k}`), ...ctx.approvalsInvalid.map((a) => `- Void approval: ${a}`), "");
  lines.push("## 12. Submission status", "- **NOT SUBMITTED.** `READY_TO_SUBMIT` would only mean the evidence supports your final review; it never means submitted.", "");
  return lines.join("\n");
}

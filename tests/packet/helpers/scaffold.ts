import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JobPosting } from "../../../src/adapters/types.js";
import { evaluateJob, structuredExtractionDigest } from "../../../src/decision/evaluate.js";
import { profileDigest, type CandidateFact } from "../../../src/domain/candidate-profile.js";
import { buildAndRenderResumePlan } from "../../../src/pipeline/resume-plan.js";
import { loadVerifiedInputs } from "../../../src/pipeline/trust.js";
import { saveJobs } from "../../../src/storage/job-store.js";
import { upsertStructuredJob } from "../../../src/storage/structured-store.js";
import type { FormEvidenceFile, OfficialVerificationFile } from "../../../src/packet/build.js";
import type { FillResult } from "../../../src/packet/form-fill.js";
import { planForm } from "../../../src/packet/form-plan.js";
import { JD_HASH, fact, job as structuredJob, profile, review } from "../../helpers/decision-fixtures.js";
import { buildDocx } from "../../helpers/docx.js";

// A complete synthetic workspace for the packet builder: saved job, structured job, deterministic decision, rendered
// resume plan and PDF, pipeline checkpoint, official-verification evidence and a verified form-fill record. Nothing
// private, nothing external. The browser pieces are covered separately by form-fill.e2e.test.ts.

export const SENTINEL_EMAIL = "sentinel.person@example.test";
export const AS_OF = "2026-10-07";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const FACTS: CandidateFact[] = [
  fact({ factId: "f-job", kind: "employment", value: "Example Corp — QA Tester", attributes: { employer: "Example Corp", title: "QA Tester", startDate: "2020-03", endDate: "2022-06", roleTags: ["QA"], detail: "Tested web applications and wrote regression suites." }, source: { kind: "user-statement", reference: "resume.docx", locator: "paragraph 3" } }),
  fact({ factId: "f-py", kind: "skill", value: "Python", attributes: { detail: "Wrote Python test scripts for APIs." }, source: { kind: "user-statement", reference: "resume.docx", locator: "paragraph 9" } }),
  fact({ factId: "f-name", kind: "legal_name", value: "Sam Q Sentinel", attributes: { givenName: "Sam", familyName: "Sentinel" } }),
  fact({ factId: "f-email", kind: "email", value: SENTINEL_EMAIL }),
];

export interface Workspace {
  dir: string;
  dataDir: string;
  outputDir: string;
  packetRoot: string;
  profilePath: string;
  policyPath: string;
  jobId: string;
  jdHash: string;
  pdfPath: string;
  jobsPath: string;
  packetDir: string;
}

export async function makeWorkspace(options: { coverage?: "complete" | "partial"; withForm?: boolean; extraRequirements?: Array<Record<string, unknown>> } = {}): Promise<Workspace> {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-packet-"));
  const dataDir = path.join(dir, "data");
  const outputDir = path.join(dir, "output");
  const packetRoot = path.join(dir, "packets");
  mkdirSync(dataDir, { recursive: true });
  const write = (name: string, bytes: Buffer | string) => { const p = path.join(dir, name); writeFileSync(p, bytes); return { path: p, sha: sha(bytes).toUpperCase() }; };
  const prof = profile(FACTS);
  const profileFile = write("profile.json", JSON.stringify(prof));
  const pending = write("pending.json", "{}");
  const lanes: Record<string, unknown> = {};
  for (const lane of ["cybersecurity", "sdet", "cloud", "network"]) {
    const resume = write(`${lane}.docx`, buildDocx([`Example Corp\tMarch 2020 – June 2022`, "QA Tester"]));
    const cover = write(`${lane}-cover.docx`, buildDocx(["Cover letter"]));
    lanes[lane] = { resume: resume.path, coverLetter: cover.path, sha256Resume: resume.sha, sha256CoverLetter: cover.sha };
  }
  const registry = write("registry.json", JSON.stringify({ version: 1, status: "canonical", candidate: "synthetic", lanes, candidateProfile: { path: profileFile.path, sha256: profileFile.sha }, pendingFacts: { path: pending.path, sha256: pending.sha } }));
  const verifiedInputs = loadVerifiedInputs({ registryPath: registry.path, profilePath: profileFile.path, asOf: AS_OF });

  const jobId = "job-1";
  const job = {
    id: jobId, source: "boards", sourceType: "company-careers", company: "Acme", title: "QA Analyst", location: "Remote, US", remoteType: null, employmentType: null, department: null, requisitionId: "1",
    postingDate: null, discoveredAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-07T00:00:00Z", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1", applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
    descriptionText: "Acme needs a QA analyst who writes Python tests. We are only hiring those authorized to work in the United States. We do not currently sponsor immigration visas. 2+ years of testing experience is required.",
    descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: ["sdet"], discoveredFrom: ["boards"], schemaVersion: 1, jdContentHash: JD_HASH, extractedAt: "2026-10-07T00:00:00Z",
    resolutionStatus: "resolved", atsIdentity: "greenhouse:acme:1", rawMetadata: {},
  } as JobPosting;
  const jobsPath = path.join(dataDir, "jobs.jsonl");
  saveJobs(jobsPath, [job]);

  const structured = structuredJob({ requirements: [{ value: "Python", type: "skill" }, ...(options.extraRequirements ?? [])] as never });
  await upsertStructuredJob(path.join(dataDir, "structured-jobs.jsonl"), structured);
  const decision = evaluateJob({ structured, profile: prof, review: review({ coverage: options.coverage ?? "complete", jobId, structuredId: structured.id, extractionDigest: structuredExtractionDigest(structured) }), asOf: AS_OF, evaluatedAt: "2026-10-07T12:00:00.000Z" });
  const artifact = await buildAndRenderResumePlan({ job, lane: "sdet", decision, profileDigest: profileDigest(prof), verifiedInputs, factCandidates: [{ factId: "f-py" }], outputDir });
  const runDir = path.join(outputDir, jobId, JD_HASH);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "pipeline-checkpoint.json"), JSON.stringify({ schemaVersion: 1, outcome: "WAITING_FOR_USER", stages: { decision: { status: "DONE", outcome: decision.outcome, decision }, resumePlan: { status: artifact.plan.previewOnly ? "PREVIEW" : "VALIDATED", pdfPath: artifact.pdfPath, artifactSha256: artifact.sha256 } } }));

  const packetDir = path.join(packetRoot, jobId);
  mkdirSync(path.join(packetDir, "evidence"), { recursive: true });
  const verification: OfficialVerificationFile = { verifiedAt: "2026-10-07T00:00:00Z", apiUrl: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/1?content=true", responseSha256: "r".repeat(64).replace(/r/g, "1"), officialUpdatedAt: null, officialUrl: job.canonicalUrl, postingLive: true, jdHash: JD_HASH, jdChanged: false, previousJdHash: JD_HASH };
  writeFileSync(path.join(packetDir, "evidence", "official-job-verification.json"), JSON.stringify(verification));

  if (options.withForm !== false) {
    const control = (id: string, label: string, over: object = {}) => ({ id, label, help: "", type: "text", required: true, disabled: false, options: [], accept: null, role: null, ...over });
    const inspection = { url: "https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1", title: "Job Application for QA Analyst at Acme", controls: [control("first_name", "First Name*"), control("email", "Email*")], submitControls: 1, verificationDetected: false };
    const plan = planForm({ inspection, profile: prof, asOf: AS_OF, resume: { approved: true, fileName: path.basename(artifact.pdfPath), sha256: artifact.sha256 } });
    const fill: FillResult = {
      state: "FORM_VERIFIED", targetOk: true,
      fields: [{ controlId: "first_name", label: "First Name", factId: "f-name", expected: "Sam", before: "", actual: "Sam", verified: true, skippedBecauseAlreadyCorrect: false }, { controlId: "email", label: "Email", factId: "f-email", expected: SENTINEL_EMAIL, before: "", actual: SENTINEL_EMAIL, verified: true, skippedBecauseAlreadyCorrect: false }],
      upload: null, mismatches: [], unresolved: [], interrupted: null, submitControlsBefore: 1, submitControlsAfter: 1, formFingerprintBefore: plan.formFingerprint, formFingerprintAfter: plan.formFingerprint,
    };
    const evidence: FormEvidenceFile = { capturedAt: "2026-10-07T00:00:00Z", inspection, jdHash: JD_HASH, plan, resume: { sha256: artifact.sha256, fileName: path.basename(artifact.pdfPath), approved: true }, target: { ok: true, reasons: [], url: inspection.url }, fill };
    writeFileSync(path.join(packetDir, "evidence", "form-evidence.json"), JSON.stringify(evidence));
  }
  const policyPath = path.join(dir, "policy.json");
  writeFileSync(policyPath, JSON.stringify({ excludedTerms: ["bridge inspection"] }));
  return { dir, dataDir, outputDir, packetRoot, profilePath: profileFile.path, policyPath, jobId, jdHash: JD_HASH, pdfPath: artifact.pdfPath, jobsPath, packetDir };
}

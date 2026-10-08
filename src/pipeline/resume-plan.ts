import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { JobPosting } from "../adapters/types.js";
import { z } from "zod";
import type { CandidateFact } from "../domain/candidate-profile.js";
import type { Decision } from "../decision/evaluate.js";
import type { CanonicalLane, VerifiedInputs } from "./trust.js";

const sourceFactSchema = z.object({ factId: z.string().min(1), wording: z.string().min(1), sourceReference: z.string().min(1), sourceLocator: z.string().nullable() }).strict();
export const resumePlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.string().min(1),
  jdHash: z.string().regex(/^[a-f0-9]{64}$/),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  lane: z.enum(["cybersecurity", "sdet", "cloud", "network"]),
  canonicalResumePath: z.string().min(1),
  canonicalResumeHash: z.string().regex(/^[A-F0-9]{64}$/),
  selectedFacts: z.array(sourceFactSchema).min(1),
  uncoveredRequirementIds: z.array(z.string()),
  decisionOutcome: z.enum(["ELIGIBLE", "REJECT", "REVIEW"]),
  previewOnly: z.boolean(),
}).strict();
export type ResumePlan = z.infer<typeof resumePlanSchema>;

export interface RenderedResumeArtifact {
  plan: ResumePlan;
  planPath: string;
  gapReportPath: string;
  pdfPath: string;
  sha256: string;
  bytes: number;
  pageCount: number;
  extractedText: string;
  inspection: "PASS";
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function factWording(fact: CandidateFact): string {
  // These are approved profile fields copied verbatim; no generative rewrite enters the artifact.
  return fact.attributes.detail ?? fact.value;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function flattenPdfText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  return items.map((item) => `${item.str ?? ""}${item.hasEOL ? "\n" : " "}`).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

export function normalizeExtractedPdfText(text: string): string {
  return text.replace(/([\p{L}])-[\t\r\n ]+([\p{L}])/gu, "$1-$2").replace(/\s+/g, " ").trim();
}

export async function buildAndRenderResumePlan(input: {
  job: JobPosting;
  lane: CanonicalLane;
  decision: Decision;
  profileDigest: string;
  verifiedInputs: VerifiedInputs;
  factCandidates: Array<{ factId: string }>;
  outputDir: string;
  maxFacts?: number;
}): Promise<RenderedResumeArtifact> {
  if (!input.job.jdContentHash) throw new Error("Cannot create a job-specific plan without a canonical JD content hash.");
  const laneFiles = input.verifiedInputs.laneFiles[input.lane];
  const byId = new Map(input.verifiedInputs.approvedFacts.map((fact) => [fact.factId, fact]));
  const ids = input.factCandidates.map((candidate) => candidate.factId);
  const protectedJobs = input.verifiedInputs.protectedEmployment;
  for (const job of [...protectedJobs].reverse()) if (!ids.includes(job.factId)) ids.unshift(job.factId);
  const selectedFacts = ids.map((id) => byId.get(id)).filter((fact): fact is CandidateFact => fact !== undefined).slice(0, input.maxFacts ?? 8).map((fact) => ({ factId: fact.factId, wording: factWording(fact), sourceReference: fact.source.reference, sourceLocator: fact.source.locator ?? null }));
  for (const job of protectedJobs) if (!selectedFacts.some((fact) => fact.factId === job.factId)) throw new Error(`ResumePlan must preserve the approved employment fact ${job.factId}.`);
  const uncoveredRequirementIds = input.decision.rules.filter((rule) => rule.mandatory && rule.status !== "PASS").map((rule) => rule.ruleId);
  const planSeed = JSON.stringify({ jobId: input.job.id, jdHash: input.job.jdContentHash, profileDigest: input.profileDigest, lane: input.lane, canonicalResumeHash: laneFiles.resumeHash, selectedFacts, uncoveredRequirementIds, decisionOutcome: input.decision.outcome });
  const plan = resumePlanSchema.parse({
    schemaVersion: 1,
    id: sha256(planSeed),
    jobId: input.job.id,
    jdHash: input.job.jdContentHash,
    profileDigest: input.profileDigest,
    lane: input.lane,
    canonicalResumePath: laneFiles.resumePath,
    canonicalResumeHash: laneFiles.resumeHash,
    selectedFacts,
    uncoveredRequirementIds,
    decisionOutcome: input.decision.outcome,
    previewOnly: input.decision.outcome !== "ELIGIBLE",
  });

  const outputDir = path.resolve(input.outputDir, input.job.id, input.job.jdContentHash);
  await mkdir(outputDir, { recursive: true });
  const planPath = path.join(outputDir, "resume-plan.json");
  const gapReportPath = path.join(outputDir, "gap-report.json");
  const pdfPath = path.join(outputDir, plan.previewOnly ? "resume-preview.pdf" : "resume-job-specific.pdf");
  try {
    const previous = resumePlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
    if (previous.id === plan.id && previous.canonicalResumeHash === plan.canonicalResumeHash && previous.profileDigest === plan.profileDigest && previous.jdHash === plan.jdHash) {
      const pdfBytes = await readFile(pdfPath);
      const pdf = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
      const cachedPages: string[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const pdfPage = await pdf.getPage(pageNumber);
        const content = await pdfPage.getTextContent();
          cachedPages.push(flattenPdfText(content.items as Array<{ str?: string; hasEOL?: boolean }>));
      }
      await pdf.cleanup();
      const cachedText = cachedPages.join(" ");
      const normalized = normalizeExtractedPdfText(cachedText).toLocaleLowerCase("en-US");
      const intact = plan.selectedFacts.every((fact) => normalized.includes(normalizeExtractedPdfText(fact.wording).toLocaleLowerCase("en-US")))
        && protectedJobs.every((job) => cachedText.includes(job.employer) && cachedText.includes(job.title));
      if (intact) return { plan, planPath, gapReportPath, pdfPath, sha256: sha256(pdfBytes), bytes: pdfBytes.length, pageCount: cachedPages.length, extractedText: cachedText, inspection: "PASS" };
    }
  } catch {
    // Missing, stale, corrupt, or unreadable cached artifacts are regenerated below.
  }
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(gapReportPath, `${JSON.stringify({ jobId: plan.jobId, jdHash: plan.jdHash, decision: input.decision.outcome, uncoveredRequirementIds: plan.uncoveredRequirementIds, reasons: input.decision.reasons, missingFacts: input.decision.unresolvedQuestions }, null, 2)}\n`, "utf8");

  const factsHtml = selectedFacts.filter((fact) => !protectedJobs.some((job) => job.factId === fact.factId)).map((fact) => `<li class="fact" data-fact-id="${escapeHtml(fact.factId)}"><span>${escapeHtml(fact.wording)}</span><small>Evidence: ${escapeHtml(fact.sourceReference)}${fact.sourceLocator ? `, ${escapeHtml(fact.sourceLocator)}` : ""} · ${escapeHtml(fact.factId)}</small></li>`).join("\n");
  const profileName = input.verifiedInputs.approvedFacts.find((fact) => fact.kind === "legal_name")?.value ?? `Candidate ${input.verifiedInputs.profile.candidateId}`;
  const title = plan.previewOnly ? "PREVIEW — REVIEW REQUIRED" : "Job-specific resume";
  const experienceHtml = protectedJobs
    .map((job) => `<p class="fact">${escapeHtml(job.employer)} — ${escapeHtml(job.title)}<br>${escapeHtml(job.dateLabel)}<br>${escapeHtml(factWording(byId.get(job.factId)!))}<small>${job.roleTags.length ? `role tags: ${escapeHtml(job.roleTags.join(", "))} · ` : ""}${escapeHtml(job.factId)}</small></p>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
@page{size:Letter;margin:0.62in}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#172033;font-size:10.5pt;line-height:1.28;margin:0}header{border-bottom:2px solid #253858;padding-bottom:9pt;margin-bottom:12pt}h1{font-size:19pt;margin:0 0 5pt;color:#14213d}h2{font-size:11pt;text-transform:uppercase;letter-spacing:.7pt;color:#29466d;border-bottom:1px solid #bdc9d8;padding-bottom:3pt;margin:12pt 0 6pt}.status{font-size:8.5pt;color:${plan.previewOnly ? "#8b4b00" : "#1c5c38"};font-weight:bold}.role{font-size:10pt;color:#31425d;margin-top:5pt}.fact{margin:0 0 7pt;break-inside:avoid}.fact span{display:block}.fact small{display:block;color:#637086;font-size:7.5pt;margin-top:2pt}.meta{font-size:8pt;color:#68758a}.warning{padding:6pt 8pt;background:#fff4dc;color:#794800;margin:9pt 0;font-size:9pt}
</style></head><body><header><div class="status">${title}</div><h1>${escapeHtml(profileName)}</h1><div class="role">Target: ${escapeHtml(input.job.title)} · ${escapeHtml(input.lane)} · ${escapeHtml(input.job.company)}</div><div class="meta">Plan ${plan.id.slice(0, 12)} · approved profile facts only</div></header>${plan.previewOnly ? `<div class="warning">This is a review preview, not an application-ready resume. Uncovered mandatory requirements: ${plan.uncoveredRequirementIds.length}.</div>` : ""}<h2>Approved evidence</h2><ul>${factsHtml}</ul><h2>Professional experience</h2>${experienceHtml}</body></html>`;

  // Use the same installed Chrome channel as the headed discovery/application stages. This
  // environment does not have Playwright's separately downloaded Chromium bundle.
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  let extractedText = "";
  let pageCount = 0;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: pdfPath, format: "Letter", printBackground: true });
    const pdfBytes = await readFile(pdfPath);
    const pdf = await getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true }).promise;
    pageCount = pdf.numPages;
    const textPages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const pdfPage = await pdf.getPage(pageNumber);
      const content = await pdfPage.getTextContent();
      textPages.push(flattenPdfText(content.items as Array<{ str?: string; hasEOL?: boolean }>));
    }
    extractedText = textPages.join(" ");
    await pdf.cleanup();
  } finally {
    await browser.close();
  }

  const normalizedOutput = normalizeExtractedPdfText(extractedText).toLocaleLowerCase("en-US");
  for (const fact of selectedFacts) {
    if (!normalizedOutput.includes(normalizeExtractedPdfText(fact.wording).toLocaleLowerCase("en-US"))) throw new Error(`Rendered PDF text did not preserve approved fact ${fact.factId}.`);
  }
  if (!protectedJobs.every((job) => extractedText.includes(job.employer) && extractedText.includes(job.title))) throw new Error("Rendered artifact lost protected employment identity.");
  const pdfBytes = await readFile(pdfPath);
  return { plan, planPath, gapReportPath, pdfPath, sha256: sha256(pdfBytes), bytes: pdfBytes.length, pageCount, extractedText, inspection: "PASS" };
}

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runMatch } from "../src/match/pipeline.js";
import { decideMatch } from "../src/match/intelligence.js";
import { RulesJobSemanticProvider } from "../src/match/rules-provider.js";
import type { EvidenceCorpus } from "../src/match/evidence.js";
import { makeJob } from "../tests/match/helpers.js";

// Public, read-only Lever board API. No application endpoint, credentials, browser bypass, or candidate facts.
const targets = [
  ["filevine", "fc5419e5-1a2a-4b21-a54d-2aa5a8d9cef3", "sdet"],
  ["saviynt", "bcb3c9f3-3688-446e-b85b-269f8949aa91", "security"],
  ["steerbridge", "a0c2acff-28da-4eaf-a6e5-c840f49e2f76", "cloud"],
  ["RyzLabs", "de6d3290-92c2-4ed2-8ee2-804779c2e761", "network"],
] as const;
const corpus: EvidenceCorpus = { units: [], eligibility: [], employment: [], excluded: [], boundaryExclusions: [], version: {
  profileId: null, profileKind: null, profileRevisionNo: null, profileDigest: null, evidenceDigest: "no-candidate-evidence", factCount: 0, authorizedResumeIds: [], confirmedEmploymentReferences: 0,
} };
const rows = [];
const raw = [];
for (const [board, id, role] of targets) {
  const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(board)}/${id}`;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const data = await response.json() as { id?: string; text?: string; hostedUrl?: string; descriptionPlain?: string; additionalPlain?: string; lists?: Array<{ text?: string; content?: string }>; categories?: { location?: string; commitment?: string } };
    if (data.id !== id || !data.hostedUrl?.startsWith(`https://jobs.lever.co/${board}/`) || !data.descriptionPlain) throw new Error("UNVERIFIED_POSTING_IDENTITY_OR_TEXT");
    const strip = (html: string): string => html.replace(/<\/(?:li|p|div)>/gi, "\n").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();
    const sections = (data.lists ?? []).map((list) => [list.text ?? "", strip(list.content ?? "")].filter(Boolean).join(": "));
    const originalText = [data.descriptionPlain, ...sections, data.additionalPlain ?? ""].filter((part) => part.trim()).join("\n\n");
    const observedAt = new Date().toISOString();
    const job = makeJob(originalText, { id, source: "lever-public-api", company: board, title: data.text, location: data.categories?.location ?? "", employmentType: data.categories?.commitment ?? null,
      canonicalUrl: data.hostedUrl, atsIdentity: `lever:${board.toLowerCase()}:${id}`, lastSeenAt: observedAt, discoveredAt: observedAt, extractedAt: observedAt });
    const report = await runMatch({ job, provider: new RulesJobSemanticProvider(), corpus, encoder: null, asOf: observedAt.slice(0, 10) });
    const decision = decideMatch(report, { postingStatus: "RECENT" });
    const evidenceValid = report.status === "COMPLETE" && report.requirements.every((r) => originalText.slice(r.jd.start, r.jd.end) === r.jd.quote);
    raw.push({ role, board, id, sourceUrl: data.hostedUrl, observedAt, title: data.text, location: data.categories?.location ?? null, employmentType: data.categories?.commitment ?? null,
      originalText, textSha256: createHash("sha256").update(originalText).digest("hex") });
    rows.push({ role, board, id, sourceUrl: data.hostedUrl, observedAt, title: data.text, textLength: originalText.length,
      textSha256: createHash("sha256").update(originalText).digest("hex"), extractionStatus: report.status,
      requirements: report.status === "COMPLETE" ? report.requirements.length : 0, evidenceValid, outcome: decision.outcome,
      warnings: report.status === "COMPLETE" ? [...report.extraction.warnings, ...report.extraction.analysisWarnings] : [report.failure.code],
      note: "Diagnostic only: no independently labeled real-job accuracy or candidate eligibility claim." });
  } catch (error) {
    rows.push({ role, board, id, sourceUrl: `https://jobs.lever.co/${board}/${id}`, error: error instanceof Error ? error.message : String(error) });
  }
}
const dir = path.resolve("private-runtime/m4");
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, "real-postings.json"), JSON.stringify(raw, null, 2) + "\n");
writeFileSync(path.join(dir, "real-posting-diagnostic.json"), JSON.stringify({ collectedAt: new Date().toISOString(), source: "public Lever posting API, read only", rows }, null, 2) + "\n");
console.log(JSON.stringify({ attempted: targets.length, retrieved: raw.length, evidenceValid: rows.filter((r) => "evidenceValid" in r && r.evidenceValid).length, failures: rows.filter((r) => "error" in r).length }));

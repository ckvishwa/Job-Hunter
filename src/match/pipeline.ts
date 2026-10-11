import type { JobPosting } from "../adapters/types.js";
import type { JobSemanticProvider } from "../semantic/provider.js";
import { parseCanonicalJob } from "../semantic/parse-job.js";
import type { EmbeddingEncoder } from "../nlu/local-transformer.js";
import { analyzeJd, type JdAnalysis } from "./analyze.js";
import { MATCH_POLICY_VERSION, decideConditions, decideRequirements, rollupItems, type ConditionDecision, type GroupDecision, type ReqStatus, type RequirementDecision } from "./decide.js";
import type { EvidenceCorpus } from "./evidence.js";
import type { VectorCache } from "./embedding-cache.js";
import { EvidenceIndex, RRF_K, queryFor, type RetrievalResult } from "./retrieval.js";
import { lexicon } from "./lexicon.js";

// Official JD -> structured requirements -> authorized candidate facts -> evidence retrieval -> requirement decisions -> explainable report.
// No numeric score of any kind. An extraction failure ends the run with no decisions (fail closed); it never falls back silently to another extractor.

export const REPORT_SCHEMA = "orbital-job-match-report/1";

export interface MatchSelection { workModes: string[]; locations: Array<{ kind: string; value: string }> }

export type MatchReport =
  | { schema: typeof REPORT_SCHEMA; status: "EXTRACTION_FAILED"; failure: { code: string; issues: Array<{ code: string; path: string; message: string }> }; versions: Record<string, unknown>; note: string }
  | {
      schema: typeof REPORT_SCHEMA;
      status: "COMPLETE";
      scoring: "NONE: statuses and evidence only; no match score, hiring probability or eligibility percentage exists";
      versions: Record<string, unknown>;
      job: { title: string; company: string; location: string | null; url: string | null; jdSha256: string };
      extraction: { providerRevision: string; requirements: number; groups: number; warnings: string[]; analysisWarnings: string[] };
      summary: {
        required: Record<ReqStatus, number>;
        preferred: Record<ReqStatus, number>;
        criticalBlockers: ConditionDecision[];
        needsCandidateAnswer: ConditionDecision[];
        extractionGaps: ConditionDecision[];
        missingRequiredEvidence: Array<{ requirementId: string; value: string; missing: string[] }>;
      };
      conditions: ConditionDecision[];
      arrangement: JdAnalysis["arrangement"] & { selection: "MATCHES_SELECTION" | "NOT_IN_SELECTION" | "NO_SELECTION" | "UNKNOWN" };
      requirements: RequirementDecision[];
      alternativeGroups: GroupDecision[];
      itemRollups: ReturnType<typeof rollupItems>;
      retrieval: { rrfK: number; encoder: string | null; semantic: string; perRequirement: Array<{ requirementId: string; lexical: number; bm25: number; semantic: number | null; hybrid: number }> };
      evidence: { approvedProfessionalEmployment: number; unitsSearched: number; boundaryExcludedApproved: EvidenceCorpus["boundaryExclusions"]; corpusExcluded: EvidenceCorpus["excluded"] };
    };

const empty = (): Record<ReqStatus, number> => ({ SUPPORTED: 0, PARTIAL: 0, UNSUPPORTED: 0, UNKNOWN: 0 });

export async function runMatch(input: {
  job: JobPosting;
  provider: JobSemanticProvider;
  corpus: EvidenceCorpus;
  encoder?: EmbeddingEncoder | null;
  encoderLabel?: string | null;
  asOf: string;
  selection?: MatchSelection | null;
  cache?: VectorCache | null;
  now?: string;
}): Promise<MatchReport> {
  const parsed = await parseCanonicalJob(input.job, input.provider, { now: input.now });
  const versions = {
    policy: MATCH_POLICY_VERSION, lexicon: `jd-terms@${lexicon().version}`, asOf: input.asOf, profile: input.corpus.version,
    jd: { jobId: input.job.id, jdSha256: input.job.jdContentHash ?? null, extractor: input.provider.revision },
  };
  if (!parsed.ok) {
    return { schema: REPORT_SCHEMA, status: "EXTRACTION_FAILED", failure: { code: parsed.failure.code, issues: parsed.failure.issues }, versions,
      note: "Extraction failed validation, so no requirement was invented and no decision was made. The deterministic baseline extractor is unaffected." };
  }
  const structured = parsed.structured;
  const analysis = analyzeJd(input.job, structured);

  const index = new EvidenceIndex(input.corpus.units, input.encoder ?? null, input.cache ?? null);
  await index.prepare();
  const retrieval = new Map<string, RetrievalResult>();
  for (const r of analysis.requirements) retrieval.set(r.id, await index.retrieve(queryFor({ id: r.id, value: r.value, type: r.type })));

  const { decisions, groups } = decideRequirements({ analysis, corpus: input.corpus, retrieval, asOf: input.asOf });
  const conditions = decideConditions(analysis, input.corpus.eligibility);

  const required = empty();
  const preferred = empty();
  for (const d of decisions) {
    if (!d.applicable) continue;
    if (d.effectiveLevel === "required") required[d.status] += 1;
    else if (d.effectiveLevel === "preferred") preferred[d.status] += 1;
  }
  const sel = input.selection ?? null;
  const modeWord = analysis.arrangement.mode;
  const selection: "MATCHES_SELECTION" | "NOT_IN_SELECTION" | "NO_SELECTION" | "UNKNOWN" =
    !sel || sel.workModes.length === 0 ? "NO_SELECTION" : modeWord === "unknown" ? "UNKNOWN" : sel.workModes.includes(modeWord === "onsite" ? "onsite" : modeWord) ? "MATCHES_SELECTION" : "NOT_IN_SELECTION";

  return {
    schema: REPORT_SCHEMA, status: "COMPLETE", scoring: "NONE: statuses and evidence only; no match score, hiring probability or eligibility percentage exists", versions: { ...versions, jd: { ...versions.jd, structuredId: structured.id, parserVersion: structured.parserVersion } },
    job: { title: input.job.title, company: input.job.company, location: input.job.location ?? null, url: input.job.canonicalUrl ?? null, jdSha256: structured.jdHash },
    extraction: { providerRevision: structured.providerRevision, requirements: structured.requirements.length, groups: structured.alternativeGroups.length, warnings: structured.warnings.map((w) => `${w.code}:${w.path}`), analysisWarnings: analysis.warnings },
    summary: {
      required, preferred,
      criticalBlockers: conditions.filter((c) => c.severity === "blocker"),
      needsCandidateAnswer: conditions.filter((c) => c.severity === "needs-candidate-answer"),
      extractionGaps: conditions.filter((c) => c.severity === "extraction-gap"),
      missingRequiredEvidence: decisions.filter((d) => d.applicable && d.effectiveLevel === "required" && (d.status === "UNSUPPORTED" || d.status === "PARTIAL") && d.missingEvidence.length).map((d) => ({ requirementId: d.requirementId, value: d.value, missing: d.missingEvidence })),
    },
    conditions, arrangement: { ...analysis.arrangement, selection }, requirements: decisions, alternativeGroups: groups, itemRollups: rollupItems(decisions),
    retrieval: {
      rrfK: RRF_K, encoder: input.encoderLabel ?? null, semantic: index.semanticStatus,
      perRequirement: [...retrieval.values()].map((r) => ({ requirementId: r.requirementId, lexical: r.lexical.length, bm25: r.bm25.length, semantic: r.semantic ? r.semantic.length : null, hybrid: r.hybrid.length })),
    },
    evidence: { approvedProfessionalEmployment: input.corpus.employment.filter((f) => f.attributes.employmentType === "professional").length, unitsSearched: input.corpus.units.length, boundaryExcludedApproved: input.corpus.boundaryExclusions, corpusExcluded: input.corpus.excluded },
  };
}

export function renderMatchMarkdown(report: MatchReport): string {
  const L: string[] = [];
  if (report.status === "EXTRACTION_FAILED") {
    return `# Job match: extraction failed\n\n${report.note}\n\nFailure: ${report.failure.code}\n${report.failure.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}\n`;
  }
  const j = report.job;
  L.push(`# Job match report: ${j.title}, ${j.company}`, "", `Location: ${j.location ?? "(not stated)"}  |  Posting: ${j.url ?? "(none)"}`, "",
    "> Evidence and statuses only. There is no match score, hiring probability or eligibility percentage. Nothing here approves a fact, edits employment or applies anywhere.", "",
    "## Versions", "", "```json", JSON.stringify(report.versions, null, 2), "```", "");
  L.push("## Summary", "", `- Required requirements: ${Object.entries(report.summary.required).map(([k, v]) => `${k} ${v}`).join(", ")}`, `- Preferred requirements: ${Object.entries(report.summary.preferred).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `- Critical eligibility blockers: ${report.summary.criticalBlockers.length ? report.summary.criticalBlockers.map((b) => b.type).join(", ") : "none demonstrated"}`,
    `- Needs a candidate answer (never inferred): ${report.summary.needsCandidateAnswer.map((b) => b.type).join(", ") || "none"}`,
    `- Conditions the JD mentions but the extractor could not classify (read the posting): ${report.summary.extractionGaps.map((b) => b.type).join(", ") || "none"}`,
    `- Approved professional employment facts used: ${report.evidence.approvedProfessionalEmployment}. Confirmed-employment statements on file: ${(report.versions.profile as { confirmedEmploymentReferences?: number }).confirmedEmploymentReferences ?? 0}. A statement is a reference, not evidence: it is not counted until a source résumé is ingested and approved.`, "");
  L.push("## Eligibility conditions (four separate checks)", "");
  for (const c of report.conditions) L.push(`- **${c.type}**: JD ${c.jd.status}${c.jd.value ? ` (${c.jd.value})` : ""} -> **${c.result}**. ${c.explanation}${c.jd.quote ? `\n  - JD: "${c.jd.quote}"` : ""}${c.candidateFactIds.length ? `\n  - candidate facts: ${c.candidateFactIds.join(", ")}` : ""}`);
  L.push("", `Work arrangement: ${report.arrangement.mode} (from ${report.arrangement.source}); selection check: ${report.arrangement.selection}`, "");
  for (const level of ["required", "preferred"] as const) {
    L.push(`## ${level === "required" ? "Required" : "Preferred"} requirements`, "");
    for (const d of report.requirements.filter((x) => x.effectiveLevel === level || (level === "required" && x.effectiveLevel === "not_required"))) {
      L.push(`### ${d.status}: ${d.value}${d.groupId ? `  [alternative group ${d.groupId}]` : ""}${d.termRole === "example" ? "  [example term]" : ""}`, `- JD: "${d.jd.quote.replace(/\s+/g, " ").slice(0, 200)}"`, `- ${d.explanation}`);
      for (const s of d.support) L.push(`- evidence: fact \`${s.factId}\` (résumé \`${s.resumeId ?? "attested"}\`, ${s.category}, ${s.strength}, ${s.basis}) "${(s.quote ?? s.value).replace(/\s+/g, " ").slice(0, 160)}"`);
      for (const n of d.notCounted.slice(0, 3)) L.push(`- not counted: \`${n.factId}\`: ${n.reason}`);
      if (d.missingEvidence.length) L.push(`- missing evidence: ${d.missingEvidence.join("; ")}`);
      if (d.retrievalLeads.length && d.status !== "SUPPORTED") L.push(`- retrieval leads for review (similarity only, not counted): ${d.retrievalLeads.map((l) => `\`${l.factId}\` hybrid#${l.hybridRank}${l.semanticScore !== null ? ` cos ${l.semanticScore.toFixed(2)}` : ""}`).join(", ")}`);
      L.push("");
    }
  }
  if (report.alternativeGroups.length) { L.push("## Alternatives (any one satisfies)", ""); for (const g of report.alternativeGroups) L.push(`- ${g.groupId}: **${g.status}**. ${g.explanation}`); L.push(""); }
  L.push("## Evidence used and kept out", "", `Evidence units searched: ${report.evidence.unitsSearched}. Approved facts the profile boundary kept out: ${report.evidence.boundaryExcludedApproved.length}`, "");
  for (const e of report.evidence.boundaryExcludedApproved.slice(0, 30)) L.push(`- \`${e.factId}\` ${e.code}: ${e.detail}`);
  for (const e of report.evidence.corpusExcluded) L.push(`- \`${e.factId}\`: ${e.reason}`);
  return L.join("\n") + "\n";
}

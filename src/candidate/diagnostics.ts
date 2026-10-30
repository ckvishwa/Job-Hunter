import { createHash } from "node:crypto";
import type { FactView } from "../db/candidate-repo.js";
import type { RolesRepo } from "../db/roles-repo.js";
import { candidateFactSchema, type CandidateFact } from "../domain/candidate-profile.js";
import { summarizeExperience } from "../roles/experience.js";
import { extractStatements, skillContexts, splitLines, type SectionName } from "./achievements.js";
import type { ConflictContext } from "./fact-context.js";
import { evaluateIfPossible, type Evaluation, type ReferenceLabels } from "./extraction-metrics.js";
import { assessFactQuality, type QualityCode } from "./fact-quality.js";
import { isMaskedKind, maskValue } from "./fact-review-file.js";

// Résumé diagnostics: a read-only report built from what is ACTUALLY in PostgreSQL. Four separate questions are answered separately and
// never merged into one number:
//   extraction coverage  - which sections and fact categories the parser captured
//   evidence quality     - source anchoring, malformed phrases, duplicates, conflicts
//   review status        - what a person approved, rejected or left pending
//   career relevance     - the S2 SUPPORTED / PARTIAL explanations
// Precision/recall/F1 appear only against an independent human-labelled reference; otherwise the value is NOT_EVALUATED.

export const DIAGNOSTIC_SCHEMA = "orbital-resume-diagnostic/1";

export type RolePreview = Awaited<ReturnType<RolesRepo["previewAssessment"]>>;

export interface ResumeInput {
  resumeId: string;
  fileType: string;
  sha256: string;
  byteSize: number;
  createdAt: Date;
  versionId: string;
  state: string;
  parserRevision: string | null;
  contractRevision: string;
  warnings: unknown[];
  stats: unknown;
  text: string | null;
  textSha256: string | null;
}

export interface DiagnoseInput {
  asOf: string;
  resume: ResumeInput;
  facts: readonly FactView[];
  /** All of this user's facts (every résumé plus attested): the same pool S2 reads. */
  userFacts: readonly CandidateFact[];
  revisions: ReadonlyMap<string, ReadonlyArray<{ revision: number; action: string; actor: string; snapshot: unknown }>>;
  conflicts: ConflictContext;
  preview: RolePreview;
  /** Fact ids that exist on this résumé; used to tell whether a recommendation's evidence comes from it. */
  reference: ReferenceLabels | null;
  latestRulesRevision: string | null;
  options: { reveal: boolean; hideValues: boolean; showText: boolean };
}

const EXPECTED_KIND: Partial<Record<SectionName, string>> = {
  skills: "skill", experience: "employment", internship: "employment", education: "education", certifications: "certification", projects: "project",
};

const count = <T,>(items: readonly T[], pick: (t: T) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of items) out[pick(i)] = (out[pick(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

function shownValue(f: Pick<FactView, "kind" | "sensitivity" | "value">, o: DiagnoseInput["options"]): string | null {
  if (o.hideValues) return null;
  return !o.reveal && isMaskedKind(f.kind, f.sensitivity) ? maskValue(f.value) : f.value;
}

export function buildDiagnostic(input: DiagnoseInput) {
  const { resume, facts, options } = input;
  const text = resume.text;
  const proposedBy = count(facts, (f) => f.proposedBy);
  const editedIds = new Set([...input.revisions.entries()].filter(([, revs]) => revs.some((r) => r.action === "EDIT")).map(([id]) => id));
  const conflictRefs = new Set(input.conflicts.conflicts.flatMap((c) => c.records.map((r) => r.ref)));
  const resumeFactIds = new Set(facts.map((f) => f.factId));

  // ---- per-fact quality -------------------------------------------------------------------------------------------------------------
  const qualityInput = facts.map((f) => ({ factId: f.factId, kind: f.kind, value: f.value, attributes: f.attributes, span: f.span }));
  const perFact = facts.map((f) => ({
    factId: f.factId, kind: f.kind,
    warnings: assessFactQuality(f, qualityInput, text, input.conflicts.conflicts).map((w) => ({ code: w.code, message: options.hideValues ? null : w.message })),
  })).filter((x) => x.warnings.length);
  const byCode = count(perFact.flatMap((x) => x.warnings), (w) => w.code);

  // Category provenance for employment: was the category set by the parser at proposal time and approved unchanged?
  const categoryProvenance = facts.filter((f) => f.kind === "employment" && (f.attributes as { employmentType?: string }).employmentType).map((f) => {
    const revs = input.revisions.get(f.factId) ?? [];
    const proposed = (revs.find((r) => r.action === "PROPOSED")?.snapshot as { fact?: { attributes?: { employmentType?: string } } } | undefined)?.fact?.attributes?.employmentType;
    const edited = editedIds.has(f.factId);
    return {
      factId: f.factId, employmentType: (f.attributes as { employmentType?: string }).employmentType!,
      source: proposed && !edited ? "assigned by the parser at proposal time (keyword rule); approved as proposed" : edited ? "set or changed through an edit" : "not present at proposal",
    };
  });

  // ---- sections, omissions, achievements -------------------------------------------------------------------------------------------
  const lines = text ? splitLines(text) : [];
  const sectionRows = (["header", "summary", "skills", "experience", "internship", "projects", "certifications", "education", "other"] as SectionName[]).map((section) => {
    const inSection = lines.filter((l) => l.section === section && !l.isHeading && l.text.trim());
    const long = inSection.filter((l) => l.text.trim().length >= 40);
    const covered = long.filter((l) => facts.some((f) => f.span && f.span.start < l.end && f.span.end > l.start));
    const expected = EXPECTED_KIND[section] ?? null;
    const have = expected ? facts.filter((f) => f.kind === expected).length : null;
    return {
      section, nonEmptyLines: inSection.length, longLines: long.length, longLinesCoveredByAFact: covered.length,
      expectedFactKind: expected, factsOfThatKind: have,
      flag: expected && inSection.length > 0 && have === 0 ? "SECTION_PRESENT_NO_FACTS" : null,
    };
  }).filter((s) => s.nonEmptyLines > 0);
  const uncovered = lines.filter((l) => !l.isHeading && l.text.trim().length >= 40 && !facts.some((f) => f.span && f.span.start < l.end && f.span.end > l.start))
    .map((l) => ({ line: l.index + 1, start: l.start, end: l.end, section: l.section, characters: l.text.trim().length, text: options.showText ? l.text.trim().slice(0, 200) : null }));

  const statements = text ? extractStatements(text, facts) : [];
  const quantified = statements.filter((s) => s.quantities.length);
  const skillRows = facts.filter((f) => f.kind === "skill");
  const contexts = text ? skillContexts(text, statements, skillRows.map((f) => ({ factId: f.factId, value: f.value }))) : [];
  const mergedWordRuns = text ? [...text.matchAll(/[A-Za-z]{30,}/g)].length : 0;
  const hyphenBreaks = text ? [...text.matchAll(/[A-Za-z]{2,}-\n[a-z]{2,}/g)].length : 0;
  const parserWarnings = Object.entries(count(input.resume.warnings as Array<{ code?: string }>, (w) => String(w.code ?? "UNKNOWN"))).map(([code, n]) => ({ code, count: n }));

  // ---- experience -------------------------------------------------------------------------------------------------------------------
  const approvedHere = facts.filter((f) => f.approvalStatus === "approved").map((f) => candidateFactSchema.parse({
    factId: f.factId, kind: f.kind, value: f.value, polarity: f.polarity, attributes: f.attributes, source: f.source, verification: f.verification,
    approvalStatus: f.approvalStatus, sensitivity: f.sensitivity, ...(f.notes ? { notes: f.notes } : {}),
  }));
  const thisResume = summarizeExperience(approvedHere, input.asOf);
  const userWide = input.preview.experience;
  const approvedIds = new Set(facts.filter((f) => f.approvalStatus === "approved").map((f) => f.factId));
  const openConflictFactIds = [...conflictRefs].filter((r) => approvedIds.has(r));
  const slim = (e: typeof userWide) => ({
    status: e.status, convention: e.convention,
    buckets: Object.fromEntries(Object.entries(e.buckets).map(([k, b]) => [k, { factIds: b.factIds, monthsLower: b.monthsLower, monthsUpper: b.monthsUpper, gaps: b.gaps }])),
    entries: e.entries.map((x) => ({ factId: x.factId, bucket: x.bucket, counted: x.counted, start: x.start, end: x.end, employer: options.hideValues ? null : x.employer, title: options.hideValues ? null : x.title })),
    issues: e.issues, counts: e.counts, academicStudy: e.academicStudy,
  });

  // ---- roles ------------------------------------------------------------------------------------------------------------------------
  const valueOf = new Map(input.userFacts.map((f) => [f.factId, f]));
  const persistedBySlug = new Map(input.preview.persisted.map((p) => [p.role_slug, p]));
  const recs = input.preview.assessments.filter((a) => a.support !== "NO_MATCH").map((a) => {
    const persisted = persistedBySlug.get(a.roleSlug);
    const support = a.sourceFactIds.map((id) => {
      const f = valueOf.get(id);
      return {
        factId: id, kind: f?.kind ?? null, status: f?.approvalStatus ?? null, value: f && !options.hideValues ? f.value : null,
        resumeId: input.preview.evidence.factResume.get(id) ?? null,
        onThisResume: resumeFactIds.has(id), inOpenConflict: conflictRefs.has(id),
        // weak evidence behind a recommendation is shown next to it, never hidden
        qualityWarningCodes: perFact.find((p) => p.factId === id)?.warnings.map((w) => w.code) ?? [],
      };
    });
    return {
      roleSlug: a.roleSlug, title: a.title, familySlug: a.familySlug, support: a.support,
      why: { coreRequirementsMet: a.coreMet, coreRequirementsTotal: a.coreTotal, minimumCoreMatches: a.minCoreMatches },
      requirements: a.requirements.map((r) => ({
        id: r.id, label: r.label, importance: r.importance, met: r.met,
        matches: r.matches.map((m) => ({ factId: m.factId, via: m.via, matchedTerm: options.hideValues ? null : m.matchedTerm, demonstrated: m.demonstrated })),
      })),
      supportingFacts: support, gaps: a.gaps.map((g) => ({ code: g.code, message: g.message })),
      dependsOnDisputedRecord: support.some((s) => s.inOpenConflict),
      dependsOnWeaklyAnchoredFact: support.some((s) => s.qualityWarningCodes.some((c) => c === "SOURCE_MISMATCH" || c === "BROKEN_LINE")),
      stored: persisted ? { status: persisted.status, current: persisted.input_digest === a.inputDigest } : { status: "NOT_STORED_YET", current: false },
    };
  });

  const evaluation: Evaluation = evaluateIfPossible(facts.map((f) => ({ kind: f.kind, value: f.value, attributes: f.attributes as never })), input.reference, resume.textSha256);

  // ---- next actions -----------------------------------------------------------------------------------------------------------------
  const nextActions: Array<{ priority: number; action: string; command: string | null }> = [];
  const add = (priority: number, action: string, command: string | null = null): void => void nextActions.push({ priority, action, command });
  for (const c of input.conflicts.conflicts.filter((x) => x.records.some((r) => resumeFactIds.has(r.ref)))) {
    add(1, `Resolve the ${c.employer} employment disagreement (${c.differences.map((d) => d.field).join(", ")}). Neither record is assumed correct: confirm from documents or state the truth, then correct the résumé fact.`,
      `npm run facts:correct -- --resume ${resume.resumeId} --fact <factId> --dry-run --reason "<document or statement>" --employer ... --title ... --start YYYY-MM --end YYYY-MM --category ...`);
  }
  const unsplit = facts.filter((f) => f.kind === "employment" && (!(f.attributes as { employer?: string }).employer || !(f.attributes as { title?: string }).title));
  if (unsplit.length) add(2, `${unsplit.length} employment fact(s) still combine employer and title: set them with the correction tool (each field is confirmed explicitly).`, `npm run facts:correct -- --resume ${resume.resumeId} --fact ${unsplit[0]!.factId} --dry-run --reason "..." --employer "..." --title "..."`);
  const unclassified = approvedHere.filter((f) => f.kind === "employment" && !f.attributes.employmentType);
  if (unclassified.length) add(2, `${unclassified.length} approved employment fact(s) have no category; S2 does not count them until you choose one.`);
  if (byCode.SOURCE_MISMATCH) add(3, `${byCode.SOURCE_MISMATCH} fact(s) whose value is not backed by their source quotation: reject or correct them.`);
  if (byCode.BROKEN_LINE || byCode.POSSIBLE_DUPLICATE) add(3, "Fragments of words split by line wraps, or duplicates: reject the fragments (a parser re-run proposes the repaired phrase).");
  const pending = facts.filter((f) => f.approvalStatus === "pending").length;
  if (pending) add(4, `${pending} fact(s) are still pending a decision.`, `npm run facts:export -- --resume ${resume.resumeId} --force; npm run facts:review -- --resume ${resume.resumeId}`);
  if (sectionRows.some((s) => s.flag)) add(4, `Sections with text but no extracted facts: ${sectionRows.filter((s) => s.flag).map((s) => s.section).join(", ")}.`);
  if (quantified.length) add(5, `${quantified.length} quantified statement(s) exist only as résumé text, not as structured facts; they are listed under achievementEvidence with exact quotations.`);
  if (input.latestRulesRevision && resume.parserRevision && !resume.parserRevision.startsWith(input.latestRulesRevision)) {
    add(5, `This résumé was extracted by ${resume.parserRevision}; the current parser is ${input.latestRulesRevision}. Run with --rerun-parser to preview what it would propose (nothing is written).`);
  }
  if (evaluation.status === "NOT_EVALUATED") add(6, "Accuracy is NOT_EVALUATED: write an independent reference (see docs/RESUME-DIAGNOSTICS.md) to get precision/recall/F1.");
  nextActions.sort((a, b) => a.priority - b.priority);

  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  return {
    schema: DIAGNOSTIC_SCHEMA,
    redaction: { sensitiveValues: options.reveal ? "REVEALED" : "MASKED", allValues: options.hideValues ? "HIDDEN" : "SHOWN", resumeTextExcerpts: options.showText ? "SHOWN" : "HIDDEN" },
    resume: {
      resumeId: resume.resumeId, label: `resume-${resume.sha256.slice(0, 12)}.${resume.fileType}`, fileType: resume.fileType, byteSize: resume.byteSize,
      uploadedOn: resume.createdAt.toISOString().slice(0, 10), versionId: resume.versionId, extractionState: resume.state,
      textSha256: resume.textSha256, characterCount: text?.length ?? null, lineCount: text ? text.split("\n").length : null,
    },
    parser: {
      parserRevision: resume.parserRevision, contractRevision: resume.contractRevision, latestRulesRevision: input.latestRulesRevision,
      proposedBy, aiAssistedFacts: proposedBy.qwen ?? 0,
      aiModelUsedForThisExtraction: (proposedBy.qwen ?? 0) > 0 ? "yes (facts marked proposedBy=qwen)" : "no: rules only",
      stats: resume.stats, parserWarnings, employmentCategoryProvenance: categoryProvenance,
    },
    extractionSummary: {
      totalFacts: facts.length,
      byStatus: { approved: facts.filter((f) => f.approvalStatus === "approved").length, pending, rejected: facts.filter((f) => f.approvalStatus === "rejected").length },
      edited: editedIds.size, editedFactIds: [...editedIds].sort(), factsWithQualityWarnings: perFact.length,
    },
    factsByCategory: Object.fromEntries(Object.entries(count(facts, (f) => f.kind)).map(([kind, total]) => {
      const of = facts.filter((f) => f.kind === kind);
      return [kind, {
        total, approved: of.filter((f) => f.approvalStatus === "approved").length, pending: of.filter((f) => f.approvalStatus === "pending").length,
        rejected: of.filter((f) => f.approvalStatus === "rejected").length, edited: of.filter((f) => editedIds.has(f.factId)).length,
        facts: of.map((f) => ({
          factId: f.factId, status: f.approvalStatus, edited: editedIds.has(f.factId), headRevision: f.headRevision, value: shownValue(f, options),
          span: f.span ? { start: f.span.start, end: f.span.end } : null, warningCodes: perFact.find((p) => p.factId === f.factId)?.warnings.map((w) => w.code) ?? [],
        })),
      }];
    })),
    qualityWarnings: {
      byCode, perFact, employmentConflicts: input.conflicts.conflicts.filter((c) => c.records.some((r) => resumeFactIds.has(r.ref) || r.origin === "prior-record")),
      earlierProfileUsed: input.conflicts.priorProfileFile ? input.conflicts.priorProfileFile.split(/[\\/]/).pop() : null,
      earlierProfileProblem: input.conflicts.priorProfileProblem,
    },
    possibleOmissions: {
      sections: sectionRows,
      uncoveredLongLines: { count: uncovered.length, lines: uncovered },
      textLayer: { hyphenatedLineBreaksInText: hyphenBreaks, runsOf30PlusLettersWithoutSpaces: mergedWordRuns },
      quantifiedStatementsNotStructured: quantified.length,
    },
    achievementEvidence: {
      note: "Statements the résumé makes, with exact offsets. They are self-reported text, not facts, not verified, and never converted into months or years. Project statements are never professional time.",
      statementCount: statements.length,
      byKind: count(statements, (s) => s.kind),
      statements: statements.map((s, i) => ({
        index: i, kind: s.kind, section: s.section, start: s.start, end: s.end, ownerFactId: s.ownerFactId, quantities: s.quantities,
        quote: options.hideValues ? null : s.quote,
      })),
      skillContext: {
        note: "Textual co-occurrence only. 'demonstrated_in_context' means the skill appears inside a described activity; it is not proficiency and not years of hands-on use.",
        counts: count(contexts, (c) => c.context),
        skills: contexts.map((c) => ({ factId: c.factId, context: c.context, statementIndexes: c.inStatements })),
      },
    },
    approvedExperience: {
      note: "Counts only APPROVED, classified employment. Where an employment record is in an open conflict the range below is DISPUTED: it uses the record as approved, and neither version is confirmed.",
      status: openConflictFactIds.length ? "DISPUTED" : userWide.status,
      openConflictFactIdsOnThisResume: openConflictFactIds.sort(),
      thisResumeApprovedFactsOnly: slim(thisResume),
      allUploadedAndAttestedFacts_theViewS2Uses: slim(userWide),
    },
    evidenceScope: {
      note: "Career scoring (S2, later S4) reads only evidence the ACTIVE candidate profile authorizes. Unclassified résumés are unverified and excluded.",
      profile: input.preview.evidence.profile,
      thisResume: input.preview.evidence.sources.find((s) => s.resumeId === resume.resumeId)
        ? (({ provenance, authorized, basis }) => ({ provenance, authorized, basis }))(input.preview.evidence.sources.find((s) => s.resumeId === resume.resumeId)!)
        : { provenance: "unverified", authorized: false, basis: "not classified for the active profile" },
      factsUsedByS2: input.preview.evidence.facts.length,
      approvedFactsKeptOut: input.preview.evidence.excluded,
      employmentCountedOnce: input.preview.evidence.duplicates,
    },
    roleRecommendations: {
      catalogVersion: input.preview.catalogVersion,
      supported: recs.filter((r) => r.support === "SUPPORTED"),
      partial: recs.filter((r) => r.support === "PARTIAL"),
      noMatchRoles: input.preview.assessments.filter((a) => a.support === "NO_MATCH").length,
    },
    evaluationMetrics: {
      noOverallScore: true,
      note: "Four separate views. They are not combined, weighted or turned into a percentage.",
      extractionCoverage: {
        categoriesDetected: Object.keys(count(facts, (f) => f.kind)), sectionsObserved: sectionRows.map((s) => s.section),
        sectionsWithTextButNoFacts: sectionRows.filter((s) => s.flag).map((s) => s.section), structuredFacts: facts.length,
        statementsFound: statements.length, quantifiedStatements: quantified.length,
      },
      evidenceQuality: {
        factsWithSourceSpan: facts.filter((f) => f.span).length, factsWithoutSourceSpan: facts.filter((f) => !f.span).length,
        sourceMismatch: byCode.SOURCE_MISMATCH ?? 0, brokenLine: byCode.BROKEN_LINE ?? 0, possibleDuplicate: byCode.POSSIBLE_DUPLICATE ?? 0,
        insufficientContext: byCode.INSUFFICIENT_CONTEXT ?? 0, employmentReview: byCode.EMPLOYMENT_REVIEW ?? 0, employmentConflict: byCode.EMPLOYMENT_CONFLICT ?? 0,
      },
      reviewStatus: {
        approved: facts.filter((f) => f.approvalStatus === "approved").length, pending, rejected: facts.filter((f) => f.approvalStatus === "rejected").length,
        edited: editedIds.size,
      },
      careerRelevance: { supported: recs.filter((r) => r.support === "SUPPORTED").length, partial: recs.filter((r) => r.support === "PARTIAL").length },
      accuracy: evaluation,
    },
    nextActions,
    integrity: { reportDigest: sha(JSON.stringify([resume.resumeId, resume.textSha256, facts.map((f) => [f.factId, f.contentDigest, f.headRevision])])).slice(0, 16) },
  };
}

export type Diagnostic = ReturnType<typeof buildDiagnostic>;
export type { QualityCode };

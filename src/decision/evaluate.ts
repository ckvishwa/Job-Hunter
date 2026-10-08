import { createHash } from "node:crypto";
import { z } from "zod";
import {
  factUsability,
  profileDigest,
  unionMonths,
  type CandidateFact,
  type CandidateProfile,
  type FactKind,
} from "../domain/candidate-profile.js";
import type { EvidenceSpan, StructuredJob } from "../domain/structured-job.js";

// V1 Slice 3: deterministic job decision. StructuredJob + approved candidate facts -> ELIGIBLE / REJECT / REVIEW.
// Every evaluated criterion carries the JD evidence and the candidate fact ids behind its result.
//
// What this is NOT: it never looks at the job TITLE or at any title-targeting result (a title MATCH proves
// nothing about eligibility), it uses no model, it infers no sensitive answer, and it applies no
// sponsorship-based filtering (sponsorship statements are recorded, never used to reject).
//
// Result semantics, per criterion:
//   PASS     an approved, current candidate fact satisfies it.
//   FAIL     candidate facts DEMONSTRATE it is not met (an explicit "lacks" fact, or a years shortfall against a
//            history the candidate attested is complete). Never produced by merely missing information.
//   UNKNOWN  a fact needed to decide is missing, pending, expired, unverified or conflicting.
// Outcome: any mandatory FAIL -> REJECT. Else any mandatory UNKNOWN, or extraction coverage not attested
// complete by a reviewer -> REVIEW. Else ELIGIBLE. Preferred criteria never turn into mandatory failures.

export const DECISION_SCHEMA_VERSION = 1;

export interface DecisionPolicy {
  policyVersion: string;
  // Sponsorship statements in a JD are recorded but never filter jobs (the user's stated preference).
  sponsorship: "record_only";
  // Whether undated personal projects can count toward professional years. They cannot.
  projectsCountAsProfessionalYears: false;
}
export const POLICY_V1: DecisionPolicy = {
  policyVersion: "decision-policy@1",
  sponsorship: "record_only",
  projectsCountAsProfessionalYears: false,
};

// Reviewer attestation of how much of the JD the structured extraction covers. A manual annotation or a model
// output is "partial" until a named reviewer says otherwise; omitted requirements are never assumed to pass.
export const extractionReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: z.string().min(1).optional(),
    structuredId: z.string().min(1).optional(),
    extractionDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    jdHash: z.string().regex(/^[0-9a-f]{64}$/),
    provenance: z.enum(["MANUAL_ANNOTATION", "MODEL_OUTPUT"]),
    coverage: z.enum(["complete", "partial"]),
    reviewedBy: z.string().min(1).nullable(),
    reviewedAt: z.string().min(1).nullable(),
    omissions: z.array(z.string().max(300)).max(50).default([]),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type ExtractionReview = z.infer<typeof extractionReviewSchema>;

/** Binds human coverage review to the actual validated interpretation, even if a
 * provider erroneously reuses its revision string for changed output. */
export function structuredExtractionDigest(structured: StructuredJob): string {
  const material = { jobId: structured.jobId, jdHash: structured.jdHash, parserVersion: structured.parserVersion, providerRevision: structured.providerRevision, requirements: structured.requirements, responsibilities: structured.responsibilities, constraints: structured.constraints, alternativeGroups: structured.alternativeGroups, warnings: structured.warnings };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export type RuleStatus = "PASS" | "FAIL" | "UNKNOWN";

export interface RuleResult {
  ruleId: string;
  subject: { kind: "requirement" | "group" | "constraint" | "preference" | "coverage"; id: string };
  label: string;
  mandatory: boolean;
  level: "required" | "preferred" | "unknown" | "n/a";
  status: RuleStatus;
  explanation: string;
  evidence: EvidenceSpan[];
  factIds: string[];
}

export interface RecordedStatement {
  constraintId: string;
  type: string;
  status: string;
  value: string | null;
  evidence: EvidenceSpan[];
  handling: string;
}

export interface Decision {
  schemaVersion: number;
  id: string;
  jobId: string;
  jdHash: string;
  structuredId: string;
  extraction: {
    provenance: string;
    providerRevision: string;
    parserVersion: string;
    coverage: "complete" | "partial" | "unreviewed";
    reviewedBy: string | null;
    omissions: string[];
  };
  candidateId: string;
  profileVersion: string;
  profileDigest: string;
  policyVersion: string;
  asOf: string;
  evaluatedAt: string;
  outcome: "ELIGIBLE" | "REJECT" | "REVIEW";
  reasons: string[];
  rules: RuleResult[];
  recordedStatements: RecordedStatement[];
  unresolvedQuestions: string[];
  counts: { mandatory: { pass: number; fail: number; unknown: number }; preferred: { pass: number; fail: number; unknown: number } };
}

// ---------------------------------------------------------------------------
// Matching (exact after normalization; a small reviewed synonym list; NO fuzzy matching)
// ---------------------------------------------------------------------------

// Reviewed spellings of the same thing. Deliberately tiny. Tools that merely resemble each other
// (Selenium / Playwright, Java / JavaScript) are NOT here and never match.
const SYNONYMS: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  k8s: "kubernetes",
  postgres: "postgresql",
  golang: "go",
};

export function normalizeTerm(text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9+#./ -]/g, " ").replace(/\s+/g, " ").trim();
  return SYNONYMS[base] ?? base;
}

function factTerms(fact: CandidateFact): string[] {
  return [fact.value, ...(fact.attributes.matchTerms ?? [])].map(normalizeTerm);
}

interface Matches {
  usableHas: CandidateFact[];
  usableLacks: CandidateFact[];
  unusable: { fact: CandidateFact; detail: string }[];
}

function matchFacts(profile: CandidateProfile, kinds: readonly FactKind[], term: string, asOf: string): Matches {
  const wanted = normalizeTerm(term);
  const out: Matches = { usableHas: [], usableLacks: [], unusable: [] };
  for (const fact of profile.facts) {
    if (!kinds.includes(fact.kind) || !factTerms(fact).includes(wanted)) continue;
    const usable = factUsability(fact, asOf);
    if (!usable.usable) out.unusable.push({ fact, detail: usable.detail });
    else if (fact.polarity === "lacks") out.usableLacks.push(fact);
    else out.usableHas.push(fact);
  }
  return out;
}

const unusableNote = (m: Matches): string => (m.unusable.length > 0 ? ` Not usable: ${m.unusable.map((u) => u.detail).join("; ")}.` : "");

// ---------------------------------------------------------------------------
// Requirement evaluation
// ---------------------------------------------------------------------------

type Requirement = StructuredJob["requirements"][number];
type Outcome = Pick<RuleResult, "status" | "explanation" | "factIds">;

const SKILL_LIKE = new Set(["skill", "tool", "language", "platform", "domain_knowledge", "soft_skill"]);

function yearsText(months: number): string {
  return `${(months / 12).toFixed(1)} years`;
}

function evaluateRequirement(req: Requirement, profile: CandidateProfile, asOf: string): Outcome {
  const attested = profile.employmentHistoryComplete !== null;
  const usableEmployment = (): CandidateFact[] =>
    profile.facts.filter((f) => f.kind === "employment" && f.polarity === "has" && factUsability(f, asOf).usable);

  const compareYears = (months: number, factIds: string[], what: string): Outcome => {
    const needed = req.minimumYears!;
    if (months / 12 >= needed) {
      return { status: "PASS", explanation: `${what}: ${yearsText(months)} (overlap-safe union of approved employment dates) meets the ${needed}-year minimum.`, factIds };
    }
    const shortfall = `${what}: ${yearsText(months)} (overlap-safe union of approved employment dates) is below the ${needed}-year minimum.`;
    return attested
      ? { status: "FAIL", explanation: `${shortfall} The candidate attested the approved employment history is complete, so this is a demonstrated shortfall.`, factIds }
      : { status: "UNKNOWN", explanation: `${shortfall} The employment history is not attested complete, so an unlisted role could close the gap.`, factIds };
  };

  // --- experience measured in years ---------------------------------------------------------------------
  if (req.type === "role_experience" && req.scope.kind === "unspecified" && req.minimumYears !== null) {
    // "N+ years of experience" with no stated role or tool: the overlap-safe union of ALL approved employment.
    const all = usableEmployment();
    if (all.length === 0) {
      return { status: "UNKNOWN", explanation: `No approved employment facts, so ${req.minimumYears}+ years of experience cannot be established.`, factIds: [] };
    }
    return compareYears(unionMonths(all, asOf), all.map((f) => f.factId), "Total professional experience");
  }

  if (req.type === "role_experience") {
    const scopeTerm = req.scope.kind === "role" && req.scope.value ? req.scope.value : req.value;
    const wanted = normalizeTerm(scopeTerm);
    const tagged = profile.facts.filter((f) => f.kind === "employment" && (f.attributes.roleTags ?? []).map(normalizeTerm).includes(wanted));
    const usable = tagged.filter((f) => f.polarity === "has" && factUsability(f, asOf).usable);
    const unusable = tagged.filter((f) => !factUsability(f, asOf).usable).map((f) => (factUsability(f, asOf) as { detail: string }).detail);
    const note = unusable.length > 0 ? ` Not usable: ${unusable.join("; ")}.` : "";
    if (usable.length === 0) {
      return { status: "UNKNOWN", explanation: `No approved employment fact is tagged "${scopeTerm}". Role experience is never inferred from a job title.${note}`, factIds: tagged.map((f) => f.factId) };
    }
    const ids = usable.map((f) => f.factId);
    if (req.minimumYears === null) return { status: "PASS", explanation: `Approved employment tagged "${scopeTerm}" exists.`, factIds: ids };
    return compareYears(unionMonths(usable, asOf), ids, `Role experience "${scopeTerm}"`);
  }

  if (req.minimumYears !== null && SKILL_LIKE.has(req.type)) {
    const m = matchFacts(profile, ["skill"], req.value, asOf);
    if (m.usableLacks.length > 0 && m.usableHas.length === 0) {
      return { status: "FAIL", explanation: `The candidate explicitly states they lack "${req.value}".`, factIds: m.usableLacks.map((f) => f.factId) };
    }
    if (m.usableHas.length === 0) {
      return { status: "UNKNOWN", explanation: `No approved skill fact for "${req.value}", so ${req.minimumYears}+ years cannot be established.${unusableNote(m)}`, factIds: m.unusable.map((u) => u.fact.factId) };
    }
    const linkedIds = [...new Set(m.usableHas.flatMap((f) => f.attributes.experienceIds ?? []))];
    const linked = usableEmployment().filter((f) => linkedIds.includes(f.factId));
    const factIds = [...m.usableHas.map((f) => f.factId), ...linked.map((f) => f.factId)];
    if (linked.length === 0) {
      return { status: "UNKNOWN", explanation: `An approved skill fact for "${req.value}" exists but links to no approved employment, and years are not inferred from a skill mention.`, factIds };
    }
    return compareYears(unionMonths(linked, asOf), factIds, `Experience with "${req.value}"`);
  }

  if (req.minimumYears !== null) {
    // Years attached to a degree/certification-type requirement: nothing approved can establish it.
    return { status: "UNKNOWN", explanation: `A duration requirement on a ${req.type} requirement cannot be evaluated from approved facts.`, factIds: [] };
  }

  // --- skills / qualifications --------------------------------------------------------------------------
  const kinds: readonly FactKind[] = req.type === "degree" ? ["education"] : req.type === "certification" ? ["certification"] : ["skill"];
  const m = matchFacts(profile, kinds, req.value, asOf);
  if (m.usableHas.length > 0 && m.usableLacks.length > 0) {
    return { status: "UNKNOWN", explanation: `Approved facts conflict about "${req.value}" (one states it, one states a lack).`, factIds: [...m.usableHas, ...m.usableLacks].map((f) => f.factId) };
  }
  if (m.usableHas.length > 0) {
    return { status: "PASS", explanation: `Approved current fact(s) state "${req.value}".`, factIds: m.usableHas.map((f) => f.factId) };
  }
  if (m.usableLacks.length > 0) {
    return { status: "FAIL", explanation: `The candidate explicitly states they lack "${req.value}".`, factIds: m.usableLacks.map((f) => f.factId) };
  }
  return { status: "UNKNOWN", explanation: `No approved current fact states "${req.value}"; absence of a fact is not a demonstrated lack.${unusableNote(m)}`, factIds: m.unusable.map((u) => u.fact.factId) };
}

function combineGroup(members: Outcome[]): Outcome {
  const passed = members.filter((m) => m.status === "PASS");
  if (passed.length > 0) {
    return { status: "PASS", explanation: `At least one alternative is satisfied (${passed.length} of ${members.length}).`, factIds: [...new Set(passed.flatMap((m) => m.factIds))] };
  }
  const allFail = members.every((m) => m.status === "FAIL");
  return {
    status: allFail ? "FAIL" : "UNKNOWN",
    explanation: allFail ? `Every alternative is demonstrably not met (${members.length} of ${members.length}).` : `No alternative is satisfied and ${members.filter((m) => m.status === "UNKNOWN").length} of ${members.length} cannot be decided from approved facts.`,
    factIds: [...new Set(members.flatMap((m) => m.factIds))],
  };
}

const uniqueSpans = (spans: EvidenceSpan[]): EvidenceSpan[] => {
  const seen = new Set<string>();
  return spans.filter((s) => (seen.has(`${s.start}:${s.end}`) ? false : (seen.add(`${s.start}:${s.end}`), true)));
};

// ---------------------------------------------------------------------------
// Constraint evaluation
// ---------------------------------------------------------------------------

type Constraint = StructuredJob["constraints"][number];

function evaluateExplicitFactConstraint(c: Constraint, profile: CandidateProfile, kind: "clearance" | "work_authorization", asOf: string): Outcome {
  const term = c.value ?? c.type;
  const m = matchFacts(profile, [kind], term, asOf);
  const kindFacts = profile.facts.filter((f) => f.kind === kind);
  if (m.usableHas.length > 0) return { status: "PASS", explanation: `An approved explicit ${kind} fact matches "${term}".`, factIds: m.usableHas.map((f) => f.factId) };
  if (m.usableLacks.length > 0) return { status: "FAIL", explanation: `The candidate explicitly states they do not meet "${term}".`, factIds: m.usableLacks.map((f) => f.factId) };
  const pending = kindFacts.map((f) => factUsability(f, asOf)).filter((u): u is Extract<typeof u, { usable: false }> => !u.usable).map((u) => u.detail);
  return {
    status: "UNKNOWN",
    explanation: `No approved explicit ${kind} fact matches "${term}". Sensitive answers are never inferred from a name, education, employment history or a model.${pending.length > 0 ? ` Not usable: ${pending.join("; ")}.` : ""}`,
    factIds: [...m.unusable.map((u) => u.fact.factId)],
  };
}

function textOfConstraint(c: Constraint): string {
  return [c.value ?? "", ...c.evidence.map((e) => e.quote)].join(" ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface EvaluateInput {
  structured: StructuredJob;
  profile: CandidateProfile;
  review: ExtractionReview | null;
  /** ISO date the facts are judged on (expiry, "current" employment). */
  asOf: string;
  evaluatedAt?: string;
  policy?: DecisionPolicy;
}

export function evaluateJob(input: EvaluateInput): Decision {
  const { structured, profile, review, asOf } = input;
  const policy = input.policy ?? POLICY_V1;
  const rules: RuleResult[] = [];
  const recorded: RecordedStatement[] = [];

  // Requirements: grouped alternatives become one rule; the rest one rule each.
  const groups = new Map<string, Requirement[]>();
  const solo: Requirement[] = [];
  for (const r of structured.requirements) {
    if (r.groupId) groups.set(r.groupId, [...(groups.get(r.groupId) ?? []), r]);
    else solo.push(r);
  }
  const levelOf = (level: Requirement["level"]): { mandatory: boolean; level: RuleResult["level"] } => ({ mandatory: level === "required", level });

  for (const r of solo) {
    const outcome = evaluateRequirement(r, profile, asOf);
    rules.push({ ruleId: `req:${r.id}`, subject: { kind: "requirement", id: r.id }, label: `${r.type}: ${r.value}${r.minimumYears !== null ? ` (${r.minimumYears}+ years)` : ""}`, ...levelOf(r.level), ...outcome, evidence: r.evidence });
  }
  for (const [groupId, members] of groups) {
    const results = members.map((m) => evaluateRequirement(m, profile, asOf));
    const combined = combineGroup(results);
    // Each alternative's own status and reason, so a reader sees WHY a group is undecided.
    const detail = members.map((m, i) => `${m.value} -> ${results[i]!.status}: ${results[i]!.explanation}`).join(" || ");
    rules.push({
      ruleId: `group:${groupId}`,
      subject: { kind: "group", id: groupId },
      label: `any of: ${members.map((m) => m.value).join(" | ")}`,
      ...levelOf(members[0]!.level),
      status: combined.status,
      explanation: `${combined.explanation} [${detail}]`,
      factIds: combined.factIds,
      evidence: uniqueSpans(members.flatMap((m) => m.evidence)),
    });
  }

  // Constraints.
  for (const c of structured.constraints) {
    const base = { constraintId: c.id, type: c.type, status: c.status, value: c.value, evidence: c.evidence };
    if (c.type === "sponsorship") {
      recorded.push({ ...base, handling: "Recorded only. Sponsorship-based filtering is disabled by policy; this statement does not affect the outcome." });
      continue;
    }
    if (c.status === "unknown") continue; // the JD says nothing: no rule, no restriction invented
    if ((c.type === "clearance" || c.type === "work_authorization" || c.type === "citizenship") && c.status === "required") {
      const kind = c.type === "clearance" ? "clearance" : "work_authorization";
      const outcome = evaluateExplicitFactConstraint(c, profile, kind, asOf);
      rules.push({ ruleId: `constraint:${c.id}`, subject: { kind: "constraint", id: c.id }, label: `${c.type} required${c.value ? `: ${c.value}` : ""}`, mandatory: true, level: "required", ...outcome, evidence: c.evidence });
      continue;
    }
    if (c.type === "location") {
      const pref = profile.preferences.locationWorkMode;
      if (!pref) {
        recorded.push({ ...base, handling: "Recorded only: no location/work-mode preference is configured in the candidate profile." });
        continue;
      }
      const text = textOfConstraint(c);
      const hit = pref.terms.find((t) => text.includes(t.toLowerCase()));
      const mandatory = pref.strength === "mandatory";
      const status: RuleStatus = hit ? "PASS" : mandatory ? "FAIL" : "UNKNOWN";
      if (!mandatory && !hit) {
        recorded.push({ ...base, handling: `Recorded only: the JD's stated location matches none of the candidate's preferred terms (${pref.terms.join(", ")}); the preference is not mandatory.` });
        continue;
      }
      rules.push({
        ruleId: `constraint:${c.id}`,
        subject: { kind: "preference", id: c.id },
        label: `location/work mode (${pref.strength} preference: ${pref.terms.join(", ")})`,
        mandatory,
        level: mandatory ? "required" : "preferred",
        status,
        explanation: hit ? `The JD's stated location matches the candidate's term "${hit}".` : `The JD's stated location matches none of the candidate's mandatory terms (${pref.terms.join(", ")}).`,
        factIds: [],
        evidence: c.evidence,
      });
      continue;
    }
    recorded.push({ ...base, handling: "Recorded only; not an evaluated eligibility rule." });
  }

  // Coverage: omitted requirements must never be read as passed.
  const reviewMatches = review !== null && review.jdHash === structured.jdHash && review.jobId === structured.jobId && review.structuredId === structured.id && review.extractionDigest === structuredExtractionDigest(structured);
  const attestedComplete = reviewMatches && review!.coverage === "complete" && !!review!.reviewedBy && !!review!.reviewedAt;
  const coverage: Decision["extraction"]["coverage"] = !reviewMatches ? "unreviewed" : review!.coverage;
  rules.push({
    ruleId: "coverage:extraction",
    subject: { kind: "coverage", id: "extraction" },
    label: "structured extraction covers the JD and was reviewed",
    mandatory: true,
    level: "n/a",
    status: attestedComplete ? "PASS" : "UNKNOWN",
    explanation: attestedComplete
      ? `Reviewer ${review!.reviewedBy} attested complete coverage.`
      : review === null
        ? "No extraction review record: nothing attests that the extracted requirements cover the JD."
        : !reviewMatches
          ? review.jdHash !== structured.jdHash ? "The extraction review record is for a different JD revision." : review.jobId === undefined || review.structuredId === undefined || review.extractionDigest === undefined ? "The extraction review record is not bound to a job and extraction (legacy format); re-review it against this extraction." : review.jobId !== structured.jobId ? "The extraction review record is for a different job." : "The extraction review record is for a different extraction revision."
          : review.coverage === "partial"
            ? `The reviewer marked coverage partial${review.omissions.length ? `; known omissions: ${review.omissions.map((o) => o.replace(/\.$/, "")).join("; ")}` : ""}.`
            : "Coverage is marked complete but no reviewer name and date are recorded.",
    factIds: [],
    evidence: [],
  });

  const tally = (mandatory: boolean) => ({
    pass: rules.filter((r) => r.mandatory === mandatory && r.status === "PASS").length,
    fail: rules.filter((r) => r.mandatory === mandatory && r.status === "FAIL").length,
    unknown: rules.filter((r) => r.mandatory === mandatory && r.status === "UNKNOWN").length,
  });
  const counts = { mandatory: tally(true), preferred: tally(false) };
  const mandatoryCriteria = rules.filter((r) => r.mandatory && r.subject.kind !== "coverage");

  const reasons: string[] = [];
  let outcome: Decision["outcome"];
  if (counts.mandatory.fail > 0) {
    outcome = "REJECT";
    for (const r of rules.filter((x) => x.mandatory && x.status === "FAIL")) reasons.push(`Mandatory criterion not met: ${r.label}.`);
  } else if (counts.mandatory.unknown > 0 || mandatoryCriteria.length === 0) {
    outcome = "REVIEW";
    for (const r of rules.filter((x) => x.mandatory && x.status === "UNKNOWN")) reasons.push(`Cannot decide: ${r.label}.`);
    if (mandatoryCriteria.length === 0) reasons.push("The extraction contains no mandatory criteria to evaluate.");
  } else {
    outcome = "ELIGIBLE";
    reasons.push("Every applicable mandatory criterion passed on approved current facts and the extraction coverage was attested complete.");
  }
  if (counts.mandatory.fail > 0 && !attestedComplete) reasons.push("Extraction coverage is not attested complete; the rejection rests on the criteria that were extracted.");

  const unresolvedQuestions = rules
    .filter((r) => r.status === "UNKNOWN" && (r.mandatory || r.level === "preferred"))
    .map((r) => (r.subject.kind === "coverage" ? "Who reviewed the extraction, and does it cover every requirement in the JD?" : `Provide or approve a candidate fact for: ${r.label}${r.mandatory ? " (mandatory)" : " (preferred)"}.`));

  const digest = profileDigest(profile);
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    id: decisionKey({ jobId: structured.jobId, jdHash: structured.jdHash, structuredId: structured.id, profileDigest: digest, policyVersion: policy.policyVersion }),
    jobId: structured.jobId,
    jdHash: structured.jdHash,
    structuredId: structured.id,
    extraction: {
      provenance: review?.provenance ?? (structured.providerRevision.includes("MANUAL_ANNOTATION") ? "MANUAL_ANNOTATION" : "UNKNOWN"),
      providerRevision: structured.providerRevision,
      parserVersion: structured.parserVersion,
      coverage,
      reviewedBy: reviewMatches ? review!.reviewedBy : null,
      omissions: reviewMatches ? review!.omissions : [],
    },
    candidateId: profile.candidateId,
    profileVersion: profile.profileVersion,
    profileDigest: digest,
    policyVersion: policy.policyVersion,
    asOf,
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
    outcome,
    reasons,
    rules,
    recordedStatements: recorded,
    unresolvedQuestions,
    counts,
  };
}

export function decisionKey(parts: { jobId: string; jdHash: string; structuredId: string; profileDigest: string; policyVersion: string }): string {
  return `${parts.jobId}::${parts.jdHash}::${parts.structuredId}::${parts.profileDigest.slice(0, 16)}::${parts.policyVersion}`;
}

/** Why a stored decision no longer applies to the current inputs (empty = still current). */
export function decisionStaleness(
  decision: Pick<Decision, "jdHash" | "structuredId" | "profileDigest" | "policyVersion" | "schemaVersion">,
  current: { jdHash: string; structuredId: string; profileDigest: string; policyVersion: string },
): string[] {
  const reasons: string[] = [];
  if (decision.schemaVersion !== DECISION_SCHEMA_VERSION) reasons.push("decision schema version changed");
  if (decision.jdHash !== current.jdHash) reasons.push("the job description changed");
  if (decision.structuredId !== current.structuredId) reasons.push("the structured extraction changed");
  if (decision.profileDigest !== current.profileDigest) reasons.push("the candidate profile changed");
  if (decision.policyVersion !== current.policyVersion) reasons.push("the decision policy changed");
  return reasons;
}

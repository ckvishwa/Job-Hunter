import type { ConditionDecision, RequirementDecision } from "./decide.js";
import type { MatchReport } from "./pipeline.js";

/** M4 policy is deliberately limited to an employer's explicit restriction contradicted by an approved candidate attestation. */
export const DECISION_POLICY_VERSION = "match-decision@2";
export const RANKING_WEIGHTS = Object.freeze({ requiredSkills: 30, preferredSkills: 10, professionalExperience: 15, educationCertification: 10,
  rolePreference: 10, locationCompatibility: 5, workArrangement: 5, employmentArrangement: 5, postingFreshness: 5, knownApplicationConstraints: 5 });
export type MatchOutcome = "SHORTLIST" | "REVIEW_REQUIRED" | "REJECT";
export type PostingStatus = "RECENT" | "STALE" | "UNKNOWN";

type RequirementRef = Pick<RequirementDecision, "requirementId" | "value" | "type" | "status" | "jd" | "matchedFactIds" | "explanation"> & { candidateFactIds: string[] };
export interface MatchDecision {
  version: typeof DECISION_POLICY_VERSION;
  outcome: MatchOutcome;
  hardReject: boolean;
  ranking: { score: number; weights: typeof RANKING_WEIGHTS; components: Record<keyof typeof RANKING_WEIGHTS, number>; normalization: string } | null;
  matched: RequirementRef[];
  missing: RequirementRef[];
  uncertain: RequirementRef[];
  blocking: Array<{ condition: ConditionDecision["type"]; rule: "explicit-attestation-conflict"; jd: ConditionDecision["jd"]; candidateFactIds: string[]; explanation: string }>;
  warnings: string[];
  reason: string;
  nextReviewAction: string | null;
  sourceVerification?: { observedAt: string | null; liveConfirmed: boolean | null; finalUrl: string | null };
}

const DEFAULT_REJECT_ON = ["citizenship", "clearance", "work_authorization"] as const;

const ref = (r: RequirementDecision): RequirementRef => ({
  requirementId: r.requirementId, value: r.value, type: r.type, status: r.status, jd: r.jd,
  matchedFactIds: r.matchedFactIds, candidateFactIds: r.matchedFactIds, explanation: r.explanation,
});

function fraction(items: RequirementDecision[]): number {
  if (!items.length) return 0.5; // neutral when a JD states no requirement in this category
  return items.reduce((n, r) => n + (r.status === "SUPPORTED" ? 1 : r.status === "PARTIAL" ? 0.5 : 0), 0) / items.length;
}

export function decideMatch(report: MatchReport, options: { rejectOn?: readonly ConditionDecision["type"][]; postingStatus?: PostingStatus;
  rolePreference?: "MATCH" | "MISMATCH" | "UNKNOWN"; locationCompatibility?: "MATCH" | "MISMATCH" | "UNKNOWN";
  employmentArrangement?: "MATCH" | "MISMATCH" | "UNKNOWN" } = {}): MatchDecision {
  const empty: MatchDecision = {
    version: DECISION_POLICY_VERSION, outcome: "REVIEW_REQUIRED", hardReject: false, ranking: null,
    matched: [], missing: [], uncertain: [], blocking: [], warnings: [], reason: "", nextReviewAction: null,
  };
  if (report.status === "EXTRACTION_FAILED") return { ...empty, warnings: [report.failure.code], reason: "The JD extraction did not validate.", nextReviewAction: "Review the original posting and retry extraction." };

  const groups = new Map(report.alternativeGroups.map((g) => [g.groupId, g]));
  const relevant = report.requirements.filter((r) => r.applicable && (r.effectiveLevel === "required" || r.effectiveLevel === "preferred"));
  const effective = relevant.filter((r) => !r.groupId || groups.get(r.groupId)?.status !== "SUPPORTED" || r.status === "SUPPORTED");
  const required = effective.filter((r) => r.effectiveLevel === "required");
  const preferred = effective.filter((r) => r.effectiveLevel === "preferred");
  const matched = relevant.filter((r) => r.status === "SUPPORTED").map(ref);
  const missing = relevant.filter((r) => r.status === "UNSUPPORTED").map(ref);
  const uncertain = relevant.filter((r) => r.effectiveLevel === "required" && r.status !== "SUPPORTED").map(ref);

  const rejectOn = new Set(options.rejectOn ?? DEFAULT_REJECT_ON);
  const blocking = report.conditions.filter((c) => c.result === "BLOCKER" && c.severity === "blocker" && rejectOn.has(c.type) && !!c.jd.quote?.trim() && c.candidateFactIds.length > 0)
    .map((c) => ({ condition: c.type, rule: "explicit-attestation-conflict" as const, jd: c.jd, candidateFactIds: c.candidateFactIds, explanation: c.explanation }));
  const unprovenBlockers = report.conditions.filter((c) => c.severity === "blocker" && !blocking.some((b) => b.condition === c.type));
  const warningConditions = report.conditions.filter((c) => c.severity === "needs-candidate-answer" || c.severity === "extraction-gap");
  const warnings = [...report.extraction.warnings, ...report.extraction.analysisWarnings];
  if (options.postingStatus === "STALE") warnings.push("POSTING_STALE");
  if (options.postingStatus === "UNKNOWN") warnings.push("POSTING_NOT_VERIFIED_RECENTLY");
  if (report.extraction.requirements === 0) warnings.push("NO_EXTRACTED_REQUIREMENTS");

  const skill = (r: RequirementDecision) => !["role_experience", "degree", "certification"].includes(r.type);
  const professional = (r: RequirementDecision) => r.type === "role_experience" || /experience/.test(r.type) || r.support.some((s) => s.basis === "computed-months");
  const education = (r: RequirementDecision) => r.type === "degree" || r.type === "certification";
  const components = {
    requiredSkills: fraction(required.filter(skill)), preferredSkills: fraction(preferred.filter(skill)),
    professionalExperience: fraction(required.filter(professional)), educationCertification: fraction(required.filter(education)),
    rolePreference: options.rolePreference === "MATCH" ? 1 : options.rolePreference === "MISMATCH" ? 0 : 0.5,
    locationCompatibility: options.locationCompatibility === "MATCH" ? 1 : options.locationCompatibility === "MISMATCH" ? 0 : 0.5,
    workArrangement: report.arrangement.selection === "MATCHES_SELECTION" ? 1 : report.arrangement.selection === "NOT_IN_SELECTION" ? 0 : 0.5,
    employmentArrangement: options.employmentArrangement === "MATCH" ? 1 : options.employmentArrangement === "MISMATCH" ? 0 : 0.5,
    postingFreshness: options.postingStatus === "RECENT" ? 1 : options.postingStatus === "STALE" ? 0 : 0.5,
    knownApplicationConstraints: warningConditions.length ? 0 : report.conditions.some((c) => c.result === "SATISFIED") ? 1 : 0.5,
  };
  const score = Math.round((Object.keys(RANKING_WEIGHTS) as Array<keyof typeof RANKING_WEIGHTS>).reduce((sum, key) => sum + RANKING_WEIGHTS[key] * components[key], 0));
  const ranking = { score, weights: RANKING_WEIGHTS, components, normalization: "Each factor is in [0,1]; absent or unknown factors receive 0.5. This is an ordering heuristic, not a hiring probability." };

  if (blocking.length && !warnings.some((w) => /CONFLICT/.test(w))) return { ...empty, outcome: "REJECT", hardReject: true, ranking: null, matched, missing, uncertain, blocking, warnings,
    reason: "An explicit employer eligibility requirement conflicts with an approved candidate attestation under the screening policy.", nextReviewAction: "Review the quoted restriction, attestation and policy before closing the job." };
  const needsReview = uncertain.length > 0 || warningConditions.length > 0 || unprovenBlockers.length > 0 || report.arrangement.selection === "NOT_IN_SELECTION" || warnings.some((w) => /CONDITION_MENTIONED_BUT_UNCLASSIFIED|OTHER_ELIGIBILITY_UNCLASSIFIED|STUDENT_ONLY|POSTING_|NO_EXTRACTED_REQUIREMENTS|CONFLICT/i.test(w)) || required.length === 0;
  if (needsReview) return { ...empty, ranking, matched, missing, uncertain, warnings,
    reason: "A required qualification, eligibility condition, or posting source needs review.", nextReviewAction: "Check the original JD and the missing or ambiguous approved candidate evidence." };
  return { ...empty, outcome: "SHORTLIST", ranking, matched, missing, uncertain, warnings,
    reason: "Required qualifications are supported by approved evidence and no verified blocking condition is present.", nextReviewAction: "Verify the posting remains open before application preparation." };
}

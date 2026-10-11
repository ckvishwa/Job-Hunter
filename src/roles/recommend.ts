import { factContentDigest, factUsability, type CandidateFact } from "../domain/candidate-profile.js";
import { EVIDENCE_KINDS, normalizeAlias, roleDefinitionDigest, sha256Json, type RoleDefinition } from "./catalog.js";
import type { ExperienceSummary } from "./experience.js";

// S2: explainable, deterministic role assessment. A pure function of (role definitions, candidate facts, asOf). It never
// reads JSONL, never calls a model, and never looks at sensitive facts. Evidence is a link back to an approved fact; a
// requirement is "met" only by an approved, usable fact that states it (polarity "has"). Similarity is not used here.
//
//   SUPPORTED : at least `minCoreMatches` core requirements are met AND at least one core requirement is met by a
//               demonstrated fact (employment, project or certification) rather than only a skill mention or coursework.
//   PARTIAL   : at least one core requirement is met, but the SUPPORTED conditions are not.
//   NO_MATCH  : no core requirement is met. Never persisted as a recommendation; returned with its evidence gaps.

export type Support = "SUPPORTED" | "PARTIAL" | "NO_MATCH";
export type EvidenceVia = "employment" | "project" | "certification" | "education" | "skill_mention";
const DEMONSTRATED_VIA: ReadonlySet<EvidenceVia> = new Set(["employment", "project", "certification"]);

export interface EvidenceMatch {
  factId: string;
  kind: CandidateFact["kind"];
  via: EvidenceVia;
  matchedTerm: string;
  demonstrated: boolean;
}

export interface RequirementResult {
  id: string;
  label: string;
  importance: "core" | "supporting";
  met: boolean;
  matches: EvidenceMatch[];
  /** Approved facts that explicitly say the candidate lacks this (polarity "lacks"). They never count as support. */
  explicitLackFactIds: string[];
}

export type GapCode = "UNMET_CORE" | "UNMET_SUPPORTING" | "NO_DEMONSTRATED_EVIDENCE" | "BELOW_MIN_CORE" | "EXPLICIT_LACK";
export interface Gap {
  code: GapCode;
  requirementId?: string;
  message: string;
}

export interface TitleSignal {
  factId: string;
  alias: string;
}

export interface RoleAssessment {
  roleSlug: string;
  familySlug: string;
  title: string;
  support: Support;
  coreMet: number;
  coreTotal: number;
  minCoreMatches: number;
  requirements: RequirementResult[];
  titleSignals: TitleSignal[];
  sourceFactIds: string[];
  gaps: Gap[];
  roleDefinitionDigest: string;
  /** Changes if and only if the role definition or the evidence it rests on changes. */
  inputDigest: string;
}

const EVIDENCE_KIND_SET: ReadonlySet<string> = new Set(EVIDENCE_KINDS);

/** Lowercase; every run of non-[a-z0-9+#] becomes one space, so "MITRE ATT&CK", "Node.js" and "SC-200" compare predictably. */
export function normalizeForMatch(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim()} `;
}

function factText(fact: CandidateFact): string {
  const a = fact.attributes;
  return normalizeForMatch([fact.value, a.detail, a.title, ...(a.technologies ?? []), ...(a.matchTerms ?? []), ...(a.roleTags ?? [])].filter(Boolean).join(" | "));
}

const viaOf = (kind: CandidateFact["kind"]): EvidenceVia =>
  kind === "employment" ? "employment" : kind === "project" ? "project" : kind === "certification" ? "certification" : kind === "education" ? "education" : "skill_mention";

const findTerm = (haystack: string, terms: readonly string[]): string | null => {
  for (const term of terms) {
    const needle = normalizeForMatch(term);
    if (needle.trim() && haystack.includes(needle)) return term;
  }
  return null;
};

export interface AssessInput {
  roles: readonly RoleDefinition[];
  facts: readonly CandidateFact[];
  asOf: string;
}

export interface AssessOutput {
  assessments: RoleAssessment[];
  /** Per role and requirement: PENDING facts that mention it. Hints only; they never count and are not persisted. */
  pendingHints: Record<string, Record<string, string[]>>;
}

export function assessRoles(input: AssessInput): AssessOutput {
  const usable = input.facts.filter((f) => EVIDENCE_KIND_SET.has(f.kind) && f.sensitivity === "normal" && factUsability(f, input.asOf).usable);
  const pending = input.facts.filter((f) => EVIDENCE_KIND_SET.has(f.kind) && f.sensitivity === "normal" && f.approvalStatus === "pending" && f.polarity === "has");
  const usableText = new Map(usable.map((f) => [f.factId, factText(f)]));
  const pendingText = new Map(pending.map((f) => [f.factId, factText(f)]));
  const digestOf = new Map(usable.map((f) => [f.factId, factContentDigest(f)]));
  const pendingHints: AssessOutput["pendingHints"] = {};

  const assessments = input.roles
    .filter((r) => r.active)
    .map((role): RoleAssessment => {
      const requirements: RequirementResult[] = role.evidence.requirements.map((req) => {
        const matches: EvidenceMatch[] = [];
        const lacks: string[] = [];
        for (const fact of usable) {
          const term = findTerm(usableText.get(fact.factId)!, req.terms);
          if (!term) continue;
          if (fact.polarity === "lacks") {
            lacks.push(fact.factId);
            continue;
          }
          const via = viaOf(fact.kind);
          matches.push({ factId: fact.factId, kind: fact.kind, via, matchedTerm: term, demonstrated: DEMONSTRATED_VIA.has(via) });
        }
        matches.sort((a, b) => a.factId.localeCompare(b.factId));
        const hints = pending.filter((f) => findTerm(pendingText.get(f.factId)!, req.terms)).map((f) => f.factId).sort();
        if (hints.length > 0 && matches.length === 0) (pendingHints[role.roleSlug] ??= {})[req.id] = hints;
        return { id: req.id, label: req.label, importance: req.importance, met: matches.length > 0, matches, explicitLackFactIds: lacks.sort() };
      });

      const coreReqs = requirements.filter((r) => r.importance === "core");
      const coreMet = coreReqs.filter((r) => r.met).length;
      const demonstratedCore = coreReqs.filter((r) => r.matches.some((m) => m.demonstrated)).length;
      const support: Support =
        coreMet >= role.evidence.minCoreMatches && demonstratedCore >= 1 ? "SUPPORTED" : coreMet >= 1 ? "PARTIAL" : "NO_MATCH";

      const gaps: Gap[] = [];
      for (const r of requirements) {
        if (!r.met) gaps.push({ code: r.importance === "core" ? "UNMET_CORE" : "UNMET_SUPPORTING", requirementId: r.id, message: `No approved fact shows: ${r.label}.` });
        if (r.explicitLackFactIds.length > 0) gaps.push({ code: "EXPLICIT_LACK", requirementId: r.id, message: `You stated you lack: ${r.label}.` });
      }
      if (support !== "SUPPORTED") {
        if (coreMet >= role.evidence.minCoreMatches && demonstratedCore === 0) {
          gaps.push({ code: "NO_DEMONSTRATED_EVIDENCE", message: "Core requirements appear only as skill mentions or coursework; no approved job, project or certification shows them." });
        } else if (coreMet < role.evidence.minCoreMatches) {
          gaps.push({ code: "BELOW_MIN_CORE", message: `${coreMet} of the ${role.evidence.minCoreMatches} core requirements needed are met.` });
        }
      }

      const aliasNorms = [...role.aliases, role.title].map(normalizeAlias).filter(Boolean);
      const titleSignals: TitleSignal[] = [];
      if (support !== "NO_MATCH") {
        for (const fact of usable) {
          if (fact.kind !== "employment" || fact.polarity !== "has") continue;
          const title = normalizeForMatch(fact.attributes.title ?? fact.value);
          const alias = aliasNorms.find((a) => title.includes(normalizeForMatch(a)));
          if (alias) titleSignals.push({ factId: fact.factId, alias });
        }
        titleSignals.sort((a, b) => a.factId.localeCompare(b.factId));
      }

      const sourceFactIds =
        support === "NO_MATCH"
          ? []
          : [...new Set([...requirements.flatMap((r) => r.matches.map((m) => m.factId)), ...requirements.flatMap((r) => r.explicitLackFactIds), ...titleSignals.map((t) => t.factId)])].sort();

      const defDigest = roleDefinitionDigest(role);
      const inputDigest = sha256Json({
        role: defDigest, support,
        sources: sourceFactIds.map((id) => [id, digestOf.get(id)]),
        requirements: requirements.map((r) => [r.id, r.met, r.matches.map((m) => [m.factId, m.matchedTerm]), r.explicitLackFactIds]),
        gaps: gaps.map((g) => [g.code, g.requirementId ?? ""]),
      });

      return {
        roleSlug: role.roleSlug, familySlug: role.familySlug, title: role.title, support, coreMet, coreTotal: coreReqs.length,
        minCoreMatches: role.evidence.minCoreMatches, requirements, titleSignals, sourceFactIds, gaps, roleDefinitionDigest: defDigest, inputDigest,
      };
    });

  return { assessments, pendingHints };
}

export interface ExperienceNote {
  code: "EXPERIENCE_NEEDS_REVIEW" | "EXPERIENCE_BELOW_ADVISORY" | "EXPERIENCE_UNCERTAIN" | "NO_EXPERIENCE_DATA";
  message: string;
}

/** Advisory only. Computed at read time (it depends on `asOf`), never persisted, never a gate. */
export function experienceNote(role: Pick<RoleDefinition, "evidence">, experience: ExperienceSummary): ExperienceNote | null {
  const want = role.evidence.advisoryProfessionalMonths;
  if (want <= 0) return null;
  if (experience.status === "REVIEW") return { code: "EXPERIENCE_NEEDS_REVIEW", message: "Your employment history has items that need review, so professional experience cannot be stated reliably." };
  if (experience.status === "NO_DATA") return { code: "NO_EXPERIENCE_DATA", message: "No approved, classified professional employment yet; this role usually looks for some." };
  const p = experience.buckets.professional;
  if (p.monthsUpper < want) return { code: "EXPERIENCE_BELOW_ADVISORY", message: `Approved professional experience is at most ${p.monthsUpper} months; this role usually looks for about ${want}. Advice only.` };
  if (p.monthsLower < want) return { code: "EXPERIENCE_UNCERTAIN", message: `Approved professional experience is ${p.monthsLower}-${p.monthsUpper} months (month precision); this role usually looks for about ${want}. Advice only.` };
  return null;
}

export type Readiness = "UNKNOWN" | "ENTRY" | "EARLY_CAREER" | "ESTABLISHED";

/**
 * Advice for the S3 search band. NOT a statement of how many years the candidate has and NOT a job-level eligibility decision.
 * Based on the conservative lower bound of approved, classified professional time.
 */
export function suggestSearchBand(experience: ExperienceSummary): { readiness: Readiness; minYears: number; maxYears: number; basis: string } {
  if (experience.status === "REVIEW" || experience.status === "NO_DATA") {
    return { readiness: "UNKNOWN", minYears: 0, maxYears: 5, basis: "Experience is unknown or needs review; the default 0-5 year discovery window is shown. It is not a claim of five years." };
  }
  const lowerYears = experience.buckets.professional.monthsLower / 12;
  const readiness: Readiness = lowerYears < 1 ? "ENTRY" : lowerYears < 3 ? "EARLY_CAREER" : "ESTABLISHED";
  const maxYears = Math.min(5, Math.max(2, Math.ceil(lowerYears) + 2));
  return { readiness, minYears: 0, maxYears, basis: `Based on ${experience.buckets.professional.monthsLower} approved professional months (lower bound). The discovery window is advice, not a claim.` };
}

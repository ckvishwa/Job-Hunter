import { unionMonths } from "../domain/candidate-profile.js";
import type { AnalyzedRequirement, Condition, JdAnalysis } from "./analyze.js";
import type { EligibilityFact, EvidenceCorpus, EvidenceUnit } from "./evidence.js";
import { lexicon, normalizeText, type Lexicon } from "./lexicon.js";
import type { RetrievalResult } from "./retrieval.js";

// S4A requirement decision engine. Deterministic. Retrieval results are attached as LEADS and never change a status.
//
//   SUPPORTED    an approved, authorized, source-backed fact states it (exact reviewed spelling, or a member of the requirement's category),
//                at the strength the wording asks for; or computed professional months from approved classified employment meet the minimum.
//   PARTIAL      real approved evidence exists but does not establish the whole requirement (a skills-list mention where the JD asks for hands-on
//                use; a tool with no linked duration; fewer months than asked; some but not all of an AND list).
//   UNSUPPORTED  no approved, authorized evidence supports it. This is an evidence gap, not proof of a lack; `explicitLack` is true only when
//                an approved "lacks" fact says so.
//   UNKNOWN      the engine cannot judge from facts (soft qualities, wording it cannot map to a reviewed term, a domain-scoped duration with no
//                linked employment, a requirement the JD says is not needed).
// Never: years inferred from a keyword or a title, projects counted as professional employment, a sensitive condition inferred, a numeric score.

export const MATCH_POLICY_VERSION = "match-policy@1";
export type ReqStatus = "SUPPORTED" | "PARTIAL" | "UNSUPPORTED" | "UNKNOWN";

export interface SupportQuote {
  factId: string;
  resumeId: string | null;
  category: EvidenceUnit["category"];
  value: string;
  quote: string | null;
  basis: "exact" | "category-member" | "computed-months";
  strength: "demonstrated" | "mention";
}

export interface RequirementDecision {
  requirementId: string;
  value: string;
  type: string;
  level: AnalyzedRequirement["level"];
  effectiveLevel: AnalyzedRequirement["effectiveLevel"];
  applicable: boolean;
  mandatory: boolean;
  status: ReqStatus;
  explicitLack: boolean;
  matchedFactIds: string[];
  support: SupportQuote[];
  /** Related approved evidence that was NOT counted (for example projects offered against a professional-years requirement). */
  notCounted: Array<{ factId: string; reason: string }>;
  /** Similarity-ranked leads for a human reviewer. Never counted. */
  retrievalLeads: Array<{ factId: string; unitId: string; hybridRank: number; lexicalRank: number | null; bm25Rank: number | null; semanticRank: number | null; semanticScore: number | null }>;
  missingEvidence: string[];
  explanation: string;
  jd: { quote: string; start: number; end: number };
  groupId: string | null;
  termRole: AnalyzedRequirement["termRole"];
}

export interface GroupDecision { groupId: string; status: ReqStatus; memberIds: string[]; satisfiedBy: string[]; explanation: string }

export interface ConditionDecision {
  type: Condition["type"];
  jd: { status: Condition["status"]; value: string | null; quote: string | null };
  candidateFactIds: string[];
  result: "SATISFIED" | "BLOCKER" | "UNKNOWN" | "NOT_APPLICABLE" | "ATTENTION";
  severity: "blocker" | "needs-candidate-answer" | "extraction-gap" | "info";
  explanation: string;
}

const MANDATORY: ReadonlySet<string> = new Set(["required"]);
const COUNTRY = /\b(?:u\.?s\.?a?|united states(?: of america)?)\b/i;

function lookupLead(retrieval: RetrievalResult | undefined, units: Map<string, EvidenceUnit>, limit = 3): RequirementDecision["retrievalLeads"] {
  if (!retrieval) return [];
  const rank = (list: Array<{ unitId: string; rank: number; score: number }> | null | undefined, id: string) => list?.find((r) => r.unitId === id);
  return retrieval.hybrid.slice(0, limit).map((h) => ({
    factId: units.get(h.unitId)!.factId, unitId: h.unitId, hybridRank: h.rank, lexicalRank: rank(retrieval.lexical, h.unitId)?.rank ?? null, bm25Rank: rank(retrieval.bm25, h.unitId)?.rank ?? null,
    semanticRank: rank(retrieval.semantic, h.unitId)?.rank ?? null, semanticScore: rank(retrieval.semantic, h.unitId)?.score ?? null,
  }));
}

function degreeLevel(text: string): "bachelor" | "master" | "doctorate" | null {
  if (/\b(?:ph\.?d|doctor)/i.test(text)) return "doctorate";
  if (/\b(?:m\.?s\.?|m\.?sc|master|m\.?tech|mba)\b/i.test(text)) return "master";
  if (/\b(?:b\.?s\.?|b\.?sc|b\.?a\.?|b\.?tech|b\.?e\.?|bachelor)\b/i.test(text)) return "bachelor";
  return null;
}
const DEGREE_RANK = { bachelor: 1, master: 2, doctorate: 3 } as const;

export interface DecideInput {
  analysis: JdAnalysis;
  corpus: EvidenceCorpus;
  retrieval: Map<string, RetrievalResult>;
  asOf: string;
  lex?: Lexicon;
}

export function decideRequirements(input: DecideInput): { decisions: RequirementDecision[]; groups: GroupDecision[] } {
  const lex = input.lex ?? lexicon();
  const unitsById = new Map(input.corpus.units.map((u) => [u.unitId, u]));
  const decisions: RequirementDecision[] = [];

  for (const r of input.analysis.requirements) {
    const base: RequirementDecision = {
      requirementId: r.id, value: r.value, type: r.type, level: r.level, effectiveLevel: r.effectiveLevel, applicable: !r.negated, mandatory: MANDATORY.has(r.effectiveLevel),
      status: "UNKNOWN", explicitLack: false, matchedFactIds: [], support: [], notCounted: [], retrievalLeads: lookupLead(input.retrieval.get(r.id), unitsById), missingEvidence: [],
      explanation: "", jd: r.quote, groupId: r.groupId, termRole: r.termRole,
    };
    const done = (status: ReqStatus, explanation: string, extra: Partial<RequirementDecision> = {}): void => {
      decisions.push({ ...base, ...extra, status, explanation, matchedFactIds: [...new Set((extra.support ?? base.support).map((s) => s.factId))] });
    };

    if (r.negated) { done("UNKNOWN", "The cited text says this is not required, so it is not counted as a requirement."); continue; }
    if (r.softSkill) { done("UNKNOWN", "A personal quality or soft skill is not something approved facts can establish; it is left for the candidate to judge.", { missingEvidence: ["No approved fact can establish a personal quality."] }); continue; }

    // ---- years -----------------------------------------------------------------------------------------------------------------------
    if (r.minimumYears !== null) {
      const professional = input.corpus.employment.filter((f) => f.attributes.employmentType === "professional");
      const projects = input.corpus.units.filter((u) => u.category === "project");
      const notCounted = projects.map((p) => ({ factId: p.factId, reason: "a project is not professional employment and never adds years" }));
      const monthsFor = (facts: typeof professional): number => (facts.length ? unionMonths(facts, input.asOf) : 0);
      const asYears = (m: number): string => `${(m / 12).toFixed(1)} years`;
      const supportFrom = (facts: typeof professional): SupportQuote[] => facts.map((f) => {
        const u = unitsById.get(`fact:${f.factId}`);
        return { factId: f.factId, resumeId: u?.resumeId ?? null, category: "employment" as const, value: f.value, quote: u?.quote ?? null, basis: "computed-months" as const, strength: "demonstrated" as const };
      });

      if (r.yearsKind === "tool") {
        const tool = input.corpus.units.filter((u) => (u.category === "skill" || u.category === "project") && lex.satisfies(r.value, u.value) !== null || (u.attributes.technologies ?? []).some((t) => lex.satisfies(r.value, t) !== null));
        const linkedIds = new Set(tool.flatMap((u) => u.attributes.experienceIds ?? []));
        const linked = professional.filter((f) => linkedIds.has(f.factId));
        if (tool.length === 0) { done("UNSUPPORTED", `No approved fact shows ${r.value}, so ${r.minimumYears}+ years of it cannot be established.`, { notCounted, missingEvidence: [`Approved evidence of ${r.value}`, `Approved employment linked to ${r.value} with dates`] }); continue; }
        if (linked.length === 0) {
          done("PARTIAL", `${r.value} appears in approved evidence, but no approved professional employment is linked to it, and duration is never inferred from a skill mention.`, { support: tool.map((u) => ({ factId: u.factId, resumeId: u.resumeId, category: u.category, value: u.value, quote: u.quote, basis: "exact" as const, strength: "mention" as const })), notCounted, missingEvidence: [`Approved dated employment linked to ${r.value}`] });
          continue;
        }
        const m = monthsFor(linked);
        done(m / 12 >= r.minimumYears ? "SUPPORTED" : "PARTIAL", `${asYears(m)} of approved professional employment linked to ${r.value} against ${r.minimumYears}+ requested.`, { support: supportFrom(linked), notCounted });
        continue;
      }
      if (r.yearsKind === "domain" || r.yearsKind === "role") {
        const wanted = normalizeText(r.scopeValue ?? "").split(" ").filter((w) => w.length > 2 && !["and", "the", "for", "experience", "years"].includes(w));
        const related = professional.filter((f) => (f.attributes.roleTags ?? []).some((t) => wanted.some((w) => normalizeText(t).split(" ").includes(w))));
        if (professional.length === 0) {
          done("UNSUPPORTED", `The active profile has no approved professional employment, so ${r.minimumYears}+ years${r.scopeValue ? ` of ${r.scopeValue}` : ""} cannot be established.`, { notCounted, missingEvidence: ["Approved, dated, classified professional employment relevant to this field"] });
          continue;
        }
        if (related.length === 0) {
          done("UNKNOWN", `The profile has approved professional employment, but none is tagged as relevant to "${r.scopeValue ?? "this field"}". Relevance is never inferred from a job title or a skill.`, { support: [], notCounted, missingEvidence: [`An approved role tag showing which employment is ${r.scopeValue ?? "relevant"}`] });
          continue;
        }
        const m = monthsFor(related);
        done(m / 12 >= r.minimumYears ? "SUPPORTED" : "PARTIAL", `${asYears(m)} of approved professional employment tagged for ${r.scopeValue} against ${r.minimumYears}+ requested.`, { support: supportFrom(related), notCounted });
        continue;
      }
      // unspecified: total professional experience
      if (professional.length === 0) {
        done("UNSUPPORTED", `The active profile has no approved professional employment, so ${r.minimumYears}+ years of experience cannot be established. Projects, education and skill mentions do not add professional years.`, { notCounted, missingEvidence: ["Approved, dated, classified professional employment"] });
        continue;
      }
      const m = monthsFor(professional);
      done(m / 12 >= r.minimumYears ? "SUPPORTED" : "PARTIAL", `${asYears(m)} of approved professional employment (overlap-safe) against ${r.minimumYears}+ requested.`, { support: supportFrom(professional), notCounted });
      continue;
    }

    // ---- degree ----------------------------------------------------------------------------------------------------------------------
    if (r.type === "degree") {
      const need = degreeLevel(r.value + " " + r.quote.quote) ?? "bachelor";
      const edu = input.corpus.units.filter((u) => u.category === "education" && u.polarity === "has");
      const meets = edu.filter((u) => { const have = degreeLevel(u.value); return have !== null && DEGREE_RANK[have] >= DEGREE_RANK[need]; });
      if (meets.length === 0) { done("UNSUPPORTED", `No approved education fact shows a ${need}'s-level degree.`, { missingEvidence: [`Approved education fact at ${need} level or above`] }); continue; }
      const field = /\b(?:in|of)\s+([A-Za-z ,/&-]{3,80}?)(?:\s+or\s+(?:a\s+)?related|\.|,|;|$)/i.exec(r.quote.quote)?.[1];
      const fieldWords = (field ?? "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !["related", "field", "equivalent", "degree", "experience"].includes(w));
      const fieldOk = fieldWords.length === 0 || meets.some((u) => fieldWords.some((w) => u.value.toLowerCase().includes(w)));
      done(fieldOk ? "SUPPORTED" : "PARTIAL", fieldOk ? `An approved education fact shows a ${need}-level degree${field ? ` consistent with "${field.trim()}"` : ""}.` : `A ${need}-level degree is approved, but its field was not shown to match "${field?.trim()}".`,
        { support: meets.map((u) => ({ factId: u.factId, resumeId: u.resumeId, category: u.category, value: u.value, quote: u.quote, basis: "exact" as const, strength: "demonstrated" as const })), missingEvidence: fieldOk ? [] : [`Evidence that the degree field matches "${field?.trim()}"`] });
      continue;
    }

    // ---- terms (skill / tool / language / platform / certification / domain knowledge) -----------------------------------------------
    const term = lex.lookup(r.value);
    if (!term) {
      done("UNKNOWN", "The wording could not be mapped to a reviewed term, so it is not decided automatically. Retrieval leads are listed for a person to judge.", { missingEvidence: ["A reviewed term for this requirement, or a person's judgement"] });
      continue;
    }
    const support: SupportQuote[] = [];
    let lackFact: EvidenceUnit | null = null;
    for (const u of input.corpus.units) {
      const rel = u.category === "certification" || u.category === "skill" ? lex.satisfies(term.canonical, u.value) : null;
      const techRel = u.category === "project" ? (u.attributes.technologies ?? []).map((t) => lex.satisfies(term.canonical, t)).find((x) => x !== null) ?? null : null;
      const stmt = u.category === "statement" ? lex.find(u.value).map((h) => lex.satisfies(term.canonical, h.canonical)).find((x) => x !== null) ?? null : null;
      const basis = rel ?? techRel ?? stmt;
      if (!basis) continue;
      if (u.polarity === "lacks") { lackFact = u; continue; }
      if (r.type === "certification" && u.category !== "certification") continue; // a certification requirement is met by a certification fact only
      const demonstrated = u.category === "project" || u.category === "statement" || u.category === "certification";
      support.push({ factId: u.factId, resumeId: u.resumeId, category: u.category, value: u.value, quote: u.quote, basis, strength: demonstrated ? "demonstrated" : "mention" });
    }
    if (lackFact && support.length === 0) {
      done("UNSUPPORTED", `The candidate states they lack "${term.canonical}" (approved fact).`, { explicitLack: true, support: [{ factId: lackFact.factId, resumeId: lackFact.resumeId, category: lackFact.category, value: lackFact.value, quote: lackFact.quote, basis: "exact", strength: "mention" }] });
      continue;
    }
    if (lackFact && support.length > 0) { done("UNKNOWN", `Approved facts conflict about "${term.canonical}" (one states it, one states a lack).`, { support }); continue; }
    if (support.length === 0) {
      done("UNSUPPORTED", `No approved, authorized fact shows ${term.canonical}${(term.members ?? []).length ? ` (or a tool of that kind: ${(term.members ?? []).slice(0, 4).join(", ")}...)` : ""}. This is an evidence gap, not proof of a lack.`, { missingEvidence: [`Approved evidence of ${term.canonical}`] });
      continue;
    }
    const demonstrated = support.some((s) => s.strength === "demonstrated");
    if (r.demandsDemonstration && !demonstrated) {
      done("PARTIAL", `${term.canonical} appears only as a skills-list mention; the wording asks for hands-on experience and no approved project, statement or certification shows use.`, { support, missingEvidence: [`Approved project, employment or certification showing use of ${term.canonical}`] });
      continue;
    }
    done("SUPPORTED", `Approved fact(s) state ${term.canonical}${support.some((s) => s.basis === "category-member") ? " (a tool of that kind)" : ""}${demonstrated ? ", including demonstrated use" : " at the level of familiarity the wording asks for"}.`, { support });
  }

  // alternatives: any_of
  const groups: GroupDecision[] = [];
  const byGroup = new Map<string, RequirementDecision[]>();
  for (const d of decisions) if (d.groupId) byGroup.set(d.groupId, [...(byGroup.get(d.groupId) ?? []), d]);
  for (const [groupId, members] of byGroup) {
    const live = members.filter((m) => m.applicable);
    const satisfied = live.filter((m) => m.status === "SUPPORTED");
    const partial = live.filter((m) => m.status === "PARTIAL");
    const status: ReqStatus = satisfied.length ? "SUPPORTED" : partial.length ? "PARTIAL" : live.length && live.every((m) => m.status === "UNSUPPORTED") ? "UNSUPPORTED" : "UNKNOWN";
    groups.push({
      groupId, status, memberIds: members.map((m) => m.requirementId), satisfiedBy: satisfied.map((m) => m.requirementId),
      explanation: satisfied.length ? `At least one alternative is supported (${satisfied.map((m) => m.value).join(", ")}).` : partial.length ? "No alternative is fully supported; some are partly supported." : "No alternative is supported by approved evidence.",
    });
  }
  return { decisions, groups };
}

/** Source-item rollup for lists whose members are examples ("tools like SIEM, EDR, IDS/IPS") or an AND list. */
export function rollupItems(decisions: RequirementDecision[]): Array<{ start: number; end: number; quote: string; level: string; status: ReqStatus; memberIds: string[]; note: string }> {
  const byItem = new Map<number, RequirementDecision[]>();
  for (const d of decisions) byItem.set(d.jd.start, [...(byItem.get(d.jd.start) ?? []), d]);
  const out = [];
  for (const [start, members] of byItem) {
    const live = members.filter((m) => m.applicable && !m.groupId);
    const grouped = members.filter((m) => m.groupId);
    if (members.length < 2) continue;
    const basis = live.length ? live : grouped;
    const status: ReqStatus = basis.every((m) => m.status === "SUPPORTED") ? "SUPPORTED" : basis.some((m) => m.status === "SUPPORTED" || m.status === "PARTIAL") ? "PARTIAL" : basis.every((m) => m.status === "UNSUPPORTED") ? "UNSUPPORTED" : "UNKNOWN";
    out.push({ start, end: members[0]!.jd.end, quote: members[0]!.jd.quote, level: members[0]!.effectiveLevel, status, memberIds: members.map((m) => m.requirementId), note: `${basis.filter((m) => m.status === "SUPPORTED").length} of ${basis.length} listed terms supported` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Eligibility conditions: four separate checks. Sensitive answers come only from explicit approved candidate facts, never from anything else.
// ---------------------------------------------------------------------------------------------------------------------------------------

export function decideConditions(analysis: JdAnalysis, eligibility: readonly EligibilityFact[]): ConditionDecision[] {
  const out: ConditionDecision[] = [];
  const of = (kind: EligibilityFact["kind"]): EligibilityFact[] => eligibility.filter((f) => f.kind === kind);
  for (const type of ["citizenship", "clearance", "work_authorization", "sponsorship"] as const) {
    const c = analysis.conditions[type];
    const jd = { status: c.status, value: c.value, quote: c.quote?.quote ?? null };
    const kind: EligibilityFact["kind"] = type === "sponsorship" ? "sponsorship_need" : type;
    const facts = of(kind);
    const decide = (result: ConditionDecision["result"], severity: ConditionDecision["severity"], explanation: string, ids: string[] = facts.map((f) => f.factId)): void => void out.push({ type, jd, candidateFactIds: ids, result, severity, explanation });

    if (c.status === "unknown") {
      // "unknown" means the extractor recorded nothing. It only means "the JD is silent" when the JD text really never mentions the topic.
      if (analysis.warnings.includes(`CONDITION_MENTIONED_BUT_UNCLASSIFIED:${type}`)) decide("UNKNOWN", "extraction-gap", `The JD text mentions ${type.replace("_", " ")}, but the extractor did not classify it. It is not treated as "no restriction"; read the posting.`, []);
      else decide("NOT_APPLICABLE", "info", "The JD does not mention this condition. Silence is not a restriction.", []);
      continue;
    }
    if (c.status === "not_required") { decide("NOT_APPLICABLE", "info", "The JD says this is not required."); continue; }
    if (type === "sponsorship") {
      // The JD does/does not offer future sponsorship; whether the candidate needs it is the candidate's own attested fact. Recorded, never auto-filtering.
      const needs = facts.find((f) => f.polarity === "has");
      const none = facts.find((f) => f.polarity === "lacks");
      if (c.status === "offered") decide("NOT_APPLICABLE", "info", "The employer says it offers sponsorship.");
      else if (needs) decide("ATTENTION", "needs-candidate-answer", "The JD says the employer does not sponsor, and the candidate has attested that they need sponsorship. Recorded for the candidate's decision; sponsorship never filters jobs automatically.", [needs.factId]);
      else if (none) decide("SATISFIED", "info", "The JD says the employer does not sponsor; the candidate has attested they do not need sponsorship.", [none.factId]);
      else decide("UNKNOWN", "needs-candidate-answer", "The JD says the employer does not sponsor. No approved fact states whether the candidate will need sponsorship in future; it is not inferred.", []);
      continue;
    }
    const want = c.value ?? "";
    const matching = facts.filter((f) => (type === "clearance" ? true : COUNTRY.test(want) ? COUNTRY.test(f.value) : normalizeText(f.value).includes(normalizeText(want))));
    const has = matching.filter((f) => f.polarity === "has");
    const lacks = matching.filter((f) => f.polarity === "lacks");
    const label = type === "work_authorization" ? "present work authorization" : type;
    if (has.length && !lacks.length) decide("SATISFIED", "info", `An approved candidate fact states ${label}${want ? ` (${want})` : ""}.`, has.map((f) => f.factId));
    else if (lacks.length && !has.length) decide("BLOCKER", "blocker", `The candidate has attested they do not meet this ${label} condition${want ? ` (${want})` : ""}.`, lacks.map((f) => f.factId));
    else if (has.length && lacks.length) decide("UNKNOWN", "needs-candidate-answer", `Approved facts conflict about ${label}.`, matching.map((f) => f.factId));
    else decide("UNKNOWN", "needs-candidate-answer", `The JD requires ${label}${want ? ` (${want})` : ""}. No approved candidate fact states it, and it is never inferred from a résumé, a name, education or employment.`, []);
  }
  return out;
}

import type { StructuredJob } from "../domain/structured-job.js";
import { lexicon, normalizeText, type Lexicon } from "./lexicon.js";

// Deterministic interpretation layer over ANY validated StructuredJob (rules baseline or model challenger): requirement roles
// (listed / example / alternative), negation, how much demonstration the wording asks for, and the separate candidate-facing conditions.
// It reads only the cited quotations; it never adds a requirement and never relaxes one without a cited negation.

export type Level = "required" | "preferred" | "unknown";
export type EffectiveLevel = Level | "not_required";
export type TermRole = "single" | "listed" | "example" | "alternative";
export type YearsKind = "none" | "professional" | "domain" | "tool" | "role";
export type ConditionStatus = "required" | "not_required" | "offered" | "not_offered" | "unknown";

export interface AnalyzedRequirement {
  id: string;
  type: StructuredJob["requirements"][number]["type"];
  value: string;
  level: Level;
  effectiveLevel: EffectiveLevel;
  negated: boolean;
  minimumYears: number | null;
  yearsKind: YearsKind;
  scopeValue: string | null;
  groupId: string | null;
  termRole: TermRole;
  /** The wording asks for hands-on use ("experience with ..."), so a skills-list mention alone cannot establish it. */
  demandsDemonstration: boolean;
  softSkill: boolean;
  quote: { quote: string; start: number; end: number };
}

export interface Condition {
  type: "citizenship" | "clearance" | "work_authorization" | "sponsorship";
  status: ConditionStatus;
  value: string | null;
  quote: { quote: string; start: number; end: number } | null;
}

export interface JdAnalysis {
  schema: "orbital-jd-analysis/1";
  job: { jobId: string; title: string; company: string; location: string | null; remoteType: string | null; jdSha256: string };
  extraction: { structuredId: string; providerRevision: string; parserVersion: string };
  requirements: AnalyzedRequirement[];
  /** Four distinct conditions; none stands in for another. */
  conditions: Record<Condition["type"], Condition>;
  arrangement: { mode: "remote" | "hybrid" | "onsite" | "unknown"; source: "jd-text" | "posting-metadata" | "none"; evidence: string | null };
  travel: { value: string; quote: string } | null;
  warnings: string[];
}

const EXAMPLE_CUE = /(?:such as|like|e\.g\.,?|including|for example|\()[^.;]*$/i;
const NEGATION = /\b(?:no|not|without|never)\b[^.;]{0,60}\b(?:required|necessary|needed|expected|mandatory)\b|\b(?:not required|isn['’]t required|aren['’]t required|need not|does not require|do not require|not necessary|unnecessary)\b/i;

export function analyzeJd(
  job: { id: string; title: string; company: string; location: string | null; remoteType: string | null; descriptionText: string },
  structured: StructuredJob,
  lex: Lexicon = lexicon(),
): JdAnalysis {
  const warnings: string[] = [];
  const requirements: AnalyzedRequirement[] = structured.requirements.map((r) => {
    const ev = r.evidence[0]!;
    const quote = { quote: ev.quote, start: ev.start, end: ev.end };
    const at = ev.quote.toLowerCase().indexOf(r.value.toLowerCase());
    const before = at >= 0 ? ev.quote.slice(0, at) : "";
    const termRole: TermRole = r.groupId ? "alternative" : at >= 0 && EXAMPLE_CUE.test(before) ? "example" : structured.requirements.filter((x) => x.evidence[0]!.start === ev.start).length > 1 ? "listed" : "single";
    const text = normalizeText(ev.quote);
    const familiarity = lex.familiarityCues.some((c) => text.includes(c));
    const demand = lex.demonstrationCues.some((c) => text.includes(c));
    const negated = NEGATION.test(ev.quote);
    if (negated) warnings.push(`NEGATED_REQUIREMENT:${r.id}`);
    return {
      id: r.id, type: r.type, value: r.value, level: r.level, effectiveLevel: negated ? "not_required" : r.level, negated, minimumYears: r.minimumYears,
      yearsKind: r.minimumYears === null ? "none" : r.scope.kind === "tool" ? "tool" : r.scope.kind === "domain" ? "domain" : r.scope.kind === "role" ? "role" : "professional",
      scopeValue: r.scope.value, groupId: r.groupId, termRole, demandsDemonstration: r.minimumYears !== null || (demand && !familiarity),
      softSkill: r.type === "soft_skill", quote,
    };
  });

  const emptyCondition = (type: Condition["type"]): Condition => ({ type, status: "unknown", value: null, quote: null });
  const conditions = { citizenship: emptyCondition("citizenship"), clearance: emptyCondition("clearance"), work_authorization: emptyCondition("work_authorization"), sponsorship: emptyCondition("sponsorship") };
  for (const c of structured.constraints) {
    if (c.type in conditions) {
      const ev = c.evidence[0];
      conditions[c.type as Condition["type"]] = { type: c.type as Condition["type"], status: c.status, value: c.value, quote: ev ? { quote: ev.quote, start: ev.start, end: ev.end } : null };
    }
  }
  // A mention the extractor could not classify is surfaced, never silently treated as "no restriction".
  const mentions: Array<[Condition["type"], RegExp]> = [["citizenship", /citizen/i], ["clearance", /clearance/i], ["work_authorization", /authori[sz]ed to work|work authori[sz]ation|right to work|eligible to work/i], ["sponsorship", /sponsor|visa/i]];
  for (const [type, re] of mentions) if (conditions[type].status === "unknown" && re.test(job.descriptionText)) warnings.push(`CONDITION_MENTIONED_BUT_UNCLASSIFIED:${type}`);

  const location = structured.constraints.find((c) => c.type === "location" && c.status === "required");
  const meta = `${job.location ?? ""} ${job.remoteType ?? ""}`.toLowerCase();
  let arrangement: JdAnalysis["arrangement"] = { mode: "unknown", source: "none", evidence: null };
  const modeOf = (s: string): "remote" | "hybrid" | "onsite" | "unknown" => (/hybrid/.test(s) ? "hybrid" : /remote/.test(s) ? "remote" : /on-?site|in[- ]office/.test(s) ? "onsite" : "unknown");
  if (location?.value && modeOf(location.value.toLowerCase()) !== "unknown") arrangement = { mode: modeOf(location.value.toLowerCase()), source: "jd-text", evidence: location.evidence[0]?.quote ?? null };
  else if (modeOf(meta) !== "unknown") arrangement = { mode: modeOf(meta), source: "posting-metadata", evidence: (job.location ?? job.remoteType) };
  const travel = structured.constraints.find((c) => c.type === "travel");

  return {
    schema: "orbital-jd-analysis/1",
    job: { jobId: job.id, title: job.title, company: job.company, location: job.location, remoteType: job.remoteType, jdSha256: structured.jdHash },
    extraction: { structuredId: structured.id, providerRevision: structured.providerRevision, parserVersion: structured.parserVersion },
    requirements, conditions, arrangement, travel: travel?.value ? { value: travel.value, quote: travel.evidence[0]?.quote ?? "" } : null, warnings,
  };
}

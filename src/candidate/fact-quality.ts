import type { FactView } from "../db/candidate-repo.js";
import type { EmploymentConflict } from "./employment-conflicts.js";

// Non-destructive extraction-quality hints for the fast fact review. A warning only asks a human to look; nothing here edits, approves or
// rejects a fact, and nothing fabricates a replacement.

export type QualityCode = "BROKEN_LINE" | "POSSIBLE_DUPLICATE" | "EMPLOYMENT_REVIEW" | "INSUFFICIENT_CONTEXT" | "SOURCE_MISMATCH" | "EMPLOYMENT_CONFLICT";

export interface QualityWarning {
  code: QualityCode;
  message: string;
}

type QualityFact = Pick<FactView, "factId" | "kind" | "value" | "attributes" | "span">;

/** One-word skills that name a category rather than a tool or technique. Deliberately short and data-only. */
const GENERIC_TERMS = new Set([
  "orchestration", "automation", "management", "security", "cloud", "analysis", "networking", "network", "monitoring", "scripting", "testing",
  "development", "integration", "engineering", "administration", "operations", "support", "reporting", "design", "infrastructure", "compliance",
  "detection", "response", "investigation", "documentation", "troubleshooting", "communication", "leadership",
]);

const INTERN_WORDS = /\b(intern|internship|co-?op|trainee|apprentice|contract|contractor|freelance|part[- ]time|temporary)\b/i;
const COMBINED_SEPARATORS = /\s(?:at|@|\||—|–|-)\s|,\s/;

const squash = (v: string): string => v.toLowerCase().replace(/[-‐-―]/g, "").replace(/[^a-z0-9]+/g, "");

export function assessFactQuality(fact: QualityFact, all: readonly QualityFact[], text: string | null, conflicts: readonly EmploymentConflict[] = []): QualityWarning[] {
  const out: QualityWarning[] = [];
  const value = fact.value.trim();
  const add = (code: QualityCode, message: string): void => void out.push({ code, message });

  // BROKEN_LINE: a hyphen at the end of the value, or a span that begins right after a hyphen + line break, is a word split by PDF wrapping.
  const start = fact.span?.start ?? null;
  const end = fact.span?.end ?? null;
  const endsOpen = /[-‐-―]$/.test(value);
  const startsMidWord = text !== null && start !== null && /[A-Za-z][-‐-―]\s*\r?\n?\s*$/.test(text.slice(Math.max(0, start - 6), start));
  if (endsOpen || startsMidWord) {
    const partner = start !== null && end !== null ? all.find((o) => o.factId !== fact.factId && o.span && (endsOpen ? o.span.start - end >= 0 && o.span.start - end <= 4 : end !== null && start - o.span.end >= 0 && start - o.span.end <= 4)) : undefined;
    const joined = partner ? ` It may be one term together with "${partner.value}" (kept separate here).` : "";
    add("BROKEN_LINE", `Looks like a word split by a line wrap.${joined} Check the source and, if needed, edit it with evidence.`);
  }

  // POSSIBLE_DUPLICATE: same kind and the same text once case, spaces and hyphens are ignored.
  const key = squash(value);
  if (key && all.some((o) => o.factId !== fact.factId && o.kind === fact.kind && squash(o.value) === key)) {
    add("POSSIBLE_DUPLICATE", "Another extracted fact of the same type has the same wording (ignoring case, spacing and hyphens).");
  }

  // EMPLOYMENT_REVIEW
  if (fact.kind === "employment") {
    const a = fact.attributes as Record<string, unknown>;
    const reasons: string[] = [];
    if (!a.employer || !a.title) reasons.push("employer or title is missing");
    if ((!a.employer || !a.title) && COMBINED_SEPARATORS.test(value)) reasons.push("title and employer appear combined in one field");
    if (!a.employmentType) reasons.push("employment category is not set (professional, internship, academic or volunteer); it is not counted until you choose it");
    if (INTERN_WORDS.test(value) || (typeof a.employmentType === "string" && a.employmentType !== "full-time")) reasons.push("internship/contract style entry; classification needs checking");
    const s = typeof a.startDate === "string" ? a.startDate : null;
    const e = typeof a.endDate === "string" ? a.endDate : null;
    if (s && e && e < s) reasons.push("end date is before start date");
    if (reasons.length) add("EMPLOYMENT_REVIEW", `Verify against your employment records: ${reasons.join("; ")}.`);
  }

  // EMPLOYMENT_CONFLICT: another record about the same employer disagrees. Neither side is chosen here.
  for (const c of conflicts) {
    if (!c.records.some((r) => r.ref === fact.factId)) continue;
    const other = c.records.find((r) => r.ref !== fact.factId);
    const diff = c.differences.map((d) => `${d.field}: ${d.values[0]} vs ${d.values[1]}`).join("; ");
    add("EMPLOYMENT_CONFLICT", `Disagrees with ${other?.origin === "confirmed-statement" ? "your confirmed employment statement" : other?.origin === "prior-record" ? "an earlier recorded entry" : "another extracted record"} (${other?.ref ?? "?"}) about ${c.employer}: ${diff}. Neither version is assumed correct; confirm from documents.`);
  }

  // INSUFFICIENT_CONTEXT: a lone generic noun says little by itself.
  if ((fact.kind === "skill" || fact.kind === "certification") && !/\s/.test(value) && GENERIC_TERMS.has(value.toLowerCase())) {
    add("INSUFFICIENT_CONTEXT", "A single generic term; it is not clear which tool or technique it refers to.");
  }

  // SOURCE_MISMATCH: the evidence does not back the value.
  if (fact.span) {
    if (text !== null && text.slice(fact.span.start, fact.span.end) !== fact.span.quote) add("SOURCE_MISMATCH", "The stored quotation no longer matches the extracted résumé text at its position.");
    else if ((fact.kind === "skill" || fact.kind === "certification") && !squash(fact.span.quote).includes(squash(value))) add("SOURCE_MISMATCH", "The value does not appear in its source quotation.");
  } else if (fact.kind !== "legal_name" && fact.kind !== "email" && fact.kind !== "phone" && !["clearance", "work_authorization", "citizenship", "sponsorship_need"].includes(fact.kind)) {
    add("SOURCE_MISMATCH", "No source quotation is stored for this fact.");
  }
  return out;
}

/** Count of substantial text lines that no extracted fact overlaps. Content is never returned, only the count. */
export function uncoveredLineCount(text: string, facts: readonly Pick<QualityFact, "span">[]): number {
  let pos = 0;
  let n = 0;
  for (const line of text.split("\n")) {
    const from = pos;
    const to = pos + line.length;
    pos = to + 1;
    if (line.trim().length < 40) continue;
    if (!facts.some((f) => f.span && f.span.start < to && f.span.end > from)) n += 1;
  }
  return n;
}

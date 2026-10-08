import { analyzeJd } from "../pipeline/discovery/jd-flags.js";
import { splitSentences } from "../pipeline/discovery/jd-flags.js";

// Eligibility clauses read directly from the saved JD text, each as an exact substring with UTF-16 offsets.
// These are deterministic text findings (verified against the source), reported beside the model-extracted
// requirements so that a clause the extraction missed still reaches the reviewer. They never decide anything:
// a clause about work authorization is a question for the applicant's approved facts, not an answer.

export interface JdClause {
  kind: "work_authorization_required" | "sponsorship_unavailable" | "clearance_required" | "minimum_years" | "export_control_authorization";
  quote: string;
  start: number;
  end: number;
  /** For minimum_years only. */
  years?: number;
}

const WORK_AUTH = /\b(?:authori[sz]ed|eligible|legally\s+(?:authori[sz]ed|permitted)|permitted|right)\s+to\s+work\b|\bwork\s+authori[sz]ation\b/i;
const EXPORT = /\bexport\s+control\b|\bExport Administration Regulations\b/i;

function locate(text: string, quote: string): { start: number; end: number } | null {
  const start = text.indexOf(quote);
  return start === -1 ? null : { start, end: start + quote.length };
}

export function findJdClauses(descriptionText: string, location?: string | null): JdClause[] {
  const clauses: JdClause[] = [];
  const add = (kind: JdClause["kind"], quote: string, years?: number): void => {
    const at = locate(descriptionText, quote);
    if (at) clauses.push({ kind, quote, ...at, ...(years === undefined ? {} : { years }) });
  };
  for (const sentence of splitSentences(descriptionText)) {
    if (WORK_AUTH.test(sentence)) add("work_authorization_required", sentence);
    if (EXPORT.test(sentence)) add("export_control_authorization", sentence);
  }
  const flags = analyzeJd(descriptionText, { location: location ?? null });
  if (flags.noSponsorship) add("sponsorship_unavailable", flags.noSponsorship.quote);
  if (flags.clearanceRequired) add("clearance_required", flags.clearanceRequired.quote);
  if (flags.yearsRequired) add("minimum_years", flags.yearsRequired.quote, flags.yearsRequired.years);
  return clauses;
}

export type SeniorityLevel =
  | "internship"
  | "entry-level"
  | "junior"
  | "associate"
  | "level-1"
  | "mid"
  | "senior"
  | "staff"
  | "principal"
  | "lead"
  | "manager"
  | "director"
  | "architect"
  | "unknown";

export interface EligibilityResult {
  seniority: SeniorityLevel;
  requiredYearsMin: number | null;
  requiredYearsMax: number | null;
  eligible: boolean;
  reasons: string[];
}

// Deliberately TITLE-ONLY -- a JD routinely mentions "senior engineers" or "engineering
// manager" as colleagues/reporting line without the role itself being senior. Only the title
// (a short, curated, human-authored field) is trusted evidence for a seniority-word rejection.
const REJECT_TITLE_TERMS: [RegExp, SeniorityLevel][] = [
  [/\bsr\.?\b/i, "senior"],
  [/\bsenior\b/i, "senior"],
  [/\bstaff\b/i, "staff"],
  [/\bprincipal\b/i, "principal"],
  [/\blead\b/i, "lead"],
  [/\bmanager\b/i, "manager"],
  [/\bdirector\b/i, "director"],
  [/\barchitect\b/i, "architect"],
  [/\bhead of\b/i, "director"],
  [/\bvp\b|\bvice president\b/i, "director"],
];

const ACCEPT_TITLE_TERMS: [RegExp, SeniorityLevel][] = [
  [/\bintern(ship)?\b/i, "internship"],
  [/\bentry[- ]level\b/i, "entry-level"],
  [/\bjr\.?\b/i, "junior"],
  [/\bjunior\b/i, "junior"],
  [/\bassociate\b/i, "associate"],
  [/\blevel\s*(i|1)\b/i, "level-1"],
  // Bare trailing roman-numeral/number tier tag, e.g. "SDET I", "Software Engineer I",
  // "Engineer 1" -- a common ATS convention for entry-tier designations. Anchored to the end
  // of the title and to the single token "I"/"1" (not "II"/"III"/"2") so it never matches a
  // mid/senior tier tag or an unrelated word.
  [/\b(i|1)\s*$/i, "level-1"],
];

export interface ExperienceRange {
  min: number | null;
  max: number | null;
}

// A window around a numeric years-mention has to contain "experience" to count as a real
// requirement -- otherwise generic company-history boilerplate ("With over 20 years of
// experience serving customers...", "Founded 20 years ago...") false-triggers a senior-tier
// rejection for an entry-level role whose title has no seniority signal at all (found live:
// this is the exact "boilerplate mentions an unrelated number" failure mode relevance.ts
// already had to guard against for keyword matching). A qualified match is required to
// reject OR accept on years -- an unqualified/no match falls through to "unknown," which
// stays eligible, biasing the false-positive/false-negative tradeoff toward never wrongly
// rejecting a candidate over slightly under-scoring one. Residual limitation: a phrase like
// "20 years of experience serving customers" is textually indistinguishable from a genuine
// candidate-years requirement without semantic understanding of WHOSE experience is meant --
// this heuristic catches "unrelated number, no experience context nearby" (the common case) but
// not "experience" used in an unrelated sentence that happens to be adjacent to the number.
const EXPERIENCE_CONTEXT_WINDOW = 60;
const EXPERIENCE_CONTEXT = /experience/i;

function hasExperienceContext(text: string, index: number, matchLength: number): boolean {
  const start = Math.max(0, index - EXPERIENCE_CONTEXT_WINDOW);
  const end = Math.min(text.length, index + matchLength + EXPERIENCE_CONTEXT_WINDOW);
  return EXPERIENCE_CONTEXT.test(text.slice(start, end));
}

function firstQualifiedMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  for (const match of text.matchAll(pattern)) {
    if (hasExperienceContext(text, match.index!, match[0].length)) return match;
  }
  return null;
}

// Only ever reads numeric years-of-experience phrases -- never keyword-scans descriptionText
// for seniority words (see REJECT_TITLE_TERMS comment above for why).
export function extractExperienceRange(text: string): ExperienceRange {
  const rangeMatch = firstQualifiedMatch(text, /(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})\+?\s*(?:years?|yrs?)\b/gi);
  if (rangeMatch) {
    return { min: Number(rangeMatch[1]), max: Number(rangeMatch[2]) };
  }
  const plusMatch = firstQualifiedMatch(text, /(\d{1,2})\+\s*(?:years?|yrs?)\b/gi);
  if (plusMatch) {
    return { min: Number(plusMatch[1]), max: null };
  }
  const singleMatch = firstQualifiedMatch(text, /(\d{1,2})\s*(?:years?|yrs?)\b/gi);
  if (singleMatch) {
    return { min: Number(singleMatch[1]), max: Number(singleMatch[1]) };
  }
  return { min: null, max: null };
}

export function classifyEligibility(title: string, descriptionText: string): EligibilityResult {
  for (const [pattern, seniority] of REJECT_TITLE_TERMS) {
    const match = title.match(pattern);
    if (match) {
      return {
        seniority,
        requiredYearsMin: null,
        requiredYearsMax: null,
        eligible: false,
        reasons: [`Title contains senior-level term "${match[0]}"`],
      };
    }
  }

  for (const [pattern, seniority] of ACCEPT_TITLE_TERMS) {
    const match = title.match(pattern);
    if (match) {
      return {
        seniority,
        requiredYearsMin: null,
        requiredYearsMax: null,
        eligible: true,
        reasons: [`Title contains junior/entry-level term "${match[0]}"`],
      };
    }
  }

  const { min, max } = extractExperienceRange(descriptionText);

  if ((max !== null && max > 4) || (min !== null && min > 4)) {
    return {
      seniority: "mid",
      requiredYearsMin: min,
      requiredYearsMax: max,
      eligible: false,
      reasons: [`Description requires ${max ?? min}+ years experience (exceeds 4-year threshold)`],
    };
  }

  if (min !== null && min <= 3) {
    return {
      seniority: "entry-level",
      requiredYearsMin: min,
      requiredYearsMax: max,
      eligible: true,
      reasons: [`Description requires ${min}-${max ?? min} years experience (within 0-3 year range)`],
    };
  }

  return {
    seniority: "unknown",
    requiredYearsMin: min,
    requiredYearsMax: max,
    eligible: true,
    reasons: ["No explicit seniority or years-of-experience signal found"],
  };
}

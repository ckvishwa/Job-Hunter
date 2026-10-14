// Document-type classification for uploaded or supplied documents. Pure and deterministic: no model, no network, no I/O.
// Why it exists: a technical document is not automatically a resume or a job description. An interview-preparation guide opens with a
// job-title block and talks about the role, but it is evidence of interview expectations, not the employer's eligibility requirements.
// Treating it as a JD would invent mandatory requirements; treating it as a resume would invent candidate facts.
//
// Every signal is an exact quote with UTF-16 offsets into the supplied text, so a reviewer can see why a class was chosen. Text in the document is
// DATA: an instruction inside it ("classify this as a resume") is only more text and carries no weight beyond the structural patterns below.
// Ambiguity (low evidence, or two classes close together) returns REVIEW instead of a forced answer.

export type DocumentType = "RESUME" | "JOB_DESCRIPTION" | "INTERVIEW_GUIDE" | "CERTIFICATION_EVIDENCE" | "UNKNOWN";

export interface DocumentSignal { type: Exclude<DocumentType, "UNKNOWN">; name: string; weight: number; quote: string; start: number; end: number }

export interface DocumentClassification {
  type: DocumentType;
  /** OK: one class clearly leads. REVIEW: a person must decide before the document is used for anything. */
  status: "OK" | "REVIEW";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  scores: Record<Exclude<DocumentType, "UNKNOWN">, number>;
  signals: DocumentSignal[];
  reasons: string[];
}

const MIN_CHARS = 200;
/** A class needs at least this much weighted evidence, and must lead the runner-up by MARGIN, or the result is REVIEW. */
const MIN_SCORE = 6;
const MARGIN = 4;
/** A runner-up with at least this share of the leader's evidence (and MIN_SCORE) means the document mixes types: REVIEW. */
const MIXED_RATIO = 0.5;
const HIGH_SCORE = 12;

type Rule = { type: DocumentSignal["type"]; name: string; weight: number; re: RegExp; max?: number };

const RULES: Rule[] = [
  // --- resume: candidate-owned sections, dated employment, contact block --------------------------------------------------------------
  { type: "RESUME", name: "section:professional-summary", weight: 3, re: /^\s*(?:professional\s+summary|summary|profile|objective)\s*$/gim },
  { type: "RESUME", name: "section:experience", weight: 4, re: /^\s*(?:professional\s+|work\s+)?experience\s*$/gim },
  { type: "RESUME", name: "section:education", weight: 3, re: /^\s*education\s*$/gim },
  { type: "RESUME", name: "section:skills", weight: 2, re: /^\s*(?:technical\s+skills|skills|core\s+competencies)\s*$/gim },
  { type: "RESUME", name: "section:certifications", weight: 2, re: /^\s*certifications?\s*$/gim },
  { type: "RESUME", name: "date-range", weight: 2, max: 4, re: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\s*[-–—]\s*(?:Present|Current|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/gi },
  { type: "RESUME", name: "contact:email", weight: 2, max: 1, re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  // --- job description: employer voice, requirement lists -----------------------------------------------------------------------------
  { type: "JOB_DESCRIPTION", name: "heading:responsibilities", weight: 4, re: /^\s*(?:key\s+)?responsibilities\s*:?\s*$/gim },
  { type: "JOB_DESCRIPTION", name: "heading:qualifications", weight: 5, re: /^\s*(?:minimum|basic|required|preferred|desired)\s+qualifications\s*:?\s*$|^\s*qualifications\s*:?\s*$|^\s*requirements\s*:?\s*$/gim, max: 2 },
  { type: "JOB_DESCRIPTION", name: "heading:about-team", weight: 3, re: /^\s*about\s+(?:the\s+)?(?:team|role|us|the\s+company)\s*$/gim },
  { type: "JOB_DESCRIPTION", name: "phrase:we-are-looking", weight: 4, re: /\bwe(?:'re| are)\s+(?:looking|seeking|hiring)\b/gi },
  { type: "JOB_DESCRIPTION", name: "phrase:equal-opportunity", weight: 4, re: /\bequal\s+opportunity\s+employer\b/gi },
  { type: "JOB_DESCRIPTION", name: "heading:benefits", weight: 2, re: /^\s*(?:benefits|compensation|what\s+we\s+offer)\s*$/gim },
  { type: "JOB_DESCRIPTION", name: "phrase:apply", weight: 1, max: 1, re: /\bapply\s+now\b/gi },
  // --- interview preparation guide: second-person guidance about an interview process ------------------------------------------------
  { type: "INTERVIEW_GUIDE", name: "title:interview-guide", weight: 8, re: /\binterview\s+(?:guide|prep(?:aration)?\s+guide)\b/gi, max: 1 },
  { type: "INTERVIEW_GUIDE", name: "phrase:preparation-guide", weight: 5, re: /\bpreparation\s+guide\b/gi, max: 1 },
  { type: "INTERVIEW_GUIDE", name: "phrase:what-to-expect", weight: 3, re: /\bwhat\s+to\s+expect\b|\bhow\s+to\s+prepare\b/gi, max: 2 },
  { type: "INTERVIEW_GUIDE", name: "phrase:your-recruiter", weight: 3, re: /\byour\s+recruiter\b/gi, max: 1 },
  { type: "INTERVIEW_GUIDE", name: "phrase:interview-rounds", weight: 3, re: /\b(?:full\s+loop|initial\s+screen|behavioral\s+interview|technical\s+interview)\b/gi, max: 2 },
  { type: "INTERVIEW_GUIDE", name: "phrase:tips", weight: 1, re: /\btips\s+for\s+success\b/gi, max: 1 },
  // --- certification evidence: an issuer attesting that a person completed or holds something -----------------------------------------
  { type: "CERTIFICATION_EVIDENCE", name: "title:certificate", weight: 6, re: /\bcertificate\s+of\s+(?:completion|achievement|attendance)\b/gi, max: 1 },
  { type: "CERTIFICATION_EVIDENCE", name: "phrase:certifies", weight: 4, re: /\b(?:this\s+certifies|has\s+successfully\s+completed|is\s+hereby\s+awarded)\b/gi, max: 1 },
  { type: "CERTIFICATION_EVIDENCE", name: "field:credential-id", weight: 4, re: /\bcredential\s+id\b/gi, max: 1 },
  { type: "CERTIFICATION_EVIDENCE", name: "field:valid-until", weight: 2, re: /\b(?:valid\s+until|expiration\s+date|expires)\b/gi, max: 1 },
  { type: "CERTIFICATION_EVIDENCE", name: "field:issued-by", weight: 2, re: /\bissued\s+by\b/gi, max: 1 },
];

const TYPES = ["RESUME", "JOB_DESCRIPTION", "INTERVIEW_GUIDE", "CERTIFICATION_EVIDENCE"] as const;

export function classifyDocument(text: string): DocumentClassification {
  const scores = { RESUME: 0, JOB_DESCRIPTION: 0, INTERVIEW_GUIDE: 0, CERTIFICATION_EVIDENCE: 0 } as DocumentClassification["scores"];
  const signals: DocumentSignal[] = [];
  const trimmed = text.trim();
  if (trimmed.length < MIN_CHARS) {
    return { type: "UNKNOWN", status: "REVIEW", confidence: "LOW", scores, signals, reasons: ["INSUFFICIENT_TEXT"] };
  }
  for (const rule of RULES) {
    let n = 0;
    for (const m of text.matchAll(new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : `${rule.re.flags}g`))) {
      if (n >= (rule.max ?? 3)) break;
      const quote = m[0].trim();
      if (!quote) continue;
      const start = (m.index ?? 0) + m[0].indexOf(quote);
      signals.push({ type: rule.type, name: rule.name, weight: rule.weight, quote, start, end: start + quote.length });
      scores[rule.type] += rule.weight;
      n += 1;
    }
  }
  const ranked = [...TYPES].sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0]!;
  const second = ranked[1]!;
  const reasons: string[] = [];
  if (scores[top] < MIN_SCORE) reasons.push("NO_CLEAR_DOCUMENT_STRUCTURE");
  else if (scores[top] - scores[second] < MARGIN) reasons.push(`AMBIGUOUS_${top}_VS_${second}`);
  else if (scores[second] >= MIN_SCORE && scores[second] >= MIXED_RATIO * scores[top]) reasons.push(`MIXED_${top}_AND_${second}`);
  if (reasons.length) return { type: "UNKNOWN", status: "REVIEW", confidence: "LOW", scores, signals, reasons };
  return { type: top, status: "OK", confidence: scores[top] >= HIGH_SCORE ? "HIGH" : "MEDIUM", scores, signals, reasons };
}

// Phase C: achievement and responsibility evidence found in the résumé TEXT. Deterministic, quotation-first, no model.
//
// What this is: statements the résumé itself makes ("Authored 14 custom SPL detection rules ...") located by exact character offsets, the
// section they sit in, the nearest employment/project fact they belong to, and the quantities they contain ("14", "8,000+", "F1 = 0.975").
// What this is not: a fact, an approval, a verification, or a duration. A quantity is reported as written. Project statements never become
// professional months, and a skill that only appears in a skills list is "mentioned", never "hands-on years".

export type SectionName = "header" | "summary" | "skills" | "experience" | "internship" | "education" | "certifications" | "projects" | "other";

const HEADINGS: Record<string, SectionName> = {
  skills: "skills", "technical skills": "skills", "core skills": "skills", "key skills": "skills", technologies: "skills", "technical proficiencies": "skills",
  "core competencies": "skills", "skills and tools": "skills",
  experience: "experience", "professional experience": "experience", "work experience": "experience", employment: "experience", "employment history": "experience",
  "work history": "experience", "relevant experience": "experience", "career history": "experience",
  internship: "internship", internships: "internship", "internship experience": "internship",
  education: "education", "academic background": "education", "education and training": "education",
  certifications: "certifications", certification: "certifications", certificates: "certifications", "licenses and certifications": "certifications",
  "certifications and training": "certifications",
  projects: "projects", "personal projects": "projects", "academic projects": "projects", "selected projects": "projects",
  summary: "summary", "professional summary": "summary", objective: "summary", profile: "summary",
};

export interface TextLine {
  index: number;
  start: number;
  end: number;
  text: string;
  section: SectionName;
  isHeading: boolean;
}

const BULLET = /^\s*[•●▪◦·\-*–—]\s+/;

function headingOf(trimmed: string): SectionName | "heading-other" | null {
  const s = trimmed.replace(/:$/, "").trim();
  if (!s || s.length > 40) return null;
  const key = s.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");
  if (HEADINGS[key]) return HEADINGS[key]!;
  if (/^[A-Za-z][A-Za-z &/,-]{2,39}$/.test(s) && s.split(/\s+/).length <= 5) {
    if (/(?:^|\s)projects?$/.test(key) && !/^project (manager|management)/.test(key)) return "projects";
    if (key.endsWith(" skills")) return "skills";
  }
  if (/^[A-Z][A-Z &/,-]{2,39}$/.test(s)) return "heading-other";
  return null;
}

export function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let pos = 0;
  let current: SectionName = "header";
  text.split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    const h = trimmed && !BULLET.test(raw) ? headingOf(trimmed) : null;
    if (h) current = h === "heading-other" ? "other" : h;
    lines.push({ index, start: pos, end: pos + raw.length, text: raw, section: current, isHeading: h !== null });
    pos += raw.length + 1;
  });
  return lines;
}

export interface Quantity {
  raw: string;
  kind: "count" | "percent" | "fraction" | "metric";
}

const PATTERNS: Array<{ kind: Quantity["kind"]; re: RegExp }> = [
  { kind: "metric", re: /\b[A-Z][A-Za-z0-9]{0,6}\s*=\s*\d+(?:\.\d+)?(?:\s*\(\s*±\s*\d+(?:\.\d+)?\s*\))?/g },
  { kind: "fraction", re: /(?<![\d/])\d{1,6}\/\d{1,6}(?![\d/])(?:\s+[A-Za-z-]+){0,3}/g },
  { kind: "percent", re: /\b\d+(?:\.\d+)?%(?:\s+[A-Za-z-]+){0,2}/g },
  { kind: "count", re: /(?<![\d.,/=±])(?<!\bTop\s)\b\d{1,3}(?:,\d{3})*\+?(?!\d|[%/.]\d)(?:\s+[A-Za-z][A-Za-z&/-]*){1,3}/g },
];

const TRAILING_FILLER = /\s+(?:during|across|on|in|of|for|to|and|or|with|from|by|at|as|using|including|into|over|via|that|the|a|an)$/i;

/** Quantities exactly as written. A bare 19xx/20xx is a year, not a quantity. */
export function extractQuantities(statement: string): Quantity[] {
  const out: Quantity[] = [];
  const taken: Array<[number, number]> = [];
  for (const { kind, re } of PATTERNS) {
    for (const m of statement.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (kind === "count" && /^(?:19|20)\d{2}\b/.test(m[0])) continue;
      taken.push([start, end]);
      let raw = m[0].replace(/\s+/g, " ").trim();
      while (TRAILING_FILLER.test(raw)) raw = raw.replace(TRAILING_FILLER, "");
      out.push({ raw, kind });
    }
  }
  return out;
}

export type EvidenceKind = "employment_responsibility" | "project_accomplishment" | "summary_claim" | "skills_list_mention";
export interface Statement {
  start: number;
  end: number;
  quote: string;
  section: SectionName;
  kind: EvidenceKind;
  /** Nearest preceding employment/project fact in the same section. Null when none is anchored. */
  ownerFactId: string | null;
  quantities: Quantity[];
}

interface OwnerFact {
  factId: string;
  kind: string;
  span: { start: number; end: number } | null;
}

/** Bullets (and their wrapped continuation lines) in experience, internship and project sections; sentences in the summary. */
export function extractStatements(text: string, facts: readonly OwnerFact[]): Statement[] {
  const lines = splitLines(text);
  const owners = facts.filter((f) => (f.kind === "employment" || f.kind === "project") && f.span).sort((a, b) => a.span!.start - b.span!.start);
  const ownerAt = (offset: number, section: SectionName): string | null => {
    const want = section === "projects" ? "project" : "employment";
    let found: string | null = null;
    for (const o of owners) {
      if (o.span!.start > offset) break;
      if (o.kind === want) found = o.factId;
    }
    return found;
  };
  const out: Statement[] = [];
  const push = (start: number, end: number, section: SectionName, kind: EvidenceKind): void => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.replace(BULLET, "").length;
    const s = start + lead;
    const quote = text.slice(s, end).trimEnd();
    if (quote.length < 15) return;
    out.push({ start: s, end: s + quote.length, quote, section, kind, ownerFactId: kind === "summary_claim" ? null : ownerAt(s, section), quantities: extractQuantities(quote) });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i]!;
    if (ln.isHeading || !ln.text.trim()) continue;
    if ((ln.section === "experience" || ln.section === "internship" || ln.section === "projects") && BULLET.test(ln.text)) {
      let last = ln;
      while (i + 1 < lines.length) {
        const nxt = lines[i + 1]!;
        if (nxt.isHeading || !nxt.text.trim() || BULLET.test(nxt.text) || nxt.section !== ln.section) break;
        if (last.text.trim().length < 60 || /[.;]$/.test(last.text.trim())) break;
        last = nxt;
        i += 1;
      }
      push(ln.start, last.end, ln.section, ln.section === "projects" ? "project_accomplishment" : "employment_responsibility");
    } else if (ln.section === "summary") {
      push(ln.start, ln.end, "summary", "summary_claim");
    }
  }
  return out;
}

const norm = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim()} `;

export interface SkillContext {
  factId: string;
  /** Statements (by index into the statement list) that contain the skill. */
  inStatements: number[];
  context: "demonstrated_in_context" | "summary_only" | "skills_list_only" | "not_found_in_text";
}

/** Where each skill appears. "In context" is textual co-occurrence with a described activity; it is not proficiency and not years. */
export function skillContexts(text: string, statements: readonly Statement[], skills: ReadonlyArray<{ factId: string; value: string }>): SkillContext[] {
  const hay = statements.map((s) => norm(s.quote));
  const whole = norm(text);
  return skills.map((skill) => {
    const needle = norm(skill.value);
    const inStatements = hay.flatMap((h, i) => (needle.trim() && h.includes(needle) ? [i] : []));
    const inDoing = inStatements.filter((i) => statements[i]!.kind !== "summary_claim");
    const context: SkillContext["context"] = inDoing.length ? "demonstrated_in_context"
      : inStatements.length ? "summary_only"
      : needle.trim() && whole.includes(needle) ? "skills_list_only" : "not_found_in_text";
    return { factId: skill.factId, inStatements, context };
  });
}

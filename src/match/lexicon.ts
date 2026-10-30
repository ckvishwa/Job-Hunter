import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

// S4A reviewed vocabulary (config/jd-terms.v1.json). Exact spellings only; the only "relatedness" is membership in a CATEGORY term
// (Splunk is a SIEM by definition). No fuzzy or semantic relation lives here.

const termSchema = z.object({
  canonical: z.string().min(1),
  type: z.enum(["tool", "language", "platform", "certification", "degree", "domain_knowledge", "skill"]),
  forms: z.array(z.string().min(1)).min(1),
  members: z.array(z.string().min(1)).optional(),
}).strict();
const lexiconSchema = z.object({
  version: z.literal(1), purpose: z.string(), terms: z.array(termSchema).min(1),
  softSkillCues: z.array(z.string()), demonstrationCues: z.array(z.string()), familiarityCues: z.array(z.string()),
}).strict();
export type LexiconTerm = z.infer<typeof termSchema>;

export interface TermHit {
  canonical: string;
  type: LexiconTerm["type"];
  form: string;
  start: number;
  end: number;
  members: string[];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const normalizeText = (s: string): string => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9+#./&' -]+/g, " ").replace(/\s+/g, " ").trim();

export class Lexicon {
  readonly version = 1;
  readonly softSkillCues: string[];
  readonly demonstrationCues: string[];
  readonly familiarityCues: string[];
  private readonly terms: LexiconTerm[];
  private readonly byForm = new Map<string, LexiconTerm>();
  private readonly byCanonical = new Map<string, LexiconTerm>();
  private readonly matchers: Array<{ term: LexiconTerm; form: string; re: RegExp }> = [];

  constructor(raw: unknown) {
    const parsed = lexiconSchema.parse(raw);
    this.terms = parsed.terms;
    this.softSkillCues = parsed.softSkillCues;
    this.demonstrationCues = parsed.demonstrationCues;
    this.familiarityCues = parsed.familiarityCues;
    for (const term of this.terms) {
      this.byCanonical.set(normalizeText(term.canonical), term);
      for (const form of [term.canonical, ...term.forms]) {
        const key = normalizeText(form);
        // the first reviewed term to claim a spelling keeps it, so the file's order is the tie-break
        if (!this.byForm.has(key)) this.byForm.set(key, term);
        // short all-caps spellings (AD, IDS, JS, MS) are matched case-sensitively; everything else ignores case
        const sensitive = form.length <= 4 && form === form.toUpperCase();
        this.matchers.push({ term, form, re: new RegExp(`(?<![A-Za-z0-9+#])${escape(form)}(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])`, sensitive ? "g" : "gi") });
      }
    }
    this.matchers.sort((a, b) => b.form.length - a.form.length);
  }

  static load(file = path.resolve("config", "jd-terms.v1.json")): Lexicon {
    return new Lexicon(JSON.parse(readFileSync(file, "utf8")));
  }

  /** The reviewed term a free-text value stands for, or null. Whole-value match only. */
  lookup(value: string): LexiconTerm | null {
    return this.byForm.get(normalizeText(value)) ?? null;
  }

  /** Terms that appear in `text`, longest spelling first, never overlapping. */
  find(text: string): TermHit[] {
    const taken: Array<[number, number]> = [];
    const hits: TermHit[] = [];
    for (const { term, form, re } of this.matchers) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        taken.push([start, end]);
        hits.push({ canonical: term.canonical, type: term.type, form: m[0], start, end, members: term.members ?? [] });
      }
    }
    return hits.sort((a, b) => a.start - b.start);
  }

  /** True when `candidate` (a fact value) is the term itself or a member of the term's category. */
  satisfies(requirementCanonical: string, candidate: string): "exact" | "category-member" | null {
    const want = this.byCanonical.get(normalizeText(requirementCanonical));
    const have = this.lookup(candidate);
    if (!want) return normalizeText(requirementCanonical) === normalizeText(candidate) ? "exact" : null;
    if (have && have.canonical === want.canonical) return "exact";
    if (!have && want.forms.some((f) => normalizeText(f) === normalizeText(candidate))) return "exact";
    if (have && (want.members ?? []).some((m) => normalizeText(m) === normalizeText(have.canonical))) return "category-member";
    return null;
  }

  spellings(canonical: string): string[] {
    const t = this.byCanonical.get(normalizeText(canonical));
    return t ? [t.canonical, ...t.forms] : [canonical];
  }
}

let shared: Lexicon | null = null;
export const lexicon = (): Lexicon => (shared ??= Lexicon.load());

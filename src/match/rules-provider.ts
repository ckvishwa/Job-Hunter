import type { JobSemanticProvider } from "../semantic/provider.js";
import { inventorySource, type SourceItem } from "../semantic/source-coverage.js";
import { deriveAlternatives } from "../semantic/source-alternatives.js";
import { Lexicon, lexicon as sharedLexicon, normalizeText, type TermHit } from "./lexicon.js";

// S4A deterministic JD extractor: the BASELINE and the AI-off path. Official JD text -> a StructuredProposal that goes through the unchanged
// production validator (src/domain/structured-job.ts). No model, no network. Everything it emits quotes an exact slice of the JD; what it cannot
// read with confidence it leaves out, and the validator adds `unknown` for sensitive conditions the JD is silent on. Absence is never a restriction.
//
//   level      : taken from the section the source item sits in (required / preferred), never guessed per sentence
//   years      : "N+ years [of] <phrase>": tool-scoped when the phrase is a reviewed tool/language/platform, domain-scoped when it is a field
//                ("IT or security"), role-scoped after "as a ...", otherwise unspecified. A range keeps its lower bound.
//   alternatives: explicit OR between listed terms only (any_of); a plain list is NOT alternatives
//   conditions : citizenship, clearance, present work authorization and sponsorship are separate constraint types

export const RULES_EXTRACTOR_REVISION = "rules-jd-extractor@1:jd-terms@1:source-inventory@8";

/** Evidence quotes must stay inside the structured-job validator's limit and remain an exact JD slice. */
const MAX_EVIDENCE_QUOTE = 2000;

function fitSpan(raw: string, start: number, end: number): { start: number; end: number; quote: string } {
  if (end - start <= MAX_EVIDENCE_QUOTE) return { start, end, quote: raw.slice(start, end) };
  const boundedEnd = start + MAX_EVIDENCE_QUOTE;
  return { start, end: boundedEnd, quote: raw.slice(start, boundedEnd) };
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const YEARS = /(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:[-–—]|to)\s*(\d+(?:\.\d+)?))?\s*\+?\s+years?\b/i;
const LEADING_FILLER = /^\s*(?:of\s+)?(?:(?:relevant|hands-on|professional|practical|work|working|industry|related|progressive|prior|direct|proven|demonstrated|solid)\s+)*(?:experience|expertise)?\s*(?:(?:with|in|using|as|on|within|of|working with)\s+)?/i;

interface Proposal {
  requirements: Array<Record<string, unknown>>;
  responsibilities: unknown[];
  constraints: Array<Record<string, unknown>>;
  alternativeGroups: Array<{ id: string; operator: "any_of" }>;
}

/** A sentence-ending character, except the periods inside "U.S." (a following capital after the second one is not treated as a new sentence). */
function isStop(raw: string, i: number): boolean {
  const c = raw[i]!;
  if (c === "\n" || c === "!" || c === "?") return true;
  if (c !== ".") return false;
  const insideUS = (raw[i - 1] === "U" && raw[i + 1] === "S") || (raw[i - 1] === "S" && raw[i - 2] === "." && raw[i - 3] === "U");
  return !insideUS;
}

function sentenceAround(raw: string, index: number): { start: number; end: number; quote: string } | null {
  let start = index;
  while (start > 0 && !isStop(raw, start - 1)) start -= 1;
  let end = index;
  while (end < raw.length && !isStop(raw, end)) end += 1;
  if (end < raw.length && raw[end] !== "\n") end += 1;
  while (start < end && /\s/.test(raw[start]!)) start += 1;
  while (end > start && /\s/.test(raw[end - 1]!)) end -= 1;
  return end > start ? { start, end, quote: raw.slice(start, end) } : null;
}

function yearsOf(text: string): { min: number; match: RegExpExecArray } | null {
  const m = YEARS.exec(text);
  if (!m) return null;
  const first = m[1]!.toLowerCase();
  const min = WORD_NUMBERS[first] ?? Number(first);
  return Number.isFinite(min) && min > 0 && min <= 50 ? { min, match: m } : null;
}

export class RulesJobSemanticProvider implements JobSemanticProvider {
  readonly revision = RULES_EXTRACTOR_REVISION;
  constructor(private readonly lex: Lexicon = sharedLexicon()) {}

  async extractJob(input: { rawJd: string; jdHash: string }): Promise<unknown> {
    const raw = input.rawJd;
    const out: Proposal = { requirements: [], responsibilities: [], constraints: [], alternativeGroups: [] };
    const inventory = inventorySource(raw);
    let groupSeq = 0;
    for (const item of inventory.items) {
      if (!item.annotate || raw.slice(item.start, item.end) !== item.text) continue;
      const level = item.section === "required" ? "required" : "preferred";
      this.fromItem(item, level, out, () => `g-${++groupSeq}`);
    }
    this.constraints(raw, out);
    return out;
  }

  private fromItem(item: SourceItem, level: "required" | "preferred", out: Proposal, nextGroup: () => string): void {
    const evidence = [fitSpan(item.text, 0, item.text.length)].map((span) => ({ quote: span.quote, start: item.start + span.start, end: item.start + span.end }));
    const base = (n: number) => `r-${item.id}-${n}`.slice(0, 64);
    const years = yearsOf(item.text);
    if (years) {
      const after = item.text.slice(years.match.index + years.match[0].length);
      const rest = after.replace(LEADING_FILLER, "").split(/[,.;:]|\s+(?:is|are)\s+(?:preferred|required|desired|a plus)|\s+but\b|\s+or equivalent/i)[0]!.trim();
      const roleTitle = /^\s*(?:of\s+)?(?:\w+\s+){0,3}?(?:experience\s+)?as\s+an?\s+([A-Z][\w /-]{2,60})/.exec(after);
      const hit = this.lex.find(rest).find((h) => h.type === "tool" || h.type === "language" || h.type === "platform");
      const domain = rest.replace(/\s*\b(?:experience|expertise)\b\s*$/i, "").trim();
      if (hit) {
        out.requirements.push({ id: base(1), type: hit.type, value: hit.form, level, minimumYears: years.min, scope: { kind: "tool", value: hit.form }, groupId: null, evidence });
      } else if (roleTitle) {
        out.requirements.push({ id: base(1), type: "role_experience", value: roleTitle[1]!.trim().slice(0, 100), level, minimumYears: years.min, scope: { kind: "role", value: roleTitle[1]!.trim().slice(0, 100) }, groupId: null, evidence });
      } else if (domain && domain.split(/\s+/).length <= 7 && /[A-Za-z]/.test(domain)) {
        out.requirements.push({ id: base(1), type: "role_experience", value: `${domain} experience`.slice(0, 120), level, minimumYears: years.min, scope: { kind: "domain", value: domain.slice(0, 120) }, groupId: null, evidence });
      } else {
        out.requirements.push({ id: base(1), type: "role_experience", value: "professional experience", level, minimumYears: years.min, scope: { kind: "unspecified", value: null }, groupId: null, evidence });
      }
      return;
    }
    const hits = this.lex.find(item.text);
    if (hits.length === 0) {
      const soft = this.lex.softSkillCues.some((c) => normalizeText(item.text).includes(c));
      const familiar = this.lex.familiarityCues.some((c) => normalizeText(item.text).includes(c));
      out.requirements.push({ id: base(1), type: soft ? "soft_skill" : familiar ? "domain_knowledge" : "skill", value: item.text.length > 200 ? item.text.slice(0, 200).replace(/\s+\S*$/, "") : item.text, level, minimumYears: null, scope: { kind: "unspecified", value: null }, groupId: null, evidence });
      return;
    }
    // one requirement per distinct reviewed term; an explicit OR chain between neighbours becomes one any_of group
    const unique: TermHit[] = [];
    for (const h of hits) if (!unique.some((u) => u.canonical === h.canonical)) unique.push(h);
    const alt = deriveAlternatives(item.text);
    const chain = this.orChain(item.text, unique);
    const inGroup = new Set<string>();
    let groupId: string | null = null;
    const orTerms = alt ? unique.filter((u) => (alt.logic as { args: string[] }).args.some((a) => normalizeText(a) === normalizeText(u.form))) : chain;
    if (orTerms.length >= 2) {
      groupId = nextGroup();
      out.alternativeGroups.push({ id: groupId, operator: "any_of" });
      orTerms.forEach((h) => inGroup.add(h.canonical));
    }
    unique.forEach((h, i) => {
      out.requirements.push({ id: base(i + 1), type: h.type, value: h.form, level, minimumYears: null, scope: { kind: "unspecified", value: null }, groupId: inGroup.has(h.canonical) ? groupId : null, evidence });
    });
  }

  /** Neighbouring terms joined only by list separators where at least one separator is "or" / "and/or" and none is a plain "and". */
  private orChain(text: string, hits: TermHit[]): TermHit[] {
    const sorted = [...hits].sort((a, b) => a.start - b.start);
    let best: TermHit[] = [];
    let current: TermHit[] = [];
    let sawOr = false;
    for (let i = 0; i < sorted.length; i += 1) {
      const h = sorted[i]!;
      if (current.length === 0) {
        current = [h];
        sawOr = false;
        continue;
      }
      const gap = text.slice(current[current.length - 1]!.end, h.start);
      if (/^\s*(?:,\s*)?(?:(?:and\/or|or)\s+)?$|^\s*\/\s*$/i.test(gap) && !/\band\b(?!\/or)/i.test(gap)) {
        current.push(h);
        sawOr ||= /\bor\b|and\/or/i.test(gap);
      } else {
        if (sawOr && current.length > best.length) best = current;
        current = [h];
        sawOr = false;
      }
    }
    if (sawOr && current.length > best.length) best = current;
    return best;
  }

  private constraints(raw: string, out: Proposal): void {
    const add = (id: string, type: string, status: string, value: string | null, index: number): void => {
      const s = sentenceAround(raw, index);
      if (s && !out.constraints.some((c) => c.type === type && ["clearance", "sponsorship", "citizenship", "work_authorization"].includes(type))) {
        const span = fitSpan(raw, s.start, s.end);
        out.constraints.push({ id, type, status, value, evidence: [{ quote: span.quote, start: span.start, end: span.end }] });
      }
    };
    const first = (re: RegExp): RegExpExecArray | null => re.exec(raw);
    const sentenceOf = (m: RegExpExecArray): string => sentenceAround(raw, m.index)?.quote ?? "";

    // present work authorization ("authorized to work in the United States"), kept apart from future sponsorship
    const auth = first(/\b(?:authori[sz]ed|eligible|legally (?:authori[sz]ed|able)|have the (?:legal )?right) to work (?:in|within) (?:the )?([A-Z][A-Za-z. ]{2,40}?)(?=[.,;\n]| without| and\b|$)/);
    // "the legal right to work in the country where the position is based" names no country; the JD's own words are kept as the value
    const authLocal = auth ? null : first(/\b(?:have|hold) the (?:legal )?right to work in (the country (?:where|in which) the (?:position|role) is based)/i);
    if (authLocal) add("c-work-authorization", "work_authorization", "required", authLocal[1]!.trim(), authLocal.index);
    if (auth) {
      const neg = /\b(?:not|no longer)\s+required\b/i.test(sentenceOf(auth));
      add("c-work-authorization", "work_authorization", neg ? "not_required" : "required", auth[1]!.trim(), auth.index);
    }
    const spNot = first(/\b(?:do(?:es)? not|don[’']t|cannot|can[’']t|will not|won[’']t|unable to)\s+(?:currently\s+)?(?:offer|provide|sponsor|support)[^.\n]{0,60}?\b(?:sponsor\w*|visas?)\b/i) ?? first(/\bno (?:visa )?sponsorship\b/i) ?? first(/\bwithout (?:the need for )?(?:visa )?sponsorship\b/i) ?? first(/\bnot (?:be )?(?:able|eligible) (?:to|for) (?:visa )?sponsor\w*/i);
    const spYes = first(/\b(?:will|can|may) (?:provide |offer )?(?:visa )?sponsor\w*|sponsorship (?:is )?(?:available|provided|offered)|visa sponsorship (?:is )?(?:available|offered|provided)\b/i);
    if (spNot) add("c-sponsorship", "sponsorship", "not_offered", null, spNot.index);
    else if (spYes) add("c-sponsorship", "sponsorship", "offered", null, spYes.index);
    const cit = first(/\b(?:U\.?S\.?|United States)\s+citizen(?:ship)?\b/i);
    if (cit) {
      const sentence = sentenceOf(cit);
      const neg = /\b(?:not|no)\s+(?:be\s+)?required\b|\bdoes not require\b/i.test(sentence);
      const req = /\b(?:must|required|only|need to|have to|be a)\b/i.test(sentence);
      if (neg) add("c-citizenship", "citizenship", "not_required", "U.S. citizenship", cit.index);
      else if (req) add("c-citizenship", "citizenship", "required", "U.S. citizenship", cit.index);
    }
    const clr = first(/\b(?:(?:ts\/sci|top secret|secret|public trust|security|active|current)\s+)*clearance\b/i);
    if (clr) {
      const sentence = sentenceOf(clr);
      if (/\b(?:no|not)\b[^.]{0,30}\b(?:clearance|required|necessary)\b/i.test(sentence)) add("c-clearance", "clearance", "not_required", null, clr.index);
      else if (/\b(?:must|required|need|obtain|hold|maintain|active|eligible to obtain)\b/i.test(sentence) && !/\b(?:preferred|a plus|desired|nice to have|bonus)\b/i.test(sentence)) add("c-clearance", "clearance", "required", null, clr.index);
    }
    const arrangement = first(/\b(?:this (?:role|position) is|role is|position is|(?:you|candidates|employees) (?:will|must|are expected to) (?:work|be))[^.\n]{0,60}?\b(fully remote|remote|hybrid|on-?site|in[- ]office)\b/i);
    if (arrangement) {
      const word = arrangement[1]!.toLowerCase();
      add("c-location-arrangement", "location", "required", /remote/.test(word) ? "Remote" : /hybrid/.test(word) ? "Hybrid" : "Onsite", arrangement.index);
    }
    const travel = first(/\btravel(?:ling|ing)?\s+(?:up to\s+|approximately\s+)?(\d{1,3})\s*%/i);
    if (travel) add("c-travel", "travel", "required", `up to ${travel[1]}%`, travel.index);
  }
}

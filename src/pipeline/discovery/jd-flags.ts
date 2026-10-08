import { inventorySource } from "../../semantic/source-coverage.js";

// Informational flags read from the saved JD text. Each flag carries the verbatim quote it came from
// (an exact substring of the text), so a reviewer can check the wording. Flags inform; they never remove a row.

export interface QuotedFlag {
  quote: string;
}

export interface YearsFlag extends QuotedFlag {
  years: number;
}

export interface JdFlags {
  noSponsorship: QuotedFlag | null;
  clearanceRequired: QuotedFlag | null;
  /** Highest minimum years of experience stated as required (the lower bound of a range such as "3-5 years"). */
  yearsRequired: YearsFlag | null;
  /** A remote role that lists states it cannot hire in, with Connecticut among them. */
  remoteExcludesCt: QuotedFlag | null;
}

const MAX_QUOTE = 600;
const quoteOf = (s: string) => s.trim().slice(0, MAX_QUOTE);

/** Sentences as exact substrings of the text. Line breaks end a sentence; flattened one-line postings split on terminal punctuation. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const sentenceEnd = /[.!?]+["”’')]*\s+(?=[A-Z0-9*•"“‘'(])/g;
  for (const line of text.matchAll(/[^\r\n]+/g)) {
    const body = line[0];
    let start = 0;
    sentenceEnd.lastIndex = 0;
    for (let m = sentenceEnd.exec(body); m; m = sentenceEnd.exec(body)) {
      out.push(body.slice(start, m.index + m[0].trimEnd().length));
      start = m.index + m[0].length;
    }
    out.push(body.slice(start));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

// "We do not currently sponsor immigration visas", "unable to sponsor", "without sponsorship", "sponsorship is not available".
const NEGATED_SPONSOR = /\b(?:not|no|cannot|can[’']t|unable|won[’']t|don[’']t|doesn[’']t|never|without)\b[^.]{0,70}\bsponsor/i;
const SPONSOR_UNAVAILABLE = /\bsponsor\w*\b[^.]{0,50}\b(?:is|are)\s+not\s+(?:available|offered|provided|possible)/i;

// Clearance wording. A sentence that negates it or calls it a plus is not a requirement.
const CLEARANCE_TERM = /\b(?:security clearance|clearance|public trust|polygraph|TS\/SCI|top secret)\b/i;
const CLEARANCE_NEGATED = /\b(?:no|not|without)\b[^.]{0,40}\b(?:clearance|public trust|polygraph)\b|\bclearance\b[^.]{0,40}\b(?:is|are)\s+not\s+required/i;
const SOFT = /\b(?:preferred|desired|desirable|a plus|bonus|nice[- ]to[- ]haves?|nonessential|non-essential|helpful|beneficial)\b/i;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };

const YEARS = /\b(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)\s*\+?\s*(?:(?:-|–|—|to)\s*(?:\d+(?:\.\d+)?|\w+)\s*)?\+?\s*years?\b/gi;

const EXCLUSION_CUE = /\b(?:not\s+(?:eligible|available|open|currently\s+hiring|hiring)|cannot|can[’']t|unable|not\s+able|do(?:es)?\s+not\s+hire|will\s+not\s+hire|excluding|except|other\s+than)\b/i;
const CT = /\b(?:CT|Connecticut)\b/;
// Sponsorship of an export licence or an event is not visa sponsorship.
const NOT_VISA = /\b(?:export|licen[sc]e|licen[sc]ing)\b/i;

const WINDOW_BEFORE = 130;
const WINDOW_AFTER = 170;

/** A quote no longer than a sentence-sized window around the match: flattened postings can have one huge "sentence". Always an exact substring. */
function windowAround(s: string, index: number, length: number): string {
  if (s.length <= 260) return s.trim();
  let a = Math.max(0, index - WINDOW_BEFORE);
  let b = Math.min(s.length, index + length + WINDOW_AFTER);
  if (a > 0) {
    const space = s.indexOf(" ", a);
    if (space >= 0 && space < index) a = space + 1;
  }
  if (b < s.length) {
    const space = s.lastIndexOf(" ", b);
    if (space > index + length) b = space;
  }
  return s.slice(a, b).trim();
}

function firstMatch(re: RegExp, s: string): { index: number; length: number } | null {
  const m = new RegExp(re.source, re.flags.replace("g", "")).exec(s);
  return m ? { index: m.index, length: m[0].length } : null;
}

export function analyzeJd(text: string, options: { location?: string | null } = {}): JdFlags {
  const sentences = splitSentences(text);
  const flags: JdFlags = { noSponsorship: null, clearanceRequired: null, yearsRequired: null, remoteExcludesCt: null };

  for (const s of sentences) {
    if (!flags.noSponsorship) {
      const hit = firstMatch(NEGATED_SPONSOR, s) ?? firstMatch(SPONSOR_UNAVAILABLE, s);
      if (hit) {
        const quote = windowAround(s, hit.index, hit.length);
        if (!NOT_VISA.test(quote)) flags.noSponsorship = { quote: quoteOf(quote) };
      }
    }
    if (!flags.clearanceRequired) {
      const hit = firstMatch(CLEARANCE_TERM, s);
      if (hit) {
        const quote = windowAround(s, hit.index, hit.length);
        if (!CLEARANCE_NEGATED.test(quote) && !SOFT.test(quote)) flags.clearanceRequired = { quote: quoteOf(quote) };
      }
    }
    if (!flags.remoteExcludesCt) {
      const remote = /\bremote\b/i.test(s) || /\bremote\b/i.test(options.location ?? "");
      const hit = remote && EXCLUSION_CUE.test(s) ? firstMatch(CT, s) : null;
      if (hit) flags.remoteExcludesCt = { quote: quoteOf(windowAround(s, hit.index, hit.length)) };
    }
  }

  // Years: items of the explicit required sections first; with no such section, fall back to sentences.
  // Each "N years" is judged on its own window, which must speak of experience and must not be a preferred/plus statement.
  const inventory = inventorySource(text);
  const requiredItems = inventory.items.filter((i) => i.section === "required").map((i) => i.text);
  // The fallback never counts text that sits inside a preferred item.
  const preferred = inventory.items.filter((i) => i.section === "preferred").map((i) => i.text);
  const inPreferred = (sentence: string) => preferred.some((p) => p.includes(sentence) || sentence.includes(p));
  const candidates = requiredItems.length > 0 ? requiredItems : sentences.filter((s) => !inPreferred(s));
  for (const item of candidates) {
    for (const m of item.matchAll(YEARS)) {
      const raw = m[1]!.toLowerCase();
      const years = /^\d/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
      if (years === undefined || !(years > 0 && years <= 40)) continue;
      const quote = windowAround(item, m.index!, m[0].length);
      if (!/\bexperience\b/i.test(quote) || SOFT.test(quote)) continue;
      if (!flags.yearsRequired || years > flags.yearsRequired.years) flags.yearsRequired = { years, quote: quoteOf(quote) };
    }
  }
  return flags;
}

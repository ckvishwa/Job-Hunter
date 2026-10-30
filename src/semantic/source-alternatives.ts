import type { Logic } from "./compact-annotations.js";

// Deterministic alternative splitting for one whole source item. The model never re-types terms:
// it only classifies an item (kind, years, scope); explicit OR alternatives come from the source
// text itself, and every term returned is a verbatim, ordered slice of that text. Anything not
// confidently splittable returns null and the caller retains the item as unresolved evidence.

export interface DerivedAlternatives {
  logic: Logic;
  /** The source ended its list with an open-ended tail ("or similar technologies"); that tail is not a term. */
  openEnded: boolean;
}

const MARKER = /\b(?:such as|using|e\.g\.,?|like)\s+/gi;
const OPEN_ENDED = /^(?:(?:a|an|any)\s+)?(?:comparable|similar|equivalent|related|other|etc)\b/i;
const CONNECTOR = /\band\/or\b|\bor\b/gi;
const STANDALONE_AND = /\band\b(?!\/or)/i;
const MAX_TERM_WORDS = 6;

function cleanTerm(raw: string): string | null {
  const term = raw.trim().replace(/^(?:(?:a|an|the)\s+)/i, "").trim();
  if (!term || term.split(/\s+/).length > MAX_TERM_WORDS) return null;
  return term;
}

function splitList(tail: string): { terms: string[]; openEnded: boolean } | null {
  // "A, B, C, or D" / "A or B" / "A, B and/or C". A plain "and" inside the list is a conjunction.
  if (STANDALONE_AND.test(tail)) return null;
  const parts = tail.split(/\s*,\s*(?:(?:and\/or|or)\s+)?|\s+(?:and\/or|or)\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let openEnded = false;
  const terms: string[] = [];
  for (const part of parts) {
    if (OPEN_ENDED.test(part)) {
      openEnded = true;
      continue;
    }
    const term = cleanTerm(part);
    if (!term) return null;
    terms.push(term);
  }
  return terms.length >= 2 ? { terms, openEnded } : null;
}

export function deriveAlternatives(text: string): DerivedAlternatives | null {
  if (![...text.matchAll(CONNECTOR)].length) return null;
  const body = text.replace(/[\s.]+$/, "");

  // The innermost example-list marker starts a list that runs to the end of the sentence.
  // "including" is not a marker: it elaborates a term rather than listing alternatives.
  const markers = [...body.matchAll(MARKER)];
  const marker = markers[markers.length - 1];
  const hasElaboration = /\bincluding\b/i.test(body);
  let list: { terms: string[]; openEnded: boolean } | null = null;
  if (hasElaboration) return null;
  if (marker?.index !== undefined) {
    list = splitList(body.slice(marker.index + marker[0].length));
  } else {
    const connectors = [...body.matchAll(CONNECTOR)].length;
    if (connectors === 1 && !STANDALONE_AND.test(body)) {
      // One short pair after a preposition ("with Go or Rust"), nothing else in the item.
      const pair = /\b(?:in|with|of|on|using|for)\s+(\S+(?:\s+\S+)?)\s+(?:and\/or|or)\s+(\S+(?:\s+\S+)?)$/i.exec(body);
      if (pair) list = splitList(pair[1] + " or " + pair[2]);
    }
    if (!list) {
      // Comma list ending in "or", introduced by the preposition nearest its first comma:
      // "experience in A, B, or C".
      const comma = body.indexOf(",");
      const lead = comma > 0 ? /^[\s\S]*\b(?:in|with|of|on|for)\s+/i.exec(body.slice(0, comma)) : null;
      if (lead) list = splitList(body.slice(lead[0].length));
    }
  }
  if (!list) return null;

  // Every term must occur verbatim, in order, in the item: this is what the downstream validator re-checks.
  let cursor = 0;
  for (const term of list.terms) {
    const at = text.indexOf(term, cursor);
    if (at < 0) return null;
    cursor = at + term.length;
  }
  return { logic: { op: "any_of", args: list.terms }, openEnded: list.openEnded };
}

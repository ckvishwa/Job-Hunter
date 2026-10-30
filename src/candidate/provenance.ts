import type { Provenance } from "../roles/profile-evidence.js";

// Evidence-based classification SUGGESTIONS for an uploaded résumé. Pure. Nothing is assumed:
//   * "fixture" needs positive proof: the document is (almost) line for line a known fixture in this repository.
//   * "personal" needs the owner's identity (their email) to appear in the document AND an explicit human classification; this module only suggests it.
//   * everything else is "unverified": not synthetic by assumption, not personal by assumption, and excluded from career scoring.

export interface FixtureDoc {
  id: string;
  file: string;
  lines: string[];
}

export interface ProvenanceSuggestion {
  provenance: Provenance;
  /** True only for a suggestion a person must still apply explicitly (personal). Fixture/unverified never authorize anything. */
  needsExplicitAuthorization: boolean;
  basis: string;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const MIN_LINE = 12;

export function suggestProvenance(input: { text: string | null; fixtures: readonly FixtureDoc[]; ownerEmail?: string | null }): ProvenanceSuggestion {
  if (!input.text) return { provenance: "unverified", needsExplicitAuthorization: false, basis: "no extracted text to compare" };
  const lines = new Set(input.text.split("\n").map(norm).filter((l) => l.length > MIN_LINE));
  let best: { fixture: FixtureDoc; hit: number; total: number } | null = null;
  for (const fx of input.fixtures) {
    const fl = fx.lines.map(norm).filter((l) => l.length > MIN_LINE);
    if (!fl.length) continue;
    const hit = fl.filter((l) => lines.has(l)).length;
    if (!best || hit / fl.length > best.hit / best.total) best = { fixture: fx, hit, total: fl.length };
  }
  // proof = every fixture line is present AND the document has no substantial content beyond the fixture
  if (best && best.hit === best.total && best.total >= 3 && lines.size <= best.total + 1) {
    return { provenance: "fixture", needsExplicitAuthorization: false, basis: `all ${best.total} non-trivial lines are identical to fixture case ${best.fixture.id} (${best.fixture.file})` };
  }
  if (input.ownerEmail && input.text.toLowerCase().includes(input.ownerEmail.toLowerCase())) {
    return { provenance: "personal", needsExplicitAuthorization: true, basis: "the document contains the owner's own email address (owner identity match); a person must still authorize it" };
  }
  const near = best && best.hit > 0 ? ` (closest fixture ${best.fixture.id}: ${best.hit}/${best.total} lines, not a match)` : "";
  return { provenance: "unverified", needsExplicitAuthorization: false, basis: `no fixture match and no owner identity evidence${near}` };
}

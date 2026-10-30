import type { CandidateFact } from "../domain/candidate-profile.js";

// P0 candidate-profile boundary. Pure: decides which stored facts may be evidence for career scoring (S2 now, S4 later).
//
// A fact is evidence only if ALL of these hold:
//   1. it comes from a résumé that is AUTHORIZED for the ACTIVE profile with the provenance that profile accepts
//      (personal profile <- personal résumés, demo profile <- fixture résumés). A résumé with no classification is UNVERIFIED and excluded.
//      Attested user statements (no résumé) belong to the user and stay in.
//   2. if approved, its quotation really backs it (SOURCE_EVIDENCE_BROKEN excludes it until the fact is corrected).
//   3. if it is employment, it does not contradict the candidate's confirmed employment for the same employer.
//   4. alternate copies of the same employment (other résumé versions) are counted once.
// Rejected and pending facts are passed through untouched; the scoring code already ignores them, and the tests prove it.

export type Provenance = "personal" | "fixture" | "unverified";
export type ProfileKind = "personal" | "demo";

export interface ProfileRef {
  id: string;
  kind: ProfileKind;
  label: string;
}

export interface SourceAuth {
  resumeId: string;
  provenance: Provenance;
  authorized: boolean;
}

export interface ConfirmedEmployment {
  employer: string;
  title: string;
  startDate: string;
  /** null = current */
  endDate: string | null;
  employmentType: string;
}

export interface EvidenceRow {
  fact: CandidateFact;
  resumeId: string | null;
  resumeCreatedAt: Date | null;
  span: { start: number; end: number; quote: string } | null;
  sourceText: string | null;
}

export type ExclusionCode = "NO_ACTIVE_PROFILE" | "SOURCE_NOT_AUTHORIZED" | "SOURCE_EVIDENCE_BROKEN" | "CONFLICTS_WITH_CONFIRMED_EMPLOYMENT" | "DUPLICATE_EMPLOYMENT";

export interface Exclusion {
  factId: string;
  resumeId: string | null;
  kind: string;
  value: string;
  code: ExclusionCode;
  detail: string;
}

export interface EvidenceSelection {
  profile: ProfileRef | null;
  facts: CandidateFact[];
  /** factId -> contributing résumé id (null for an attested statement). */
  factResume: Map<string, string | null>;
  /** Only APPROVED facts that were kept out, with the reason. */
  excluded: Exclusion[];
  /** Facts (any status) from unauthorized résumés, counted per résumé; they are never shown as evidence or hints. */
  unauthorizedFactCounts: Record<string, number>;
  /** factId -> its stored source quotation (null for an attested statement). */
  factSpan: Map<string, { start: number; end: number; quote: string } | null>;
  duplicates: Array<{ kept: string; dropped: string; keptResumeId: string | null; droppedResumeId: string | null }>;
}

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "");
const phrase = (s: string): string => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Null when the quotation backs the fact; otherwise why it does not. Employment values are not matched to the quote (they are composed). */
export function sourceEvidenceProblem(fact: { kind: string; value: string }, span: { start: number; end: number; quote: string } | null, text: string | null): string | null {
  if (!span) return "the fact has no source quotation";
  if (text !== null && text.slice(span.start, span.end) !== span.quote) return "the stored quotation no longer matches the extracted text at its position";
  if ((fact.kind === "skill" || fact.kind === "certification") && !squash(span.quote).includes(squash(fact.value))) return "the value does not appear in its source quotation";
  return null;
}

export function authorizes(profile: ProfileRef | null, auth: SourceAuth | undefined): boolean {
  if (!profile || !auth || !auth.authorized) return false;
  return profile.kind === "personal" ? auth.provenance === "personal" : auth.provenance === "fixture";
}

export function employerMatches(fact: CandidateFact, confirmed: ConfirmedEmployment): boolean {
  const e = phrase(confirmed.employer);
  return (!!fact.attributes.employer && phrase(fact.attributes.employer).includes(e)) || phrase(fact.value).includes(e);
}

export function agreesWithConfirmed(fact: CandidateFact, c: ConfirmedEmployment): boolean {
  const a = fact.attributes;
  const titleOk = a.title ? phrase(a.title).includes(phrase(c.title)) || phrase(c.title).includes(phrase(a.title)) : phrase(fact.value).includes(phrase(c.title));
  return titleOk && a.startDate === c.startDate && (a.endDate ?? null) === c.endDate && (a.employmentType === undefined || a.employmentType === c.employmentType);
}

export function selectEvidence(input: { profile: ProfileRef | null; sources: readonly SourceAuth[]; confirmed: readonly ConfirmedEmployment[]; rows: readonly EvidenceRow[] }): EvidenceSelection {
  const { profile, confirmed } = input;
  const auth = new Map(input.sources.map((s) => [s.resumeId, s]));
  const out: EvidenceSelection = { profile, facts: [], factResume: new Map(), factSpan: new Map(), excluded: [], unauthorizedFactCounts: {}, duplicates: [] };
  const exclude = (row: EvidenceRow, code: ExclusionCode, detail: string): void => {
    if (row.fact.approvalStatus === "approved") out.excluded.push({ factId: row.fact.factId, resumeId: row.resumeId, kind: row.fact.kind, value: row.fact.value, code, detail });
  };

  const kept: EvidenceRow[] = [];
  for (const row of input.rows) {
    if (row.resumeId !== null) {
      const a = auth.get(row.resumeId);
      if (!profile) {
        out.unauthorizedFactCounts[row.resumeId] = (out.unauthorizedFactCounts[row.resumeId] ?? 0) + 1;
        exclude(row, "NO_ACTIVE_PROFILE", "there is no active candidate profile");
        continue;
      }
      if (!authorizes(profile, a)) {
        out.unauthorizedFactCounts[row.resumeId] = (out.unauthorizedFactCounts[row.resumeId] ?? 0) + 1;
        exclude(row, "SOURCE_NOT_AUTHORIZED", `source is ${a ? `${a.provenance}${a.authorized ? "" : " (not authorized)"}` : "unverified (unclassified)"}; this profile accepts ${profile.kind === "personal" ? "personal" : "fixture"} sources only`);
        continue;
      }
      if (row.fact.approvalStatus === "approved") {
        const problem = sourceEvidenceProblem(row.fact, row.span, row.sourceText);
        if (problem) {
          exclude(row, "SOURCE_EVIDENCE_BROKEN", `${problem}; excluded from scoring until the fact is corrected`);
          continue;
        }
      }
    }
    kept.push(row);
  }

  // confirmed employment: contradicting approved résumé employment does not count
  const afterConfirmed: EvidenceRow[] = [];
  for (const row of kept) {
    if (row.fact.kind === "employment" && row.fact.approvalStatus === "approved" && row.fact.polarity === "has") {
      const same = confirmed.filter((c) => employerMatches(row.fact, c));
      if (same.length && !same.some((c) => agreesWithConfirmed(row.fact, c))) {
        const c = same[0]!;
        exclude(row, "CONFLICTS_WITH_CONFIRMED_EMPLOYMENT",
          `disagrees with the candidate's confirmed ${c.employer} employment (${c.title}, ${c.startDate} to ${c.endDate ?? "current"}); correct the source résumé and review it again`);
        continue;
      }
    }
    afterConfirmed.push(row);
  }

  // the same approved employment on several résumé versions counts once (earliest upload, then fact id, is kept)
  const keyOf = (f: CandidateFact): string => [squash(f.attributes.employer ?? f.value), squash(f.attributes.title ?? ""), f.attributes.startDate ?? "", f.attributes.endDate ?? "current", f.attributes.employmentType ?? ""].join("|");
  const ordered = [...afterConfirmed].sort((a, b) => (a.resumeCreatedAt?.getTime() ?? 0) - (b.resumeCreatedAt?.getTime() ?? 0) || a.fact.factId.localeCompare(b.fact.factId));
  const seen = new Map<string, EvidenceRow>();
  const dropped = new Set<string>();
  for (const row of ordered) {
    if (row.fact.kind !== "employment" || row.fact.approvalStatus !== "approved" || row.fact.polarity !== "has" || !row.fact.attributes.startDate) continue;
    const k = keyOf(row.fact);
    const first = seen.get(k);
    if (!first) {
      seen.set(k, row);
      continue;
    }
    dropped.add(row.fact.factId);
    out.duplicates.push({ kept: first.fact.factId, dropped: row.fact.factId, keptResumeId: first.resumeId, droppedResumeId: row.resumeId });
    exclude(row, "DUPLICATE_EMPLOYMENT", `same employment as ${first.fact.factId}; counted once`);
  }

  for (const row of input.rows) {
    if (!afterConfirmed.includes(row) || dropped.has(row.fact.factId)) continue;
    out.facts.push(row.fact);
    out.factResume.set(row.fact.factId, row.resumeId);
    out.factSpan.set(row.fact.factId, row.span);
  }
  return out;
}

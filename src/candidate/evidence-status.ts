import type { CandidateFact } from "../domain/candidate-profile.js";
import { agreesWithConfirmed, employerMatches, type ConfirmedEmployment, type EvidenceSelection } from "../roles/profile-evidence.js";

// Explicit evidence-status taxonomy for the candidate evidence readiness view. It READS the boundary's decision (selectEvidence) and names it; it never changes a fact,
// approves, rejects, or resurrects anything. A fact counts as evidence only in APPROVED_VALID.

export type EvidenceStatus =
  | "APPROVED_VALID"
  | "PENDING"
  | "REJECTED"
  | "APPROVED_WEAK_SOURCE"
  | "APPROVED_CONFLICTING"
  | "APPROVED_DUPLICATE"
  | "UNAUTHORIZED_SOURCE";

export const COUNTS_AS_EVIDENCE: ReadonlySet<EvidenceStatus> = new Set<EvidenceStatus>(["APPROVED_VALID"]);

export interface FactEvidenceStatus {
  factId: string;
  kind: string;
  value: string;
  status: EvidenceStatus;
  countsAsEvidence: boolean;
  detail: string | null;
}

export function classifyFacts(scope: Pick<EvidenceSelection, "facts" | "excluded">): FactEvidenceStatus[] {
  const excluded = new Map(scope.excluded.map((e) => [e.factId, e]));
  const rank = (f: CandidateFact): EvidenceStatus => (f.approvalStatus === "approved" ? "APPROVED_VALID" : f.approvalStatus === "rejected" ? "REJECTED" : "PENDING");
  const statusOf = (code: string): EvidenceStatus =>
    code === "SOURCE_EVIDENCE_BROKEN" ? "APPROVED_WEAK_SOURCE" : code === "CONFLICTS_WITH_CONFIRMED_EMPLOYMENT" ? "APPROVED_CONFLICTING" : code === "DUPLICATE_EMPLOYMENT" ? "APPROVED_DUPLICATE" : "UNAUTHORIZED_SOURCE";
  const listed = scope.facts.map((f): FactEvidenceStatus => {
    const ex = excluded.get(f.factId);
    const status: EvidenceStatus = ex ? statusOf(ex.code) : rank(f);
    return { factId: f.factId, kind: f.kind, value: f.value, status, countsAsEvidence: COUNTS_AS_EVIDENCE.has(status), detail: ex?.detail ?? null };
  });
  // approved facts the boundary kept out before they became evidence (weak source, conflicting) are not in scope.facts; they are listed from the exclusions
  const have = new Set(listed.map((f) => f.factId));
  for (const ex of scope.excluded) {
    if (have.has(ex.factId) || ex.code === "SOURCE_NOT_AUTHORIZED" || ex.code === "NO_ACTIVE_PROFILE") continue;
    listed.push({ factId: ex.factId, kind: ex.kind, value: ex.value, status: statusOf(ex.code), countsAsEvidence: false, detail: ex.detail });
  }
  return listed;
}

export interface AwaitingResume {
  employer: string;
  title: string;
  startDate: string;
  endDate: string | null;
  note: string;
}

/**
 * Confirmed employment statements are references from the candidate. Until a source résumé states the same employment and it is reviewed and approved, the statement is
 * AWAITING_RESUME: it contributes no experience and no skills. (A résumé that disagrees with it is reported as APPROVED_CONFLICTING above.)
 */
export function confirmedAwaitingResume(confirmed: readonly ConfirmedEmployment[], facts: readonly CandidateFact[]): AwaitingResume[] {
  const approved = facts.filter((f) => f.kind === "employment" && f.approvalStatus === "approved" && f.polarity === "has");
  return confirmed
    .filter((c) => !approved.some((f) => employerMatches(f, c) && agreesWithConfirmed(f, c)))
    .map((c) => ({
      employer: c.employer, title: c.title, startDate: c.startDate, endDate: c.endDate,
      note: "Confirmed by the candidate but no approved résumé fact agrees with it yet. It adds no experience and no skills until a corrected résumé is uploaded, reviewed and approved.",
    }));
}

export interface EvidenceReadiness {
  counts: Record<EvidenceStatus, number>;
  unauthorizedSourceFacts: number;
  awaitingResume: AwaitingResume[];
  facts: FactEvidenceStatus[];
}

export function evidenceReadiness(scope: Pick<EvidenceSelection, "facts" | "excluded" | "unauthorizedFactCounts">, confirmed: readonly ConfirmedEmployment[]): EvidenceReadiness {
  const facts = classifyFacts(scope);
  const counts: Record<EvidenceStatus, number> = { APPROVED_VALID: 0, PENDING: 0, REJECTED: 0, APPROVED_WEAK_SOURCE: 0, APPROVED_CONFLICTING: 0, APPROVED_DUPLICATE: 0, UNAUTHORIZED_SOURCE: 0 };
  for (const f of facts) counts[f.status] += 1;
  const unauthorizedSourceFacts = Object.values(scope.unauthorizedFactCounts).reduce((a, b) => a + b, 0);
  counts.UNAUTHORIZED_SOURCE += unauthorizedSourceFacts;
  return { counts, unauthorizedSourceFacts, awaitingResume: confirmedAwaitingResume(confirmed, scope.facts), facts };
}

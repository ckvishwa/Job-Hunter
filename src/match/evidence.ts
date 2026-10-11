import { createHash } from "node:crypto";
import { factContentDigest, factUsability, type CandidateFact } from "../domain/candidate-profile.js";
import type { CandidateRepo } from "../db/candidate-repo.js";
import { loadScopedEvidence } from "../db/profile-repo.js";
import type { Pool } from "pg";
import { extractStatements } from "../candidate/achievements.js";

// S4A candidate evidence: the ONLY facts matching may see. Built from the active, authorized profile (loadScopedEvidence), then narrowed again:
//   kept     approved + normal sensitivity + currently usable (not expired) + non-contact, with an intact source quotation
//   dropped  rejected / pending / disputed (already out of the profile pool or not approved), unauthorized and fixture résumés, source-mismatched
//            facts, contact details and sensitive kinds, employment with no stated category (unverified experience), and accomplishment text
//            whose owning employment or project is not itself kept.
// Sensitive ELIGIBILITY facts (citizenship, clearance, work authorization, sponsorship need) are returned separately for the eligibility rules only;
// they are never retrieval units.

export const CONTACT_KINDS = ["legal_name", "email", "phone"] as const;
export const ELIGIBILITY_KINDS = ["citizenship", "clearance", "work_authorization", "sponsorship_need"] as const;

export type UnitCategory = "skill" | "certification" | "education" | "project" | "employment" | "statement";

export interface EvidenceUnit {
  unitId: string;
  factId: string;
  resumeId: string | null;
  category: UnitCategory;
  kind: CandidateFact["kind"];
  /** The fact's own value (or the accomplishment text); decisions compare against this, retrieval searches `text`. */
  value: string;
  /** What retrieval searches over. */
  text: string;
  /** The exact source quotation backing the fact (or the accomplishment statement). */
  quote: string | null;
  span: { start: number; end: number } | null;
  verification: { verifiedBy: string | null; verifiedAt: string | null; contentDigest: string; status: "approved" };
  sourceReference: string;
  attributes: CandidateFact["attributes"];
  polarity: CandidateFact["polarity"];
}

export interface EligibilityFact {
  factId: string;
  kind: (typeof ELIGIBILITY_KINDS)[number];
  value: string;
  polarity: CandidateFact["polarity"];
}

export interface CorpusExclusion {
  factId: string;
  resumeId: string | null;
  reason: string;
}

export interface EvidenceCorpus {
  units: EvidenceUnit[];
  eligibility: EligibilityFact[];
  /** Approved, classified, in-scope employment (the only thing that can create professional years). */
  employment: CandidateFact[];
  excluded: CorpusExclusion[];
  /** Reasons approved facts were kept out by the profile boundary itself. */
  boundaryExclusions: Array<{ factId: string; resumeId: string | null; code: string; detail: string }>;
  version: { profileId: string | null; profileKind: string | null; profileRevisionNo: number | null; profileDigest: string | null; evidenceDigest: string; factCount: number; authorizedResumeIds: string[]; confirmedEmploymentReferences: number };
}

const retrievalText = (f: CandidateFact): string =>
  [f.value, f.attributes.detail, ...(f.attributes.technologies ?? []), ...(f.attributes.matchTerms ?? []), ...(f.attributes.roleTags ?? [])].filter(Boolean).join(". ");

export async function buildEvidenceCorpus(input: { pool: Pool; candidates: CandidateRepo; userId: string; asOf: string }): Promise<EvidenceCorpus> {
  const scope = await loadScopedEvidence(input.pool, input.userId);
  const units: EvidenceUnit[] = [];
  const eligibility: EligibilityFact[] = [];
  const excluded: CorpusExclusion[] = [];
  const employment: CandidateFact[] = [];
  const keptFacts = new Map<string, CandidateFact>();

  for (const f of scope.facts) {
    const resumeId = scope.factResume.get(f.factId) ?? null;
    const drop = (reason: string): void => void excluded.push({ factId: f.factId, resumeId, reason });
    if ((ELIGIBILITY_KINDS as readonly string[]).includes(f.kind)) {
      if (f.approvalStatus === "approved" && factUsability(f, input.asOf).usable) eligibility.push({ factId: f.factId, kind: f.kind as EligibilityFact["kind"], value: f.value, polarity: f.polarity });
      continue;
    }
    if ((CONTACT_KINDS as readonly string[]).includes(f.kind) || f.sensitivity === "sensitive") {
      if (f.approvalStatus === "approved") drop("sensitive contact detail is never retrieval evidence");
      continue;
    }
    if (f.approvalStatus !== "approved") {
      if (f.approvalStatus === "rejected") drop("rejected");
      continue; // pending facts are not evidence and are not even listed
    }
    if (!factUsability(f, input.asOf).usable) {
      drop("not currently usable (expired or unverified)");
      continue;
    }
    if (f.kind === "employment" && !f.attributes.employmentType) {
      drop("employment has no stated category: unverified experience is not counted or retrieved");
      continue;
    }
    keptFacts.set(f.factId, f);
    const span = scope.factSpan.get(f.factId) ?? null;
    const category: UnitCategory = f.kind === "skill" || f.kind === "certification" || f.kind === "education" || f.kind === "project" || f.kind === "employment" ? f.kind : "skill";
    units.push({
      unitId: `fact:${f.factId}`, factId: f.factId, resumeId, category, kind: f.kind, value: f.value, text: retrievalText(f), quote: span?.quote ?? null,
      span: span ? { start: span.start, end: span.end } : null,
      verification: { verifiedBy: f.verification.verifiedBy, verifiedAt: f.verification.verifiedAt, contentDigest: factContentDigest(f), status: "approved" },
      sourceReference: f.source.reference, attributes: f.attributes, polarity: f.polarity,
    });
    if (f.kind === "employment" && f.polarity === "has") employment.push(f);
  }

  // Accomplishment statements: only text whose owning employment/project fact is itself kept, so nothing attached to rejected or inaccurate employment survives.
  for (const [resumeId, text] of scope.resumeText) {
    if (!text) continue;
    const owners = [...keptFacts.values()].filter((f) => scope.factResume.get(f.factId) === resumeId && (f.kind === "employment" || f.kind === "project") && scope.factSpan.get(f.factId));
    for (const s of extractStatements(text, owners.map((f) => ({ factId: f.factId, kind: f.kind, span: scope.factSpan.get(f.factId)! })))) {
      if (!s.ownerFactId || !keptFacts.has(s.ownerFactId) || s.kind === "summary_claim") continue;
      units.push({
        unitId: `st:${resumeId}:${s.start}`, factId: s.ownerFactId, resumeId, category: "statement", kind: keptFacts.get(s.ownerFactId)!.kind, value: s.quote.replace(/\s+/g, " "), text: s.quote.replace(/\s+/g, " "), quote: s.quote,
        span: { start: s.start, end: s.end }, verification: { verifiedBy: keptFacts.get(s.ownerFactId)!.verification.verifiedBy, verifiedAt: keptFacts.get(s.ownerFactId)!.verification.verifiedAt, contentDigest: factContentDigest(keptFacts.get(s.ownerFactId)!), status: "approved" },
        sourceReference: keptFacts.get(s.ownerFactId)!.source.reference, attributes: {}, polarity: "has",
      });
    }
  }

  const profileRevisions = await input.candidates.listProfileRevisions(input.userId);
  const latest = profileRevisions[profileRevisions.length - 1] ?? null;
  const evidenceDigest = createHash("sha256").update(JSON.stringify(units.map((u) => [u.unitId, u.verification.contentDigest]).sort())).digest("hex");
  return {
    units, eligibility, employment, excluded,
    boundaryExclusions: scope.excluded.map((e) => ({ factId: e.factId, resumeId: e.resumeId, code: e.code, detail: e.detail })),
    version: {
      profileId: scope.profile?.id ?? null, profileKind: scope.profile?.kind ?? null, profileRevisionNo: latest?.revisionNo ?? null, profileDigest: latest?.profileDigest ?? null,
      evidenceDigest, factCount: keptFacts.size, authorizedResumeIds: scope.sources.filter((s) => s.authorized).map((s) => s.resumeId), confirmedEmploymentReferences: scope.confirmed.length,
    },
  };
}

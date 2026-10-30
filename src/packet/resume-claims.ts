import { factUsability, type CandidateFact, type CandidateProfile } from "../domain/candidate-profile.js";
import type { Decision } from "../decision/evaluate.js";
import { normalizeExtractedPdfText, type ResumePlan } from "../pipeline/resume-plan.js";
import { protectedEmploymentOf } from "../pipeline/trust.js";

// "Zero unsupported resume claims" as a checkable property. Every claim on the artifact must be an approved,
// current fact quoted verbatim; all other text on the page must be recognised template furniture; and none of the
// applicant's excluded experience may appear. Anything left over is reported, never waved through.

export interface Claim {
  claimId: string;
  factId: string;
  factKind: string | null;
  text: string;
  source: { reference: string; locator: string | null } | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** Mandatory requirement rule ids this fact was matched to by the deterministic decision. */
  supportsRequirements: string[];
  supported: boolean;
  problems: string[];
}

export interface ClaimMap {
  schemaVersion: 1;
  planId: string;
  jobId: string;
  jdHash: string;
  claims: Claim[];
  /** Text on the artifact that is neither an approved claim nor recognised template furniture. */
  unsupportedText: string[];
  excludedTermHits: string[];
  /** Mandatory requirements with no approved supporting fact (stated, not hidden). */
  uncoveredRequirementIds: string[];
  unsupportedCount: number;
}

const norm = (text: string): string => normalizeExtractedPdfText(text);
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordingOf = (fact: CandidateFact): string => fact.attributes.detail ?? fact.value;

export function buildClaimMap(input: {
  plan: ResumePlan;
  profile: CandidateProfile;
  asOf: string;
  decision: Decision | null;
  extractedText: string;
  job: { company: string; title: string };
  /** Applicant-supplied terms whose experience must never appear (kept in a private policy file, not in code). */
  excludedTerms: string[];
}): ClaimMap {
  const byId = new Map(input.profile.facts.map((f) => [f.factId, f]));
  const rules = input.decision?.rules ?? [];
  const claims: Claim[] = input.plan.selectedFacts.map((selected, index) => {
    const fact = byId.get(selected.factId);
    const problems: string[] = [];
    if (!fact) problems.push("fact id is not in the candidate profile");
    else {
      if (!factUsability(fact, input.asOf).usable) problems.push("fact is not approved, current and verified");
      if (fact.polarity !== "has") problems.push("fact is an explicit statement of absence");
      if (wordingOf(fact) !== selected.wording) problems.push("artifact wording differs from the approved wording");
    }
    return {
      claimId: `claim-${index + 1}`,
      factId: selected.factId,
      factKind: fact?.kind ?? null,
      text: selected.wording,
      source: fact ? { reference: fact.source.reference, locator: fact.source.locator ?? null } : null,
      approvedBy: fact?.verification.verifiedBy ?? null,
      approvedAt: fact?.verification.verifiedAt ?? null,
      supportsRequirements: rules.filter((r) => r.mandatory && r.status === "PASS" && r.factIds.includes(selected.factId)).map((r) => r.ruleId),
      supported: problems.length === 0,
      problems,
    };
  });

  // Strip everything that is accounted for; whatever remains is unsupported content.
  let rest = norm(input.extractedText);
  const strip = (pattern: RegExp) => { rest = rest.replace(pattern, " "); };
  for (const claim of claims) if (claim.text) strip(new RegExp(escapeRe(norm(claim.text)), "g"));
  strip(/Evidence: .*? · [A-Za-z0-9._-]+/g);
  const protectedJobs = protectedEmploymentOf(input.profile.facts.filter((f) => factUsability(f, input.asOf).usable));
  for (const job of protectedJobs) {
    strip(new RegExp(escapeRe(norm(`${job.employer} — ${job.title}`)), "g"));
    strip(new RegExp(escapeRe(norm(job.dateLabel)), "g"));
    strip(new RegExp(`role tags: .*? · ${escapeRe(job.factId)}`, "g"));
    strip(new RegExp(escapeRe(job.factId), "g"));
  }
  const name = input.profile.facts.find((f) => f.kind === "legal_name" && factUsability(f, input.asOf).usable)?.value ?? `Candidate ${input.profile.candidateId}`;
  strip(new RegExp(escapeRe(norm(name)), "g"));
  strip(/PREVIEW — REVIEW REQUIRED/g);
  strip(/Job-specific resume/g);
  strip(new RegExp(`Target: ${escapeRe(norm(input.job.title))} · [a-z]+ · ${escapeRe(norm(input.job.company))}`, "g"));
  strip(/Plan [a-f0-9]{12} · approved profile facts only/g);
  strip(/This is a review preview, not an application-ready resume\. Uncovered mandatory requirements: \d+\./g);
  strip(/APPROVED EVIDENCE|PROFESSIONAL EXPERIENCE/g);
  const leftover = rest.replace(/[\s·—–-]+/g, " ").trim();
  const unsupportedText = leftover ? [leftover.slice(0, 240)] : [];

  const haystack = norm(input.extractedText).toLocaleLowerCase("en-US");
  const excludedTermHits = input.excludedTerms.filter((t) => t.trim() && new RegExp(`(^|[^a-z0-9])${escapeRe(norm(t).toLocaleLowerCase("en-US"))}($|[^a-z0-9])`).test(haystack));

  const unsupportedCount = claims.filter((c) => !c.supported).length + unsupportedText.length + excludedTermHits.length;
  return {
    schemaVersion: 1,
    planId: input.plan.id,
    jobId: input.plan.jobId,
    jdHash: input.plan.jdHash,
    claims,
    unsupportedText,
    excludedTermHits,
    uncoveredRequirementIds: input.plan.uncoveredRequirementIds,
    unsupportedCount,
  };
}

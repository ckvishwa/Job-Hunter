import { createHash } from "node:crypto";
import {
  CANDIDATE_PROFILE_SCHEMA_VERSION,
  SENSITIVE_FACT_KINDS,
  candidateFactSchema,
  factAttributesSchema,
  factContentDigest,
  parseCandidateProfile,
  profileDigest,
  type CandidateFact,
  type CandidateProfile,
  type FactKind,
} from "../domain/candidate-profile.js";
import type { ExtractResponse, ProposedFact } from "../ai/contracts.js";
import { applyFactReview } from "./review.js";

// S1 fact lifecycle: pure functions. Reuses the existing candidate schema, `applyFactReview` and content digests, and adds
// the S1-specific invariants: machine proposals are always PENDING; citizenship/clearance/work authorization/sponsorship
// can only come from an explicit user attestation; sensitive approvals need explicit confirmation; every approval is
// bound to the exact content digest the reviewer saw.

/** Facts that no resume, parser or model may ever produce. They exist only as explicit user statements. */
export const USER_ONLY_KINDS: readonly FactKind[] = ["clearance", "work_authorization", "citizenship", "sponsorship_need"];

export type FactRuleCode = "CONFIRMATION_REQUIRED" | "STALE_FACT" | "INVALID_EDIT" | "NOT_ALLOWED" | "CONFLICTING_FACT" | "INVALID_ATTESTATION";

export class FactRuleError extends Error {
  constructor(readonly code: FactRuleCode, message: string) {
    super(message);
    this.name = "FactRuleError";
  }
}

export class ExtractionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionIntegrityError";
  }
}

export interface FactSpan {
  start: number;
  end: number;
  quote: string;
}

export interface FactDraft {
  fact: CandidateFact;
  span: FactSpan | null;
  proposedBy: "rules" | "qwen" | "user";
  /** Deterministic extraction identity; null for facts the user attested directly. */
  factKey: string | null;
}

export interface DroppedProposal {
  code: "PROPOSAL_INVALID" | "PROPOSAL_FORBIDDEN_KIND" | "PROPOSAL_SPAN_MISMATCH";
  message: string;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const normalizeValue = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/** `scope` is the resume version, so identical text in two different uploads stays two facts with separate provenance. */
export function factKeyFor(scope: string, kind: string, value: string, start: number, end: number): string {
  return sha256(`${scope}|${kind}|${normalizeValue(value)}|${start}|${end}`);
}

const EMPLOYMENT_ONLY = ["employer", "title", "startDate", "endDate", "current", "employmentType"] as const;

/**
 * Validates the AI service output and builds PENDING facts. A proposal that fails any check is dropped (never repaired)
 * and reported. Throws ExtractionIntegrityError if the returned text does not match its declared hash.
 */
export function buildPendingFacts(
  response: ExtractResponse,
  context: { resumeReference: string; scope: string },
): { drafts: FactDraft[]; dropped: DroppedProposal[] } {
  if (sha256(response.text) !== response.textSha256) throw new ExtractionIntegrityError("Returned text does not match its declared SHA-256.");
  const drafts: FactDraft[] = [];
  const dropped: DroppedProposal[] = [];
  const seen = new Set<string>();

  for (const proposal of response.facts) {
    const drop = (code: DroppedProposal["code"], message: string): void => void dropped.push({ code, message: `${proposal.kind}: ${message}` });
    if ((USER_ONLY_KINDS as readonly string[]).includes(proposal.kind)) {
      drop("PROPOSAL_FORBIDDEN_KIND", "this kind can only be attested by the user");
      continue;
    }
    const { start, end, quote } = proposal.span;
    if (!(start < end && end <= response.text.length) || response.text.slice(start, end) !== quote) {
      drop("PROPOSAL_SPAN_MISMATCH", "span does not match the extracted text");
      continue;
    }
    const built = toPendingFact(proposal, context.resumeReference);
    if (!built) {
      drop("PROPOSAL_INVALID", "failed validation");
      continue;
    }
    const factKey = factKeyFor(context.scope, proposal.kind, built.value, start, end);
    if (seen.has(factKey)) continue;
    seen.add(factKey);
    const factId = `f-${proposal.kind}-${factKey.slice(0, 16)}`;
    drafts.push({ fact: { ...built, factId }, span: { start, end, quote }, proposedBy: proposal.proposedBy, factKey });
  }
  return { drafts, dropped };
}

function toPendingFact(proposal: ProposedFact, resumeReference: string): Omit<CandidateFact, "factId"> | null {
  const a = proposal.attributes;
  const attributes: Record<string, unknown> = {};
  if (proposal.kind === "employment") {
    if (!a.startDate || (a.current && a.endDate)) return null;
    if (a.employer) attributes.employer = a.employer;
    if (a.title) attributes.title = a.title;
    attributes.startDate = a.startDate;
    if (a.current) attributes.endDate = null;
    else if (a.endDate) attributes.endDate = a.endDate;
    if (a.employmentType) attributes.employmentType = a.employmentType;
  } else {
    if (EMPLOYMENT_ONLY.some((key) => a[key] !== undefined && a[key] !== null)) return null;
  }
  if (a.technologies) {
    if (proposal.kind !== "project") return null;
    attributes.technologies = a.technologies;
  }
  const sensitive = (SENSITIVE_FACT_KINDS as readonly string[]).includes(proposal.kind);
  const candidate = {
    factId: "pending-placeholder",
    kind: proposal.kind,
    value: proposal.value.trim(),
    polarity: "has" as const,
    attributes,
    source: { kind: "resume-import" as const, reference: resumeReference, locator: `chars ${proposal.span.start}-${proposal.span.end}` },
    verification: { verifiedBy: null, verifiedAt: null, validUntil: null },
    approvalStatus: "pending" as const,
    sensitivity: sensitive ? ("sensitive" as const) : ("normal" as const),
    ...(proposal.notes ? { notes: proposal.notes.slice(0, 500) } : {}),
  };
  const parsed = candidateFactSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const { factId: _ignored, ...rest } = parsed.data;
  return rest;
}

// ---------------------------------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------------------------------

export interface ReviewInput {
  action: "approve" | "reject" | "edit";
  actor: string;
  /** YYYY-MM-DD */
  today: string;
  /** The content digest the reviewer was looking at. A mismatch means the fact changed since; nothing is applied. */
  expectedDigest: string;
  confirmSensitive?: boolean;
  edit?: { value?: string; attributes?: unknown };
}

export interface ReviewOutcome {
  fact: CandidateFact;
  /** null = nothing changed, no revision should be written (idempotent repeat). */
  revisionAction: "APPROVE" | "REJECT" | "EDIT" | null;
  explicitConfirmation: boolean;
}

function soloProfile(fact: CandidateFact, today: string): CandidateProfile {
  return parseCandidateProfile({
    schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
    candidateId: "review",
    profileVersion: "solo",
    updatedAt: today,
    facts: [fact],
    preferences: {},
    employmentHistoryComplete: null,
  });
}

export function reviewFact(fact: CandidateFact, input: ReviewInput): ReviewOutcome {
  if (factContentDigest(fact) !== input.expectedDigest) {
    throw new FactRuleError("STALE_FACT", "The fact changed since it was loaded. Reload and review the current version.");
  }
  if (input.action === "reject") {
    if (fact.approvalStatus === "rejected") return { fact, revisionAction: null, explicitConfirmation: false };
    const next = applyFactReview(soloProfile(fact, input.today), { factId: fact.factId, action: "reject", reviewer: input.actor, reviewedAt: input.today });
    return { fact: next.facts[0]!, revisionAction: "REJECT", explicitConfirmation: false };
  }
  if (input.action === "approve") {
    if ((USER_ONLY_KINDS as readonly string[]).includes(fact.kind) && fact.source.kind !== "user-statement") {
      throw new FactRuleError("NOT_ALLOWED", `${fact.kind} can only be approved when it is the user's own explicit statement.`);
    }
    if (fact.sensitivity === "sensitive" && input.confirmSensitive !== true) {
      throw new FactRuleError("CONFIRMATION_REQUIRED", "Approving a sensitive fact needs explicit confirmation.");
    }
    if (fact.approvalStatus === "approved" && fact.verification.contentDigest === input.expectedDigest) {
      return { fact, revisionAction: null, explicitConfirmation: false };
    }
    const next = applyFactReview(soloProfile(fact, input.today), { factId: fact.factId, action: "approve", reviewer: input.actor, reviewedAt: input.today });
    return { fact: next.facts[0]!, revisionAction: "APPROVE", explicitConfirmation: fact.sensitivity === "sensitive" };
  }

  // edit: replaces value and/or the whole attributes object; the fact goes back to PENDING and keeps its provenance.
  const edit = input.edit;
  if (!edit || (edit.value === undefined && edit.attributes === undefined)) throw new FactRuleError("INVALID_EDIT", "An edit needs a value or attributes.");
  let value = fact.value;
  if (edit.value !== undefined) {
    value = edit.value.trim();
    if (!value || value.length > 300) throw new FactRuleError("INVALID_EDIT", "Value must be 1-300 characters.");
  }
  let attributes = fact.attributes;
  if (edit.attributes !== undefined) {
    const parsed = factAttributesSchema.safeParse(edit.attributes);
    if (!parsed.success) throw new FactRuleError("INVALID_EDIT", "Attributes are not valid for a candidate fact.");
    attributes = parsed.data;
  }
  const edited: CandidateFact = {
    ...fact,
    value,
    attributes,
    approvalStatus: "pending",
    verification: { verifiedBy: null, verifiedAt: null, validUntil: null },
  };
  try {
    soloProfile(edited, input.today);
  } catch {
    throw new FactRuleError("INVALID_EDIT", "The edited fact is not valid (an employment fact needs a start date).");
  }
  if (factContentDigest(edited) === factContentDigest(fact) && fact.approvalStatus === "pending") {
    return { fact, revisionAction: null, explicitConfirmation: false };
  }
  return { fact: edited, revisionAction: "EDIT", explicitConfirmation: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// Direct user attestation of sensitive facts
// ---------------------------------------------------------------------------------------------------------------------

export interface AttestInput {
  kind: FactKind;
  value: string;
  polarity: "has" | "lacks";
  actor: string;
  today: string;
  confirm: boolean;
}

export function attestFact(input: AttestInput): FactDraft {
  if (!(SENSITIVE_FACT_KINDS as readonly string[]).includes(input.kind)) {
    throw new FactRuleError("INVALID_ATTESTATION", "Only sensitive fact kinds are attested this way; other facts come from a resume and are reviewed.");
  }
  if (input.confirm !== true) throw new FactRuleError("CONFIRMATION_REQUIRED", "Attesting a sensitive fact needs explicit confirmation.");
  const value = input.value.trim();
  if (!value || value.length > 300) throw new FactRuleError("INVALID_ATTESTATION", "Value must be 1-300 characters.");
  const factId = `f-${input.kind}-${sha256(`${input.kind}|${input.polarity}|${normalizeValue(value)}`).slice(0, 16)}`;
  const base: CandidateFact = {
    factId,
    kind: input.kind,
    value,
    polarity: input.polarity,
    attributes: {},
    source: { kind: "user-statement", reference: "ui-attestation" },
    verification: { verifiedBy: input.actor, verifiedAt: input.today, validUntil: null },
    approvalStatus: "approved",
    sensitivity: "sensitive",
  };
  const fact: CandidateFact = { ...base, verification: { ...base.verification, contentDigest: factContentDigest(base) } };
  return { fact: candidateFactSchema.parse(fact), span: null, proposedBy: "user", factKey: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Profile revision digest
// ---------------------------------------------------------------------------------------------------------------------

export function assembleProfile(facts: CandidateFact[], candidateId: string, revisionNo: number, today: string): CandidateProfile {
  return parseCandidateProfile({
    schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION,
    candidateId,
    profileVersion: `s1-r${revisionNo}`,
    updatedAt: today,
    facts,
    preferences: {},
    employmentHistoryComplete: null,
  });
}

export const digestOfProfile = (profile: CandidateProfile): string => profileDigest(profile);

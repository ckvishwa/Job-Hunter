import { factAttributesSchema, type CandidateFact } from "../domain/candidate-profile.js";
import type { FactView } from "../db/candidate-repo.js";
import { FactRuleError } from "./fact-lifecycle.js";

// Evidence-backed correction of ONE extracted fact. It is the existing `edit` review action (value + attributes replaced, fact returns to
// PENDING, provenance span untouched, append-only revision, digest- and revision-locked) with a planning layer in front:
//   * what will change is computed and shown first;
//   * a change to employer, title, dates or category must be confirmed field by field;
//   * an APPROVED fact is edited only on an explicit flag, and it loses its approval (a person must approve the corrected content).
// Nothing here approves anything and nothing writes to the database.

export const CONFIRMED_FIELDS = ["employer", "title", "startDate", "endDate", "employmentType", "evidence"] as const;
export type ConfirmedField = (typeof CONFIRMED_FIELDS)[number];
export const EMPLOYMENT_CATEGORIES = ["professional", "internship", "academic", "volunteer"] as const;

export interface CorrectionRequest {
  value?: string;
  employer?: string;
  title?: string;
  /** YYYY-MM */
  startDate?: string;
  /** YYYY-MM, or "current" */
  endDate?: string;
  /** a category, or "none" to clear it */
  employmentType?: string;
  /**
   * Widen the source quotation to this exact text of the extracted resume (e.g. "event corre-\nlation"). It must occur once in the text and
   * overlap the fact's current quotation: evidence is adjusted, never replaced by something unrelated.
   */
  quote?: string;
}

export interface EvidenceSpan {
  start: number;
  end: number;
  quote: string;
}

export interface CorrectionPlan {
  factId: string;
  kind: string;
  wasApproved: boolean;
  before: { value: string; attributes: Record<string, unknown> };
  after: { value: string; attributes: Record<string, unknown> };
  changes: Array<{ field: "value" | ConfirmedField; from: string; to: string }>;
  /** Present when the source quotation is being widened. */
  evidence: { before: EvidenceSpan | null; after: EvidenceSpan } | null;
  /** Fields the person must confirm one by one before this can be applied. */
  needsConfirmation: ConfirmedField[];
  consequences: string[];
}

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const show = (v: unknown): string => (v === undefined ? "(unset)" : v === null ? "current" : String(v));

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function planCorrection(fact: FactView, request: CorrectionRequest, sourceText: string | null = null): CorrectionPlan {
  if (fact.sensitivity === "sensitive") throw new FactRuleError("NOT_ALLOWED", "Sensitive facts are not corrected through this tool.");
  const employmentOnly = request.employer !== undefined || request.title !== undefined || request.startDate !== undefined || request.endDate !== undefined || request.employmentType !== undefined;
  if (employmentOnly && fact.kind !== "employment") throw new FactRuleError("INVALID_EDIT", "Employer, title, dates and category only apply to an employment fact.");
  if (request.value === undefined && !employmentOnly && request.quote === undefined) throw new FactRuleError("INVALID_EDIT", "Nothing to change: give --value or at least one employment field.");

  const attrs: Record<string, unknown> = { ...(fact.attributes as Record<string, unknown>) };
  const changes: CorrectionPlan["changes"] = [];
  const set = (field: ConfirmedField, next: unknown): void => {
    if (attrs[field] === next) return; // null (= current) and undefined (= unset) are different states
    changes.push({ field, from: show(attrs[field]), to: show(next) });
    if (next === undefined) delete attrs[field];
    else attrs[field] = next;
  };
  const text = (label: string, v: string): string => {
    const t = v.trim();
    if (!t || t.length > 300) throw new FactRuleError("INVALID_EDIT", `${label} must be 1-300 characters.`);
    return t;
  };
  if (request.employer !== undefined) set("employer", text("Employer", request.employer));
  if (request.title !== undefined) set("title", text("Title", request.title));
  if (request.startDate !== undefined) {
    if (!YM.test(request.startDate)) throw new FactRuleError("INVALID_EDIT", "Start date must be YYYY-MM (a month is never guessed).");
    set("startDate", request.startDate);
  }
  if (request.endDate !== undefined) {
    if (request.endDate !== "current" && !YM.test(request.endDate)) throw new FactRuleError("INVALID_EDIT", 'End date must be YYYY-MM or "current".');
    set("endDate", request.endDate === "current" ? null : request.endDate);
  }
  if (request.employmentType !== undefined) {
    if (request.employmentType === "none") set("employmentType", undefined);
    else if ((EMPLOYMENT_CATEGORIES as readonly string[]).includes(request.employmentType)) set("employmentType", request.employmentType);
    else throw new FactRuleError("INVALID_EDIT", `Category must be one of ${EMPLOYMENT_CATEGORIES.join(", ")}, or "none".`);
  }
  if (fact.kind === "employment") {
    const s = attrs.startDate as string | undefined;
    const e = attrs.endDate as string | null | undefined;
    if (s && typeof e === "string" && e < s) throw new FactRuleError("INVALID_EDIT", "The end date is before the start date.");
  }

  let value = fact.value;
  if (request.value !== undefined) value = text("Value", request.value);
  else if (fact.kind === "employment" && (request.employer !== undefined || request.title !== undefined)) {
    if (!attrs.employer || !attrs.title) throw new FactRuleError("INVALID_EDIT", "Give both --employer and --title (the display value is built from them), or pass --value.");
    value = `${attrs.employer} — ${attrs.title}`;
  }
  if (value !== fact.value) changes.unshift({ field: "value", from: fact.value, to: value });

  const parsed = factAttributesSchema.safeParse(attrs);
  if (!parsed.success) throw new FactRuleError("INVALID_EDIT", "The corrected attributes are not valid for a candidate fact.");
  let evidence: CorrectionPlan["evidence"] = null;
  if (request.quote !== undefined) {
    if (!fact.span) throw new FactRuleError("INVALID_EDIT", "This fact has no source quotation to adjust.");
    if (sourceText === null) throw new FactRuleError("INVALID_EDIT", "The extracted resume text is not available, so the quotation cannot be verified.");
    if (!request.quote.trim() || request.quote.length > 400) throw new FactRuleError("INVALID_EDIT", "The quotation must be 1-400 characters.");
    const hits: number[] = [];
    for (let at = sourceText.indexOf(request.quote); at !== -1; at = sourceText.indexOf(request.quote, at + 1)) hits.push(at);
    const overlapping = hits.filter((at) => at < fact.span!.end && at + request.quote!.length > fact.span!.start);
    if (overlapping.length !== 1) {
      throw new FactRuleError("INVALID_EDIT", hits.length === 0 ? "That quotation does not occur verbatim in the extracted text." : "That quotation must occur exactly once at the fact's current location.");
    }
    const start = overlapping[0]!;
    const after = { start, end: start + request.quote.length, quote: request.quote };
    if ((fact.kind === "skill" || fact.kind === "certification") && !squash(after.quote).includes(squash(value))) {
      throw new FactRuleError("INVALID_EDIT", "The new quotation does not contain the value; the evidence would not back it.");
    }
    if (after.start !== fact.span.start || after.end !== fact.span.end) {
      evidence = { before: fact.span, after };
      changes.push({ field: "evidence", from: JSON.stringify(fact.span.quote), to: JSON.stringify(after.quote) });
    }
  }
  if (!changes.length) throw new FactRuleError("INVALID_EDIT", "The correction changes nothing.");

  const needsConfirmation = changes.map((c) => c.field).filter((f): f is ConfirmedField => (CONFIRMED_FIELDS as readonly string[]).includes(f));
  const wasApproved = fact.approvalStatus === "approved";
  const consequences = [
    "The source quotation and its position are kept exactly as extracted.",
    "The fact returns to PENDING; a person must approve the corrected content.",
    ...(wasApproved ? ["It is APPROVED today: it stops counting as approved evidence now, and every S2 recommendation that rests on it is superseded."] : []),
  ];
  return {
    factId: fact.factId, kind: fact.kind, wasApproved,
    before: { value: fact.value, attributes: fact.attributes as Record<string, unknown> },
    after: { value, attributes: parsed.data as Record<string, unknown> },
    changes, evidence, needsConfirmation, consequences,
  };
}

/** Throws unless every field that needs confirmation was confirmed explicitly (by name) and an approved fact was explicitly allowed. */
export function assertConfirmed(plan: CorrectionPlan, confirmed: readonly string[], allowApprovedEdit: boolean): void {
  const missing = plan.needsConfirmation.filter((f) => !confirmed.includes(f));
  if (missing.length) {
    throw new FactRuleError("CONFIRMATION_REQUIRED", `Confirm each changed field explicitly. Not confirmed: ${missing.join(", ")}.`);
  }
  if (plan.wasApproved && !allowApprovedEdit) {
    throw new FactRuleError("CONFIRMATION_REQUIRED", "This fact is approved. Editing it removes its approval; pass --allow-approved-edit to confirm that.");
  }
}

export const toEditInput = (plan: CorrectionPlan): { value: string; attributes: Record<string, unknown> } => ({ value: plan.after.value, attributes: plan.after.attributes });

export type { CandidateFact };

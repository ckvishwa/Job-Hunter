import { z } from "zod";
import { computeJdContentHash } from "./canonical-job.js";

// V1 Slice 2: StructuredJob contract and the validator every provider proposal must pass.
//
// Trust model: a provider returns an unvalidated PROPOSAL (requirements, responsibilities,
// constraints, alternative groups, evidence). Identity (jobId), the source hash (jdHash), the
// parser version and the provider revision are bound by orchestration from trusted context, so
// the proposal schema is strict and REJECTS any such field instead of believing it. The only
// provenance a proposal may echo is `sourceJdHash`, used solely to detect stale output.
//
// What validation proves: structure, controlled vocabularies, referential integrity, and that
// every evidence span is an exact UTF-16 slice of the persisted JD. What it cannot prove:
// that the interpretation of a quote is right (required vs preferred, scope, OR vs AND,
// negation). Those are covered by reviewed fixtures and surfaced as warnings, never silently
// "fixed" here.

export const STRUCTURED_SCHEMA_VERSION = 1;
export const STRUCTURED_PARSER_VERSION = "structured-job-validator@1";

export const REQUIREMENT_TYPES = [
  "skill",
  "tool",
  "language",
  "platform",
  "certification",
  "degree",
  "role_experience",
  "domain_knowledge",
  "soft_skill",
] as const;
export const REQUIREMENT_LEVELS = ["required", "preferred", "unknown"] as const;
export const SCOPE_KINDS = ["role", "tool", "domain", "unspecified"] as const;
export const CONSTRAINT_TYPES = [
  "clearance",
  "sponsorship",
  "citizenship",
  "work_authorization",
  "location",
  "travel",
  "employment_type",
] as const;
// required: the JD imposes it. not_required: the JD says it is not needed. offered / not_offered:
// the JD states it is (not) provided (e.g. sponsorship). unknown: the JD says nothing.
export const CONSTRAINT_STATUSES = ["required", "not_required", "offered", "not_offered", "unknown"] as const;

// Constraints a candidate decision can hinge on. Always present in an accepted StructuredJob;
// a JD that is silent on them gets an `unknown` entry added by the validator (never `false`).
export const SENSITIVE_CONSTRAINT_TYPES = ["clearance", "sponsorship", "citizenship", "work_authorization"] as const;

const MAX_REQUIREMENTS = 150;
const MAX_RESPONSIBILITIES = 100;
const MAX_CONSTRAINTS = 30;
const MAX_GROUPS = 50;
const MAX_EVIDENCE_PER_ITEM = 5;
const MAX_QUOTE_CHARS = 2000;
const MAX_ISSUES_REPORTED = 20;

const idString = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "id must be 1-64 chars of [A-Za-z0-9._-]");
const valueString = z.string().trim().min(1).max(200);

export const evidenceSpanSchema = z
  .object({
    quote: z.string().max(MAX_QUOTE_CHARS),
    start: z.number().int(),
    end: z.number().int(),
  })
  .strict();
export type EvidenceSpan = z.infer<typeof evidenceSpanSchema>;

const scopeSchema = z
  .object({
    kind: z.enum(SCOPE_KINDS),
    value: valueString.nullable(),
  })
  .strict();

const requirementProposalSchema = z
  .object({
    id: idString,
    type: z.enum(REQUIREMENT_TYPES),
    value: valueString,
    level: z.enum(REQUIREMENT_LEVELS),
    minimumYears: z.number().positive().max(50).nullable().default(null),
    scope: scopeSchema.default({ kind: "unspecified", value: null }),
    groupId: idString.nullable().default(null),
    evidence: z.array(evidenceSpanSchema).min(1).max(MAX_EVIDENCE_PER_ITEM),
  })
  .strict();

const responsibilityProposalSchema = z
  .object({
    id: idString,
    value: valueString,
    evidence: z.array(evidenceSpanSchema).min(1).max(MAX_EVIDENCE_PER_ITEM),
  })
  .strict();

const constraintProposalSchema = z
  .object({
    id: idString,
    type: z.enum(CONSTRAINT_TYPES),
    status: z.enum(CONSTRAINT_STATUSES),
    value: valueString.nullable().default(null),
    evidence: z.array(evidenceSpanSchema).max(MAX_EVIDENCE_PER_ITEM).default([]),
  })
  .strict();

const groupSchema = z.object({ id: idString, operator: z.literal("any_of") }).strict();

// `.strict()` is deliberate: jobId / jdHash / parserVersion / providerRevision / validationStatus /
// warnings are owned by orchestration and validation. A proposal that carries them is rejected.
export const structuredProposalSchema = z
  .object({
    sourceJdHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    requirements: z.array(requirementProposalSchema).max(MAX_REQUIREMENTS),
    responsibilities: z.array(responsibilityProposalSchema).max(MAX_RESPONSIBILITIES).default([]),
    constraints: z.array(constraintProposalSchema).max(MAX_CONSTRAINTS).default([]),
    alternativeGroups: z.array(groupSchema).max(MAX_GROUPS).default([]),
  })
  .strict();
export type StructuredProposal = z.input<typeof structuredProposalSchema>;

export const warningSchema = z.object({ code: z.string(), path: z.string(), message: z.string() }).strict();
export type StructuredWarning = z.infer<typeof warningSchema>;

export const structuredJobSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_SCHEMA_VERSION),
    id: z.string().min(1), // record key for the JSONL store: jobId::jdHash::parserVersion::providerRevision
    jobId: z.string().min(1),
    jdHash: z.string().regex(/^[0-9a-f]{64}$/),
    parserVersion: z.string().min(1),
    providerRevision: z.string().min(1),
    requirements: z.array(requirementProposalSchema.extend({ minimumYears: z.number().positive().max(50).nullable() })),
    responsibilities: z.array(responsibilityProposalSchema),
    constraints: z.array(constraintProposalSchema.extend({ value: valueString.nullable() })),
    alternativeGroups: z.array(groupSchema),
    warnings: z.array(warningSchema),
    validationStatus: z.literal("VALID"),
    validatedAt: z.string().datetime(),
  })
  .strict();
export type StructuredJob = z.infer<typeof structuredJobSchema>;

export function structuredJobKey(parts: { jobId: string; jdHash: string; parserVersion: string; providerRevision: string }): string {
  return `${parts.jobId}::${parts.jdHash}::${parts.parserVersion}::${parts.providerRevision}`;
}

// ---------------------------------------------------------------------------
// Typed failure
// ---------------------------------------------------------------------------

export type SemanticFailureCode =
  | "MALFORMED_JSON"
  | "SCHEMA_INVALID"
  | "STALE_OUTPUT"
  | "STALE_SOURCE"
  | "EVIDENCE_INVALID"
  | "DUPLICATE_ID"
  | "GROUP_INVALID"
  | "CONSTRAINT_INVALID"
  | "YEARS_UNSUPPORTED"
  | "SCOPE_MISMATCH"
  | "PROVIDER_FAILED";

export interface SemanticIssue {
  code: SemanticFailureCode;
  // e.g. "requirements[2].evidence[0]". Paths and counts only; never provider text or JD content.
  path: string;
  message: string;
}

export interface SemanticParseFailure {
  schemaVersion: number;
  category: "SEMANTIC_PARSE_FAILED";
  code: SemanticFailureCode;
  stage: "semantic_parse";
  runId: string;
  jobId: string;
  jdHash: string;
  parserVersion: string;
  providerRevision: string;
  retryable: boolean;
  issues: SemanticIssue[];
  at: string;
}

export interface TrustedParseContext {
  jobId: string;
  jdHash: string;
  parserVersion: string;
  providerRevision: string;
  now: string;
}

export type ValidationOutcome = { ok: true; job: StructuredJob } | { ok: false; code: SemanticFailureCode; issues: SemanticIssue[] };

export function buildSemanticFailure(input: {
  code: SemanticFailureCode;
  issues: SemanticIssue[];
  runId: string;
  trusted: Pick<TrustedParseContext, "jobId" | "jdHash" | "parserVersion" | "providerRevision">;
  retryable?: boolean;
  at?: string;
}): SemanticParseFailure {
  return {
    schemaVersion: STRUCTURED_SCHEMA_VERSION,
    category: "SEMANTIC_PARSE_FAILED",
    code: input.code,
    stage: "semantic_parse",
    runId: input.runId,
    jobId: input.trusted.jobId,
    jdHash: input.trusted.jdHash,
    parserVersion: input.trusted.parserVersion,
    providerRevision: input.trusted.providerRevision,
    retryable: input.retryable ?? input.code === "PROVIDER_FAILED",
    issues: input.issues.slice(0, MAX_ISSUES_REPORTED),
    at: input.at ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Evidence validation (exact UTF-16 slices of the persisted JD)
// ---------------------------------------------------------------------------

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Returns null if the span is an exact, non-empty slice of `rawJd`; otherwise a safe message. */
export function checkEvidenceSpan(rawJd: string, span: EvidenceSpan): string | null {
  const { start, end, quote } = span;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "offsets must be integers";
  if (start < 0 || end > rawJd.length || start >= end) {
    return `offsets out of range (start=${start}, end=${end}, sourceLength=${rawJd.length})`;
  }
  if (quote.trim().length === 0) return "evidence quote is empty or whitespace-only";
  if (start > 0 && isLowSurrogate(rawJd.charCodeAt(start)) && isHighSurrogate(rawJd.charCodeAt(start - 1))) {
    return `start offset splits a surrogate pair (start=${start})`;
  }
  if (end < rawJd.length && isHighSurrogate(rawJd.charCodeAt(end - 1)) && isLowSurrogate(rawJd.charCodeAt(end))) {
    return `end offset splits a surrogate pair (end=${end})`;
  }
  // No trimming or normalization: the persisted string is compared as-is.
  if (rawJd.slice(start, end) !== quote) {
    return `source slice does not equal quote (start=${start}, end=${end}, quoteLength=${quote.length})`;
  }
  return null;
}

const NUMBER_WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
  11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen", 16: "sixteen", 17: "seventeen",
  18: "eighteen", 19: "nineteen", 20: "twenty",
};

function evidenceMentionsNumber(evidence: EvidenceSpan[], n: number): boolean {
  const text = evidence.map((e) => e.quote).join(" \n ").toLowerCase();
  const numeral = new RegExp(`(?<![\\d.])${String(n).replace(".", "\\.")}(?![\\d]|\\.\\d)`);
  if (numeral.test(text)) return true;
  const word = NUMBER_WORDS[n];
  return word !== undefined && new RegExp(`\\b${word}\\b`).test(text);
}

const NEGATION_CUE = /\b(not required|no\s+\w+(\s+\w+)?\s+(is\s+)?required|not necessary|isn['’]t required|without|unnecessary|need not|does not require|do not require)\b/i;
const PREFERRED_CUE = /\b(preferred|nice to have|nice-to-have|bonus|a plus|added plus|desirable|ideally)\b/i;
const REQUIRED_CUE = /\b(required|must have|must be|must possess|minimum|mandatory|you must)\b/i;

// ---------------------------------------------------------------------------
// Proposal validation
// ---------------------------------------------------------------------------

function zodIssues(error: z.ZodError): SemanticIssue[] {
  return error.issues.slice(0, MAX_ISSUES_REPORTED).map((issue) => {
    // Messages are built from the issue CODE and our own vocabulary only. zod's default text can echo
    // the received value (e.g. invalid_enum_value), which would leak provider output into logs.
    let message: string;
    switch (issue.code) {
      case "unrecognized_keys":
        message = `unsupported field(s): ${issue.keys.map((k) => k.slice(0, 40)).join(", ")}`;
        break;
      case "invalid_enum_value":
        message = `value not in the allowed set: ${issue.options.join(" | ")}`;
        break;
      case "invalid_type":
        message = `expected ${issue.expected}, received ${issue.received}`;
        break;
      case "custom":
        message = issue.message.slice(0, 120);
        break;
      default:
        message = issue.code;
    }
    return { code: "SCHEMA_INVALID" as const, path: issue.path.map(String).join(".") || "(root)", message };
  });
}

/**
 * Validates an unknown provider output against the persisted JD and trusted context. Pure and
 * deterministic: no I/O. Rejects the WHOLE proposal on any error; returns a partial result never.
 */
export function validateStructuredProposal(rawJd: string, trusted: TrustedParseContext, proposalInput: unknown): ValidationOutcome {
  // 0. Trusted source must itself be consistent: the hash orchestration holds must be the hash of this exact text.
  if (computeJdContentHash(rawJd) !== trusted.jdHash) {
    return {
      ok: false,
      code: "STALE_SOURCE",
      issues: [{ code: "STALE_SOURCE", path: "(source)", message: "stored JD text does not match the recorded jdHash" }],
    };
  }

  // 1. Runtime schema (strict).
  const parsed = structuredProposalSchema.safeParse(proposalInput);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_INVALID", issues: zodIssues(parsed.error) };
  }
  const proposal = parsed.data;

  // 2. Stale output: an echoed hash that is not this JD's hash.
  if (proposal.sourceJdHash !== undefined && proposal.sourceJdHash !== trusted.jdHash) {
    return {
      ok: false,
      code: "STALE_OUTPUT",
      issues: [{ code: "STALE_OUTPUT", path: "sourceJdHash", message: "proposal was produced for a different JD revision" }],
    };
  }

  const issues: SemanticIssue[] = [];
  const warnings: StructuredWarning[] = [];

  // 3. Unique ids across requirements, responsibilities and constraints; unique group ids.
  const seen = new Set<string>();
  const checkId = (id: string, path: string): void => {
    if (id.startsWith("auto-")) issues.push({ code: "DUPLICATE_ID", path, message: 'the "auto-" id prefix is reserved for system-generated entries' });
    if (seen.has(id)) issues.push({ code: "DUPLICATE_ID", path, message: "id is used more than once" });
    seen.add(id);
  };
  proposal.requirements.forEach((r, i) => checkId(r.id, `requirements[${i}].id`));
  proposal.responsibilities.forEach((r, i) => checkId(r.id, `responsibilities[${i}].id`));
  proposal.constraints.forEach((c, i) => checkId(c.id, `constraints[${i}].id`));
  const groupIds = new Set<string>();
  proposal.alternativeGroups.forEach((g, i) => {
    if (groupIds.has(g.id)) issues.push({ code: "DUPLICATE_ID", path: `alternativeGroups[${i}].id`, message: "group id is used more than once" });
    groupIds.add(g.id);
  });

  // 4. Evidence: exact slices of the persisted JD.
  const checkEvidence = (evidence: EvidenceSpan[], path: string): void => {
    evidence.forEach((span, j) => {
      const problem = checkEvidenceSpan(rawJd, span);
      if (problem) issues.push({ code: "EVIDENCE_INVALID", path: `${path}.evidence[${j}]`, message: problem });
    });
  };
  proposal.requirements.forEach((r, i) => checkEvidence(r.evidence, `requirements[${i}]`));
  proposal.responsibilities.forEach((r, i) => checkEvidence(r.evidence, `responsibilities[${i}]`));
  proposal.constraints.forEach((c, i) => checkEvidence(c.evidence, `constraints[${i}]`));

  // 5. Requirement semantics that are mechanically checkable.
  proposal.requirements.forEach((r, i) => {
    const path = `requirements[${i}]`;
    const scopeNeedsValue = r.scope.kind !== "unspecified";
    if (scopeNeedsValue && r.scope.value === null) {
      issues.push({ code: "SCOPE_MISMATCH", path: `${path}.scope`, message: `scope kind "${r.scope.kind}" requires a value` });
    }
    if (!scopeNeedsValue && r.scope.value !== null) {
      issues.push({ code: "SCOPE_MISMATCH", path: `${path}.scope`, message: "unspecified scope must not carry a value" });
    }
    if (r.minimumYears !== null) {
      if (!evidenceMentionsNumber(r.evidence, r.minimumYears)) {
        issues.push({ code: "YEARS_UNSUPPORTED", path: `${path}.minimumYears`, message: `duration ${r.minimumYears} does not appear in the cited evidence` });
      }
      // Role-years and tool-years are different claims and must not be cross-labelled.
      if (r.type === "role_experience" && r.scope.kind === "tool") {
        issues.push({ code: "SCOPE_MISMATCH", path: `${path}.scope`, message: "role experience cannot be scoped to a tool" });
      }
      if ((r.type === "tool" || r.type === "language" || r.type === "platform") && r.scope.kind !== "tool") {
        issues.push({ code: "SCOPE_MISMATCH", path: `${path}.scope`, message: "years for a tool/language/platform must be scoped to that tool" });
      }
      if (r.scope.kind === "tool" && r.scope.value !== null && r.scope.value.toLowerCase() !== r.value.toLowerCase()) {
        issues.push({ code: "SCOPE_MISMATCH", path: `${path}.scope`, message: "tool scope value must equal the requirement value" });
      }
    }
    // Interpretation cues the validator can only flag, not decide.
    const quotes = r.evidence.map((e) => e.quote).join(" ");
    if (NEGATION_CUE.test(quotes)) {
      warnings.push({ code: "NEGATION_CUE_IN_EVIDENCE", path, message: "evidence contains a negation cue; confirm this is not an exclusion" });
    }
    if (r.level === "required" && PREFERRED_CUE.test(quotes) && !REQUIRED_CUE.test(quotes)) {
      warnings.push({ code: "LEVEL_CUE_MISMATCH", path, message: "level is required but the evidence uses preferred wording" });
    }
    if (r.level === "preferred" && REQUIRED_CUE.test(quotes) && !PREFERRED_CUE.test(quotes)) {
      warnings.push({ code: "LEVEL_CUE_MISMATCH", path, message: "level is preferred but the evidence uses required wording" });
    }
    const evidenceText = quotes.toLowerCase();
    if (!evidenceText.includes(r.value.toLowerCase())) {
      warnings.push({ code: "VALUE_NOT_IN_EVIDENCE", path, message: "normalized value does not appear verbatim in the evidence (normalization or paraphrase)" });
    }
  });

  // 6. Alternative groups: declared, referenced, >= 2 members, one level per group.
  const membersByGroup = new Map<string, number[]>();
  proposal.requirements.forEach((r, i) => {
    if (r.groupId === null) return;
    if (!groupIds.has(r.groupId)) {
      issues.push({ code: "GROUP_INVALID", path: `requirements[${i}].groupId`, message: "references an undeclared alternative group" });
      return;
    }
    membersByGroup.set(r.groupId, [...(membersByGroup.get(r.groupId) ?? []), i]);
  });
  proposal.alternativeGroups.forEach((g, gi) => {
    const members = membersByGroup.get(g.id) ?? [];
    if (members.length < 2) {
      issues.push({ code: "GROUP_INVALID", path: `alternativeGroups[${gi}]`, message: `any_of group needs at least 2 members (has ${members.length})` });
      return;
    }
    const levels = new Set(members.map((i) => proposal.requirements[i]!.level));
    if (levels.size > 1) {
      issues.push({ code: "GROUP_INVALID", path: `alternativeGroups[${gi}]`, message: "members of one alternative group must share a level" });
    }
  });

  // 7. Constraints: unknown carries no evidence/value; anything else must cite the JD; sensitive types appear once.
  const sensitiveSeen = new Map<string, number>();
  proposal.constraints.forEach((c, i) => {
    const path = `constraints[${i}]`;
    if (c.status === "unknown") {
      if (c.evidence.length > 0 || c.value !== null) {
        issues.push({ code: "CONSTRAINT_INVALID", path, message: "an unknown constraint must not carry evidence or a value (absence has no source text)" });
      }
    } else if (c.evidence.length === 0) {
      issues.push({ code: "CONSTRAINT_INVALID", path, message: `status "${c.status}" requires source evidence` });
    }
    if ((SENSITIVE_CONSTRAINT_TYPES as readonly string[]).includes(c.type)) {
      if (sensitiveSeen.has(c.type)) {
        issues.push({ code: "CONSTRAINT_INVALID", path, message: `more than one "${c.type}" constraint; ambiguous` });
      }
      sensitiveSeen.set(c.type, i);
    }
  });

  if (issues.length > 0) {
    return { ok: false, code: issues[0]!.code, issues: issues.slice(0, MAX_ISSUES_REPORTED) };
  }

  // 8. Accept: add `unknown` for sensitive constraints the JD is silent on (system-generated, no evidence).
  const constraints = proposal.constraints.map((c) => ({ ...c }));
  for (const type of SENSITIVE_CONSTRAINT_TYPES) {
    if (!sensitiveSeen.has(type)) {
      constraints.push({ id: `auto-unknown-${type}`, type, status: "unknown", value: null, evidence: [] });
    }
  }

  const job: StructuredJob = {
    schemaVersion: STRUCTURED_SCHEMA_VERSION,
    id: structuredJobKey(trusted),
    jobId: trusted.jobId,
    jdHash: trusted.jdHash,
    parserVersion: trusted.parserVersion,
    providerRevision: trusted.providerRevision,
    requirements: proposal.requirements,
    responsibilities: proposal.responsibilities,
    constraints,
    alternativeGroups: proposal.alternativeGroups,
    warnings,
    validationStatus: "VALID",
    validatedAt: trusted.now,
  };
  return { ok: true, job };
}

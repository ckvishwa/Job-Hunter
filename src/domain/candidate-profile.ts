import { createHash } from "node:crypto";
import { z } from "zod";

// V1 Slice 3: versioned candidate profile. Authority rule (docs/ard/00-SHARED-CONTRACTS.md section 1): the
// candidate supplies approved, current facts; nothing is inferred. Imported resume text starts `pending`
// and can never satisfy a requirement until a person approves it (verifiedBy + verifiedAt) and, where
// applicable, it has not expired. Sensitive answers (work authorization, sponsorship need, clearance)
// exist only as explicit facts and are never derived from a name, education, employment history or a model.

export const CANDIDATE_PROFILE_SCHEMA_VERSION = 1;

export const FACT_KINDS = [
  "skill",
  "employment",
  "project",
  "education",
  "certification",
  "clearance",
  "work_authorization",
  "sponsorship_need",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const SENSITIVE_FACT_KINDS: readonly FactKind[] = ["clearance", "work_authorization", "sponsorship_need"];

const idString = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "id must be 1-64 chars of [A-Za-z0-9._-]");
const textValue = z.string().trim().min(1).max(300);
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be YYYY-MM");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/, "must be an ISO date (YYYY-MM-DD)");

export const factSourceSchema = z
  .object({
    kind: z.enum(["resume-import", "user-statement", "verified-document"]),
    // A file name or label only (never an absolute path), so a profile can be shared without leaking directories.
    reference: z.string().min(1).max(200),
    locator: z.string().max(200).optional(),
  })
  .strict();

export const factAttributesSchema = z
  .object({
    // employment
    employer: textValue.optional(),
    title: textValue.optional(),
    startDate: yearMonth.optional(),
    endDate: yearMonth.nullable().optional(), // null = current
    // Approved wording naming what this role counts as for years-of-role requirements (e.g. "QA automation").
    // Role-years are never inferred from a job title.
    roleTags: z.array(textValue).max(20).optional(),
    // skill: other approved spellings that mean the same thing, and the employment facts that use it.
    matchTerms: z.array(textValue).max(20).optional(),
    experienceIds: z.array(idString).max(20).optional(),
    // project
    technologies: z.array(textValue).max(40).optional(),
    // education / certification / clearance / authorization: free approved detail
    detail: z.string().max(300).optional(),
  })
  .strict();

export const candidateFactSchema = z
  .object({
    factId: idString,
    kind: z.enum(FACT_KINDS),
    value: textValue,
    // "lacks" is an explicit candidate statement of absence; silence is never treated as "lacks".
    polarity: z.enum(["has", "lacks"]).default("has"),
    attributes: factAttributesSchema.default({}),
    source: factSourceSchema,
    verification: z
      .object({
        verifiedBy: z.string().min(1).nullable(),
        verifiedAt: isoDate.nullable(),
        validUntil: isoDate.nullable().default(null),
      })
      .strict(),
    approvalStatus: z.enum(["pending", "approved", "rejected"]),
    sensitivity: z.enum(["normal", "sensitive"]),
    notes: z.string().max(500).optional(),
  })
  .strict();
export type CandidateFact = z.infer<typeof candidateFactSchema>;

const preferenceSchema = z
  .object({
    // Matched (case-insensitive substring) against a job's stated location text, e.g. ["united states", "remote"].
    terms: z.array(textValue).min(1).max(20),
    // mandatory: no term in the JD's stated location is a FAIL. preferred: never a failure, recorded only.
    strength: z.enum(["mandatory", "preferred"]),
    approvedBy: z.string().min(1),
    approvedAt: isoDate,
  })
  .strict();

export const candidateProfileSchema = z
  .object({
    schemaVersion: z.literal(CANDIDATE_PROFILE_SCHEMA_VERSION),
    candidateId: idString,
    // Human-set label; the decision also records a content digest, so an edit without a version bump is still caught.
    profileVersion: z.string().min(1).max(64),
    updatedAt: isoDate,
    facts: z.array(candidateFactSchema).max(2000),
    preferences: z
      .object({
        locationWorkMode: preferenceSchema.optional(),
      })
      .strict()
      .default({}),
    // The candidate attests the approved employment facts are the COMPLETE history. Only then can a years
    // shortfall be a demonstrated FAIL; otherwise it is UNKNOWN (an unlisted job might exist).
    employmentHistoryComplete: z
      .object({ attestedBy: z.string().min(1), attestedAt: isoDate })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    const byId = new Map(profile.facts.map((f) => [f.factId, f]));
    profile.facts.forEach((fact, i) => {
      const at = (message: string, key: string = "facts"): void => ctx.addIssue({ code: "custom", path: [key, i], message });
      if (seen.has(fact.factId)) at(`duplicate factId "${fact.factId}"`);
      seen.add(fact.factId);
      if (fact.approvalStatus === "approved" && (!fact.verification.verifiedBy || !fact.verification.verifiedAt)) {
        at(`approved fact "${fact.factId}" needs verifiedBy and verifiedAt`);
      }
      if (SENSITIVE_FACT_KINDS.includes(fact.kind) && fact.sensitivity !== "sensitive") {
        at(`fact "${fact.factId}" of kind ${fact.kind} must have sensitivity "sensitive"`);
      }
      if (fact.kind === "employment") {
        if (!fact.attributes.startDate) at(`employment fact "${fact.factId}" needs attributes.startDate`);
        const { startDate, endDate } = fact.attributes;
        if (startDate && endDate && endDate < startDate) at(`employment fact "${fact.factId}" ends before it starts`);
      }
      for (const ref of fact.attributes.experienceIds ?? []) {
        const target = byId.get(ref);
        if (!target || target.kind !== "employment") at(`fact "${fact.factId}" references "${ref}", which is not an employment fact`);
      }
    });
  });
export type CandidateProfile = z.infer<typeof candidateProfileSchema>;

export function parseCandidateProfile(input: unknown): CandidateProfile {
  return candidateProfileSchema.parse(input);
}

/** Stable digest of everything a decision can depend on (facts, preferences, attestation), independent of key order. */
export function profileDigest(profile: CandidateProfile): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value;
  };
  const material = { candidateId: profile.candidateId, facts: profile.facts, preferences: profile.preferences, employmentHistoryComplete: profile.employmentHistoryComplete };
  return createHash("sha256").update(JSON.stringify(canonical(material))).digest("hex");
}

export type FactUsability = { usable: true } | { usable: false; reason: "PENDING" | "REJECTED" | "UNVERIFIED" | "EXPIRED"; detail: string };

/** Only an approved, verified, unexpired fact can satisfy anything. `asOf` is an ISO date (YYYY-MM-DD). */
export function factUsability(fact: CandidateFact, asOf: string): FactUsability {
  if (fact.approvalStatus === "pending") return { usable: false, reason: "PENDING", detail: `fact ${fact.factId} is pending approval` };
  if (fact.approvalStatus === "rejected") return { usable: false, reason: "REJECTED", detail: `fact ${fact.factId} was rejected` };
  if (!fact.verification.verifiedBy || !fact.verification.verifiedAt) {
    return { usable: false, reason: "UNVERIFIED", detail: `fact ${fact.factId} has no verifier or verification date` };
  }
  const until = fact.verification.validUntil;
  if (until && until.slice(0, 10) < asOf.slice(0, 10)) {
    return { usable: false, reason: "EXPIRED", detail: `fact ${fact.factId} expired on ${until.slice(0, 10)}` };
  }
  return { usable: true };
}

// ---------------------------------------------------------------------------
// Employment time arithmetic (month granularity, overlap-safe)
// ---------------------------------------------------------------------------

const monthIndex = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

/**
 * Whole months covered by the UNION of the given employment facts' date ranges, counted as end minus start
 * (the end month is not counted: deliberately conservative). Overlapping jobs are never double-counted; a
 * current job (endDate null) ends at `asOf`.
 */
export function unionMonths(facts: CandidateFact[], asOf: string): number {
  const asOfIndex = monthIndex(asOf.slice(0, 7));
  const spans = facts
    .map((f) => {
      const start = f.attributes.startDate;
      if (!start) return null;
      const end = f.attributes.endDate === null || f.attributes.endDate === undefined ? asOfIndex : monthIndex(f.attributes.endDate);
      return [monthIndex(start), end] as [number, number];
    })
    .filter((s): s is [number, number] => s !== null && s[1] > s[0])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of spans) {
    if (curEnd < 0 || s > curEnd) {
      if (curEnd >= 0) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd >= 0) total += curEnd - curStart;
  return total;
}

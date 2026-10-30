import { createHash } from "node:crypto";
import { z } from "zod";
import { FACT_KINDS, SENSITIVE_FACT_KINDS } from "../domain/candidate-profile.js";

// S2: the role catalog is DATA (PostgreSQL rows, revisioned), not prompt text. A title or alias is a search/matching label; it
// never establishes that the candidate is eligible for, or qualified for, a role.

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a lowercase slug").max(64);

/** Kinds that can carry role evidence. Sensitive kinds (clearance, citizenship, authorization, contact details...) never do. */
export const EVIDENCE_KINDS = FACT_KINDS.filter((k) => !SENSITIVE_FACT_KINDS.includes(k)) as readonly (typeof FACT_KINDS)[number][];

export const evidenceRequirementSchema = z
  .object({
    id: slug,
    label: z.string().trim().min(1).max(120),
    importance: z.enum(["core", "supporting"]),
    /** Whole-word / whole-phrase terms, matched case-insensitively against approved fact text. */
    terms: z.array(z.string().trim().min(2).max(60)).min(1).max(30),
  })
  .strict();

export const roleEvidenceSchema = z
  .object({
    requirements: z.array(evidenceRequirementSchema).min(1).max(14),
    /** How many distinct CORE requirements need a matching approved fact before the role counts as SUPPORTED. */
    minCoreMatches: z.number().int().min(1).max(14),
    /** Advisory only: shown as an experience note, never a gate. */
    advisoryProfessionalMonths: z.number().int().min(0).max(120).default(0),
  })
  .strict()
  .superRefine((evidence, ctx) => {
    const ids = new Set<string>();
    for (const r of evidence.requirements) {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", message: `duplicate requirement id "${r.id}"`, path: ["requirements"] });
      ids.add(r.id);
    }
    const core = evidence.requirements.filter((r) => r.importance === "core").length;
    if (core === 0) ctx.addIssue({ code: "custom", message: "at least one core requirement is needed", path: ["requirements"] });
    if (evidence.minCoreMatches > core) ctx.addIssue({ code: "custom", message: "minCoreMatches exceeds the number of core requirements", path: ["minCoreMatches"] });
  });
export type RoleEvidence = z.infer<typeof roleEvidenceSchema>;

export const aliasListSchema = z.array(z.string().trim().min(2).max(80)).max(40);

export const familySchema = z
  .object({
    familySlug: slug,
    name: z.string().trim().min(1).max(120),
    tier: z.enum(["primary", "secondary"]),
    sortOrder: z.number().int().min(0).max(1000),
    description: z.string().max(600),
  })
  .strict();
export type RoleFamily = z.infer<typeof familySchema>;

export const roleDefinitionSchema = z
  .object({
    roleSlug: slug,
    familySlug: slug,
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(600),
    aliases: aliasListSchema,
    evidence: roleEvidenceSchema,
    active: z.boolean().default(true),
  })
  .strict();
export type RoleDefinition = z.infer<typeof roleDefinitionSchema>;

/** Editable fields. The slug and family are stable identities and cannot be edited. */
export const roleEditSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(600).optional(),
    aliases: aliasListSchema.optional(),
    evidence: roleEvidenceSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "an edit must change at least one field" });
export type RoleEdit = z.infer<typeof roleEditSchema>;

export const normalizeAlias = (alias: string): string => alias.toLowerCase().replace(/\s+/g, " ").trim();

/** Aliases are stored deduplicated (case/space-insensitive), in a stable order. */
export function canonicalAliases(aliases: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const alias of aliases) {
    const key = normalizeAlias(alias);
    if (key && !seen.has(key)) seen.set(key, alias.replace(/\s+/g, " ").trim());
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalJson(v)]));
  }
  return value;
};

/** Stable digest of everything a recommendation can depend on for one role. */
export function roleDefinitionDigest(def: RoleDefinition): string {
  const material = { ...def, aliases: canonicalAliases(def.aliases).map(normalizeAlias) };
  return createHash("sha256").update(JSON.stringify(canonicalJson(material))).digest("hex");
}

export const sha256Json = (value: unknown): string => createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex");

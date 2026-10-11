import { z } from "zod";

// Wire contract with services/ai (POST /internal/v1/ai/extract-resume). The Python service only PROPOSES; every field
// is re-validated here and every span is re-checked against the returned text before anything is persisted.

export const AI_SCHEMA_REVISION = 1;
/** Bump to force a new extraction pass (a new resume_versions row) for already-uploaded resumes. */
export const RESUME_EXTRACT_CONTRACT = "resume-extract-v1";

/** Kinds the proposer may emit. Citizenship, clearance, work authorization and sponsorship are deliberately absent. */
export const PROPOSABLE_KINDS = ["skill", "employment", "project", "education", "certification", "legal_name", "email", "phone"] as const;
export type ProposableKind = (typeof PROPOSABLE_KINDS)[number];

const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const proposedAttributesSchema = z
  .object({
    employer: z.string().min(1).max(300).nullish(),
    title: z.string().min(1).max(300).nullish(),
    startDate: yearMonth.nullish(),
    endDate: yearMonth.nullish(),
    current: z.boolean().nullish(),
    employmentType: z.literal("internship").nullish(),
    technologies: z.array(z.string().min(1).max(300)).max(40).nullish(),
  })
  .strict();

export const proposedFactSchema = z
  .object({
    kind: z.enum(PROPOSABLE_KINDS),
    value: z.string().min(1).max(300),
    attributes: proposedAttributesSchema,
    span: z.object({ start: z.number().int().min(0), end: z.number().int().min(1), quote: z.string().min(1) }).strict(),
    proposedBy: z.enum(["rules", "qwen"]),
    notes: z.string().max(300).nullish(),
  })
  .strict();
export type ProposedFact = z.infer<typeof proposedFactSchema>;

export const extractResponseSchema = z
  .object({
    schemaRevision: z.literal(AI_SCHEMA_REVISION),
    parserRevision: z.string().min(1).max(200),
    fileType: z.enum(["pdf", "docx"]),
    text: z.string().min(1).max(500_000),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    warnings: z.array(z.object({ code: z.string().min(1).max(80), message: z.string().max(500), start: z.number().int().nullish(), end: z.number().int().nullish() }).strict()).max(200),
    facts: z.array(proposedFactSchema).max(2000),
    stats: z
      .object({
        pageCount: z.number().int(),
        characterCount: z.number().int(),
        deterministicFacts: z.number().int(),
        qwenFacts: z.number().int(),
        qwenDropped: z.number().int(),
        qwenStatus: z.enum(["NOT_REQUIRED", "DISABLED", "USED", "UNAVAILABLE"]),
      })
      .strict(),
  })
  .strict();
export type ExtractResponse = z.infer<typeof extractResponseSchema>;

export const aiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const infoResponseSchema = z.object({ schemaRevision: z.literal(AI_SCHEMA_REVISION), parserRevision: z.string(), qwenFallback: z.boolean() });

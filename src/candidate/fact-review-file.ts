import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FactView } from "../db/candidate-repo.js";
import type { EmploymentConflict } from "./employment-conflicts.js";
import { assessFactQuality, uncoveredLineCount } from "./fact-quality.js";

// The reviewable JSON file: one record per extracted fact with a mutable `decision` and everything needed to map it back losslessly.
// The original quotation and value are exported as stored and are never overwritten by the review tools.

export const REVIEW_FILE_SCHEMA = "orbital-fact-review/1";

const warningSchema = z.object({ code: z.enum(["BROKEN_LINE", "POSSIBLE_DUPLICATE", "EMPLOYMENT_REVIEW", "INSUFFICIENT_CONTEXT", "SOURCE_MISMATCH", "EMPLOYMENT_CONFLICT"]), message: z.string() }).strict();

export const reviewFactSchema = z
  .object({
    factId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    resumeId: z.string().uuid(),
    kind: z.string(),
    status: z.enum(["pending", "approved", "rejected"]),
    sensitivity: z.enum(["normal", "sensitive"]),
    value: z.string(),
    valueMasked: z.boolean(),
    polarity: z.enum(["has", "lacks"]),
    attributes: z.record(z.string(), z.unknown()),
    source: z.object({ reference: z.string(), locator: z.string().nullable() }).strict(),
    quote: z.string().nullable(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    headRevision: z.number().int().min(1),
    warnings: z.array(warningSchema),
    /** The ONLY field a reviewer changes (with `reason`). null = leave the fact exactly as it is. */
    decision: z.enum(["approve", "reject"]).nullable(),
    reason: z.string().max(500).nullable().optional(),
  })
  .strict();

export const reviewFileSchema = z
  .object({
    schema: z.literal(REVIEW_FILE_SCHEMA),
    exportedAt: z.string(),
    userHandle: z.string(),
    resumeId: z.string().uuid(),
    resumeVersionId: z.string().uuid(),
    sourceTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    valuesRevealed: z.boolean(),
    coverage: z.object({ uncoveredLongLines: z.number().int().min(0), note: z.string() }).strict(),
    instructions: z.string(),
    facts: z.array(reviewFactSchema),
  })
  .strict();

export type ReviewFile = z.infer<typeof reviewFileSchema>;
export type ReviewFact = z.infer<typeof reviewFactSchema>;

const MASKED_KINDS = new Set(["legal_name", "email", "phone"]);

/** Keeps the first character and the length, nothing else. */
export function maskValue(value: string): string {
  const t = value.trim();
  return t ? `${t[0]}${"•".repeat(Math.min(t.length - 1, 8))} (${t.length} chars, masked)` : "(masked)";
}

export function isMaskedKind(kind: string, sensitivity: string): boolean {
  return MASKED_KINDS.has(kind) || sensitivity === "sensitive";
}

export function buildReviewFile(input: {
  userHandle: string; resumeId: string; resumeVersionId: string; sourceTextSha256: string; text: string; facts: readonly FactView[]; reveal: boolean; now: Date; conflicts?: readonly EmploymentConflict[];
}): ReviewFile {
  const qualityInput = input.facts.map((f) => ({ factId: f.factId, kind: f.kind, value: f.value, attributes: f.attributes, span: f.span }));
  const facts: ReviewFact[] = input.facts.map((f) => {
    const mask = !input.reveal && isMaskedKind(f.kind, f.sensitivity);
    return {
      factId: f.factId,
      resumeId: input.resumeId,
      kind: f.kind,
      status: f.approvalStatus,
      sensitivity: f.sensitivity,
      value: mask ? maskValue(f.value) : f.value,
      valueMasked: mask,
      polarity: f.polarity,
      attributes: f.attributes as Record<string, unknown>,
      source: { reference: f.source.reference, locator: f.source.locator ?? null },
      quote: f.span ? (mask ? maskValue(f.span.quote) : f.span.quote) : null,
      contentDigest: f.contentDigest,
      headRevision: f.headRevision,
      warnings: assessFactQuality({ ...f }, qualityInput, input.text, input.conflicts ?? []),
      decision: null,
      reason: null,
    };
  });
  return {
    schema: REVIEW_FILE_SCHEMA,
    exportedAt: input.now.toISOString(),
    userHandle: input.userHandle,
    resumeId: input.resumeId,
    resumeVersionId: input.resumeVersionId,
    sourceTextSha256: input.sourceTextSha256,
    valuesRevealed: input.reveal,
    coverage: {
      uncoveredLongLines: uncoveredLineCount(input.text, input.facts),
      note: "Lines of the résumé text with no extracted fact. Achievements there are not structured facts; add them with the evidence-backed edit/creation workflow if they matter.",
    },
    instructions: 'Set "decision" to "approve" or "reject" (optionally add "reason"). Leave it null to keep the fact exactly as it is. Do not edit any other field; facts:apply checks them against the database.',
    facts,
  };
}

export const defaultReviewPath = (resumeId: string): string => path.resolve("private-runtime", "fact-review", `${resumeId}.review.json`);

/** Write-then-rename so an interrupted write never leaves a half-written review file. */
export function writeReviewFile(file: string, data: ReviewFile, options: { overwrite: boolean }): void {
  const target = path.resolve(file);
  if (!options.overwrite && existsSync(target)) throw new Error(`${target} already exists; it may hold decisions. Use --force to replace it.`);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

export function readReviewFile(file: string): ReviewFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read review file: ${(error as Error).message.split("\n")[0]}`);
  }
  const parsed = reviewFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(`Invalid review file at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return parsed.data;
}

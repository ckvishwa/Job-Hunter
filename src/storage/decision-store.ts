import { z } from "zod";
import { DECISION_SCHEMA_VERSION, type Decision } from "../decision/evaluate.js";
import { loadRecords, updateRecords } from "./job-store.js";

// Derived decisions (data/decisions.jsonl) live apart from the authoritative jobs.jsonl and reuse the job
// store's strict reads, single-writer lock and atomic replacement. Records are keyed by
// jobId + jdHash + structured extraction + profile digest + policy version: a changed JD, extraction,
// profile or policy yields a NEW record and never rewrites an older one.

const ruleSchema = z
  .object({
    ruleId: z.string(),
    subject: z.object({ kind: z.string(), id: z.string() }).passthrough(),
    status: z.enum(["PASS", "FAIL", "UNKNOWN"]),
    mandatory: z.boolean(),
    evidence: z.array(z.object({ quote: z.string(), start: z.number(), end: z.number() })),
    factIds: z.array(z.string()),
  })
  .passthrough();

export const decisionRecordSchema = z
  .object({
    schemaVersion: z.literal(DECISION_SCHEMA_VERSION),
    id: z.string().min(1),
    jobId: z.string().min(1),
    jdHash: z.string().regex(/^[0-9a-f]{64}$/),
    structuredId: z.string().min(1),
    candidateId: z.string().min(1),
    profileVersion: z.string().min(1),
    profileDigest: z.string().regex(/^[0-9a-f]{64}$/),
    policyVersion: z.string().min(1),
    outcome: z.enum(["ELIGIBLE", "REJECT", "REVIEW"]),
    rules: z.array(ruleSchema),
  })
  .passthrough();

export function isDecisionRecord(value: unknown): value is Decision {
  return decisionRecordSchema.safeParse(value).success;
}

export function loadDecisions(filePath: string): Decision[] {
  return loadRecords(filePath, isDecisionRecord);
}

export async function upsertDecision(filePath: string, decision: Decision): Promise<Decision[]> {
  return updateRecords(filePath, isDecisionRecord, (current) => [...current.filter((d) => d.id !== decision.id), decision]);
}

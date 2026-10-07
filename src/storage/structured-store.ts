import { structuredJobSchema, type StructuredJob } from "../domain/structured-job.js";
import { loadRecords, updateRecords } from "./job-store.js";

// Versioned artifact of ACCEPTED structured results (data/structured-jobs.jsonl), separate from
// the authoritative jobs.jsonl. It reuses the job store's strict reads, single-writer lock and
// atomic replacement. Records are keyed by jobId + jdHash + parserVersion + providerRevision:
// a changed JD, parser or provider produces a new record and never overwrites an older one.

export function isStructuredJobRecord(value: unknown): value is StructuredJob {
  return structuredJobSchema.safeParse(value).success;
}

export function loadStructuredJobs(filePath: string): StructuredJob[] {
  return loadRecords(filePath, isStructuredJobRecord);
}

export async function upsertStructuredJob(filePath: string, job: StructuredJob): Promise<StructuredJob[]> {
  return updateRecords(filePath, isStructuredJobRecord, (current) => [...current.filter((existing) => existing.id !== job.id), job]);
}

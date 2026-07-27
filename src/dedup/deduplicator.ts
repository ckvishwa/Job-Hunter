import { canonicalizeUrl } from "./canonicalize-url.js";
import { fingerprintDescription } from "./fingerprint.js";
import type { JobPosting } from "../adapters/types.js";

function normalizeKey(...parts: (string | null)[]): string {
  return parts.map((part) => (part ?? "").toLowerCase().trim().replace(/\s+/g, " ")).join("::");
}

// Minimum trimmed description length before it's trusted as a fingerprint match key.
// An empty (or near-empty) description text is not a reliable identifying signal --
// fingerprintDescription("") is a constant hash, so without this guard any two jobs
// with no/blank description would incorrectly collapse into one record on tier 4.
const MIN_FINGERPRINTABLE_DESCRIPTION_LENGTH = 10;

function hasUsableTitle(title: string): boolean {
  return title.trim().length > 0;
}

function hasFingerprintableDescription(descriptionText: string): boolean {
  return descriptionText.trim().length >= MIN_FINGERPRINTABLE_DESCRIPTION_LENGTH;
}

export function mergeJobs(
  existing: JobPosting[],
  incoming: JobPosting[],
  now: string,
): JobPosting[] {
  const result: JobPosting[] = [...existing];
  const byUrl = new Map<string, number>();
  const byReq = new Map<string, number>();
  const byCompanyTitleLoc = new Map<string, number>();
  const byFingerprint = new Map<string, number>();

  function index(job: JobPosting, idx: number): void {
    byUrl.set(canonicalizeUrl(job.canonicalUrl), idx);
    if (job.requisitionId) byReq.set(`${job.source}::${job.requisitionId}`, idx);
    if (hasUsableTitle(job.title)) {
      byCompanyTitleLoc.set(normalizeKey(job.company, job.title, job.location), idx);
    }
    if (hasFingerprintableDescription(job.descriptionText)) {
      byFingerprint.set(fingerprintDescription(job.descriptionText), idx);
    }
  }

  function deindex(job: JobPosting, idx: number): void {
    const urlKey = canonicalizeUrl(job.canonicalUrl);
    if (byUrl.get(urlKey) === idx) byUrl.delete(urlKey);
    if (job.requisitionId) {
      const reqKey = `${job.source}::${job.requisitionId}`;
      if (byReq.get(reqKey) === idx) byReq.delete(reqKey);
    }
    if (hasUsableTitle(job.title)) {
      const ctlKey = normalizeKey(job.company, job.title, job.location);
      if (byCompanyTitleLoc.get(ctlKey) === idx) byCompanyTitleLoc.delete(ctlKey);
    }
    if (hasFingerprintableDescription(job.descriptionText)) {
      const fpKey = fingerprintDescription(job.descriptionText);
      if (byFingerprint.get(fpKey) === idx) byFingerprint.delete(fpKey);
    }
  }

  result.forEach(index);

  for (const incomingJob of incoming) {
    const urlKey = canonicalizeUrl(incomingJob.canonicalUrl);
    const reqKey = incomingJob.requisitionId
      ? `${incomingJob.source}::${incomingJob.requisitionId}`
      : null;
    const ctlKey = normalizeKey(incomingJob.company, incomingJob.title, incomingJob.location);
    const fpKey = fingerprintDescription(incomingJob.descriptionText);

    const matchIdx =
      byUrl.get(urlKey) ??
      (reqKey ? byReq.get(reqKey) : undefined) ??
      (hasUsableTitle(incomingJob.title) ? byCompanyTitleLoc.get(ctlKey) : undefined) ??
      (hasFingerprintableDescription(incomingJob.descriptionText)
        ? byFingerprint.get(fpKey)
        : undefined);

    if (matchIdx !== undefined) {
      const original = result[matchIdx]!;
      deindex(original, matchIdx);
      const merged: JobPosting = {
        ...incomingJob,
        id: original.id,
        discoveredAt: original.discoveredAt,
        lastSeenAt: now,
      };
      result[matchIdx] = merged;
      index(merged, matchIdx);
    } else {
      const fresh: JobPosting = { ...incomingJob, discoveredAt: now, lastSeenAt: now };
      result.push(fresh);
      index(fresh, result.length - 1);
    }
  }

  return result;
}

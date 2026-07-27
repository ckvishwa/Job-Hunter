import { canonicalizeUrl } from "./canonicalize-url.js";
import { fingerprintDescription } from "./fingerprint.js";
import type { JobPosting } from "../adapters/types.js";

function normalizeKey(...parts: (string | null)[]): string {
  return parts.map((part) => (part ?? "").toLowerCase().trim().replace(/\s+/g, " ")).join("::");
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
    byCompanyTitleLoc.set(normalizeKey(job.company, job.title, job.location), idx);
    byFingerprint.set(fingerprintDescription(job.descriptionText), idx);
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
      byCompanyTitleLoc.get(ctlKey) ??
      byFingerprint.get(fpKey);

    if (matchIdx !== undefined) {
      const original = result[matchIdx];
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

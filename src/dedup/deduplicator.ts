import { canonicalizeUrl } from "./canonicalize-url.js";
import { fingerprintDescription } from "./fingerprint.js";
import type { JobPosting, SourceObservation } from "../adapters/types.js";

function normalizeKey(...parts: (string | null)[]): string {
  return parts.map((part) => (part ?? "").toLowerCase().trim().replace(/\s+/g, " ")).join("::");
}

const GENERIC_TITLES = new Set([
  "software engineer",
  "developer",
  "engineer",
  "manager",
  "director",
  "consultant",
  "analyst",
  "intern",
  "associate",
  "specialist",
  "coordinator",
  "lead",
  "architect",
  "qa",
  "tester",
  "sdet",
  "qa engineer",
  "qa analyst",
  "systems engineer",
  "staff engineer",
  "senior software engineer",
  "senior engineer",
  "admin",
  "administrator",
]);

export function isGenericTitle(title: string): boolean {
  const normalized = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
  return GENERIC_TITLES.has(normalized);
}

// Minimum trimmed description length before it's trusted as a fingerprint match key.
const MIN_FINGERPRINTABLE_DESCRIPTION_LENGTH = 10;

function hasUsableTitle(title: string): boolean {
  return title.trim().length > 0 && !isGenericTitle(title);
}

function hasFingerprintableDescription(descriptionText: string): boolean {
  return descriptionText.trim().length >= MIN_FINGERPRINTABLE_DESCRIPTION_LENGTH;
}

function observationKey(o: SourceObservation): string {
  return `${o.sourceKind}|${o.observedUrl}|${o.finalUrl}|${o.extractionMethod}`;
}

// Same sighting seen again keeps one entry (with the newest observedAt); a new URL or a
// different extraction method is a new observation. Capped so a job re-seen for months stays small.
const MAX_OBSERVATIONS = 20;

function mergeObservations(
  previous: SourceObservation[] | undefined,
  incoming: SourceObservation[] | undefined,
): SourceObservation[] | undefined {
  if (!previous && !incoming) return undefined;
  const byKey = new Map<string, SourceObservation>();
  for (const o of [...(previous ?? []), ...(incoming ?? [])]) byKey.set(observationKey(o), o);
  return [...byKey.values()].slice(-MAX_OBSERVATIONS);
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
  const byAtsIdentity = new Map<string, number>();

  function index(job: JobPosting, idx: number): void {
    if (job.atsIdentity) byAtsIdentity.set(job.atsIdentity, idx);
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
    if (job.atsIdentity && byAtsIdentity.get(job.atsIdentity) === idx) byAtsIdentity.delete(job.atsIdentity);
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

    // Two postings with different stable ATS identities are different requisitions, full stop:
    // they may share a title, a location and even a boilerplate description. The looser
    // tiers below can only ever *join* postings when no such identity contradicts the match.
    const candidateIdx =
      (incomingJob.atsIdentity ? byAtsIdentity.get(incomingJob.atsIdentity) : undefined) ??
      byUrl.get(urlKey) ??
      (reqKey ? byReq.get(reqKey) : undefined) ??
      (hasUsableTitle(incomingJob.title) ? byCompanyTitleLoc.get(ctlKey) : undefined) ??
      (hasFingerprintableDescription(incomingJob.descriptionText)
        ? byFingerprint.get(fpKey)
        : undefined);

    const identityConflict =
      candidateIdx !== undefined &&
      !!incomingJob.atsIdentity &&
      !!result[candidateIdx]!.atsIdentity &&
      result[candidateIdx]!.atsIdentity !== incomingJob.atsIdentity;
    const matchIdx = identityConflict ? undefined : candidateIdx;

    if (matchIdx !== undefined) {
      const original = result[matchIdx]!;
      deindex(original, matchIdx);
      
      const mergedDiscoveredFrom = Array.from(
        new Set([
          ...(original.discoveredFrom || [original.source]),
          ...(incomingJob.discoveredFrom || [incomingJob.source]),
        ])
      );

      const mergedProfiles = Array.from(
        new Set([...(original.matchedProfiles || []), ...(incomingJob.matchedProfiles || [])])
      );

      const merged: JobPosting = {
        ...incomingJob,
        id: original.id,
        discoveredAt: original.discoveredAt,
        lastSeenAt: now,
        discoveredFrom: mergedDiscoveredFrom,
        matchedProfiles: mergedProfiles,
        sourceObservations: mergeObservations(original.sourceObservations, incomingJob.sourceObservations),
      };
      result[matchIdx] = merged;
      index(merged, matchIdx);
    } else {
      const fresh: JobPosting = {
        ...incomingJob,
        discoveredAt: now,
        lastSeenAt: now,
        discoveredFrom: incomingJob.discoveredFrom || [incomingJob.source],
      };
      result.push(fresh);
      index(fresh, result.length - 1);
    }
  }

  return result;
}


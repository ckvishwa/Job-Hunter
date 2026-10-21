import { createHash } from "node:crypto";
import type { JobPosting } from "../../adapters/types.js";
import type { PersistItem } from "../../db/jobs-repo.js";

const IDENTITY = /^(greenhouse|lever):([a-z0-9._-]+):([a-z0-9._-]+)$/;

/** PostgreSQL jobs are keyed as greenhouse or lever identities. Other sources stay in the evidence files. */
export function toPersistItem(job: JobPosting, observedAt: string): PersistItem | null {
  const match = job.atsIdentity?.match(IDENTITY);
  if (!match || !job.jdContentHash || !job.descriptionText || !job.canonicalUrl) return null;
  const ats = match[1] as "greenhouse" | "lever";
  return {
    atsIdentity: job.atsIdentity!,
    company: job.company,
    ats,
    board: match[2]!,
    requisitionId: match[3]!,
    title: job.title,
    location: job.location,
    department: job.department,
    employmentType: job.employmentType,
    postingDate: job.postingDate,
    canonicalUrl: job.canonicalUrl,
    descriptionText: job.descriptionText,
    jdSha256: job.jdContentHash,
    observation: {
      observedUrl: job.canonicalUrl,
      finalUrl: job.canonicalUrl,
      sourceKind: "m51d1-live",
      extractionMethod: "ats-api",
      verification: { hostKind: "ats-board", ats, board: match[2], roleFilter: "none" },
      matchedRoles: ["BROAD_DISCOVERY"],
      matchedPhrases: [],
      locationStatus: "UNKNOWN",
      bandStatus: "UNSTATED",
      statedYears: null,
      yearsQuote: null,
      senioritySignal: "UNSPECIFIED",
      observedAt,
    },
  };
}

export function jdSha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

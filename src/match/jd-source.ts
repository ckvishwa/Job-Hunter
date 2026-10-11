import type { Pool } from "pg";
import type { JobPosting } from "../adapters/types.js";
import { computeJdContentHash } from "../domain/canonical-job.js";
import { loadJobs } from "../storage/job-store.js";

// Where S4A reads official JDs from. Both sources are STORED data (no network): the canonical JSONL job store and the S3 PostgreSQL revisions.
// A JD is usable only when its text still matches its recorded content hash.

export class JdSourceError extends Error {
  constructor(readonly code: "NOT_RESOLVED" | "HASH_MISMATCH" | "NOT_FOUND", message: string) {
    super(message);
    this.name = "JdSourceError";
  }
}

/** Resolved canonical postings whose stored text still hashes to their recorded hash. Others are reported, not returned. */
export function loadStoredJobs(file: string): JobPosting[] {
  const jobs = loadJobs(file);
  return jobs.filter((j) => j.resolutionStatus === "resolved" && !!j.jdContentHash && computeJdContentHash(j.descriptionText) === j.jdContentHash);
}

/** `selector`: an index, a job id, or text found in exactly one title/company. */
export function pickJob(jobs: JobPosting[], selector: string | undefined): JobPosting | null {
  if (jobs.length === 0) return null;
  if (selector === undefined) return jobs.length === 1 ? jobs[0]! : null;
  if (/^\d+$/.test(selector) && jobs[Number(selector)]) return jobs[Number(selector)]!;
  const byId = jobs.filter((j) => j.id === selector);
  if (byId.length === 1) return byId[0]!;
  const text = selector.toLowerCase();
  const hits = jobs.filter((j) => `${j.company} ${j.title}`.toLowerCase().includes(text));
  return hits.length === 1 ? hits[0]! : null;
}

/** The user-scoped S3 job (JobsRepo.getJob) as the posting the pipeline reads: the CURRENT stored revision, hash re-verified. */
export function postingFromStoredJob(job: NonNullable<Awaited<ReturnType<import("../db/jobs-repo.js").JobsRepo["getJob"]>>>): JobPosting {
  const rev = job.currentRevision;
  if (!rev) throw new JdSourceError("NOT_FOUND", "The job has no stored JD revision.");
  if (computeJdContentHash(rev.descriptionText) !== rev.jdSha256) throw new JdSourceError("HASH_MISMATCH", "The stored JD text does not match its recorded hash.");
  return {
    id: job.jobId, source: "s3-postgres", sourceType: "ats", company: job.company, title: job.title, location: job.location ?? "", remoteType: null, employmentType: job.employmentType,
    department: job.department, requisitionId: job.requisitionId, postingDate: job.postingDate, discoveredAt: job.firstSeenAt ?? "", lastSeenAt: job.lastSeenAt ?? "", canonicalUrl: job.officialUrl,
    applyUrl: null, descriptionText: rev.descriptionText, descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: [], discoveredFrom: "s3", discoveredUrl: job.officialUrl,
    matchedKeywords: [], relevanceReason: "", rawMetadata: {}, schemaVersion: 1, jdContentHash: rev.jdSha256, extractedAt: rev.firstSeenAt ?? "", resolutionStatus: "resolved", sourceObservations: [],
    atsIdentity: job.atsIdentity,
  } as unknown as JobPosting;
}

/** An S3 PostgreSQL job revision as a posting the pipeline can read. */
export async function loadPgJob(pool: Pool, atsIdentity: string): Promise<JobPosting> {
  const { rows } = await pool.query(
    `SELECT j.id, j.ats_identity, j.company, j.title, j.location, j.employment_type, j.canonical_url, j.requisition_id, r.description_text, r.jd_sha256
       FROM jobs j JOIN job_revisions r ON r.id = j.current_revision_id WHERE j.ats_identity = $1`, [atsIdentity]);
  const r = rows[0];
  if (!r) throw new JdSourceError("NOT_FOUND", "No such stored job.");
  if (computeJdContentHash(r.description_text) !== r.jd_sha256) throw new JdSourceError("HASH_MISMATCH", "The stored JD text does not match its recorded hash.");
  return {
    id: r.id, source: "s3-postgres", sourceType: "ats", company: r.company, title: r.title, location: r.location ?? "", remoteType: null, employmentType: r.employment_type ?? null,
    department: null, requisitionId: r.requisition_id, postingDate: null, discoveredAt: "", lastSeenAt: "", canonicalUrl: r.canonical_url, applyUrl: null, descriptionText: r.description_text,
    descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: [], discoveredFrom: "s3", discoveredUrl: r.canonical_url, matchedKeywords: [], relevanceReason: "",
    rawMetadata: {}, schemaVersion: 1, jdContentHash: r.jd_sha256, extractedAt: "", resolutionStatus: "resolved", sourceObservations: [], atsIdentity: r.ats_identity,
  } as unknown as JobPosting;
}

import { createHash } from "node:crypto";
import { z } from "zod";
import { computeJdContentHash } from "../domain/canonical-job.js";
import { stripHtmlWithStructure } from "../extraction/jd-cleaner.js";
import type { JobPosting } from "../adapters/types.js";

// Re-verifies, against the employer's public Greenhouse board API, that a saved posting is still live and is the
// same job (id and title), and rebuilds its JD from the current official content. A changed JD gets a new content
// hash, which invalidates every approval bound to the old hash (see readiness.ts). Read-only: one GET.

const officialSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  absolute_url: z.string().url(),
  location: z.object({ name: z.string() }).partial().optional(),
  updated_at: z.string().optional(),
  content: z.string().min(1),
});
export type GreenhouseOfficialJob = z.infer<typeof officialSchema>;

export interface OfficialFetch {
  official: GreenhouseOfficialJob;
  /** sha256 of the exact response body, kept as evidence that the verification used this payload. */
  responseSha256: string;
  fetchedAt: string;
  apiUrl: string;
}

export type OfficialJobErrorCode = "POSTING_CLOSED" | "OFFICIAL_FETCH_FAILED" | "OFFICIAL_RESPONSE_INVALID" | "IDENTITY_MISMATCH";

export class OfficialJobError extends Error {
  constructor(readonly code: OfficialJobErrorCode, message: string) {
    super(message);
    this.name = "OfficialJobError";
  }
}

const BOARD_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** "greenhouse:<board>:<jobId>" to its parts; anything else is not a supported official source. */
export function parseGreenhouseIdentity(atsIdentity: string | null | undefined): { board: string; jobId: number } {
  const m = /^greenhouse:([^:]+):(\d+)$/.exec(atsIdentity ?? "");
  if (!m || !BOARD_RE.test(m[1]!)) throw new OfficialJobError("IDENTITY_MISMATCH", "The saved job is not a Greenhouse identity this module can verify.");
  return { board: m[1]!, jobId: Number(m[2]) };
}

export async function fetchGreenhouseJob(board: string, jobId: number, options: { fetchImpl?: typeof fetch; now?: () => string; timeoutMs?: number } = {}): Promise<OfficialFetch> {
  if (!BOARD_RE.test(board)) throw new OfficialJobError("IDENTITY_MISMATCH", "Board token is not a plain token.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${jobId}?content=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(apiUrl, { headers: { Accept: "application/json" }, signal: controller.signal });
    body = await response.text();
  } catch (error) {
    throw new OfficialJobError("OFFICIAL_FETCH_FAILED", `Official board API request failed (${error instanceof Error ? error.name : "error"}).`);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) throw new OfficialJobError("POSTING_CLOSED", "The official board no longer lists this job (HTTP 404).");
  if (response.status !== 200) throw new OfficialJobError("OFFICIAL_FETCH_FAILED", `Official board API answered HTTP ${response.status}.`);
  let parsed: GreenhouseOfficialJob;
  try {
    parsed = officialSchema.parse(JSON.parse(body));
  } catch {
    throw new OfficialJobError("OFFICIAL_RESPONSE_INVALID", "Official board API returned an unexpected payload.");
  }
  if (parsed.id !== jobId) throw new OfficialJobError("IDENTITY_MISMATCH", "Official payload carries a different job id.");
  return { official: parsed, responseSha256: createHash("sha256").update(body).digest("hex"), fetchedAt: (options.now ?? (() => new Date().toISOString()))(), apiUrl };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface RefreshedJob {
  job: JobPosting;
  /** True when the current official JD differs from the stored one (a new content revision). */
  jdChanged: boolean;
  previousJdHash: string | null;
  evidence: { apiUrl: string; responseSha256: string; fetchedAt: string; officialUpdatedAt: string | null; officialUrl: string };
}

/** Rebuilds the saved job from the live official payload. Throws on any identity disagreement; never guesses. */
export function refreshJobFromOfficial(saved: JobPosting, fetched: OfficialFetch): RefreshedJob {
  const { jobId } = parseGreenhouseIdentity(saved.atsIdentity);
  if (fetched.official.id !== jobId) throw new OfficialJobError("IDENTITY_MISMATCH", "Official job id does not match the saved ATS identity.");
  if (norm(fetched.official.title) !== norm(saved.title)) throw new OfficialJobError("IDENTITY_MISMATCH", "Official title differs from the saved title; treat as a different posting and rediscover.");
  const descriptionText = stripHtmlWithStructure(fetched.official.content);
  if (descriptionText.trim().length < 400) throw new OfficialJobError("OFFICIAL_RESPONSE_INVALID", "Official JD text is too short to be a complete description.");
  const jdContentHash = computeJdContentHash(descriptionText);
  const jdChanged = jdContentHash !== (saved.jdContentHash ?? null);
  const job: JobPosting = {
    ...saved,
    descriptionText,
    descriptionHtml: fetched.official.content,
    jdContentHash,
    extractedAt: fetched.fetchedAt,
    lastSeenAt: fetched.fetchedAt,
    sourceObservations: [
      ...(saved.sourceObservations ?? []),
      { sourceKind: "board-api", observedUrl: fetched.apiUrl, finalUrl: fetched.official.absolute_url, observedAt: fetched.fetchedAt, extractionMethod: "ats-api" },
    ],
  };
  return {
    job,
    jdChanged,
    previousJdHash: saved.jdContentHash ?? null,
    evidence: { apiUrl: fetched.apiUrl, responseSha256: fetched.responseSha256, fetchedAt: fetched.fetchedAt, officialUpdatedAt: fetched.official.updated_at ?? null, officialUrl: fetched.official.absolute_url },
  };
}

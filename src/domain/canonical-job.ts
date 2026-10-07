import { createHash } from "node:crypto";
import { z } from "zod";
import type { JobPosting, SourceObservation } from "../adapters/types.js";
import type { CompanyRegistryEntry } from "../config/schema.js";
import { UNRESOLVED_PLACEHOLDER_PREFIX } from "../discovery/resolve-phase.js";

// V1 Slice 1: the canonical-job gate. A JobPosting only reaches data/jobs.jsonl through
// this module's checks -- official employer identity, a real (non-placeholder) JD, and the
// additive canonical fields (schema version, JD hash, extraction time, resolution status,
// source observations). Everything here is pure: no I/O, no browser, no network.

export const CANONICAL_SCHEMA_VERSION = 1;

// A JD shorter than this (after tag stripping + whitespace collapse) is treated as an
// incomplete extraction, not a posting. Proposed budget, not a market truth: real postings
// observed on Greenhouse/Lever boards are thousands of characters; the floor only has to
// separate "a real description" from nav text, error pages and one-line stubs.
export const MIN_JD_CHARS = 200;
export const MIN_JD_WORDS = 30;

export type ExtractionMethod = SourceObservation["extractionMethod"];

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

export type JobFailureCategory = "POSTING_UNRESOLVED" | "JD_EXTRACTION_FAILED" | "DISCOVERY_FAILED";

export type JobFailureCode =
  // POSTING_UNRESOLVED
  | "INVALID_URL"
  | "UNVERIFIED_EMPLOYER"
  | "EMPLOYER_MISMATCH"
  | "UNOFFICIAL_HOST"
  | "BOARD_MISMATCH"
  | "JOB_ID_MISSING"
  | "JOB_ID_MISMATCH"
  | "RESOLUTION_TIMEOUT"
  | "RESOLUTION_ERROR"
  | "UNSTAMPED_POSTING"
  // DISCOVERY_FAILED (visible-browser search flow)
  | "SEARCH_CONTROL_NOT_FOUND"
  | "SEARCH_NO_RESPONSE"
  | "NAVIGATION_FAILED"
  // JD_EXTRACTION_FAILED
  | "EMPTY_DESCRIPTION"
  | "PLACEHOLDER_DESCRIPTION"
  | "DESCRIPTION_TOO_SHORT"
  | "SCHEMA_INVALID";

const CATEGORY_BY_CODE: Record<JobFailureCode, JobFailureCategory> = {
  INVALID_URL: "POSTING_UNRESOLVED",
  UNVERIFIED_EMPLOYER: "POSTING_UNRESOLVED",
  EMPLOYER_MISMATCH: "POSTING_UNRESOLVED",
  UNOFFICIAL_HOST: "POSTING_UNRESOLVED",
  BOARD_MISMATCH: "POSTING_UNRESOLVED",
  JOB_ID_MISSING: "POSTING_UNRESOLVED",
  JOB_ID_MISMATCH: "POSTING_UNRESOLVED",
  RESOLUTION_TIMEOUT: "POSTING_UNRESOLVED",
  RESOLUTION_ERROR: "POSTING_UNRESOLVED",
  UNSTAMPED_POSTING: "POSTING_UNRESOLVED",
  SEARCH_CONTROL_NOT_FOUND: "DISCOVERY_FAILED",
  SEARCH_NO_RESPONSE: "DISCOVERY_FAILED",
  NAVIGATION_FAILED: "DISCOVERY_FAILED",
  EMPTY_DESCRIPTION: "JD_EXTRACTION_FAILED",
  PLACEHOLDER_DESCRIPTION: "JD_EXTRACTION_FAILED",
  DESCRIPTION_TOO_SHORT: "JD_EXTRACTION_FAILED",
  SCHEMA_INVALID: "JD_EXTRACTION_FAILED",
};

// Only failures that depend on transient conditions are worth retrying later; a wrong
// employer or an empty page is a verdict about that URL, not about this attempt.
const RETRYABLE_CODES = new Set<JobFailureCode>([
  "RESOLUTION_TIMEOUT",
  "RESOLUTION_ERROR",
  "DESCRIPTION_TOO_SHORT",
  "SEARCH_NO_RESPONSE",
  "NAVIGATION_FAILED",
]);

export interface ResolutionFailure {
  code: JobFailureCode;
  detail: string;
}

export interface JobFailure {
  schemaVersion: number;
  category: JobFailureCategory;
  code: JobFailureCode;
  stage: "resolution" | "persistence" | "search";
  runId: string;
  targetUrl: string;
  company: string;
  title: string;
  sourceJobId: string | null;
  retryable: boolean;
  // Short, safe diagnostic: never a JD body, never page HTML, never credentials.
  detail: string;
  at: string;
}

const MAX_DETAIL_CHARS = 300;

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.slice(0, 200);
  }
}

export function buildJobFailure(input: {
  code: JobFailureCode;
  stage: JobFailure["stage"];
  runId: string;
  targetUrl: string;
  company: string;
  title: string;
  sourceJobId: string | null;
  detail: string;
  at?: string;
}): JobFailure {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    category: CATEGORY_BY_CODE[input.code],
    code: input.code,
    stage: input.stage,
    runId: input.runId,
    targetUrl: safeUrl(input.targetUrl),
    company: input.company,
    title: input.title,
    sourceJobId: input.sourceJobId,
    retryable: RETRYABLE_CODES.has(input.code),
    detail: input.detail.replace(/\s+/g, " ").slice(0, MAX_DETAIL_CHARS),
    at: input.at ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// JD hash and quality
// ---------------------------------------------------------------------------

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** SHA-256 of the whitespace-normalized JD text. Case is preserved: it detects content change. */
export function computeJdContentHash(descriptionText: string): string {
  return createHash("sha256").update(collapseWhitespace(descriptionText)).digest("hex");
}

export function assessJobDescription(descriptionText: string): ResolutionFailure | null {
  const text = collapseWhitespace(descriptionText ?? "");
  if (text.length === 0) {
    return { code: "EMPTY_DESCRIPTION", detail: "Extracted job description is empty." };
  }
  if (text.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX) || /full description not extracted/i.test(text)) {
    return { code: "PLACEHOLDER_DESCRIPTION", detail: "Description is a resolver placeholder, not extracted JD text." };
  }
  const words = text.split(" ").length;
  if (text.length < MIN_JD_CHARS || words < MIN_JD_WORDS) {
    return {
      code: "DESCRIPTION_TOO_SHORT",
      detail: `Description has ${text.length} chars / ${words} words; minimum is ${MIN_JD_CHARS} chars / ${MIN_JD_WORDS} words.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Official posting identity (parsed URLs + registry board relationship)
// ---------------------------------------------------------------------------

const GREENHOUSE_HOSTS = new Set([
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "boards.eu.greenhouse.io",
  "job-boards.eu.greenhouse.io",
]);
const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);

export interface ParsedAtsUrl {
  ats: "greenhouse" | "lever";
  host: string;
  board: string | null;
  jobId: string | null;
}

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

/** Parses a Greenhouse/Lever hosted-board URL by exact host. Returns null for any other host. */
export function parseAtsPostingUrl(url: string): ParsedAtsUrl | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (GREENHOUSE_HOSTS.has(host)) {
    const board = segments[0] ?? null;
    const pathId = segments[1] === "jobs" && /^\d+$/.test(segments[2] ?? "") ? segments[2]! : null;
    const queryId = parsed.searchParams.get("gh_jid");
    return { ats: "greenhouse", host, board, jobId: pathId ?? (queryId && /^\d+$/.test(queryId) ? queryId : null) };
  }
  if (LEVER_HOSTS.has(host)) {
    return { ats: "lever", host, board: segments[0] ?? null, jobId: segments[1] ?? null };
  }
  return null;
}

/** Greenhouse job id on a company-hosted page (e.g. stripe.com/jobs/search?gh_jid=123). */
export function extractGreenhouseJidParam(url: string): string | null {
  const parsed = parseHttpUrl(url);
  const jid = parsed?.searchParams.get("gh_jid");
  return jid && /^\d+$/.test(jid) ? jid : null;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export interface OfficialPostingVerdict {
  ok: boolean;
  failure?: ResolutionFailure;
  // "greenhouse:figma:5829751004" -- stable across host changes, redirects and tracking params.
  atsIdentity: string | null;
  hostKind?: "ats-board" | "company-domain";
}

/**
 * Decides whether `finalUrl` is the official posting of the employer the registry says this
 * company is. A URL that merely *contains* a company domain proves nothing: the host must
 * match exactly (or be a subdomain), or be the hosted ATS board whose slug the registry ties
 * to this company.
 */
export function verifyOfficialPosting(input: {
  finalUrl: string;
  discoveredCompany: string;
  registryEntry: CompanyRegistryEntry | null;
  apiJobId?: string | null;
  /**
   * A Greenhouse job id that the CALLER has confirmed against the employer's registered board (the id
   * exists there and its listing URL belongs to the employer). Only then may a company-hosted URL that
   * has no `gh_jid` parameter receive an ATS identity. A bare number in a URL never does.
   */
  confirmedGreenhouseJobId?: string | null;
}): OfficialPostingVerdict {
  const fail = (code: JobFailureCode, detail: string): OfficialPostingVerdict => ({
    ok: false,
    failure: { code, detail },
    atsIdentity: null,
  });

  const parsed = parseHttpUrl(input.finalUrl);
  if (!parsed) return fail("INVALID_URL", "Final posting URL is not a valid http(s) URL.");

  const entry = input.registryEntry;
  if (!entry) {
    return fail("UNVERIFIED_EMPLOYER", `No registry employer matches host "${parsed.hostname}"; employer not verified.`);
  }
  if (normalizeName(entry.company) !== normalizeName(input.discoveredCompany)) {
    return fail(
      "EMPLOYER_MISMATCH",
      `Listing employer "${input.discoveredCompany}" differs from resolved registry employer "${entry.company}".`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  const ats = parseAtsPostingUrl(input.finalUrl);
  let hostKind: "ats-board" | "company-domain";
  let board: string | null = null;
  let jobId: string | null = null;

  if (ats) {
    if (entry.atsType !== ats.ats || !entry.atsTenantOrBoardId || ats.board?.toLowerCase() !== entry.atsTenantOrBoardId.toLowerCase()) {
      return fail(
        "BOARD_MISMATCH",
        `ATS board "${ats.board ?? "(none)"}" on ${host} is not the registry board for ${entry.company} (${entry.atsType}:${entry.atsTenantOrBoardId ?? "(none)"}).`,
      );
    }
    hostKind = "ats-board";
    board = ats.board;
    jobId = ats.jobId;
  } else if (entry.corporateDomain && hostMatchesDomain(host, entry.corporateDomain)) {
    hostKind = "company-domain";
    if (entry.atsType === "greenhouse" && entry.atsTenantOrBoardId) {
      board = entry.atsTenantOrBoardId;
      jobId = extractGreenhouseJidParam(input.finalUrl) ?? input.confirmedGreenhouseJobId ?? null;
    }
  } else if (entry.atsType === "workday" && entry.atsWorkdayHostname && host === entry.atsWorkdayHostname.toLowerCase()) {
    hostKind = "ats-board";
  } else {
    return fail("UNOFFICIAL_HOST", `Host "${host}" is not an official host for ${entry.company}.`);
  }

  const identityKind = entry.atsType === "greenhouse" || entry.atsType === "lever" ? entry.atsType : null;
  if (identityKind && board) {
    if (!jobId) {
      return fail("JOB_ID_MISSING", "Resolved URL does not identify a specific job (board page or expired posting).");
    }
    if (input.apiJobId && String(input.apiJobId).toLowerCase() !== jobId.toLowerCase()) {
      return fail("JOB_ID_MISMATCH", `ATS returned job id "${input.apiJobId}" but the URL identifies "${jobId}".`);
    }
    return { ok: true, atsIdentity: `${identityKind}:${board.toLowerCase()}:${jobId.toLowerCase()}`, hostKind };
  }
  return { ok: true, atsIdentity: null, hostKind };
}

/** Stable 16-hex job id from an ATS identity, so a host/query change never changes identity. */
export function jobIdFromAtsIdentity(atsIdentity: string): string {
  return createHash("sha256").update(atsIdentity).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Stamping a resolved posting
// ---------------------------------------------------------------------------

export function stampResolution(
  posting: JobPosting,
  input: {
    sourceKind: string;
    observedUrl: string;
    observedAt: string;
    finalUrl: string;
    extractionMethod: ExtractionMethod;
    discoveredCompany: string;
    registryEntry: CompanyRegistryEntry | null;
    apiJobId?: string | null;
    confirmedGreenhouseJobId?: string | null;
    now: string;
  },
): JobPosting {
  const verdict = verifyOfficialPosting({
    finalUrl: input.finalUrl,
    discoveredCompany: input.discoveredCompany,
    registryEntry: input.registryEntry,
    apiJobId: input.apiJobId,
    confirmedGreenhouseJobId: input.confirmedGreenhouseJobId,
  });
  const failure = verdict.ok ? assessJobDescription(posting.descriptionText) : verdict.failure!;

  const observation: SourceObservation = {
    sourceKind: input.sourceKind,
    observedUrl: input.observedUrl,
    finalUrl: input.finalUrl,
    observedAt: input.observedAt,
    extractionMethod: input.extractionMethod,
  };

  const stamped: JobPosting = {
    ...posting,
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    jdContentHash: computeJdContentHash(posting.descriptionText),
    extractedAt: input.now,
    resolutionStatus: failure ? "unresolved" : "resolved",
    sourceObservations: [observation],
  };
  if (verdict.atsIdentity) {
    stamped.atsIdentity = verdict.atsIdentity;
    stamped.id = jobIdFromAtsIdentity(verdict.atsIdentity);
  }
  if (failure) stamped.resolutionFailure = failure;
  return stamped;
}

// ---------------------------------------------------------------------------
// Persistence gate (runtime schema)
// ---------------------------------------------------------------------------

const httpUrl = z
  .string()
  .url()
  .refine((value) => parseHttpUrl(value) !== null, { message: "must be http(s)" });

export const sourceObservationSchema = z.object({
  sourceKind: z.string().min(1),
  observedUrl: httpUrl,
  finalUrl: httpUrl,
  observedAt: z.string().datetime(),
  extractionMethod: z.enum(["ats-api", "browser-dom"]),
});

export const canonicalJobSchema = z
  .object({
    schemaVersion: z.literal(CANONICAL_SCHEMA_VERSION),
    id: z.string().regex(/^[0-9a-f]{16}$/),
    source: z.string().min(1),
    company: z.string().trim().min(1),
    title: z.string().trim().min(1),
    canonicalUrl: httpUrl,
    applyUrl: httpUrl,
    descriptionText: z.string().refine((text) => assessJobDescription(text) === null, {
      message: "description is empty, a placeholder, or too short",
    }),
    jdContentHash: z.string().regex(/^[0-9a-f]{64}$/),
    extractedAt: z.string().datetime(),
    resolutionStatus: z.literal("resolved"),
    sourceObservations: z.array(sourceObservationSchema).min(1),
    atsIdentity: z.string().min(1).optional(),
  })
  .passthrough();

export type PersistGateResult = { ok: true; posting: JobPosting } | { ok: false; failure: ResolutionFailure };

/** The only door into data/jobs.jsonl for discovery output. */
export function evaluatePersistable(posting: JobPosting): PersistGateResult {
  if (posting.resolutionStatus === undefined) {
    return { ok: false, failure: { code: "UNSTAMPED_POSTING", detail: "Posting has no resolution status; refusing to persist." } };
  }
  if (posting.resolutionStatus !== "resolved") {
    const failure = (posting.resolutionFailure as ResolutionFailure | undefined) ?? { code: "RESOLUTION_ERROR" as const, detail: "Posting was not resolved." };
    return { ok: false, failure };
  }
  const result = canonicalJobSchema.safeParse(posting);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return {
      ok: false,
      failure: { code: "SCHEMA_INVALID", detail: `${issue.path.join(".") || "(root)"}: ${issue.message}` },
    };
  }
  // resolutionFailure is a transient diagnostic and never belongs on a persisted record.
  const { resolutionFailure: _discarded, ...persisted } = posting;
  return { ok: true, posting: persisted };
}

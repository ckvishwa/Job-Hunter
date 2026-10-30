import { classifyLocation, type LocationVerdict } from "../../pipeline/discovery/location.js";
import type { BoardFailureKind } from "./boards.js";

export type Ats = "greenhouse" | "lever" | "ashby" | "workday" | "icims";
export const ALL_ATS: readonly Ats[] = ["greenhouse", "lever", "ashby", "workday", "icims"];

export interface BoardOutcome {
  company: string;
  ats: Ats;
  board: string;
  ownership: "CONFIRMED" | "UNCONFIRMED";
  failure: { kind: BoardFailureKind; detail: string } | null;
  listings: number;
  /** Listings whose title passed the QA/SDET gate and were stored as canonical jobs. */
  qaCandidates: number;
  canonicalJobs: number;
  fullJds: number;
  urlsVerified: number;
}

export interface AtsCoverage {
  companiesAttempted: number;
  boardsValidated: number;
  boardsUnavailable: number;
  listingsReturned: number;
  canonicalJobs: number;
  fullJdsValidated: number;
  urlsVerified: number;
  qaCandidates: number;
  zeroOpenings: number;
  errors: Array<{ company: string; kind: BoardFailureKind; detail: string }>;
}

export function summarizeCoverage(outcomes: readonly BoardOutcome[]): Record<Ats, AtsCoverage> {
  const out = Object.fromEntries(ALL_ATS.map((a) => [a, { companiesAttempted: 0, boardsValidated: 0, boardsUnavailable: 0, listingsReturned: 0, canonicalJobs: 0,
    fullJdsValidated: 0, urlsVerified: 0, qaCandidates: 0, zeroOpenings: 0, errors: [] } satisfies AtsCoverage])) as unknown as Record<Ats, AtsCoverage>;
  for (const o of outcomes) {
    const c = out[o.ats];
    c.companiesAttempted += 1;
    if (o.failure) {
      c.boardsUnavailable += 1;
      c.errors.push({ company: o.company, kind: o.failure.kind, detail: o.failure.detail });
      continue;
    }
    c.boardsValidated += 1;
    if (o.listings === 0) c.zeroOpenings += 1;
    c.listingsReturned += o.listings;
    c.qaCandidates += o.qaCandidates;
    c.canonicalJobs += o.canonicalJobs;
    c.fullJdsValidated += o.fullJds;
    c.urlsVerified += o.urlsVerified;
  }
  return out;
}

export type Decision = "PASS" | "FAIL" | "NEEDS_VERIFICATION";

export interface EvaluatedJob {
  company: string;
  title: string;
  location: string | null;
  ats: string;
  requisitionId: string;
  url: string;
  sourceStatus: string;
  eligibility: Decision;
  extractionStatus: string;
  score: number | null;
  relevanceScore: number;
  /** Posting URL answered 2xx/3xx on a direct fetch. */
  urlVerified: boolean;
}

export type DiagnosticReason = "EXTRACTION_FAILED" | "NON_US_LOCATION" | "FAIL_ELIGIBILITY" | "URL_NOT_VERIFIED" | "SENIOR_LEADERSHIP_TITLE";

export interface Partitioned<T extends EvaluatedJob> {
  actionable: T[];
  diagnostic: Array<{ job: T; reasons: DiagnosticReason[] }>;
}

/** Staff/principal/leadership titles are outside the junior QA/SDET target; kept as diagnostics, not recommendations. */
const LEADERSHIP = /\b(staff|principal|director|manager|head of|vp|vice president)\b/i;
const SENIOR = /\b(senior|sr\.?|lead)\b/i;

const ORDER: Record<Decision, number> = { PASS: 0, NEEDS_VERIFICATION: 1, FAIL: 2 };

export function locationVerdict(job: Pick<EvaluatedJob, "location">): LocationVerdict {
  return classifyLocation(job.location);
}

/** Actionable = verified URL, complete extraction, not non-US, not FAIL. Everything else is diagnostic, never padded in. */
export function partitionShortlist<T extends EvaluatedJob>(jobs: readonly T[], max: number): Partitioned<T> {
  const actionable: T[] = [];
  const diagnostic: Partitioned<T>["diagnostic"] = [];
  for (const job of jobs) {
    const reasons: DiagnosticReason[] = [];
    if (job.extractionStatus !== "COMPLETE") reasons.push("EXTRACTION_FAILED");
    if (locationVerdict(job) === "NON_US") reasons.push("NON_US_LOCATION");
    if (job.eligibility === "FAIL") reasons.push("FAIL_ELIGIBILITY");
    if (!job.urlVerified) reasons.push("URL_NOT_VERIFIED");
    if (LEADERSHIP.test(job.title)) reasons.push("SENIOR_LEADERSHIP_TITLE");
    if (reasons.length) diagnostic.push({ job, reasons }); else actionable.push(job);
  }
  actionable.sort((a, b) => ORDER[a.eligibility] - ORDER[b.eligibility] || Number(SENIOR.test(a.title)) - Number(SENIOR.test(b.title)) || (b.score ?? -1) - (a.score ?? -1) || b.relevanceScore - a.relevanceScore
    || a.company.localeCompare(b.company) || a.title.localeCompare(b.title) || a.requisitionId.localeCompare(b.requisitionId));
  return { actionable: actionable.slice(0, Math.max(0, max)), diagnostic };
}

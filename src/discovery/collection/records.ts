import { assessJobDescription } from "../../domain/canonical-job.js";
import type { JobPosting } from "../../adapters/types.js";

export const JD_SAMPLE_LIMIT = 8;

export interface ObservedRecord {
  employerId: string;
  employerName: string;
  requisitionId: string | null;
  title: string | null;
  location: string | null;
  sourceUrl: string;
  postedAt: string | null;
  postingDatePrecision: "exact" | "approximate" | "unknown";
  descriptionText: string | null;
  recordClass: "live";
  resolutionStatus: "pending" | "resolved" | "rejected";
  atsType: string | null;
}

export interface EmployerCounters {
  employerId: string;
  displayName: string;
  searchAttempted: boolean;
  careerSiteReachable: boolean;
  atsIdentityVerified: boolean;
  atsType: string | null;
  careersUrl: string | null;
  finalUrl: string | null;
  listingsObserved: number;
  uniqueListings: number;
  jobsPersisted: number;
  fullJdsRetrieved: number;
  validOfficialUrls: number;
  knownPostingDates: number;
  unknownPostingDates: number;
  elapsedMs: number;
  truncated: boolean;
  status: "VERIFIED" | "UNSUPPORTED" | "NOT_FOUND" | "ACCESS_RESTRICTED" | "TRANSIENT_FAILURE" | "IDENTITY_MISMATCH";
  reason: string;
  failures: string[];
}

export interface SourceError {
  employerId: string | null;
  stage: string;
  url: string | null;
  message: string;
  at: string;
}

export function dedupeListings(records: readonly ObservedRecord[]): ObservedRecord[] {
  const byKey = new Map<string, ObservedRecord>();
  for (const record of records) {
    const key = record.requisitionId
      ? `${record.employerId}::${record.atsType ?? "site"}::${record.requisitionId}`
      : `${record.employerId}::url::${record.sourceUrl}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, record);
      continue;
    }
    if (!prev.descriptionText && record.descriptionText) byKey.set(key, record);
  }
  return [...byKey.values()];
}

/** A failed refresh must not erase a description that was already stored for the same URL. */
export function mergeObserved(existing: readonly ObservedRecord[], incoming: readonly ObservedRecord[]): ObservedRecord[] {
  const byUrl = new Map(existing.map((record) => [record.sourceUrl, record]));
  for (const record of incoming) {
    const prev = byUrl.get(record.sourceUrl);
    if (!prev) {
      byUrl.set(record.sourceUrl, record);
      continue;
    }
    if (record.resolutionStatus === "rejected" && prev.descriptionText) continue;
    if (!record.descriptionText && prev.descriptionText) {
      byUrl.set(record.sourceUrl, { ...record, descriptionText: prev.descriptionText, resolutionStatus: prev.resolutionStatus === "resolved" ? "resolved" : record.resolutionStatus });
      continue;
    }
    byUrl.set(record.sourceUrl, record);
  }
  return [...byUrl.values()];
}

export function mergeCanonical(current: readonly JobPosting[], incoming: readonly JobPosting[]): JobPosting[] {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const job of incoming) {
    const prev = byId.get(job.id);
    if (!prev) {
      byId.set(job.id, job);
      continue;
    }
    const prevOk = assessJobDescription(prev.descriptionText) === null;
    const nextOk = assessJobDescription(job.descriptionText) === null;
    if ((prev.descriptionText?.length ?? 0) > 0 && !job.descriptionText) continue;
    if (prevOk && !nextOk) continue;
    byId.set(job.id, { ...job, discoveredAt: prev.discoveredAt });
  }
  return [...byId.values()];
}

export function countDates(records: readonly ObservedRecord[]): { known: number; unknown: number } {
  let known = 0;
  let unknown = 0;
  for (const record of records) {
    if (record.postingDatePrecision === "unknown" || !record.postedAt) unknown += 1;
    else known += 1;
  }
  return { known, unknown };
}

function csvCell(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export function toReviewCsv(records: readonly ObservedRecord[]): string {
  const header = ["employer", "title", "location", "sourceUrl", "postedAt", "postingDatePrecision", "requisitionId", "resolutionStatus", "descriptionChars"];
  const lines = [header.join(",")];
  for (const record of records) {
    lines.push([
      record.employerName,
      record.title ?? "",
      record.location ?? "",
      record.sourceUrl,
      record.postedAt ?? "",
      record.postingDatePrecision,
      record.requisitionId ?? "",
      record.resolutionStatus,
      String(record.descriptionText?.length ?? 0),
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

export function renderAuditHtml(input: { generatedAt: string; employers: readonly EmployerCounters[]; jobs: readonly ObservedRecord[] }): string {
  const rows = input.jobs.map((job) => {
    const url = escapeHtml(job.sourceUrl);
    return `<tr><td>${escapeHtml(job.employerName)}</td><td>${escapeHtml(job.title ?? "")}</td><td>${escapeHtml(job.location ?? "")}</td><td>${escapeHtml(job.postingDatePrecision)}</td><td>${escapeHtml(job.resolutionStatus)}</td><td><a href="${url}">${url}</a></td></tr>`;
  }).join("\n");
  const summary = input.employers.map((row) => `<li>${escapeHtml(row.displayName)}: ${escapeHtml(row.status)}, listings ${row.listingsObserved}, persisted ${row.jobsPersisted}, full JDs ${row.fullJdsRetrieved}. ${escapeHtml(row.reason)}</li>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>M5.1-D.1 job audit</title>
<style>body{font-family:Georgia,serif;margin:24px;color:#1c1917} table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #d6d3d1;text-align:left;padding:6px 8px;vertical-align:top} a{color:#1d4ed8}</style>
</head><body>
<h1>M5.1-D.1 live collection</h1>
<p>Generated ${escapeHtml(input.generatedAt)}. Each row keeps the original source URL.</p>
<ul>${summary}</ul>
<table><thead><tr><th>Employer</th><th>Title</th><th>Location</th><th>Date</th><th>Status</th><th>Source URL</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>
`;
}

export function normalizeEmployerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function employersOutsideWatchlist(names: readonly string[], watchlist: readonly { displayName: string; aliases?: string[] }[]): string[] {
  const known = new Set<string>();
  for (const row of watchlist) {
    known.add(normalizeEmployerName(row.displayName));
    for (const alias of row.aliases ?? []) known.add(normalizeEmployerName(alias));
  }
  const outside: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = normalizeEmployerName(name);
    if (!key || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    outside.push(name);
  }
  return outside;
}

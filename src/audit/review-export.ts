import { createHash } from "node:crypto";

export type RecordClass = "live_fetch_today" | "cached_listing" | "synthetic_fixture" | "diagnostic_read" | "closed_posting" | "duplicate";

export interface ReviewJob {
  jobId: string;
  recordClass: RecordClass;
  employer: string;
  title: string;
  team: string | null;
  location: string | null;
  pay: string | null;
  searchSource: string | null;
  sourceObservationUrl: string | null;
  officialUrl: string | null;
  applyUrl: string | null;
  discoveredAt: string | null;
  lastSeenAt: string | null;
  lastVerifiedAt: string | null;
  postedAt: string | null;
  postedAtEvidence: string | null;
  jdText: string | null;
  jdSha256: string | null;
  duplicateOf: string | null;
  screeningOutcome: string | null;
  screeningReason: string | null;
  storeLocation: string;
}

const SAFE_URL = /^https?:\/\/[^\s]+$/i;

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!SAFE_URL.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Maps a stored object onto a review row.
 * discoveredAt is never copied into postedAt. A posting date is kept only when the record
 * already has its own posting field.
 */
export function reviewJobFromStored(raw: Record<string, unknown>, storeLocation: string, recordClass: RecordClass): ReviewJob {
  const discoveredAt = text(raw.discoveredAt) ?? text(raw.firstSeenAt) ?? text(raw.first_seen_at) ?? text(raw.observedAt);
  const explicitPosted = text(raw.postedAt) ?? text(raw.postingDate) ?? text(raw.posting_date) ?? text(raw.employerPostedAt);
  const postedEvidence = text(raw.postedAtEvidence) ?? (explicitPosted ? "stored-posting-field" : null);
  const jdText = text(raw.descriptionText) ?? text(raw.description) ?? text(raw.originalText) ?? text(raw.jdText) ?? text(raw.content);
  const employer = text(raw.company) ?? text(raw.employer) ?? text(raw.companyName) ?? "unknown";
  const externalId = text(raw.sourceJobId) ?? text(raw.externalId) ?? text(raw.id) ?? text(raw.requisitionId);
  const officialUrl = safeHttpUrl(raw.officialUrl) ?? safeHttpUrl(raw.canonicalUrl) ?? safeHttpUrl(raw.canonical_url) ?? safeHttpUrl(raw.url) ?? safeHttpUrl(raw.resultUrl) ?? safeHttpUrl(raw.sourceUrl);
  const jobId = text(raw.jobId) ?? externalId ?? sha256(`${employer}|${text(raw.title) ?? ""}|${officialUrl ?? ""}`).slice(0, 16);
  return {
    jobId,
    recordClass,
    employer,
    title: text(raw.title) ?? "(untitled)",
    team: text(raw.team) ?? text(raw.department),
    location: text(raw.location),
    pay: text(raw.pay) ?? text(raw.salary) ?? text(raw.salarySnippet),
    searchSource: text(raw.source) ?? text(raw.searchSource) ?? text(raw.ats),
    sourceObservationUrl: safeHttpUrl(raw.sourceObservationUrl) ?? safeHttpUrl(raw.resultUrl) ?? safeHttpUrl(raw.sourceUrl) ?? officialUrl,
    officialUrl,
    applyUrl: safeHttpUrl(raw.applyUrl) ?? safeHttpUrl(raw.applicationUrl) ?? officialUrl,
    discoveredAt,
    lastSeenAt: text(raw.lastSeenAt) ?? text(raw.last_seen_at) ?? discoveredAt,
    lastVerifiedAt: text(raw.lastVerifiedAt) ?? text(raw.observedAt),
    postedAt: explicitPosted,
    postedAtEvidence: explicitPosted ? postedEvidence : null,
    jdText,
    jdSha256: text(raw.jdSha256) ?? text(raw.textSha256) ?? text(raw.jd_sha256) ?? (jdText ? sha256(jdText) : null),
    duplicateOf: null,
    screeningOutcome: text(raw.screeningOutcome) ?? text(raw.decision),
    screeningReason: text(raw.screeningReason) ?? text(raw.relevanceReason),
    storeLocation,
  };
}

export function linkDuplicates(jobs: ReviewJob[]): ReviewJob[] {
  const seen = new Map<string, string>();
  return jobs.map((job) => {
    const key = `${job.employer.toLowerCase()}|${job.jobId}`;
    const parent = seen.get(key);
    if (parent && parent !== job.storeLocation) {
      return { ...job, recordClass: "duplicate" as const, duplicateOf: parent };
    }
    seen.set(key, job.storeLocation);
    return job;
  });
}

export function paginate<T>(items: readonly T[], page: number, pageSize: number): { page: number; pages: number; items: T[] } {
  const size = Math.max(1, pageSize);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  return { page: current, pages, items: items.slice(start, start + size) };
}

function csvCell(value: string | null): string {
  const textValue = value ?? "";
  if (/[",\n]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

export function reviewCsv(jobs: readonly ReviewJob[]): string {
  const headers = [
    "jobId", "recordClass", "employer", "title", "team", "location", "pay", "searchSource",
    "sourceObservationUrl", "officialUrl", "applyUrl", "discoveredAt", "lastSeenAt", "lastVerifiedAt",
    "postedAt", "postedAtEvidence", "jdSha256", "duplicateOf", "screeningOutcome", "screeningReason", "storeLocation",
  ];
  const lines = [headers.join(",")];
  for (const job of jobs) {
    lines.push(headers.map((header) => csvCell(job[header as keyof ReviewJob] as string | null)).join(","));
  }
  return lines.join("\n") + "\n";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function link(url: string | null, label: string): string {
  const safe = safeHttpUrl(url);
  if (!safe) return "";
  return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

export function reviewHtml(jobs: readonly ReviewJob[]): string {
  const rows = jobs.map((job, index) => {
    const jd = job.jdText ? `<details><summary>JD</summary><pre>${escapeHtml(job.jdText)}</pre></details>` : "";
    return `<tr data-index="${index}" data-employer="${escapeHtml(job.employer)}" data-title="${escapeHtml(job.title)}" data-hash="${escapeHtml(job.jdSha256 ?? "")}" data-source="${escapeHtml(job.searchSource ?? "")}">
      <td>${escapeHtml(job.jobId)}</td>
      <td>${escapeHtml(job.recordClass)}</td>
      <td>${escapeHtml(job.employer)}</td>
      <td>${escapeHtml(job.title)}</td>
      <td>${escapeHtml(job.location ?? "")}</td>
      <td>${escapeHtml(job.pay ?? "")}</td>
      <td>${escapeHtml(job.postedAt ?? "unknown")}</td>
      <td>${link(job.officialUrl, "official")} ${link(job.sourceObservationUrl, "source")} ${link(job.applyUrl, "apply")}</td>
      <td>${escapeHtml(job.screeningOutcome ?? "")}</td>
      <td>
        <select class="label">
          <option value="">unlabeled</option>
          <option>RELEVANT</option>
          <option>ADJACENT</option>
          <option>IRRELEVANT</option>
          <option>UNSURE</option>
        </select>
        <input class="reason" placeholder="optional reason" />
      </td>
      <td>${jd}</td>
    </tr>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Job Hunter review</title>
<style>
body { font-family: Georgia, serif; margin: 1.5rem; color: #1c1917; background: #faf7f2; }
table { border-collapse: collapse; width: 100%; background: white; }
th, td { border-bottom: 1px solid #e7e5e4; padding: 0.4rem; vertical-align: top; font-size: 0.92rem; }
input, select, button { font: inherit; }
.toolbar { display: flex; gap: 0.75rem; align-items: center; margin-bottom: 1rem; }
</style>
</head>
<body>
<h1>Stored jobs</h1>
<p>${jobs.length} rows. Posting dates stay unknown when the stored record has no posting-date evidence. Labels download as JSONL and are not treated as training truth until you save them.</p>
<div class="toolbar">
  <input id="q" placeholder="Search employer, title, id" />
  <button id="prev" type="button">Previous</button>
  <span id="page"></span>
  <button id="next" type="button">Next</button>
  <button id="export" type="button">Download labels</button>
</div>
<table>
<thead><tr><th>ID</th><th>Class</th><th>Employer</th><th>Title</th><th>Location</th><th>Pay</th><th>Posted</th><th>Links</th><th>Screening</th><th>Label</th><th>JD</th></tr></thead>
<tbody id="body">${rows}</tbody>
</table>
<script>
const pageSize = 25;
const all = Array.from(document.querySelectorAll("#body tr"));
let page = 1;
let filtered = all;
function render() {
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  page = Math.min(page, pages);
  all.forEach((row) => { row.hidden = true; });
  filtered.slice((page - 1) * pageSize, page * pageSize).forEach((row) => { row.hidden = false; });
  document.getElementById("page").textContent = page + " / " + pages;
}
document.getElementById("q").addEventListener("input", (event) => {
  const q = event.target.value.toLowerCase();
  filtered = all.filter((row) => row.innerText.toLowerCase().includes(q));
  page = 1;
  render();
});
document.getElementById("prev").addEventListener("click", () => { page -= 1; render(); });
document.getElementById("next").addEventListener("click", () => { page += 1; render(); });
document.getElementById("export").addEventListener("click", () => {
  const lines = all.flatMap((row) => {
    const label = row.querySelector(".label").value;
    if (!label) return [];
    return [JSON.stringify({
      jobId: row.children[0].textContent,
      label,
      reason: row.querySelector(".reason").value || null,
      jdSha256: row.dataset.hash || null,
      employer: row.dataset.employer,
      title: row.dataset.title,
      searchSource: row.dataset.source || null,
      reviewer: "owner",
      labeledAt: new Date().toISOString(),
    })];
  });
  const blob = new Blob([lines.join("\\n") + (lines.length ? "\\n" : "")], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "labels-human.jsonl";
  a.click();
});
render();
</script>
</body>
</html>
`;
}

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AuditJob {
  jobId: string;
  store: "legacy-jsonl" | "postgres" | "provenance" | "diagnostic";
  storeLocation: string;
  title: string;
  employer: string | null;
  location: string | null;
  salary: string | null;
  sourcePortal: string | null;
  ats: string | null;
  resultUrl: string | null;
  officialUrl: string | null;
  applicationUrl: string | null;
  searchKeyword: string | null;
  searchLocation: string | null;
  searchSource: string | null;
  searchRunId: string | null;
  postingDate: string | null;
  postingDateStatus: "exact" | "unknown";
  sourceDateText: string | null;
  recordFirstDiscoveredAt: string | null;
  recordLastSeenAt: string | null;
  recordLastVerifiedAt: string | null;
  resolutionState: string | null;
  verificationErrors: string[];
  descriptionText: string | null;
  descriptionRef: string | null;
  jdSha256: string | null;
  duplicateOf: string | null;
  sourceObservations: unknown[];
  relevanceDecision: string | null;
  matchingDecision: string | null;
  score: number | null;
  evidence: string | null;
  selection: "selected" | "filtered" | "rejected" | "unknown";
  selectionReason: string;
}

export interface AuditBundle {
  generatedAt: string;
  historicalGap: string;
  counts: { legacyJsonl: number; postgres: number; provenance: number; diagnostic: number; exported: number };
  jobs: AuditJob[];
}

const HISTORICAL_GAP = "Listings rejected by the relevance filter before this change were counted and not stored. This export does not reconstruct them. Record age is discoveredAt/lastSeenAt. A source date string is kept as sourceDateText and is not treated as an exact posting date unless the source explicitly verified one.";

export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function sha256Text(text: string | null): string | null {
  if (!text) return null;
  return createHash("sha256").update(text).digest("hex");
}

function text(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function duplicateKey(job: Pick<AuditJob, "officialUrl" | "employer" | "title" | "location">): string {
  const url = job.officialUrl?.trim().toLowerCase();
  if (url) return `url:${url}`;
  return `text:${(job.employer ?? "").toLowerCase()}|${job.title.toLowerCase()}|${(job.location ?? "").toLowerCase()}`;
}

export function linkDuplicates(jobs: AuditJob[]): AuditJob[] {
  const first = new Map<string, string>();
  return jobs.map((job) => {
    const key = duplicateKey(job);
    const prior = first.get(key);
    if (!prior) {
      first.set(key, job.jobId);
      return { ...job, duplicateOf: null };
    }
    return { ...job, duplicateOf: prior };
  });
}

export function auditFromLegacy(raw: Record<string, unknown>, storeLocation: string): AuditJob {
  const description = text(raw.descriptionText);
  const id = text(raw.id) ?? sha256Text(`${text(raw.canonicalUrl) ?? ""}|${text(raw.title) ?? ""}`)!;
  return {
    jobId: id,
    store: "legacy-jsonl",
    storeLocation,
    title: text(raw.title) ?? "(untitled)",
    employer: text(raw.company),
    location: text(raw.location),
    salary: text(raw.salaryText),
    sourcePortal: text(raw.source),
    ats: text(raw.sourceType),
    resultUrl: text(raw.discoveredUrl) ?? text(raw.canonicalUrl),
    officialUrl: text(raw.canonicalUrl),
    applicationUrl: text(raw.applyUrl),
    searchKeyword: null,
    searchLocation: null,
    searchSource: text(raw.source),
    searchRunId: null,
    postingDate: null,
    postingDateStatus: "unknown",
    sourceDateText: text(raw.postingDate),
    recordFirstDiscoveredAt: text(raw.discoveredAt),
    recordLastSeenAt: text(raw.lastSeenAt),
    recordLastVerifiedAt: null,
    resolutionState: text(raw.resolutionStatus),
    verificationErrors: [],
    descriptionText: description,
    descriptionRef: description ? null : "no description stored on the legacy record",
    jdSha256: sha256Text(description),
    duplicateOf: null,
    sourceObservations: Array.isArray(raw.sourceObservations) ? raw.sourceObservations : [],
    relevanceDecision: Array.isArray(raw.matchedProfiles) ? raw.matchedProfiles.join(", ") : null,
    matchingDecision: null,
    score: null,
    evidence: text(raw.relevanceReason),
    selection: "selected",
    selectionReason: "Present in the legacy jobs store. Earlier relevance rejections were not persisted.",
  };
}

export function auditFromProvenance(raw: Record<string, unknown>, storeLocation: string): AuditJob {
  const description = text(raw.descriptionText);
  const complete = raw.descriptionComplete === true;
  return {
    jobId: `provenance:${text(raw.searchRunId) ?? "run"}:${text(raw.externalId) ?? sha256Text(`${text(raw.resultUrl) ?? ""}|${text(raw.title) ?? ""}`)}`,
    store: "provenance",
    storeLocation,
    title: text(raw.title) ?? "(untitled)",
    employer: text(raw.employer),
    location: text(raw.location),
    salary: text(raw.salary),
    sourcePortal: text(raw.source),
    ats: text(raw.source),
    resultUrl: text(raw.resultUrl),
    officialUrl: text(raw.officialUrl),
    applicationUrl: text(raw.applicationUrl),
    searchKeyword: text(raw.keyword),
    searchLocation: text(raw.searchLocation),
    searchSource: text(raw.source),
    searchRunId: text(raw.searchRunId),
    postingDate: null,
    postingDateStatus: "unknown",
    sourceDateText: text(raw.sourceDateText),
    recordFirstDiscoveredAt: text(raw.capturedAt),
    recordLastSeenAt: text(raw.capturedAt),
    recordLastVerifiedAt: null,
    resolutionState: raw.disposition === "filtered" ? "filtered-before-candidate-store" : "retained-for-candidate-store",
    verificationErrors: [],
    descriptionText: description,
    descriptionRef: complete ? null : "listing snippet only; the full description was not available when this listing was captured",
    jdSha256: sha256Text(description),
    duplicateOf: null,
    sourceObservations: [],
    relevanceDecision: text(raw.relevanceReason),
    matchingDecision: null,
    score: null,
    evidence: text(raw.filterReason) ?? text(raw.relevanceReason),
    selection: raw.disposition === "filtered" ? "filtered" : raw.disposition === "retained" ? "selected" : "unknown",
    selectionReason: text(raw.filterReason) ?? "Retained for the candidate store.",
  };
}

export function auditFromPostgres(raw: Record<string, unknown>, storeLocation: string): AuditJob {
  const description = text(raw.description_text);
  const observed = Number(raw.observations ?? 0) > 0;
  return {
    jobId: text(raw.id) ?? text(raw.ats_identity) ?? "postgres-job",
    store: "postgres",
    storeLocation,
    title: text(raw.title) ?? "(untitled)",
    employer: text(raw.company),
    location: text(raw.location),
    salary: null,
    sourcePortal: text(raw.ats),
    ats: text(raw.ats),
    resultUrl: text(raw.canonical_url),
    officialUrl: text(raw.canonical_url),
    applicationUrl: null,
    searchKeyword: null,
    searchLocation: null,
    searchSource: text(raw.ats),
    searchRunId: null,
    postingDate: null,
    postingDateStatus: "unknown",
    sourceDateText: text(raw.posting_date),
    recordFirstDiscoveredAt: text(raw.first_seen_at),
    recordLastSeenAt: text(raw.last_seen_at),
    recordLastVerifiedAt: null,
    resolutionState: description ? "revision-stored" : "no-current-revision",
    verificationErrors: [],
    descriptionText: description,
    descriptionRef: text(raw.jd_sha256),
    jdSha256: text(raw.jd_sha256) ?? sha256Text(description),
    duplicateOf: null,
    sourceObservations: [],
    relevanceDecision: null,
    matchingDecision: text(raw.decision),
    score: typeof raw.score === "number" ? raw.score : null,
    evidence: null,
    selection: observed ? "selected" : "unknown",
    selectionReason: observed ? "Observed in a candidate discovery run." : "Stored without a candidate observation.",
  };
}

export function auditFromDiagnostic(raw: Record<string, unknown>, storeLocation: string): AuditJob {
  const description = text(raw.originalText);
  return {
    jobId: `diagnostic:${text(raw.board) ?? "board"}:${text(raw.id) ?? sha256Text(text(raw.sourceUrl) ?? description ?? "diagnostic")}`,
    store: "diagnostic",
    storeLocation,
    title: text(raw.title) ?? "(untitled)",
    employer: text(raw.board),
    location: text(raw.location),
    salary: null,
    sourcePortal: "lever",
    ats: "lever",
    resultUrl: text(raw.sourceUrl),
    officialUrl: text(raw.sourceUrl),
    applicationUrl: null,
    searchKeyword: text(raw.role),
    searchLocation: null,
    searchSource: "m4-real-posting-diagnostic",
    searchRunId: null,
    postingDate: null,
    postingDateStatus: "unknown",
    sourceDateText: null,
    recordFirstDiscoveredAt: text(raw.observedAt),
    recordLastSeenAt: text(raw.observedAt),
    recordLastVerifiedAt: text(raw.observedAt),
    resolutionState: description ? "diagnostic-text-captured" : "extraction-not-captured",
    verificationErrors: [],
    descriptionText: description,
    descriptionRef: text(raw.textSha256) ? `sha256:${text(raw.textSha256)}` : null,
    jdSha256: text(raw.textSha256) ?? sha256Text(description),
    duplicateOf: null,
    sourceObservations: [],
    relevanceDecision: null,
    matchingDecision: null,
    score: null,
    evidence: "Diagnostic read only. Not an independent human label and not a catalog row.",
    selection: "unknown",
    selectionReason: "Read for the M4 diagnostic. It was not selected or rejected by a candidate search run.",
  };
}

export function buildAudit(input: {
  generatedAt?: string;
  legacy?: Array<{ raw: Record<string, unknown>; storeLocation: string }>;
  postgres?: AuditJob[];
  provenance?: AuditJob[];
  diagnostic?: Array<{ raw: Record<string, unknown>; storeLocation: string }>;
}): AuditBundle {
  const legacy = (input.legacy ?? []).map((row) => auditFromLegacy(row.raw, row.storeLocation));
  const diagnostic = (input.diagnostic ?? []).map((row) => auditFromDiagnostic(row.raw, row.storeLocation));
  const jobs = linkDuplicates([...(input.postgres ?? []), ...legacy, ...(input.provenance ?? []), ...diagnostic]);
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    historicalGap: HISTORICAL_GAP,
    counts: {
      legacyJsonl: legacy.length,
      postgres: (input.postgres ?? []).length,
      provenance: (input.provenance ?? []).length,
      diagnostic: diagnostic.length,
      exported: jobs.length,
    },
    jobs,
  };
}

function csvCell(value: unknown): string {
  const textValue = value == null ? "" : Array.isArray(value) ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

const CSV_COLUMNS: Array<keyof AuditJob> = [
  "jobId", "store", "title", "employer", "location", "salary", "sourcePortal", "ats", "resultUrl", "officialUrl", "applicationUrl",
  "searchKeyword", "searchLocation", "searchSource", "searchRunId", "postingDate", "postingDateStatus", "sourceDateText",
  "recordFirstDiscoveredAt", "recordLastSeenAt", "recordLastVerifiedAt", "resolutionState", "verificationErrors", "descriptionText",
  "descriptionRef", "jdSha256", "duplicateOf", "relevanceDecision", "matchingDecision", "score", "evidence", "selection", "selectionReason",
];

export function auditToCsv(jobs: readonly AuditJob[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const job of jobs) lines.push(CSV_COLUMNS.map((column) => csvCell(job[column])).join(","));
  return lines.join("\n") + "\n";
}

function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function auditToHtml(bundle: AuditBundle): string {
  const data = embedJson(bundle.jobs.map((job) => ({
    ...job,
    resultHref: safeHref(job.resultUrl),
    officialHref: safeHref(job.officialUrl),
    applicationHref: safeHref(job.applicationUrl),
  })));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Job audit</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; margin: 1.5rem; color: #1c1917; background: #fafaf9; }
  h1 { font-size: 1.4rem; margin-bottom: 0.2rem; }
  .meta, .gap { color: #44403c; max-width: 70rem; }
  .controls { display: flex; gap: 0.75rem; align-items: center; margin: 1rem 0; flex-wrap: wrap; }
  input, select, button, textarea { font: inherit; }
  input[type="search"] { min-width: 16rem; padding: 0.35rem 0.5rem; }
  article { background: white; border: 1px solid #e7e5e4; border-radius: 8px; padding: 0.9rem 1rem; margin: 0.7rem 0; }
  h2 { font-size: 1.05rem; margin: 0 0 0.3rem; }
  dl { display: grid; grid-template-columns: 11rem 1fr; gap: 0.15rem 0.6rem; margin: 0.4rem 0; }
  dt { color: #57534e; }
  dd { margin: 0; }
  pre { white-space: pre-wrap; background: #f5f5f4; padding: 0.6rem; max-height: 16rem; overflow: auto; }
  a { color: #1d4ed8; }
  .pager { display: flex; gap: 0.5rem; align-items: center; }
</style>
</head>
<body>
<h1>Job audit</h1>
<p class="meta" id="count"></p>
<p class="gap">${bundle.historicalGap}</p>
<div class="controls">
  <input id="q" type="search" placeholder="Search title, employer, location, id" aria-label="Search jobs">
  <select id="store" aria-label="Store"><option value="">All stores</option><option>legacy-jsonl</option><option>postgres</option><option>provenance</option><option>diagnostic</option></select>
  <select id="selection" aria-label="Selection"><option value="">All decisions</option><option>selected</option><option>filtered</option><option>rejected</option><option>unknown</option></select>
</div>
<div id="list"></div>
<div class="pager"><button id="prev" type="button">Previous</button><span id="page"></span><button id="next" type="button">Next</button>
<button id="download" type="button">Download labels</button></div>
<script type="application/json" id="jobs">${data}</script>
<script>
const jobs = JSON.parse(document.getElementById("jobs").textContent);
const labels = [];
const pageSize = 20;
let page = 0;
const q = document.getElementById("q");
const store = document.getElementById("store");
const selection = document.getElementById("selection");
function filtered() {
  const query = q.value.trim().toLowerCase();
  return jobs.filter((job) => {
    if (store.value && job.store !== store.value) return false;
    if (selection.value && job.selection !== selection.value) return false;
    if (!query) return true;
    return [job.title, job.employer, job.location, job.jobId, job.selectionReason].join("\\n").toLowerCase().includes(query);
  });
}
function link(href, label) {
  if (!href) return document.createTextNode(label || "none");
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label || href;
  a.rel = "noreferrer";
  a.target = "_blank";
  return a;
}
function row(term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value); else dd.textContent = value || "unknown";
  return [dt, dd];
}
function render() {
  const rows = filtered();
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, pages - 1);
  const slice = rows.slice(page * pageSize, page * pageSize + pageSize);
  document.getElementById("count").textContent = rows.length + " of " + jobs.length + " exported jobs. Page size " + pageSize + ". Nothing in this file was truncated.";
  document.getElementById("page").textContent = "Page " + (page + 1) + " of " + pages;
  const list = document.getElementById("list");
  list.replaceChildren();
  for (const job of slice) {
    const article = document.createElement("article");
    const h2 = document.createElement("h2");
    h2.textContent = job.title;
    article.append(h2);
    const dl = document.createElement("dl");
    const fields = [
      ["Job ID", job.jobId],
      ["Employer", job.employer],
      ["Location", job.location],
      ["Salary", job.salary],
      ["Store", job.store],
      ["Source", job.sourcePortal],
      ["ATS", job.ats],
      ["Posting date", job.postingDateStatus === "exact" ? job.postingDate : "unknown"],
      ["Source date text", job.sourceDateText],
      ["First discovered", job.recordFirstDiscoveredAt],
      ["Last seen", job.recordLastSeenAt],
      ["Last verified", job.recordLastVerifiedAt],
      ["Search", [job.searchSource, job.searchKeyword, job.searchLocation, job.searchRunId].filter(Boolean).join(" · ")],
      ["Resolution", job.resolutionState],
      ["Selection", job.selection + " — " + job.selectionReason],
      ["Relevance", job.relevanceDecision],
      ["Matching", job.matchingDecision],
      ["Score", job.score == null ? null : String(job.score)],
      ["Evidence", job.evidence],
      ["Duplicate of", job.duplicateOf],
      ["JD reference", job.descriptionRef || job.jdSha256],
    ];
    for (const [term, value] of fields) dl.append(...row(term, value));
    dl.append(...row("Result URL", link(job.resultHref, job.resultUrl)));
    dl.append(...row("Official URL", link(job.officialHref, job.officialUrl)));
    dl.append(...row("Application URL", link(job.applicationHref, job.applicationUrl)));
    article.append(dl);
    const pre = document.createElement("pre");
    pre.textContent = job.descriptionText || "No job description was stored for this record.";
    article.append(pre);
    const label = document.createElement("select");
    label.setAttribute("aria-label", "Label " + job.title);
    for (const option of ["", "RELEVANT", "ADJACENT", "IRRELEVANT", "UNSURE"]) {
      const el = document.createElement("option");
      el.value = option;
      el.textContent = option || "Label";
      label.append(el);
    }
    const reason = document.createElement("input");
    reason.placeholder = "Reason";
    reason.setAttribute("aria-label", "Reason for " + job.title);
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save label";
    save.addEventListener("click", () => {
      if (!label.value) return;
      labels.push({ jobId: job.jobId, jdSha256: job.jdSha256, queryProvenance: { searchRunId: job.searchRunId, source: job.searchSource, keyword: job.searchKeyword }, label: label.value, reason: reason.value, labeledAt: new Date().toISOString(), labeler: "owner", origin: "human" });
      save.textContent = "Saved";
    });
    article.append(label, reason, save);
    list.append(article);
  }
}
q.addEventListener("input", () => { page = 0; render(); });
store.addEventListener("change", () => { page = 0; render(); });
selection.addEventListener("change", () => { page = 0; render(); });
document.getElementById("prev").addEventListener("click", () => { page = Math.max(0, page - 1); render(); });
document.getElementById("next").addEventListener("click", () => { page += 1; render(); });
document.getElementById("download").addEventListener("click", () => {
  const blob = new Blob([labels.map((label) => JSON.stringify(label)).join("\\n") + (labels.length ? "\\n" : "")], { type: "application/jsonl" });
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

export function writeAuditFiles(directory: string, bundle: AuditBundle): { jsonPath: string; csvPath: string; htmlPath: string } {
  mkdirSync(directory, { recursive: true });
  const jsonPath = path.join(directory, "jobs-full.json");
  const csvPath = path.join(directory, "jobs-review.csv");
  const htmlPath = path.join(directory, "jobs-audit.html");
  writeFileSync(jsonPath, JSON.stringify(bundle, null, 2));
  writeFileSync(csvPath, auditToCsv(bundle.jobs));
  writeFileSync(htmlPath, auditToHtml(bundle));
  return { jsonPath, csvPath, htmlPath };
}

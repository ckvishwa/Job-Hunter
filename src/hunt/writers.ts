import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ReportRow } from "./report-rows.js";

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function writeJsonReport(filePath: string, rows: ReportRow[]): void {
  ensureDir(filePath);
  writeFileSync(filePath, JSON.stringify(rows, null, 2), "utf-8");
}

const CSV_COLUMNS: { header: string; get: (row: ReportRow) => string | number }[] = [
  { header: "rank", get: (r) => r.rank },
  { header: "score", get: (r) => r.score },
  { header: "title", get: (r) => r.title },
  { header: "company", get: (r) => r.company },
  { header: "location", get: (r) => r.location },
  { header: "city", get: (r) => r.city ?? "" },
  { header: "state", get: (r) => r.state ?? "" },
  { header: "country", get: (r) => r.country ?? "" },
  { header: "workArrangement", get: (r) => r.workArrangement },
  { header: "seniority", get: (r) => r.seniority },
  { header: "requiredYearsMin", get: (r) => r.requiredYearsMin ?? "" },
  { header: "requiredYearsMax", get: (r) => r.requiredYearsMax ?? "" },
  { header: "matchedProfile", get: (r) => r.matchedProfile },
  { header: "matchedKeywords", get: (r) => r.matchedKeywords.join("; ") },
  { header: "postingAgeDays", get: (r) => r.postingAgeDays ?? "" },
  { header: "applyUrl", get: (r) => r.applyUrl },
  { header: "source", get: (r) => r.source },
  { header: "eligibilityReasons", get: (r) => r.eligibilityReasons.join("; ") },
  { header: "score_titleRelevance", get: (r) => r.scoreBreakdown.titleRelevance },
  { header: "score_seniorityAlignment", get: (r) => r.scoreBreakdown.seniorityAlignment },
  { header: "score_yearsAlignment", get: (r) => r.scoreBreakdown.yearsAlignment },
  { header: "score_locationAlignment", get: (r) => r.scoreBreakdown.locationAlignment },
  { header: "score_remoteAlignment", get: (r) => r.scoreBreakdown.remoteAlignment },
  { header: "score_jdCompleteness", get: (r) => r.scoreBreakdown.jdCompleteness },
  { header: "score_freshness", get: (r) => r.scoreBreakdown.freshness },
  { header: "score_officialLink", get: (r) => r.scoreBreakdown.officialLink },
  { header: "score_penalties", get: (r) => r.scoreBreakdown.penalties },
  { header: "firstSeenAt", get: (r) => r.firstSeenAt },
  { header: "lastSeenAt", get: (r) => r.lastSeenAt },
  { header: "isNew", get: (r) => String(r.isNew) },
  { header: "isUpdated", get: (r) => String(r.isUpdated) },
  { header: "isStale", get: (r) => String(r.isStale) },
  { header: "unresolved", get: (r) => String(r.unresolved) },
];

function csvField(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function writeCsvReport(filePath: string, rows: ReportRow[]): void {
  ensureDir(filePath);
  const header = CSV_COLUMNS.map((c) => csvField(c.header)).join(",");
  const lines = rows.map((row) => CSV_COLUMNS.map((c) => csvField(c.get(row))).join(","));
  writeFileSync(filePath, [header, ...lines].join("\n") + "\n", "utf-8");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Entity-escaping alone doesn't stop a "javascript:"/"data:" URI from executing when the Apply
// link is clicked -- it only prevents breaking out of the href="..." attribute. applyUrl is
// scraped/resolved third-party data (ultimately from an ATS response), never assumed safe just
// because it's normally an https link. Only http(s) survives; anything else renders as "#".
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

function badgesFor(row: ReportRow): string {
  const badges: string[] = [];
  if (row.isNew) badges.push('<span class="badge badge-new">NEW</span>');
  if (row.isUpdated) badges.push('<span class="badge badge-updated">UPDATED</span>');
  if (row.unresolved) badges.push('<span class="badge badge-unresolved">UNRESOLVED</span>');
  if (row.isStale) badges.push('<span class="badge badge-stale">STALE</span>');
  return badges.join(" ");
}

function renderRow(row: ReportRow): string {
  const title = escapeHtml(row.title);
  const company = escapeHtml(row.company);
  const location = escapeHtml(row.location);
  const applyUrl = escapeHtml(safeHref(row.applyUrl));
  return `<tr data-profile="${escapeHtml(row.matchedProfile)}" data-country="${escapeHtml(row.country ?? "")}" data-seniority="${escapeHtml(row.seniority)}" data-arrangement="${escapeHtml(row.workArrangement)}" data-search="${escapeHtml(`${row.title} ${row.company} ${row.location}`.toLowerCase())}">
<td data-sort="${row.rank}">${row.rank}</td>
<td data-sort="${row.score}">${row.score}</td>
<td>${title} ${badgesFor(row)}</td>
<td>${company}</td>
<td>${location}</td>
<td>${escapeHtml(row.workArrangement)}</td>
<td>${escapeHtml(row.seniority)}</td>
<td data-sort="${row.requiredYearsMin ?? -1}">${row.requiredYearsMin ?? "?"}${row.requiredYearsMax !== null && row.requiredYearsMax !== row.requiredYearsMin ? `-${row.requiredYearsMax}` : ""}</td>
<td>${escapeHtml(row.matchedProfile)}</td>
<td data-sort="${row.postingAgeDays ?? -1}">${row.postingAgeDays ?? "?"}</td>
<td><a href="${applyUrl}" target="_blank" rel="noopener">Apply</a></td>
<td>${escapeHtml(row.source)}</td>
</tr>`;
}

const HTML_STYLE = `
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 1.5rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { border: 1px solid #8884; padding: 0.4rem 0.6rem; text-align: left; }
th { cursor: pointer; position: sticky; top: 0; background: Canvas; }
tr.row-hidden { display: none; }
.controls { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; align-items: center; }
.badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 0.25rem; margin-left: 0.3rem; }
.badge-new { background: #1a7f37; color: white; }
.badge-updated { background: #9a6700; color: white; }
.badge-unresolved { background: #6e7781; color: white; }
.badge-stale { background: #cf222e; color: white; }
`;

const HTML_SCRIPT = `
const searchInput = document.getElementById("search");
const profileFilter = document.getElementById("filter-profile");
const locationFilter = document.getElementById("filter-location");
const seniorityFilter = document.getElementById("filter-seniority");
const arrangementFilter = document.getElementById("filter-arrangement");
const rows = Array.from(document.querySelectorAll("tbody tr"));

function applyFilters() {
  const q = searchInput.value.trim().toLowerCase();
  const profile = profileFilter.value;
  const location = locationFilter.value;
  const seniority = seniorityFilter.value;
  const arrangement = arrangementFilter.value;
  for (const row of rows) {
    const matchesSearch = !q || row.dataset.search.includes(q);
    const matchesProfile = !profile || row.dataset.profile === profile;
    const matchesLocation = !location || row.dataset.country === location;
    const matchesSeniority = !seniority || row.dataset.seniority === seniority;
    const matchesArrangement = !arrangement || row.dataset.arrangement === arrangement;
    row.classList.toggle("row-hidden", !(matchesSearch && matchesProfile && matchesLocation && matchesSeniority && matchesArrangement));
  }
}

searchInput.addEventListener("input", applyFilters);
for (const el of [profileFilter, locationFilter, seniorityFilter, arrangementFilter]) {
  el.addEventListener("change", applyFilters);
}

const tbody = document.querySelector("tbody");
document.querySelectorAll("th[data-col]").forEach((th) => {
  let ascending = true;
  th.addEventListener("click", () => {
    const col = Number(th.dataset.col);
    const sorted = rows.slice().sort((a, b) => {
      const cellA = a.children[col];
      const cellB = b.children[col];
      const av = cellA.dataset.sort !== undefined ? Number(cellA.dataset.sort) : cellA.textContent.trim().toLowerCase();
      const bv = cellB.dataset.sort !== undefined ? Number(cellB.dataset.sort) : cellB.textContent.trim().toLowerCase();
      if (av < bv) return ascending ? -1 : 1;
      if (av > bv) return ascending ? 1 : -1;
      return 0;
    });
    ascending = !ascending;
    for (const row of sorted) tbody.appendChild(row);
  });
});
`;

function uniqueSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ""))].sort();
}

function optionsHtml(values: string[]): string {
  return values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}

export function writeHtmlReport(filePath: string, rows: ReportRow[]): void {
  ensureDir(filePath);
  const profiles = uniqueSorted(rows.map((r) => r.matchedProfile));
  const countries = uniqueSorted(rows.map((r) => r.country));
  const seniorities = uniqueSorted(rows.map((r) => r.seniority));
  const arrangements = uniqueSorted(rows.map((r) => r.workArrangement));

  const headers = [
    "Rank", "Score", "Title", "Company", "Location", "Arrangement",
    "Seniority", "Years", "Profile", "Age (days)", "Apply", "Source",
  ];

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Daily Job Hunt Report</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<h1>Daily Job Hunt Report</h1>
<p>${rows.length} opportunity(ies) &mdash; generated ${new Date().toISOString()}</p>
<div class="controls">
<input id="search" type="search" placeholder="Search title/company/location">
<select id="filter-profile"><option value="">All profiles</option>${optionsHtml(profiles)}</select>
<select id="filter-location"><option value="">All locations</option>${optionsHtml(countries)}</select>
<select id="filter-seniority"><option value="">All seniority</option>${optionsHtml(seniorities)}</select>
<select id="filter-arrangement"><option value="">All arrangements</option>${optionsHtml(arrangements)}</select>
</div>
<table>
<thead>
<tr>${headers.map((h, i) => `<th data-col="${i}">${h}</th>`).join("")}</tr>
</thead>
<tbody>
${rows.map(renderRow).join("\n")}
</tbody>
</table>
<script>${HTML_SCRIPT}</script>
</body>
</html>
`;

  writeFileSync(filePath, html, "utf-8");
}

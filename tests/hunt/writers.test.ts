import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeJsonReport, writeCsvReport, writeHtmlReport } from "../../src/hunt/writers.js";
import type { ReportRow } from "../../src/hunt/report-rows.js";

const TMP_DIR = path.resolve("tests/hunt/.tmp-writers");

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeRow(overrides: Partial<ReportRow> = {}): ReportRow {
  return {
    rank: 1,
    score: 87,
    scoreBreakdown: {
      titleRelevance: 20, seniorityAlignment: 15, yearsAlignment: 10, locationAlignment: 15,
      remoteAlignment: 8, jdCompleteness: 10, freshness: 10, officialLink: 10, penalties: 0, total: 87,
    },
    title: "SDET I",
    company: "Acme",
    location: "Austin, TX",
    city: "Austin",
    state: "TX",
    country: "United States",
    workArrangement: "unknown",
    seniority: "entry-level",
    requiredYearsMin: 1,
    requiredYearsMax: 1,
    matchedProfile: "sdet",
    matchedKeywords: ["SDET"],
    postingAgeDays: 2,
    applyUrl: "https://acme.example/apply/1",
    source: "company-careers",
    eligibilityReasons: ["Description requires 1-1 years experience (within 0-3 year range)"],
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-05T00:00:00.000Z",
    isNew: true,
    isUpdated: false,
    isStale: false,
    unresolved: false,
    ...overrides,
  };
}

describe("writeJsonReport", () => {
  it("writes rows that round-trip via JSON.parse", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.json");
    const rows = [makeRow()];
    writeJsonReport(filePath, rows);
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(parsed).toEqual(rows);
  });
});

describe("writeCsvReport", () => {
  it("writes a header row and one data row per job", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.csv");
    writeCsvReport(filePath, [makeRow(), makeRow({ title: "QA Automation Engineer I" })]);
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("title");
    expect(lines[0]).toContain("score");
  });

  it("quotes a title containing a comma", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.csv");
    writeCsvReport(filePath, [makeRow({ title: "SDET, Automation Team" })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('"SDET, Automation Team"');
  });

  it("escapes an embedded double-quote in a field", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.csv");
    writeCsvReport(filePath, [makeRow({ company: 'Acme "The Best"' })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('"Acme ""The Best"""');
  });
});

describe("writeHtmlReport", () => {
  it("writes a self-contained HTML file with one row per job and an apply link", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.html");
    writeHtmlReport(filePath, [makeRow(), makeRow({ title: "QA Automation Engineer I", rank: 2 })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("SDET I");
    expect(content).toContain("QA Automation Engineer I");
    expect(content).toContain("https://acme.example/apply/1");
    expect((content.match(/<tr/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("marks a new job with the new badge", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.html");
    writeHtmlReport(filePath, [makeRow({ isNew: true })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("badge-new");
  });

  it("marks an updated job with the updated badge", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.html");
    writeHtmlReport(filePath, [makeRow({ isNew: false, isUpdated: true })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("badge-updated");
  });

  it("marks an unresolved job with the unresolved badge", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.html");
    writeHtmlReport(filePath, [makeRow({ unresolved: true })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("badge-unresolved");
  });

  it("marks a stale job with the stale badge", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.html");
    writeHtmlReport(filePath, [makeRow({ isNew: false, isStale: true })]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("badge-stale");
  });

  it("includes a search input, filter selects, and no external network references", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = path.join(TMP_DIR, "latest-jobs.html");
    writeHtmlReport(filePath, [makeRow()]);
    const content = readFileSync(filePath, "utf-8");
    expect(content).toMatch(/<input[^>]*type=["']?search/i);
    expect(content).toContain("<select");
    expect(content).not.toContain("http://cdn");
    expect(content).not.toContain("https://cdn");
  });
});

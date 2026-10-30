import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boardApiUrl, boardListSchema, classifyTitle, runBoardDiscovery } from "../../src/pipeline/discovery/board-discoverer.js";
import { loadJobs } from "../../src/storage/jsonl-store.js";
import { buildTrackerRows } from "../../src/tracker/rows.js";

// Entry words never admit a title on their own: they only mark a title that already matches SECURITY or QA.
const LIST = boardListSchema.parse({
  version: 1,
  tracks: [
    { name: "SECURITY", keywords: ["SOC Analyst", "Security Engineer", "Detection Engineer"] },
    { name: "QA", keywords: ["QA Engineer", "SDET", "Test Automation"] },
  ],
  excludeTitleKeywords: ["Senior", "Manager", "Intern"],
  entrySignalKeywords: ["Associate", "Junior", "Jr", "Entry Level", "Analyst I", "Engineer I", "New Grad"],
  companies: [{ company: "Acme", ats: "greenhouse", board: "acme" }],
});

describe("ENTRY_SIGNAL", () => {
  it("marks entry words on a title that matches SECURITY or QA", () => {
    expect(classifyTitle("Associate SOC Analyst", LIST)).toMatchObject({ track: "SECURITY", entrySignal: ["Associate"] });
    expect(classifyTitle("Junior QA Engineer", LIST)).toMatchObject({ track: "QA", entrySignal: ["Junior"] });
    expect(classifyTitle("Jr. SDET", LIST)).toMatchObject({ track: "QA", entrySignal: ["Jr"] });
    expect(classifyTitle("Security Engineer, New Grad", LIST)).toMatchObject({ track: "SECURITY", entrySignal: ["New Grad"] });
    expect(classifyTitle("Security Engineer I", LIST)).toMatchObject({ track: "SECURITY", entrySignal: ["Engineer I"] });
  });

  it("a title with only an entry word is dropped, and a matching title without one has no signal", () => {
    for (const title of ["Junior Product Designer", "Associate General Counsel", "Software Engineer, New Grad", "Financial Analyst I", "Entry Level Barista"]) {
      expect(classifyTitle(title, LIST)).toMatchObject({ track: null, entrySignal: [] });
    }
    expect(classifyTitle("Detection Engineer", LIST)).toMatchObject({ track: "SECURITY", entrySignal: [] });
  });

  it("exclusions still win over entry words, and SECURITY still wins over QA", () => {
    expect(classifyTitle("Senior Associate SOC Analyst", LIST)).toMatchObject({ track: null });
    expect(classifyTitle("Junior Security Engineer, Test Automation", LIST)).toMatchObject({ track: "SECURITY", entrySignal: ["Junior"] });
  });

  it("is recorded on the saved job and shown in the tracker's Entry signal column", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-entry-"));
    const configPath = path.join(dir, "company-boards.json");
    writeFileSync(configPath, JSON.stringify(LIST));
    const body =
      "We are hiring an analyst to monitor, investigate and respond to security alerts across customer environments and to improve our detection coverage. " +
      "You will work with engineers in an Agile team, document findings, tune rules and report results every week. Experience with SIEM tools is required.";
    const gh = (id: number, title: string) => ({ id, title, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, location: { name: "Remote - US" }, content: `&lt;p&gt;${body}&lt;/p&gt;` });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== boardApiUrl(LIST.companies[0]!)) throw new Error(`unexpected request: ${String(url)}`);
      return new Response(JSON.stringify({ jobs: [gh(1, "Associate SOC Analyst"), gh(2, "SOC Analyst"), gh(3, "Junior Product Designer")] }));
    }) as unknown as typeof fetch;
    const result = await runBoardDiscovery({ configPath, dataDir: dir, fetchImpl, delayMs: 0, now: () => "2026-10-09T12:00:00.000Z" });
    expect(result.companies[0]).toMatchObject({ fetched: 3, matched: 2, saved: 2, byTrack: { SECURITY: 2 } });
    expect(loadJobs(path.join(dir, "jobs.jsonl")).map((j) => j.title).sort()).toEqual(["Associate SOC Analyst", "SOC Analyst"]);
    const out = path.join(dir, "output");
    mkdirSync(out);
    const { rows } = buildTrackerRows({ jobsPath: path.join(dir, "jobs.jsonl"), outputDir: out });
    expect(rows.map((r) => [r.title, r.track, r.entrySignal])).toEqual([["Associate SOC Analyst", "SECURITY", "Associate"], ["SOC Analyst", "SECURITY", ""]]);
  });
});

// Backward compatibility: jobs.jsonl rows written before ENTRY_SIGNAL existed, and rows tagged with the removed
// ENTRY_LEVEL track, must still load and appear in the tracker without errors or silently disappearing.
describe("backward compatibility with rows saved before ENTRY_SIGNAL", () => {
  const base = {
    id: "old-1", source: "boards::acme", sourceType: "company-careers", company: "Acme", title: "QA Engineer", location: "Remote, US", remoteType: null, employmentType: null, department: null,
    requisitionId: "1", postingDate: null, discoveredAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-01T00:00:00.000Z", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/1", descriptionText: "Test the product.", descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: ["sdet"],
    discoveredFrom: ["boards"], schemaVersion: 1, jdContentHash: "a".repeat(64), extractedAt: "2026-10-02T00:00:00.000Z", resolutionStatus: "resolved", atsIdentity: "greenhouse:acme:1", rawMetadata: {},
  };
  function rowsFor(...jobs: Record<string, unknown>[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-entry-compat-"));
    writeFileSync(path.join(dir, "jobs.jsonl"), jobs.map((j) => JSON.stringify(j)).join("\n") + "\n");
    const out = path.join(dir, "output");
    mkdirSync(out);
    return buildTrackerRows({ jobsPath: path.join(dir, "jobs.jsonl"), outputDir: out });
  }

  it("a row without any matchedKeywords has an empty entry signal and keeps its track", () => {
    const { rows, problems } = rowsFor(base);
    expect(problems).toEqual([]);
    expect(rows.map((r) => [r.title, r.track, r.entrySignal, r.state])).toEqual([["QA Engineer", "QA", "", "RESOLVED"]]);
  });

  it("a row tagged only with the removed ENTRY_LEVEL track is still listed, with no track and no crash", () => {
    const { rows, problems } = rowsFor({ ...base, id: "old-2", atsIdentity: "greenhouse:acme:2", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/2", matchedProfiles: ["entry_level"] });
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ company: "Acme", track: "", entrySignal: "", state: "RESOLVED" });
  });

  it("a row with ENTRY_LEVEL plus a real track keeps the real track", () => {
    const { rows } = rowsFor({ ...base, matchedProfiles: ["entry_level", "security"] });
    expect(rows[0]).toMatchObject({ track: "SECURITY", entrySignal: "" });
  });

  it("a board list without entrySignalKeywords still validates and yields no signal", () => {
    const legacy = boardListSchema.parse({ version: 1, tracks: [{ name: "QA", keywords: ["QA Engineer"] }], companies: [{ company: "Acme", ats: "greenhouse", board: "acme" }] });
    expect(legacy.entrySignalKeywords).toBeUndefined();
    expect(classifyTitle("Junior QA Engineer", legacy)).toMatchObject({ track: "QA", entrySignal: [] });
  });

  it("the workbook row has exactly one cell per column", async () => {
    const { rowToCells, TRACKER_COLUMNS } = await import("../../src/tracker/rows.js");
    const { rows } = rowsFor({ ...base, matchedKeywords: ["qa engineer", "entry:Junior"] });
    expect(rows[0]!.entrySignal).toBe("Junior");
    expect(rowToCells(rows[0]!)).toHaveLength(TRACKER_COLUMNS.length);
    expect(TRACKER_COLUMNS[3]).toBe("Entry signal");
  });
});

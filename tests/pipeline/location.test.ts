import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { boardApiUrl, boardListSchema, runBoardDiscovery } from "../../src/pipeline/discovery/board-discoverer.js";
import { classifyLocation, locationFlag } from "../../src/pipeline/discovery/location.js";
import { saveJobs } from "../../src/storage/job-store.js";
import { loadJobs } from "../../src/storage/jsonl-store.js";
import { writeTracker } from "../../src/tracker/cli.js";
import { buildTrackerRows } from "../../src/tracker/rows.js";

// Expected verdicts are hand-assigned from real board location strings, not produced by the classifier.
const CASES: Array<[string | null, string]> = [
  ["Remote - US", "TARGET"],
  ["Remote, United States", "TARGET"],
  ["US Remote", "TARGET"],
  ["Remote (USA)", "TARGET"],
  ["New York, NY", "TARGET"],
  ["New York City", "TARGET"],
  ["Boston, MA", "TARGET"],
  ["Cambridge, MA", "TARGET"],
  ["Hartford, CT", "TARGET"],
  ["Connecticut", "TARGET"],
  ["Remote - Massachusetts", "TARGET"],
  ["San Francisco, CA; New York, NY", "TARGET"], // any acceptable place keeps it
  ["Remote - US/Canada", "TARGET"],
  ["Dublin, Ireland", "NON_US"],
  ["London, UK", "NON_US"],
  ["Toronto, ON, Canada", "NON_US"],
  ["Remote - EMEA", "NON_US"],
  ["Remote - Canada", "NON_US"],
  ["Bengaluru, India", "NON_US"],
  ["Cambridge, UK", "NON_US"],
  ["Tel Aviv; London", "NON_US"],
  ["Austin, TX", "OTHER_US"],
  ["San Francisco, CA", "OTHER_US"],
  ["Washington, DC", "OTHER_US"],
  ["Seattle, Washington", "OTHER_US"],
  ["Remote", "UNKNOWN"],
  ["United States", "UNKNOWN"],
  ["San Francisco", "UNKNOWN"],
  ["Hybrid", "UNKNOWN"],
  ["", "UNKNOWN"],
  [null, "UNKNOWN"],
  ["Remote - North America", "UNKNOWN"],
  ["Social, MA Remote", "TARGET"], // a state code after a comma is a state; "Social" is only a word
];

describe("location classification", () => {
  it.each(CASES)("%s -> %s", (input, expected) => {
    expect(classifyLocation(input)).toBe(expected);
  });

  it("flags only the kept-but-not-clearly-wanted cases", () => {
    expect(locationFlag("Remote - US")).toBe("");
    expect(locationFlag("Remote")).toBe("LOCATION_UNKNOWN");
    expect(locationFlag(null)).toBe("LOCATION_UNKNOWN");
    expect(locationFlag("Austin, TX")).toBe("LOCATION_OTHER_US");
  });
});

const JD =
  "We are hiring a security analyst to monitor, investigate and respond to alerts across customer environments and to improve detection coverage. " +
  "You will work with engineers in an Agile team, document findings, tune rules and report results every week. Experience with SIEM tools is required.";
const board = { company: "Acme", ats: "greenhouse", board: "acme" } as const;
const gh = (id: number, title: string, location: string | undefined) => ({ id, title, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, ...(location === undefined ? {} : { location: { name: location } }), content: `&lt;p&gt;${JD}&lt;/p&gt;` });

async function discover(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-location-"));
  const configPath = path.join(dir, "company-boards.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, tracks: [{ name: "SECURITY", keywords: ["Security Analyst"] }], companies: [board], ...extra }));
  const postings = [gh(1, "Security Analyst", "Remote - US"), gh(2, "Security Analyst", "Dublin, Ireland"), gh(3, "Security Analyst", "Remote"), gh(4, "Security Analyst", "Austin, TX"), gh(5, "Security Analyst", undefined)];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (String(url) !== boardApiUrl(board)) throw new Error(`unexpected request: ${String(url)}`);
    return new Response(JSON.stringify({ jobs: postings }));
  }) as unknown as typeof fetch;
  const result = await runBoardDiscovery({ configPath, dataDir: dir, fetchImpl, delayMs: 0, now: () => "2026-10-09T12:00:00.000Z" });
  return { dir, result };
}

describe("discovery location policy", () => {
  it("drops only clearly non-US postings; unknown, ambiguous and other-US postings are saved", async () => {
    const { dir, result } = await discover();
    expect(result.companies[0]).toMatchObject({ fetched: 5, matched: 4, droppedLocation: 1, saved: 4 });
    expect(loadJobs(path.join(dir, "jobs.jsonl")).map((j) => j.atsIdentity).sort()).toEqual(["greenhouse:acme:1", "greenhouse:acme:3", "greenhouse:acme:4", "greenhouse:acme:5"]);
  });

  it("dropNonUsLocations:false keeps everything", async () => {
    const { result } = await discover({ dropNonUsLocations: false });
    expect(result.companies[0]).toMatchObject({ matched: 5, droppedLocation: 0, saved: 5 });
  });

  it("the tracker shows each kept posting's location and flag", async () => {
    const { dir } = await discover();
    const out = path.join(dir, "output");
    mkdirSync(out);
    const { rows } = buildTrackerRows({ jobsPath: path.join(dir, "jobs.jsonl"), outputDir: out });
    expect(rows.map((r) => [r.location, r.locationFlag]).sort()).toEqual([["", "LOCATION_UNKNOWN"], ["Austin, TX", "LOCATION_OTHER_US"], ["Remote - US", ""], ["Remote", "LOCATION_UNKNOWN"]]);
  });
});

describe("MANUAL_WATCH rows", () => {
  const entry = { company: "Arctic Wolf", ats: "Workday", careersUrl: "https://arcticwolf.wd1.myworkdayjobs.com/External", track: "SECURITY" };

  it("schema accepts watch entries and rejects non-http URLs", () => {
    const base = { version: 1, titleKeywords: ["QA"], companies: [board] };
    expect(boardListSchema.safeParse({ ...base, manualWatch: [entry] }).success).toBe(true);
    expect(boardListSchema.safeParse({ ...base, manualWatch: [{ ...entry, careersUrl: "javascript:alert(1)" }] }).success).toBe(false);
  });

  it("emits MANUAL_WATCH rows with ATS name and URL, sorted with their track, without touching the ledger", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-watch-"));
    const jobsPath = path.join(dir, "jobs.jsonl");
    saveJobs(jobsPath, [{ id: "a", source: "s", sourceType: "greenhouse", company: "Zed", title: "QA Engineer", location: "Remote - US", remoteType: null, employmentType: null, department: null, requisitionId: "1", postingDate: null, discoveredAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-01T00:00:00.000Z", canonicalUrl: "https://boards.greenhouse.io/zed/jobs/1", applyUrl: "https://boards.greenhouse.io/zed/jobs/1", descriptionText: "x", descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: ["qa"], discoveredFrom: ["board-api"], schemaVersion: 1, jdContentHash: "a".repeat(64), extractedAt: "2026-10-02T00:00:00.000Z", resolutionStatus: "resolved", atsIdentity: "greenhouse:zed:1", rawMetadata: {} } as JobPosting]);
    const { rows } = buildTrackerRows({ jobsPath, outputDir: path.join(dir, "output"), watch: [entry], now: "2026-10-09T00:00:00.000Z" });
    expect(rows.map((r) => [r.track, r.company, r.state, r.ats, r.officialUrl])).toEqual([
      ["SECURITY", "Arctic Wolf", "MANUAL_WATCH", "Workday", "https://arcticwolf.wd1.myworkdayjobs.com/External"],
      ["QA", "Zed", "RESOLVED", "greenhouse", "https://boards.greenhouse.io/zed/jobs/1"],
    ]);
    expect(writeTracker({ jobsPath, outputDir: path.join(dir, "output"), out: path.join(dir, "t.xlsx"), watch: [entry] }).rows).toBe(2);
  });
});

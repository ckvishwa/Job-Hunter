import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boardListSchema, classifyTitle, runBoardDiscovery, titleMatches, boardApiUrl } from "../../src/pipeline/discovery/board-discoverer.js";
import { convertCandidateBoardList, runBoardImport } from "../../src/pipeline/discovery/board-list-import.js";
import { candidateTokens, namesMatch, verifyBoards } from "../../src/pipeline/discovery/board-verify.js";
import { loadJobs } from "../../src/storage/jsonl-store.js";

// Shape of the candidate's own file (trimmed): named tracks with priorities, boardToken, notes.
const CANDIDATE_FILE = {
  _note: "guesses",
  titleMatching: {
    mode: "case-insensitive, whole-word",
    tracks: {
      QA: { priority: 2, reviewShare: 0.2, keywords: ["QA Engineer", "SDET", "Test Automation", "Security QA"] },
      SECURITY: { priority: 1, reviewShare: 0.8, keywords: ["SOC Analyst", "SOC", "IDR", "Security Engineer", "Detection Engineer", "Threat Intelligence"] },
    },
    excludeTitleKeywords: ["Senior", "Sr.", "Staff", "Lead", "Manager", "Intern", "Sales"],
    locationKeywords: ["Remote"],
  },
  companies: [{ company: "Acme", ats: "greenhouse", boardToken: "acme", why: "MDR" }],
};

describe("candidate list import (maps to the real schema, schema unchanged)", () => {
  it("orders tracks by priority, maps boardToken to board, and reports unmapped fields", () => {
    const { list, dropped } = convertCandidateBoardList(CANDIDATE_FILE);
    expect(list.tracks!.map((t) => t.name)).toEqual(["SECURITY", "QA"]);
    expect(list.companies).toEqual([{ company: "Acme", ats: "greenhouse", board: "acme" }]);
    expect(list.excludeTitleKeywords).toContain("Sr.");
    expect(dropped).toEqual(["_note", "companies[].why", "titleMatching.locationKeywords", "titleMatching.mode", "tracks.reviewShare"]);
    expect(boardListSchema.safeParse(list).success).toBe(true);
  });

  it("writes a valid config file and refuses a file without companies or tracks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-import-"));
    writeFileSync(path.join(dir, "in.json"), JSON.stringify(CANDIDATE_FILE));
    const lines: string[] = [];
    expect(runBoardImport({ in: path.join(dir, "in.json"), out: path.join(dir, "out.json") }, (l) => lines.push(l))).toBe(0);
    expect(boardListSchema.parse(JSON.parse(readFileSync(path.join(dir, "out.json"), "utf8"))).tracks).toHaveLength(2);
    writeFileSync(path.join(dir, "bad.json"), JSON.stringify({ titleMatching: { tracks: {} }, companies: [] }));
    expect(runBoardImport({ in: path.join(dir, "bad.json"), out: path.join(dir, "bad-out.json") }, () => {})).toBe(2);
  });

  it("schema requires exactly one of titleKeywords or tracks", () => {
    const company = { company: "Acme", ats: "greenhouse", board: "acme" };
    expect(boardListSchema.safeParse({ version: 1, companies: [company] }).success).toBe(false);
    expect(boardListSchema.safeParse({ version: 1, titleKeywords: ["QA"], tracks: [{ name: "QA", keywords: ["QA"] }], companies: [company] }).success).toBe(false);
    expect(boardListSchema.safeParse({ version: 1, tracks: [{ name: "qa", keywords: ["QA"] }], companies: [company] }).success).toBe(false);
  });
});

describe("title classification: exclusions first, then SECURITY, then QA", () => {
  const { list } = convertCandidateBoardList(CANDIDATE_FILE);
  const track = (title: string) => classifyTitle(title, list).track;

  it("matches whole words and phrases only, case-insensitively", () => {
    expect(titleMatches("Social Media Manager", ["SOC"])).toEqual([]);
    expect(titleMatches("Bidr Platform Engineer", ["IDR"])).toEqual([]);
    expect(titleMatches("soc analyst (tier 1)", ["SOC Analyst"])).toEqual(["SOC Analyst"]);
    expect(titleMatches("IDR Analyst", ["idr"])).toEqual(["idr"]);
    expect(titleMatches("Sr. Engineer", ["Sr."])).toEqual(["Sr."]);
    expect(titleMatches("Srinivas Engineer", ["Sr"])).toEqual([]);
    expect(track("Social Media Specialist")).toBeNull();
  });

  it("applies exclusions before any track, even when a track keyword also matches", () => {
    expect(classifyTitle("Senior SOC Analyst", list)).toMatchObject({ track: null, excludedBy: ["Senior"] });
    expect(track("Security Engineer Intern")).toBeNull();
    expect(track("Lead SDET")).toBeNull();
    expect(track("Sales Engineer, Detection")).toBeNull();
  });

  it("assigns SECURITY, QA, or nothing; a title matching both goes to SECURITY", () => {
    expect(track("SOC Analyst I")).toBe("SECURITY");
    expect(track("QA Engineer")).toBe("QA");
    expect(track("Security QA")).toBe("QA");
    expect(track("Security Engineer, Test Automation")).toBe("SECURITY"); // matches both tracks
    expect(track("Detection Engineer / SDET")).toBe("SECURITY");
    expect(track("Account Manager")).toBeNull();
  });
});

const JD_BODY =
  "We are hiring an analyst to monitor, investigate and respond to security alerts across customer environments and to improve our detection coverage. " +
  "You will work with engineers in an Agile team, document findings, tune rules and report results every week. Experience with SIEM tools is required.";
const gh = (id: number, title: string) => ({ id, title, absolute_url: `https://boards.greenhouse.io/acme/jobs/${id}`, location: { name: "Remote" }, content: `&lt;p&gt;${JD_BODY}&lt;/p&gt;` });

describe("discovery with tracks", () => {
  it("records the track on each job, counts per track and exclusions, and keeps excluded titles out of jobs.jsonl", async () => {
    const { list } = convertCandidateBoardList(CANDIDATE_FILE);
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-tracks-"));
    const configPath = path.join(dir, "company-boards.json");
    writeFileSync(configPath, JSON.stringify(list));
    const jobs = [gh(1, "SOC Analyst I"), gh(2, "QA Engineer"), gh(3, "Security Engineer, Test Automation"), gh(4, "Senior SOC Analyst"), gh(5, "Account Manager"), gh(6, "Social Media Intern")];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== boardApiUrl(list.companies[0]!)) throw new Error(`unexpected request: ${String(url)}`);
      return new Response(JSON.stringify({ jobs }));
    }) as unknown as typeof fetch;
    const result = await runBoardDiscovery({ configPath, dataDir: dir, fetchImpl, delayMs: 0, now: () => "2026-10-09T12:00:00.000Z" });
    expect(result.companies[0]).toMatchObject({ fetched: 6, matched: 3, excluded: 3, saved: 3, byTrack: { SECURITY: 2, QA: 1 } });
    const saved = loadJobs(path.join(dir, "jobs.jsonl"));
    expect(saved.map((j) => [j.title, j.matchedProfiles]).sort()).toEqual([
      ["QA Engineer", ["qa"]],
      ["SOC Analyst I", ["security"]],
      ["Security Engineer, Test Automation", ["security"]],
    ]);
  });
});

describe("board token verification", () => {
  const route = (map: Record<string, { status?: number; body: unknown }>) =>
    vi.fn(async (url: string | URL | Request) => {
      const hit = map[String(url)];
      if (!hit) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200 });
    }) as unknown as typeof fetch;
  const gh = (token: string) => `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`;
  const ghName = (token: string) => `https://boards-api.greenhouse.io/v1/boards/${token}`;

  it("classifies working, wrong-organisation, and missing tokens, and offers a verified correction", async () => {
    const fetchImpl = route({
      [gh("arcticwolf")]: { body: { jobs: [{}, {}] } },
      [ghName("arcticwolf")]: { body: { name: "Arctic Wolf Networks" } },
      [gh("expel")]: { body: { jobs: [{}] } },
      [ghName("expel")]: { body: { name: "Totally Different Org" } },
      [gh("sparksoft")]: { status: 404, body: {} },
      [gh("sparksoftcorporation")]: { body: { jobs: [{}, {}, {}] } },
      [ghName("sparksoftcorporation")]: { body: { name: "Sparksoft Corporation" } },
    });
    const results = await verifyBoards(
      [
        { company: "Arctic Wolf", ats: "greenhouse", board: "arcticwolf" },
        { company: "Expel", ats: "greenhouse", board: "expel" },
        { company: "Sparksoft", ats: "greenhouse", board: "sparksoft" },
      ],
      { fetchImpl, delayMs: 0 },
    );
    expect(results.map((r) => [r.company, r.status, r.jobs])).toEqual([["Arctic Wolf", "OK", 2], ["Expel", "NAME_MISMATCH", 1], ["Sparksoft", "NOT_FOUND", null]]);
    expect(results[2]!.correction).toMatchObject({ board: "sparksoftcorporation", jobs: 3, nameMatches: true });
    expect(results[1]!.correction).toBeUndefined(); // no candidate carried the company's own name
  });

  it("name matching and candidate tokens", () => {
    expect(namesMatch("Arctic Wolf", "Arctic Wolf Networks")).toBe(true);
    expect(namesMatch("SentinelOne", "SentinelOne Inc.")).toBe(true);
    expect(namesMatch("Expel", "Totally Different Org")).toBe(false);
    expect(candidateTokens("Red Canary", "redcanary")).toEqual(expect.arrayContaining(["red-canary", "red", "redcanaryinc"]));
    expect(candidateTokens("Red Canary", "redcanary")).not.toContain("redcanary");
  });
});

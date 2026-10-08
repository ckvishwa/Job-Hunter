import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { boardApiUrl, boardListSchema, runBoardDiscovery, titleMatches } from "../../src/pipeline/discovery/board-discoverer.js";
import { parseBoardsArgs, runBoardsCli } from "../../src/pipeline/discovery/boards-cli.js";
import { loadJobFailures, loadJobs } from "../../src/storage/jsonl-store.js";

// Production modules, real temporary storage. The only substituted boundary is the network: a fetch
// stub that serves recorded-shape board payloads and throws on any URL that is not a board API URL,
// so a stray LinkedIn/browser/other request would fail the test.

const JD_BODY =
  "We are hiring a quality engineer to design, build and maintain automated test suites for our web applications and public APIs. " +
  "You will work with developers in an Agile team, review requirements, write test cases, triage defects and report results every sprint. " +
  "Experience with test automation tools and basic programming skills is required for this position.";

const ghJob = (id: number, title: string, boardPath = "acme", content = `<p>${JD_BODY}</p>`) => ({
  id,
  title,
  absolute_url: `https://boards.greenhouse.io/${boardPath}/jobs/${id}`,
  location: { name: "Remote - US" },
  departments: [{ name: "Engineering" }],
  content: content.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  updated_at: "2026-10-01T00:00:00Z",
});

const leverJob = (id: string, text: string) => ({
  id,
  text,
  hostedUrl: `https://jobs.lever.co/globex/${id}`,
  applyUrl: `https://jobs.lever.co/globex/${id}/apply`,
  categories: { location: "Austin, TX", team: "QA", commitment: "Full-time" },
  descriptionPlain: JD_BODY,
  lists: [{ text: "Requirements", content: "<li>Selenium</li><li>API testing</li>" }],
  additionalPlain: "Equal opportunity employer.",
  createdAt: 1790000000000,
});

type Routes = Record<string, { status?: number; body: unknown } | "throw">;

function stubFetch(routes: Routes) {
  return vi.fn(async (url: string | URL | Request) => {
    const key = String(url);
    const route = routes[key];
    if (!route) throw new Error(`unexpected request: ${key}`);
    if (route === "throw") throw new TypeError("network down");
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return new Response(text, { status: route.status ?? 200 });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const GH = { company: "Acme", ats: "greenhouse", board: "acme" } as const;
const LV = { company: "Globex", ats: "lever", board: "globex" } as const;

function setup(companies: unknown[], titleKeywords = ["QA", "SDET"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-boards-"));
  const configPath = path.join(dir, "company-boards.json");
  writeFileSync(configPath, JSON.stringify({ version: 1, titleKeywords, companies }));
  return { dir, configPath, jobsPath: path.join(dir, "jobs.jsonl"), failuresPath: path.join(dir, "job-failures.jsonl") };
}

const opts = (w: ReturnType<typeof setup>, fetchImpl: typeof fetch) => ({ configPath: w.configPath, dataDir: w.dir, fetchImpl, delayMs: 0, now: () => "2026-10-09T12:00:00.000Z" });

describe("board list configuration", () => {
  it("requires title keywords, a plain board token, and unique boards", () => {
    const ok = { version: 1, titleKeywords: ["QA"], companies: [GH] };
    expect(boardListSchema.safeParse(ok).success).toBe(true);
    expect(boardListSchema.safeParse({ ...ok, titleKeywords: [] }).success).toBe(false);
    expect(boardListSchema.safeParse({ ...ok, companies: [{ ...GH, board: "acme/../evil" }] }).success).toBe(false);
    expect(boardListSchema.safeParse({ ...ok, companies: [{ ...GH, board: "https://boards.greenhouse.io/acme" }] }).success).toBe(false);
    expect(boardListSchema.safeParse({ ...ok, companies: [GH, { ...GH, company: "Acme again" }] }).success).toBe(false);
    expect(boardListSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("matches whole title phrases, not substrings", () => {
    expect(titleMatches("Senior QA Engineer", ["QA"])).toEqual(["QA"]);
    expect(titleMatches("SDET II (Remote)", ["sdet"])).toEqual(["sdet"]);
    expect(titleMatches("Aquatics Coordinator", ["QA"])).toEqual([]);
    expect(titleMatches("Account Executive", ["QA", "SDET"])).toEqual([]);
  });

  it("builds only public board API URLs", () => {
    expect(boardApiUrl(GH)).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true");
    expect(boardApiUrl(LV)).toBe("https://api.lever.co/v0/postings/globex?mode=json");
    expect(boardApiUrl({ ...LV, region: "eu" })).toBe("https://api.eu.lever.co/v0/postings/globex?mode=json");
  });
});

describe("board discovery (Greenhouse and Lever public APIs)", () => {
  it("saves title-matching official postings with full JD, distinct requisitions, and makes no other request", async () => {
    const w = setup([GH, LV]);
    const fetchImpl = stubFetch({
      [boardApiUrl(GH)]: { body: { jobs: [ghJob(1, "QA Engineer"), ghJob(2, "QA Engineer"), ghJob(3, "Account Executive"), ghJob(4, "SDET II")] } },
      [boardApiUrl(LV)]: { body: [leverJob("0d7f2b1c-1111-4222-8333-444455556666", "QA Automation Lead"), leverJob("0d7f2b1c-9999-4222-8333-444455556666", "Office Manager")] },
    });
    const result = await runBoardDiscovery(opts(w, fetchImpl));

    expect(fetchImpl.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual([boardApiUrl(GH), boardApiUrl(LV)]);
    expect(result.totals).toMatchObject({ fetched: 6, matched: 4, saved: 4, unchanged: 0, rejected: 0, failedCompanies: 0 });

    const jobs = loadJobs(w.jobsPath);
    expect(jobs.map((j) => j.atsIdentity).sort()).toEqual(["greenhouse:acme:1", "greenhouse:acme:2", "greenhouse:acme:4", "lever:globex:0d7f2b1c-1111-4222-8333-444455556666"]);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(4); // same-title requisitions stay distinct
    for (const job of jobs) {
      expect(job.resolutionStatus).toBe("resolved");
      expect(job.sourceObservations?.[0]).toMatchObject({ sourceKind: "board-api", extractionMethod: "ats-api" });
      expect(job.descriptionText).toContain("automated test suites"); // full JD, entity-decoded
      expect(job.descriptionText).not.toContain("&lt;");
      expect(job.jdContentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const lever = jobs.find((j) => j.atsIdentity?.startsWith("lever:"))!;
    expect(lever.descriptionText).toContain("Requirements: Selenium API testing");
    expect(lever.employmentType).toBe("Full-time");
    expect(existsSync(w.failuresPath)).toBe(false);
  });

  it("repeat run dedupes instead of skipping silently, and a changed JD is saved as a revision of the same job", async () => {
    const w = setup([GH]);
    const routes = (content?: string): Routes => ({ [boardApiUrl(GH)]: { body: { jobs: [ghJob(1, "QA Engineer", "acme", content), ghJob(2, "QA Engineer")] } } });

    expect((await runBoardDiscovery(opts(w, stubFetch(routes())))).totals).toMatchObject({ matched: 2, saved: 2, unchanged: 0 });
    const again = await runBoardDiscovery(opts(w, stubFetch(routes())));
    expect(again.totals).toMatchObject({ fetched: 2, matched: 2, saved: 0, unchanged: 2 });
    expect(loadJobs(w.jobsPath)).toHaveLength(2);

    const before = loadJobs(w.jobsPath).find((j) => j.atsIdentity === "greenhouse:acme:1")!;
    const revised = await runBoardDiscovery(opts(w, stubFetch(routes(`<p>${JD_BODY} The role now also covers performance testing of our public APIs in every release cycle.</p>`))));
    expect(revised.totals).toMatchObject({ saved: 1, unchanged: 1 });
    const after = loadJobs(w.jobsPath);
    expect(after).toHaveLength(2);
    const updated = after.find((j) => j.atsIdentity === "greenhouse:acme:1")!;
    expect(updated.id).toBe(before.id); // identity is the requisition, not the content
    expect(updated.jdContentHash).not.toBe(before.jdContentHash); // the hash detects the revision
  });

  it("rejects a posting whose URL belongs to a different board, and a placeholder or too-short JD, with typed failures", async () => {
    const w = setup([GH]);
    const fetchImpl = stubFetch({
      [boardApiUrl(GH)]: {
        body: { jobs: [ghJob(1, "QA Engineer"), ghJob(7, "QA Engineer", "someotherco"), ghJob(8, "QA Analyst", "acme", "<p>See our careers page.</p>"), ghJob(9, "SDET", "acme", "")] },
      },
    });
    const result = await runBoardDiscovery(opts(w, fetchImpl));
    expect(result.totals).toMatchObject({ matched: 4, saved: 1, rejected: 3 });
    expect(loadJobs(w.jobsPath).map((j) => j.atsIdentity)).toEqual(["greenhouse:acme:1"]);
    const codes = loadJobFailures(w.failuresPath).map((f) => [f.sourceJobId, f.code]).sort();
    expect(codes).toEqual([["7", "BOARD_MISMATCH"], ["8", "DESCRIPTION_TOO_SHORT"], ["9", "EMPTY_DESCRIPTION"]]);
  });

  it("isolates a failing board: typed failure, other companies still saved, no stored data touched", async () => {
    const w = setup([GH, { company: "Initech", ats: "greenhouse", board: "initech" }, LV, { company: "Hooli", ats: "lever", board: "hooli" }]);
    const fetchImpl = stubFetch({
      [boardApiUrl(GH)]: { body: { jobs: [ghJob(1, "QA Engineer")] } },
      [boardApiUrl({ ...GH, board: "initech" })]: { status: 404, body: "not found" },
      [boardApiUrl(LV)]: { body: "<html>maintenance</html>" },
      [boardApiUrl({ ...LV, board: "hooli" })]: "throw",
    });
    const result = await runBoardDiscovery(opts(w, fetchImpl));
    expect(result.companies.map((c) => [c.company, c.status, c.failure?.code])).toEqual([
      ["Acme", "OK", undefined],
      ["Initech", "FAILED", "BOARD_NOT_FOUND"],
      ["Globex", "FAILED", "BOARD_RESPONSE_INVALID"],
      ["Hooli", "FAILED", "BOARD_FETCH_FAILED"],
    ]);
    expect(result.totals).toMatchObject({ saved: 1, failedCompanies: 3 });
    expect(loadJobs(w.jobsPath)).toHaveLength(1);
    const failures = loadJobFailures(w.failuresPath);
    expect(failures.map((f) => [f.category, f.code, f.retryable])).toEqual([
      ["DISCOVERY_FAILED", "BOARD_NOT_FOUND", false],
      ["DISCOVERY_FAILED", "BOARD_RESPONSE_INVALID", false],
      ["DISCOVERY_FAILED", "BOARD_FETCH_FAILED", true],
    ]);
  });

  it("rejects an unexpected response shape without partial saves", async () => {
    const w = setup([GH]);
    const result = await runBoardDiscovery(opts(w, stubFetch({ [boardApiUrl(GH)]: { body: { jobs: [{ id: "abc", title: 5 }] } } })));
    expect(result.companies[0]).toMatchObject({ status: "FAILED", failure: { code: "BOARD_RESPONSE_INVALID" } });
    expect(existsSync(w.jobsPath)).toBe(false);
  });
});

describe("boards CLI", () => {
  it("exit codes: 0 when every board reads, 1 when a board fails, 2 for bad configuration or usage", async () => {
    const ok = setup([GH]);
    const lines: string[] = [];
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = stubFetch({ [boardApiUrl(GH)]: { body: { jobs: [ghJob(1, "QA Engineer")] } } });
      expect(await runBoardsCli({ config: ok.configPath, dataDir: ok.dir }, (l) => lines.push(l))).toBe(0);
      globalThis.fetch = stubFetch({ [boardApiUrl(GH)]: { status: 500, body: "boom" } });
      expect(await runBoardsCli({ config: ok.configPath, dataDir: ok.dir }, (l) => lines.push(l))).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    const bad = setup([GH], []);
    expect(await runBoardsCli({ config: bad.configPath, dataDir: bad.dir }, (l) => lines.push(l))).toBe(2);
    expect(await runBoardsCli({ dataDir: ok.dir }, (l) => lines.push(l))).toBe(2);
    expect(() => parseBoardsArgs(["--max-per-company", "0"])).toThrow();
    expect(readFileSync(ok.jobsPath, "utf8")).toContain("greenhouse:acme:1");
  });
});

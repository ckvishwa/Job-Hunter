import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import {
  closePersistentChrome,
  launchPersistentChrome,
  realChromeProcessDeps,
} from "../../../src/browser/launcher.js";
import { companyRegistrySchema } from "../../../src/config/schema.js";
import { searchTargetSchema, type ResolvedSearchTarget } from "../../../src/config/search-input.js";
import { runSearchDiscovery, type SearchRunOptions } from "../../../src/discovery/browser-search.js";
import { JobStoreError } from "../../../src/storage/job-store.js";
import { loadJobFailures, loadJobs } from "../../../src/storage/jsonl-store.js";

// Offline browser E2E: the PRODUCTION search flow (src/discovery/browser-search.ts), the
// production Chrome launcher/close (headed, dedicated temp profile) and the production canonical
// gate + protected store, against a loopback fixture site. Substituted boundary: the website
// (a local server on *.localhost). Every non-loopback request the page makes is aborted and
// counted. This proves wiring and failure behaviour; it says nothing about any real site.

const HOST = "acme-corp.localhost";
const GENERIC_JD =
  "Acme is hiring an engineer to own quality for our payments platform. You will design and maintain automated test suites, " +
  "partner with developers on test strategy, and build CI pipelines that gate releases on fast, reliable feedback. " +
  "You have experience testing distributed systems, strong debugging skills and clear written communication. " +
  "You will work with a small, collaborative team and see your work ship to customers every week.";

interface FixtureJob {
  id: number;
  slug: string;
  title: string;
  body: string; // paragraph(s) inside <main>
  broken?: boolean;
}
const JOBS: FixtureJob[] = [
  { id: 1000001, slug: "sdet-ii", title: "SDET II", body: GENERIC_JD },
  { id: 1000002, slug: "qa-automation-engineer", title: "QA Automation Engineer", body: `${GENERIC_JD} You will extend our Playwright suite.` },
  { id: 1000003, slug: "security-engineer", title: "Security Engineer", body: `${GENERIC_JD} You will run threat modeling sessions.` },
  { id: 1000004, slug: "stub-role", title: "Stub Role", body: "See careers page." },
  { id: 1000005, slug: "broken-page", title: "Broken Page", body: GENERIC_JD, broken: true },
  // Same title, location and description as 1000001: a distinct requisition.
  { id: 1000006, slug: "sdet-ii-2", title: "SDET II", body: GENERIC_JD },
];

const state = { noSearchBox: false, externalCalls: false, applyHits: 0, renders: [] as { query: string; count: number }[] };
let server: http.Server;
let origin = "";

function searchPage(): string {
  const jobsJson = JSON.stringify(JOBS.map(({ id, slug, title }) => ({ id, slug, title })));
  const box = state.noSearchBox
    ? "<p>Browse our teams below.</p>"
    : '<form onsubmit="return false"><input type="search" id="q" aria-label="Search for a role" placeholder="Search for a role"></form>';
  const external = state.externalCalls
    ? '<img src="https://tracker.invalid/pixel.png" alt=""><script>fetch("https://analytics.invalid/collect").catch(function(){});</script>'
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers</title></head><body>
<nav><a href="/">Home</a><a href="/careers">Open roles</a></nav>
<main><h2>Roles at Acme</h2>${box}${external}
<p id="empty" hidden>No open roles match your search.</p>
<ul id="results"></ul></main>
<script>
var JOBS = ${jobsJson};
function render(q) {
  var needle = q.trim().toLowerCase();
  var list = JOBS.filter(function (j) { return needle === "" || j.title.toLowerCase().indexOf(needle) !== -1; });
  var ul = document.getElementById("results"); ul.innerHTML = "";
  list.forEach(function (j) { var li = document.createElement("li"); var a = document.createElement("a");
    a.href = "/careers/listing/" + j.slug + "/" + j.id; a.textContent = j.title; li.appendChild(a); ul.appendChild(li); });
  document.getElementById("empty").hidden = list.length !== 0;
  history.replaceState(null, "", q ? "?query=" + encodeURIComponent(q) : location.pathname);
  fetch("/__render", { method: "POST", body: JSON.stringify({ query: q, count: list.length }) });
}
var box = document.getElementById("q");
if (box) { box.addEventListener("input", function () { render(box.value); }); }
render("");
</script></body></html>`;
}

function listingPage(job: FixtureJob): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers | ${job.title}</title></head><body>
<nav><a href="/careers">Roles at Acme</a></nav>
<main><h1>${job.title}</h1>
<p>${job.body}</p>
<h3>Office locations</h3><dl><dd>Austin, Chicago</dd></dl>
<h3>Remote location</h3><dl><dd>Remote in United States</dd></dl>
<p><a href="/apply?job=${job.id}">Apply now</a></p></main></body></html>`;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/__render") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        state.renders.push(JSON.parse(body) as { query: string; count: number });
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === "/careers") {
      res.writeHead(200, { "content-type": "text/html" }).end(searchPage());
      return;
    }
    const m = url.pathname.match(/^\/careers\/listing\/([^/]+)\/(\d+)$/);
    if (m) {
      const job = JOBS.find((j) => j.slug === m[1] && String(j.id) === m[2]);
      if (!job) return void res.writeHead(404).end("not found");
      if (job.broken) return void req.socket.destroy();
      res.writeHead(200, { "content-type": "text/html" }).end(listingPage(job));
      return;
    }
    if (url.pathname === "/apply") {
      state.applyHits += 1;
      res.writeHead(200).end("applied?!");
      return;
    }
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://${HOST}:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.noSearchBox = false;
  state.externalCalls = false;
  state.applyHits = 0;
  state.renders = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const registry = companyRegistrySchema.parse([
  {
    company: "Acme",
    fortuneRank: null,
    corporateDomain: HOST,
    careersUrl: `https://${HOST}/careers`,
    atsType: "greenhouse",
    atsTenantOrBoardId: "acme",
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    enabled: true,
    verificationStatus: "verified",
    verificationNote: null,
    sourceProvenance: ["synthetic-test-fixture"],
    lastVerifiedAt: "2026-10-07",
  },
])[0]!;

function resolvedTarget(queries: string[], maxJobs = 1): ResolvedSearchTarget {
  const target = searchTargetSchema.parse({
    company: "Acme",
    careersUrl: "https://acme-corp.localhost/careers", // replaced below: the fixture is plain http on a random port
    queries,
    maxJobs,
    selectors: { searchBoxName: "Search for a role", resultLink: "a[href*='/careers/listing/']", emptyStateText: "no open roles match your search", descriptionContainer: "main" },
  });
  return { target: { ...target, careersUrl: `${origin}/careers` }, entry: registry };
}

interface Harness {
  dataDir: string;
  profileDir: string;
  blocked: string[];
  launches: number;
  closes: BrowserContext[];
}

function harness(): Harness {
  return {
    dataDir: mkdtempSync(path.join(tmpdir(), "jh-e2e-data-")),
    profileDir: mkdtempSync(path.join(tmpdir(), "jh-e2e-profile-")),
    blocked: [],
    launches: 0,
    closes: [],
  };
}

function deps(h: Harness, afterLaunch?: () => void) {
  return {
    launchFn: (async (dir?: string, options?: Parameters<typeof launchPersistentChrome>[1]) => {
      h.launches += 1;
      const context = await launchPersistentChrome(dir, options);
      // Offline guarantee: only loopback hosts may be reached; everything else is aborted and recorded.
      await context.route(/.*/, (route) => {
        const host = new URL(route.request().url()).hostname;
        if (host === "127.0.0.1" || host === "localhost" || host.endsWith(".localhost")) return route.continue();
        h.blocked.push(route.request().url());
        return route.abort();
      });
      afterLaunch?.();
      return context;
    }) as typeof launchPersistentChrome,
    closeFn: (async (context: BrowserContext, dir?: string) => {
      h.closes.push(context);
      await closePersistentChrome(context, dir);
    }) as typeof closePersistentChrome,
    log: () => {},
    verify: async () => ({ detected: false }),
  };
}

function options(h: Harness, over: Partial<SearchRunOptions> = {}): SearchRunOptions {
  return {
    dataDir: h.dataDir,
    profileDir: h.profileDir,
    typingDelayMs: 25,
    holdMs: 0,
    settleTimeoutMs: 8000,
    navigationTimeoutMs: 8000,
    rolesConfigPath: path.resolve("config/roles.yml"),
    ...over,
  };
}

async function expectChromeGone(h: Harness): Promise<void> {
  expect(await realChromeProcessDeps.findOwningProcessIds(path.resolve(h.profileDir))).toEqual([]);
}

const T = 90_000;

describe("visible search flow against a loopback careers site (headed Chrome)", () => {
  it("types into the real search field, results change as it types, opens the first result and saves the DOM-extracted posting", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h));

    // The page re-rendered per keystroke: full list first, then narrowing as "s", "sd", "sde", "sdet" were typed.
    expect(state.renders.map((r) => r.query)).toEqual(["", "s", "sd", "sde", "sdet"]);
    expect(state.renders[0]!.count).toBe(6);
    expect(state.renders.at(-1)!.count).toBe(2);
    expect(state.renders[1]!.count).toBeGreaterThan(state.renders.at(-1)!.count);

    expect(summary.outcome).toBe("PERSISTED");
    expect(summary.queries[0]).toMatchObject({ query: "sdet", status: "results", resultCount: 2, typedValue: "sdet" });
    const [job] = summary.jobs;
    expect(job).toMatchObject({
      title: "SDET II",
      employer: "Acme",
      employerSeenOnPage: true,
      location: "Austin, Chicago; Remote in United States",
      url: `${origin}/careers/listing/sdet-ii/1000001`,
      extractionMethod: "browser-dom",
      status: "persisted",
      atsIdentity: "greenhouse:acme:1000001",
    });
    expect(job!.jdChars).toBeGreaterThan(300);

    const saved = loadJobs(path.join(h.dataDir, "jobs.jsonl"));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      title: "SDET II",
      company: "Acme",
      resolutionStatus: "resolved",
      schemaVersion: 1,
      atsIdentity: "greenhouse:acme:1000001",
      canonicalUrl: `${origin}/careers/listing/sdet-ii/1000001`,
    });
    expect(saved[0]!.sourceObservations).toHaveLength(1);
    expect(saved[0]!.sourceObservations![0]).toMatchObject({ extractionMethod: "browser-dom", sourceKind: "browser-search" });
    expect(saved[0]!.descriptionText).toContain("payments platform");
    expect(saved[0]!.descriptionText).toContain("Remote in United States");
    expect(saved[0]!.jdContentHash).toMatch(/^[0-9a-f]{64}$/);

    expect(state.applyHits).toBe(0); // the Apply link was never followed
    expect(h.blocked).toEqual([]);
    expect(summary.browserClosed).toBe(true);
    expect(h.closes).toHaveLength(1);
    await expectChromeGone(h);
  }, T);

  it("handles a genuine empty state, then searches the next query and uses its results", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["zzzzz", "security"]), options(h), deps(h));

    expect(summary.queries.map((q) => [q.query, q.status, q.resultCount])).toEqual([
      ["zzzzz", "empty", 0],
      ["security", "results", 1],
    ]);
    expect(summary.jobs.map((j) => j.title)).toEqual(["Security Engineer"]);
    expect(summary.failures).toEqual([]);
    expect(state.renders.some((r) => r.query === "zzzzz" && r.count === 0)).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("reports NO_RESULTS (not a failure, nothing saved) when every query is genuinely empty", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["zzzzz", "qqqqq"]), options(h), deps(h));
    expect(summary.outcome).toBe("NO_RESULTS");
    expect(summary.queries.map((q) => q.status)).toEqual(["empty", "empty"]);
    expect(summary.failures).toEqual([]);
    expect(existsSync(path.join(h.dataDir, "jobs.jsonl"))).toBe(false);
    expect(summary.browserClosed).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("a page without a search field is a typed SEARCH_CONTROL_NOT_FOUND failure, never a typed-into-nothing success", async () => {
    state.noSearchBox = true;
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet"]), options(h, { navigationTimeoutMs: 2500 }), deps(h));

    expect(summary.outcome).toBe("FAILED");
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]).toMatchObject({ category: "DISCOVERY_FAILED", code: "SEARCH_CONTROL_NOT_FOUND", stage: "search" });
    expect(loadJobFailures(path.join(h.dataDir, "job-failures.jsonl"))).toHaveLength(1);
    expect(existsSync(path.join(h.dataDir, "jobs.jsonl"))).toBe(false);
    expect(summary.browserClosed).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("a result whose page cannot be loaded is a typed NAVIGATION_FAILED failure and nothing is saved", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["broken"]), options(h), deps(h));

    expect(summary.outcome).toBe("FAILED");
    expect(summary.failures[0]).toMatchObject({ category: "DISCOVERY_FAILED", code: "NAVIGATION_FAILED", retryable: true });
    expect(existsSync(path.join(h.dataDir, "jobs.jsonl"))).toBe(false);
    expect(summary.browserClosed).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("an incomplete JD (one short sentence) is rejected with a typed failure and never saved as success", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["stub"]), options(h), deps(h));

    expect(summary.jobs[0]).toMatchObject({ status: "rejected", title: "Stub Role" });
    expect(summary.failures[0]).toMatchObject({ category: "JD_EXTRACTION_FAILED", code: "DESCRIPTION_TOO_SHORT" });
    expect(summary.persistedCount).toBe(0);
    expect(summary.outcome).toBe("FAILED");
    expect(existsSync(path.join(h.dataDir, "jobs.jsonl"))).toBe(false);
    await expectChromeGone(h);
  }, T);

  it("repeating the same search keeps exactly one authoritative record (same id, first-seen time, one observation)", async () => {
    const h = harness();
    await runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h));
    const first = loadJobs(path.join(h.dataDir, "jobs.jsonl"));
    await runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h));
    const second = loadJobs(path.join(h.dataDir, "jobs.jsonl"));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.discoveredAt).toBe(first[0]!.discoveredAt);
    expect(second[0]!.lastSeenAt >= first[0]!.lastSeenAt).toBe(true);
    expect(second[0]!.jdContentHash).toBe(first[0]!.jdContentHash);
    expect(second[0]!.sourceObservations).toHaveLength(1);
    await expectChromeGone(h);
  }, T);

  it("two distinct requisitions with identical title, location and description stay two records", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet"], 2), options(h), deps(h));
    expect(summary.persistedCount).toBe(2);
    const saved = loadJobs(path.join(h.dataDir, "jobs.jsonl"));
    expect(saved.map((j) => j.atsIdentity).sort()).toEqual(["greenhouse:acme:1000001", "greenhouse:acme:1000006"]);
    expect(new Set(saved.map((j) => j.descriptionText)).size).toBe(1);
    expect(new Set(saved.map((j) => j.id)).size).toBe(2);
    await expectChromeGone(h);
  }, T);

  it("blocks and records non-loopback requests the page tries to make, without breaking the run", async () => {
    state.externalCalls = true;
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h));
    expect(summary.outcome).toBe("PERSISTED");
    expect(h.blocked.some((u) => u.startsWith("https://tracker.invalid/"))).toBe(true);
    expect(h.blocked.every((u) => u.includes(".invalid/"))).toBe(true);
    await expectChromeGone(h);
  }, T);
});

describe("authoritative store and cleanup", () => {
  it("a corrupt jobs.jsonl blocks the run before any browser launches", async () => {
    const h = harness();
    const corrupt = "{\"id\":\"1\"}\nnot json\n";
    writeFileSync(path.join(h.dataDir, "jobs.jsonl"), corrupt);
    await expect(runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h))).rejects.toBeInstanceOf(JobStoreError);
    expect(h.launches).toBe(0);
    expect(readFileSync(path.join(h.dataDir, "jobs.jsonl"), "utf-8")).toBe(corrupt);
  }, T);

  it("a storage failure after Chrome launched still closes the owned browser and saves nothing partial", async () => {
    const h = harness();
    const jobsPath = path.join(h.dataDir, "jobs.jsonl");
    // A competing writer corrupts the store once the browser is up (after the startup read).
    const summaryPromise = runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h, () => writeFileSync(jobsPath, "garbage left by another writer\n")));
    await expect(summaryPromise).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    expect(h.closes).toHaveLength(1);
    expect(readFileSync(jobsPath, "utf-8")).toBe("garbage left by another writer\n");
    await expectChromeGone(h);
  }, T);
});

afterAll(() => {
  // Temp profile/data directories live under the OS temp dir; nothing in the repo is touched.
  void rmSync;
});

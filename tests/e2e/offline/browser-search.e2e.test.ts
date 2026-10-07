import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserContext } from "playwright";
import { closePersistentChrome, launchPersistentChrome, realChromeProcessDeps } from "../../../src/browser/launcher.js";
import { companyRegistrySchema } from "../../../src/config/schema.js";
import { searchTargetSchema, type ResolvedSearchTarget } from "../../../src/config/search-input.js";
import { runSearchDiscovery, type SearchRunDeps, type SearchRunOptions } from "../../../src/discovery/browser-search.js";
import { computeJdContentHash } from "../../../src/domain/canonical-job.js";
import { JobStoreError } from "../../../src/storage/job-store.js";
import { loadJobFailures, loadJobs } from "../../../src/storage/jsonl-store.js";

// Offline browser E2E: the PRODUCTION search flow (src/discovery/browser-search.ts), the
// production Chrome launcher/close (headed, dedicated temp profile) and the production canonical
// gate + protected store, against a loopback fixture site. Substituted boundaries: the website
// (a local server on *.localhost) and the Greenhouse board lookup that confirms numeric ids
// (an injected stand-in). Every non-loopback request the page makes is aborted and counted.
// This proves wiring and failure behaviour; it says nothing about any real site.

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
  team: string;
  loc: string;
  body: string;
  path?: string; // overrides /careers/listing/<slug>/<id>
  broken?: boolean;
}
// List order matters: the manager is listed BEFORE the individual-contributor title it shares a query with.
const JOBS: FixtureJob[] = [
  { id: 1000007, slug: "security-engineering-manager", title: "Security Engineering Manager", team: "Security", loc: "Remote in United States", body: `${GENERIC_JD} You will manage the security engineering team.` },
  { id: 1000001, slug: "sdet-ii", title: "SDET II", team: "Engineering", loc: "Austin", body: GENERIC_JD },
  { id: 1000002, slug: "qa-automation-engineer", title: "QA Automation Engineer", team: "Engineering", loc: "Chicago", body: `${GENERIC_JD} You will extend our Playwright suite.` },
  { id: 1000003, slug: "security-engineer", title: "Security Engineer", team: "Security", loc: "Remote in United States", body: `${GENERIC_JD} You will run threat modeling sessions.` },
  { id: 1000004, slug: "sdet-stub", title: "SDET Stub", team: "Engineering", loc: "Austin", body: "See careers page." },
  { id: 1000005, slug: "sdet-broken", title: "SDET Broken", team: "Engineering", loc: "Austin", body: GENERIC_JD, broken: true },
  // Same title, location and description as 1000001: a distinct requisition.
  { id: 1000006, slug: "sdet-ii-2", title: "SDET II", team: "Engineering", loc: "Austin", body: GENERIC_JD },
  { id: 1000008, slug: "product-marketing-manager", title: "Product Marketing Manager", team: "Marketing", loc: "Remote in United States", body: GENERIC_JD },
  { id: 1000009, slug: "abuse-research-engineer", title: "Abuse Research Engineer", team: "Security", loc: "Remote in United States", body: GENERIC_JD },
  // A numeric suffix on a URL shape the input does not declare: must never receive an ATS identity.
  { id: 2024001, slug: "sdet-legacy", title: "SDET Legacy", team: "Engineering", loc: "Austin", body: GENERIC_JD, path: "/legacy/post/2024001" },
  // Declared URL shape, but the id is not a job on the (stand-in) Greenhouse board.
  { id: 1000011, slug: "sdet-unconfirmed", title: "SDET Unconfirmed", team: "Engineering", loc: "Austin", body: GENERIC_JD },
];
const CONFIRMED_IDS = new Set(["1000001", "1000002", "1000003", "1000004", "1000005", "1000006", "1000007", "1000008", "1000009"]);

const state = { noSearchBox: false, externalCalls: false, applyHits: 0, listingHits: [] as number[], renders: [] as { query: string; count: number }[] };
let server: http.Server;
let origin = "";

const hrefFor = (j: FixtureJob): string => j.path ?? `/careers/listing/${j.slug}/${j.id}`;

function searchPage(): string {
  const jobsJson = JSON.stringify(JOBS.map((j) => ({ title: j.title, team: j.team, loc: j.loc, href: hrefFor(j) })));
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
  list.forEach(function (j) {
    var li = document.createElement("li");
    var a = document.createElement("a"); a.href = j.href; a.textContent = j.title; li.appendChild(a);
    var t = document.createElement("p"); t.className = "team"; t.textContent = j.team; li.appendChild(t);
    var l = document.createElement("span"); l.className = "loc"; l.textContent = j.loc; li.appendChild(l);
    ul.appendChild(li);
  });
  document.getElementById("empty").hidden = list.length !== 0;
  history.replaceState(null, "", q ? "?query=" + encodeURIComponent(q) : location.pathname);
  fetch("/__render", { method: "POST", body: JSON.stringify({ query: q, count: list.length }) });
}
var box = document.getElementById("q");
if (box) { box.addEventListener("input", function () { render(box.value); }); }
render("");
</script></body></html>`;
}

// Realistic posting chrome: breadcrumb, title heading, description sections, a fact sidebar and two Apply controls.
function listingPage(job: FixtureJob): string {
  const sections = job.body.length > 100
    ? `<h2>Who we are</h2><p>${job.body}</p>
<h2>What you'll do</h2><ul><li>Design and maintain automated test suites.</li><li>Partner with developers on test strategy.</li></ul>
<h2>Minimum requirements</h2><ul><li>5+ years of experience testing distributed systems.</li></ul>
<h2>Pay and benefits</h2><p>The annual salary range for this role is $150,000 - $200,000 plus equity.</p>`
    : `<p>${job.body}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acme Careers | ${job.title}</title></head><body>
<nav class="site"><a href="/careers">Roles at Acme</a></nav>
<main>
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/careers">Roles at Acme</a> / <span>Role details</span></nav>
<h1>${job.title}</h1>
<div class="layout"><div class="body">${sections}
<p><a class="cta" href="/apply?job=${job.id}">Apply now</a></p></div>
<aside><dl><h3>Company</h3><dd>Acme</dd><h3>Team</h3><dd>${job.team}</dd>
<h3>Office locations</h3><dd>${job.loc}</dd><h3>Employment type</h3><dd>Full time</dd></dl>
<a class="cta" href="/apply?job=${job.id}">Apply for this role</a></aside></div>
</main></body></html>`;
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
    const job = JOBS.find((j) => hrefFor(j) === url.pathname);
    if (job) {
      state.listingHits.push(job.id);
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
  state.listingHits = [];
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

const ID_PATTERN = "^/careers/listing/[^/]+/(\\d{6,})/?$";

function resolvedTarget(queries: string[], maxJobs = 1, over: { selectors?: Record<string, unknown>; selection?: Record<string, unknown> } = {}): ResolvedSearchTarget {
  const target = searchTargetSchema.parse({
    company: "Acme",
    careersUrl: "https://acme-corp.localhost/careers", // replaced below: the fixture is plain http on a random port
    queries,
    maxJobs,
    selection: over.selection,
    selectors: {
      searchBoxName: "Search for a role",
      resultLink: "a[href*='/careers/listing/'], a[href*='/legacy/']",
      resultTeam: ".team",
      resultLocation: ".loc",
      emptyStateText: "no open roles match your search",
      descriptionContainer: "main",
      listingIdPattern: ID_PATTERN,
      ...over.selectors,
    },
  });
  return { target: { ...target, careersUrl: `${origin}/careers` }, entry: registry };
}

interface Harness {
  dataDir: string;
  profileDir: string;
  blocked: string[];
  launches: number;
  closes: BrowserContext[];
  confirmCalls: string[];
}

function harness(): Harness {
  return {
    dataDir: mkdtempSync(path.join(tmpdir(), "jh-e2e-data-")),
    profileDir: mkdtempSync(path.join(tmpdir(), "jh-e2e-profile-")),
    blocked: [],
    launches: 0,
    closes: [],
    confirmCalls: [],
  };
}

function deps(h: Harness, afterLaunch?: () => void): SearchRunDeps {
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
    confirmListing: async (board, jobId) => {
      h.confirmCalls.push(`${board}:${jobId}`);
      return board === "acme" && CONFIRMED_IDS.has(jobId);
    },
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
    settleTimeoutMs: 20000,
    navigationTimeoutMs: 20000,
    rolesConfigPath: path.resolve("config/roles.yml"),
    ...over,
  };
}

async function expectChromeGone(h: Harness): Promise<void> {
  expect(await realChromeProcessDeps.findOwningProcessIds(path.resolve(h.profileDir))).toEqual([]);
}

const T = 90_000;
const jobsFile = (h: Harness) => path.join(h.dataDir, "jobs.jsonl");

describe("visible search flow against a loopback careers site (headed Chrome)", () => {
  it("types into the real search field, results change as it types, opens the first MATCH and saves the cleaned DOM-extracted posting", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h));

    // The page re-rendered per keystroke: full list first, then narrowing as "s", "sd", "sde", "sdet" were typed.
    expect(state.renders.map((r) => r.query)).toEqual(["", "s", "sd", "sde", "sdet"]);
    expect(state.renders[0]!.count).toBe(JOBS.length);
    expect(state.renders.at(-1)!.count).toBe(6);
    expect(state.renders[1]!.count).toBeGreaterThan(state.renders.at(-1)!.count);

    expect(summary.outcome).toBe("PERSISTED");
    expect(summary.queries[0]).toMatchObject({ query: "sdet", status: "results", resultCount: 6, matchCount: 6, typedValue: "sdet" });
    const [job] = summary.jobs;
    expect(job).toMatchObject({
      title: "SDET II",
      employer: "Acme",
      employerSeenOnPage: true,
      location: "Austin",
      url: `${origin}/careers/listing/sdet-ii/1000001`,
      extractionMethod: "browser-dom",
      status: "persisted",
      atsIdentity: "greenhouse:acme:1000001",
    });
    expect(job!.sections).toEqual(["Who we are", "What you'll do", "Minimum requirements", "Pay and benefits"]);

    const saved = loadJobs(jobsFile(h));
    expect(saved).toHaveLength(1);
    const rec = saved[0]!;
    expect(rec).toMatchObject({ title: "SDET II", company: "Acme", resolutionStatus: "resolved", schemaVersion: 1, atsIdentity: "greenhouse:acme:1000001", matchedProfiles: ["sdet"], department: "Engineering" });
    expect(rec.sourceObservations![0]).toMatchObject({ extractionMethod: "browser-dom", sourceKind: "browser-search" });

    // Clean text: substantive sections kept ...
    for (const kept of ["payments platform", "What you'll do", "Design and maintain automated test suites", "Minimum requirements", "5+ years of experience", "Pay and benefits", "$150,000 - $200,000"]) {
      expect(rec.descriptionText).toContain(kept);
    }
    // ... page chrome gone: breadcrumb, duplicate title heading, fact sidebar, action labels.
    for (const noise of ["Roles at Acme", "Role details", "Apply now", "Apply for this role", "Employment type", "Office locations", "Full time"]) {
      expect(rec.descriptionText).not.toContain(noise);
    }
    expect(rec.descriptionText.startsWith("SDET II")).toBe(false);
    expect(rec.descriptionText.startsWith("Who we are")).toBe(true);
    // Saved text, hash and strategy agree.
    expect(rec.jdContentHash).toBe(computeJdContentHash(rec.descriptionText));
    expect(rec.descriptionHtml).toContain("Pay and benefits");
    expect(rec.descriptionHtml).not.toContain("Employment type");
    expect(rec.rawMetadata).toMatchObject({ extraction: "browser-dom", titleTargeting: { classification: "MATCH" } });
    const strategy = (rec.rawMetadata as { extractionStrategy: { container: string; removedSelectors: Record<string, number>; actionLinksRemoved: number; titleHeadingRemoved: boolean; sections: string[] } }).extractionStrategy;
    expect(strategy).toMatchObject({ container: "main", titleHeadingRemoved: true });
    expect(strategy.removedSelectors.aside).toBe(1);
    expect(strategy.actionLinksRemoved).toBe(2); // the in-body "Apply now" and the sidebar "Apply for this role"
    expect(strategy.sections).toContain("Pay and benefits");

    // Shortlist: only the first MATCH was opened; the other five MATCH results are visible but untouched.
    expect(summary.shortlist.filter((e) => e.classification === "MATCH")).toHaveLength(6);
    expect(summary.shortlist.filter((e) => e.opened).map((e) => e.title)).toEqual(["SDET II"]);
    expect(summary.shortlist.find((e) => e.opened)).toMatchObject({ extracted: true, saved: true, team: "Engineering", location: "Austin" });
    expect(summary.shortlist.filter((e) => !e.opened).every((e) => e.selection === "not opened: maxJobs reached")).toBe(true);
    expect(state.listingHits).toEqual([1000001]);
    expect(state.applyHits).toBe(0); // no Apply link was ever followed
    expect(h.blocked).toEqual([]);
    expect(JSON.parse(readFileSync(summary.shortlistPath, "utf-8")).entries).toHaveLength(6);
    expect(summary.browserClosed).toBe(true);
    expect(h.closes).toHaveLength(1);
    await expectChromeGone(h);
  }, T);

  it("selects the individual-contributor title and leaves the manager title (listed first) unopened", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["security engineer"]), options(h), deps(h));

    const byTitle = Object.fromEntries(summary.shortlist.map((e) => [e.title, e]));
    expect(summary.shortlist.map((e) => e.title)).toEqual(["Security Engineering Manager", "Security Engineer"]); // list order: manager first
    expect(byTitle["Security Engineering Manager"]).toMatchObject({ classification: "REVIEW", opened: false, saved: false, team: "Security" });
    expect(byTitle["Security Engineering Manager"]!.selection).toContain("openReview");
    expect(byTitle["Security Engineer"]).toMatchObject({ classification: "MATCH", profile: "security", opened: true, extracted: true, saved: true });
    expect(byTitle["Security Engineer"]!.rule).toContain("domain qualifier");
    expect(state.listingHits).toEqual([1000003]); // the first result (the manager) was never opened
    expect(loadJobs(jobsFile(h)).map((j) => j.title)).toEqual(["Security Engineer"]);
    await expectChromeGone(h);
  }, T);

  it("opens a REVIEW result only when selection.openReview is on, and does not tag it with a profile", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["security engineer"], 2, { selection: { openReview: true } }), options(h), deps(h));
    expect(summary.persistedCount).toBe(2);
    const saved = loadJobs(jobsFile(h));
    expect(saved.map((j) => j.title).sort()).toEqual(["Security Engineer", "Security Engineering Manager"]);
    expect(saved.find((j) => j.title === "Security Engineering Manager")!.matchedProfiles).toEqual([]);
    expect(saved.find((j) => j.title === "Security Engineer")!.matchedProfiles).toEqual(["security"]);
    await expectChromeGone(h);
  }, T);

  it("every result NO_MATCH or REVIEW: nothing is opened or saved, the outcome is NO_MATCH, REVIEW stays visible", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["marketing", "abuse"]), options(h), deps(h));

    expect(summary.outcome).toBe("NO_MATCH");
    expect(summary.queries.map((q) => [q.query, q.matchCount, q.reviewCount, q.noMatchCount])).toEqual([
      ["marketing", 0, 0, 1],
      ["abuse", 0, 1, 0],
    ]);
    expect(summary.shortlist.map((e) => [e.title, e.classification, e.opened, e.saved])).toEqual([
      ["Product Marketing Manager", "NO_MATCH", false, false],
      ["Abuse Research Engineer", "REVIEW", false, false],
    ]);
    expect(summary.failures).toEqual([]);
    expect(state.listingHits).toEqual([]); // no posting page was requested at all
    expect(existsSync(jobsFile(h))).toBe(false);
    expect(summary.browserClosed).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("works without configured row selectors by reading team and location from the row's text lines", async () => {
    const h = harness();
    const target = resolvedTarget(["security engineer"], 1, { selectors: { resultTeam: undefined, resultLocation: undefined } });
    const summary = await runSearchDiscovery(target, options(h), deps(h));
    const manager = summary.shortlist.find((e) => e.title === "Security Engineering Manager")!;
    expect(manager).toMatchObject({ team: "Security", location: "Remote in United States", classification: "REVIEW" });
    expect(summary.shortlist.find((e) => e.title === "Security Engineer")!.saved).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("handles a genuine empty state, then searches the next query and uses its results", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["zzzzz", "security engineer"]), options(h), deps(h));

    expect(summary.queries.map((q) => [q.query, q.status, q.resultCount])).toEqual([
      ["zzzzz", "empty", 0],
      ["security engineer", "results", 2],
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
    expect(existsSync(jobsFile(h))).toBe(false);
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
    expect(existsSync(jobsFile(h))).toBe(false);
    expect(summary.browserClosed).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("a selected result whose page cannot be loaded is a typed NAVIGATION_FAILED failure and nothing is saved", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["broken"]), options(h), deps(h));

    expect(summary.outcome).toBe("FAILED");
    expect(summary.failures[0]).toMatchObject({ category: "DISCOVERY_FAILED", code: "NAVIGATION_FAILED", retryable: true });
    expect(summary.shortlist[0]).toMatchObject({ opened: false, saved: false, failureCode: "NAVIGATION_FAILED" });
    expect(existsSync(jobsFile(h))).toBe(false);
    expect(summary.browserClosed).toBe(true);
    await expectChromeGone(h);
  }, T);

  it("an incomplete JD (one short sentence once page chrome is removed) is rejected with a typed failure and never saved as success", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["stub"]), options(h), deps(h));

    expect(summary.jobs[0]).toMatchObject({ status: "rejected", title: "SDET Stub" });
    expect(summary.failures[0]).toMatchObject({ category: "JD_EXTRACTION_FAILED", code: "DESCRIPTION_TOO_SHORT" });
    expect(summary.shortlist[0]).toMatchObject({ opened: true, extracted: true, saved: false, failureCode: "DESCRIPTION_TOO_SHORT" });
    expect(summary.persistedCount).toBe(0);
    expect(summary.outcome).toBe("FAILED");
    expect(existsSync(jobsFile(h))).toBe(false);
    await expectChromeGone(h);
  }, T);

  it("an unsupported numeric-suffix URL gets no fabricated ATS identity and is not saved; the id lookup is not even attempted", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet legacy"]), options(h), deps(h));

    expect(state.listingHits).toEqual([2024001]); // the page was opened and read ...
    expect(summary.shortlist[0]).toMatchObject({ title: "SDET Legacy", classification: "MATCH", opened: true, saved: false });
    expect(summary.failures[0]).toMatchObject({ category: "POSTING_UNRESOLVED", code: "JOB_ID_MISSING" });
    expect(h.confirmCalls).toEqual([]); // ... but 2024001 is not in a declared URL shape, so no lookup and no identity
    expect(existsSync(jobsFile(h))).toBe(false);
    await expectChromeGone(h);
  }, T);

  it("a numeric id in the declared URL shape that the employer's board does not list gets no identity either", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet unconfirmed"]), options(h), deps(h));

    expect(h.confirmCalls).toEqual(["acme:1000011"]);
    expect(summary.failures[0]).toMatchObject({ code: "JOB_ID_MISSING" });
    expect(summary.failures[0]!.detail).toContain("not a job on Acme's registered Greenhouse board");
    expect(summary.shortlist[0]).toMatchObject({ opened: true, extracted: true, saved: false });
    expect(existsSync(jobsFile(h))).toBe(false);
    await expectChromeGone(h);
  }, T);

  it("a target with no declared URL shape never assigns identity from a bare numeric suffix", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet ii"], 1, { selectors: { listingIdPattern: undefined } }), options(h), deps(h));
    expect(summary.failures[0]).toMatchObject({ code: "JOB_ID_MISSING" });
    expect(h.confirmCalls).toEqual([]);
    expect(existsSync(jobsFile(h))).toBe(false);
    await expectChromeGone(h);
  }, T);

  it("repeating the same search keeps exactly one authoritative record (same id, first-seen time, one observation) and preserves earlier records", async () => {
    const h = harness();
    await runSearchDiscovery(resolvedTarget(["security engineer"], 2, { selection: { openReview: true } }), options(h), deps(h));
    const earlier = loadJobs(jobsFile(h));
    expect(earlier).toHaveLength(2);

    await runSearchDiscovery(resolvedTarget(["sdet ii"]), options(h), deps(h)); // a different job joins; earlier ones stay
    const afterNew = loadJobs(jobsFile(h));
    expect(afterNew).toHaveLength(3);
    for (const e of earlier) expect(afterNew.find((j) => j.id === e.id)).toMatchObject({ title: e.title, jdContentHash: e.jdContentHash, discoveredAt: e.discoveredAt });

    const first = afterNew.find((j) => j.title === "SDET II")!;
    await runSearchDiscovery(resolvedTarget(["sdet ii"]), options(h), deps(h)); // the same job again
    const second = loadJobs(jobsFile(h));
    expect(second).toHaveLength(3);
    const again = second.find((j) => j.title === "SDET II")!;
    expect(again.id).toBe(first.id);
    expect(again.discoveredAt).toBe(first.discoveredAt);
    expect(again.lastSeenAt >= first.lastSeenAt).toBe(true);
    expect(again.jdContentHash).toBe(first.jdContentHash);
    expect(again.sourceObservations).toHaveLength(1);
    await expectChromeGone(h);
  }, 150_000);

  it("two distinct requisitions with identical title, location and description stay two records", async () => {
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet ii"], 2), options(h), deps(h));
    expect(summary.persistedCount).toBe(2);
    const saved = loadJobs(jobsFile(h));
    expect(saved.map((j) => j.atsIdentity).sort()).toEqual(["greenhouse:acme:1000001", "greenhouse:acme:1000006"]);
    expect(new Set(saved.map((j) => j.descriptionText)).size).toBe(1);
    expect(new Set(saved.map((j) => j.id)).size).toBe(2);
    await expectChromeGone(h);
  }, T);

  it("blocks and records non-loopback requests the page tries to make, without breaking the run", async () => {
    state.externalCalls = true;
    const h = harness();
    const summary = await runSearchDiscovery(resolvedTarget(["sdet ii"]), options(h), deps(h));
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
    writeFileSync(jobsFile(h), corrupt);
    await expect(runSearchDiscovery(resolvedTarget(["sdet"]), options(h), deps(h))).rejects.toBeInstanceOf(JobStoreError);
    expect(h.launches).toBe(0);
    expect(readFileSync(jobsFile(h), "utf-8")).toBe(corrupt);
  }, T);

  it("a storage failure after Chrome launched still closes the owned browser and saves nothing partial", async () => {
    const h = harness();
    // A competing writer corrupts the store once the browser is up (after the startup read).
    const run = runSearchDiscovery(resolvedTarget(["sdet ii"]), options(h), deps(h, () => writeFileSync(jobsFile(h), "garbage left by another writer\n")));
    await expect(run).rejects.toMatchObject({ code: "CORRUPT_RECORD" });
    expect(h.closes).toHaveLength(1);
    expect(readFileSync(jobsFile(h), "utf-8")).toBe("garbage left by another writer\n");
    await expectChromeGone(h);
  }, T);
});

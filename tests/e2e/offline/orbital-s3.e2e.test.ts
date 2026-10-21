import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright";
import { createAiClient, type AiClient } from "../../../src/ai/client.js";
import { closePersistentChrome, launchPersistentChrome } from "../../../src/browser/launcher.js";
import {
  buildResumeFixtures, dbAvailable, freePort, getJson, login, postJson, pythonAvailable, startAiService, startHarness, upload, type AiService, type Harness,
} from "../../helpers/s1-harness.js";
import { BOARDS, DEFAULT_REPLIES, fakeBoardFetch, type BoardReply } from "../../helpers/s3-fixtures.js";
import { ensureWebBuild, waitForPreview } from "../../helpers/web-build.js";

// Browser acceptance for the Orbital app and S3: headed Chrome drives the REAL Astro build -> real Fastify API -> real Python extractor ->
// real PostgreSQL (throwaway database) -> the real official-board reader and verification, with only the HTTP fetch to the public board
// APIs replaced by synthetic payloads. A synthetic résumé is uploaded, facts are approved, roles are selected, official discovery runs and
// its listings are inspected. Every route is checked at 1440, 768, 390 and 360 px for horizontal overflow and screenshotted into
// docs/evidence/orbital-screens (synthetic data only). Every non-loopback request is aborted and counted.

function pw(locator: Locator) {
  const poll = <T>(read: () => Promise<T>, timeout = 20_000) => expect.poll(read, { timeout, interval: 100 });
  return {
    toBeVisible: () => poll(() => locator.first().isVisible().catch(() => false)).toBe(true),
    toBeHidden: () => poll(() => locator.first().isHidden().catch(() => true)).toBe(true),
    toContainText: (text: string) => poll(async () => (await locator.first().textContent().catch(() => null)) ?? "").toContain(text),
    toHaveText: (text: string) => poll(async () => ((await locator.first().textContent().catch(() => null)) ?? "").trim()).toBe(text),
    toHaveCount: (n: number) => poll(() => locator.count()).toBe(n),
    toHaveAttribute: (name: string, value: string) => poll(() => locator.first().getAttribute(name).catch(() => null)).toBe(value),
  };
}

const WEB_DIR = path.resolve("web");
const ASTRO = path.join(WEB_DIR, "node_modules", "astro", "bin", "astro.mjs");
const SHOTS = path.resolve("docs", "evidence", "orbital-screens");
const ready = (await dbAvailable()) && pythonAvailable() && existsSync(ASTRO);
const suite = ready ? describe : describe.skip;
const WIDTHS = [1440, 768, 390, 360] as const;

/** Capture away from the evidence path, then copy. A locked PNG must not fail a layout check that already passed. */
async function saveShot(page: Page, name: string, fullPage = false): Promise<void> {
  const dest = path.join(SHOTS, name);
  const temp = path.join(os.tmpdir(), `orbital-${process.pid}-${name}`);
  await page.screenshot({ path: temp, fullPage });
  try {
    copyFileSync(temp, dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "UNKNOWN" && code !== "EBUSY" && code !== "EPERM") throw error;
  }
}

suite("Orbital app and S3 official discovery (headed Chrome)", () => {
  let service: AiService;
  let ai: AiClient;
  let h: Harness;
  let apiUp = false;
  let preview: ChildProcess;
  let context: BrowserContext;
  let profileDir: string;
  let fixtureDir: string;
  let webPort: number;
  let apiPort: number;
  let store: { dbName: string; uploadDir: string } | undefined;
  let replies: Record<string, BoardReply> = { ...DEFAULT_REPLIES };
  let boardCalls: string[] = [];
  let resumeId = "";
  const external: string[] = [];
  const problems: string[] = [];
  const previewLog: string[] = [];
  const web = (p = "/") => `http://127.0.0.1:${webPort}${p}`;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const f = fakeBoardFetch(replies);
    const out = await f(input, init);
    boardCalls.push(...f.calls);
    return out;
  }) as typeof fetch;

  const startApi = async (): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        h = await startHarness(ai, {
          env: { JH_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://127.0.0.1:4321`, JH_API_PORT: String(apiPort) },
          serverDeps: { boards: () => BOARDS, runnerOptions: { fetchImpl, delayMs: 0 } }, ...(store ? { existing: store } : {}),
        });
        store = { dbName: h.dbName, uploadDir: h.uploadDir };
        await h.app.listen({ host: "127.0.0.1", port: apiPort });
        apiUp = true;
        return;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  const stopApi = async (): Promise<void> => {
    await h.close();
    apiUp = false;
  };

  beforeAll(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), "jh-orb-fixtures-"));
    buildResumeFixtures(fixtureDir);
    mkdirSync(SHOTS, { recursive: true });
    service = await startAiService();
    webPort = await freePort();
    apiPort = await freePort();
    ai = createAiClient({ baseUrl: `http://127.0.0.1:${service.port}`, serviceToken: service.token, timeoutMs: 60_000 });
    await startApi();
    await ensureWebBuild();
    preview = spawn(process.execPath, [ASTRO, "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JH_API_URL: `http://127.0.0.1:${apiPort}` },
    });
    preview.stdout?.on("data", (d: Buffer) => previewLog.push(String(d)));
    preview.stderr?.on("data", (d: Buffer) => previewLog.push(String(d)));
    await waitForPreview(`http://127.0.0.1:${webPort}/`, preview, previewLog);
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-orb-profile-"));
    context = await launchPersistentChrome(profileDir, { headless: false });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const warm = await context.newPage();
    await warm.goto(web("/dashboard")).catch(() => undefined);
    await warm.waitForSelector("#signin-panel:not([hidden]), #gate-status:not([hidden])", { timeout: 40_000 }).catch(() => undefined);
    await warm.close();

    // Synthetic candidate, set up through the same API the UI uses: upload, classify and approve facts, choose a role.
    const s = await login(h);
    const up = await upload(h, s, readFileSync(path.join(fixtureDir, "c01-soc-analyst-docx.docx")));
    resumeId = up.json().resumeId as string;
    for (let i = 0; i < 150; i += 1) {
      if ((await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body.state === "PROPOSED") break;
      if (i === 149) throw new Error("the synthetic résumé was not extracted in time");
      await new Promise((r) => setTimeout(r, 200));
    }
    const facts = async () => (await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body.facts as Array<any>;
    const review = async (factId: string, action: string, extra: Record<string, unknown> = {}) =>
      postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId, action, expectedDigest: (await facts()).find((f) => f.factId === factId)!.contentDigest, ...extra });
    for (const f of (await facts()).filter((x) => x.kind === "employment")) {
      await review(f.factId, "edit", { edit: { value: f.value, attributes: { ...f.attributes, employmentType: "professional" } } });
      await review(f.factId, "approve");
    }
    for (const [kind, value] of [["skill", "Splunk"], ["skill", "Microsoft Sentinel"], ["certification", "CompTIA Security+"]] as const) {
      await review((await facts()).find((x) => x.kind === kind && x.value === value)!.factId, "approve");
    }
    const catalog = (await getJson(h, s, "/api/v1/roles/catalog")).body;
    const saved = await postJson(h, s, "/api/v1/roles/selections", {
      expectedRevision: 0, expectedCatalogVersion: catalog.catalogVersion, targetFamilies: ["soc-blue-team"], roleSlugs: ["soc-analyst"],
      locations: [{ kind: "country", value: "United States" }, { kind: "remote", value: "Remote" }], workModes: ["remote"], seniorityLevels: ["entry", "junior"], searchBand: { minYears: 0, maxYears: 5 },
    });
    expect(saved.status).toBe(200);
  }, 240_000);

  afterAll(async () => {
    if (context) await closePersistentChrome(context, profileDir).catch(() => undefined);
    preview?.kill();
    service?.stop();
    if (apiUp) await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
    for (const dir of [fixtureDir, profileDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  beforeEach(async () => {
    if (!apiUp) await startApi();
  }, 60_000);

  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail") console.log("BROWSER DIAGNOSTICS", JSON.stringify({ problems, external, apiUp, previewLog: previewLog.join("").slice(-1500) }, null, 1));
  });

  const track = (page: Page) => {
    const apiCalls: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) apiCalls.push(`${r.method()} ${u.pathname}`);
    });
    return { apiCalls };
  };
  const signedIn = async (page: Page, url: string) => {
    await page.goto(web(url));
    await page.waitForSelector("#app:not([hidden]), #signin-panel:not([hidden])", { timeout: 30_000 });
    if (await page.locator("#signin-panel").isVisible()) {
      await page.fill("#token", "a".repeat(40));
      await page.click("#signin");
    }
    await pw(page.locator("#app")).toBeVisible();
  };

  it("the public Orbital landing at / needs no API: it renders with Fastify stopped, and every link goes somewhere real", async () => {
    await stopApi();
    const page = await context.newPage();
    const seen = track(page);
    await page.goto(web("/"));
    await pw(page.locator("h1#hero-title")).toContainText("Discover");
    await pw(page.locator(".hero-visual svg.graphic-art")).toBeVisible();
    expect(seen.apiCalls).toEqual([]); // not even a session probe
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href") ?? ""));
    expect(hrefs.filter((x) => x === "#" || x === "").length).toBe(0); // no inert links
    for (const href of new Set(hrefs)) {
      if (href.startsWith("#")) expect(await page.locator(`${href}`).count(), href).toBeGreaterThan(0);
      else expect((await context.request.get(web(href))).status(), href).toBe(200);
    }
    for (const label of ["How it works", "Career paths", "Log in", "Get started"]) await pw(page.locator("header.site-header").getByText(label).first()).toBeVisible();
    await saveShot(page, "landing-fastify-stopped.png");
    await page.close();
    await startApi();
  }, 240_000);

  it("the same landing is still served at /orbital", async () => {
    const page = await context.newPage();
    await page.goto(web("/orbital"));
    await pw(page.locator("h1#hero-title")).toContainText("skills");
    await page.close();
  }, 60_000);

  it("signed out, every private route shows Orbital sign-in and requests no private data", async () => {
    const page = await context.newPage();
    const seen = track(page);
    for (const route of ["/dashboard", "/resumes", `/review?id=${resumeId}`, "/roles", "/jobs", "/profile"]) {
      seen.apiCalls.length = 0;
      await context.clearCookies();
      await page.goto(web(route));
      await pw(page.locator("#signin-panel")).toBeVisible();
      await pw(page.locator("#app")).toBeHidden();
      expect(seen.apiCalls, route).toEqual(["GET /api/v1/session"]);
    }
    await page.close();
  }, 120_000);

  it("S1 -> S2 -> S3 in the browser: pending state, selection snapshot, run progress, official listings, JD detail, reload", async () => {
    const page = await context.newPage();
    const seen = track(page);
    await signedIn(page, "/dashboard");
    await pw(page.locator('.app-nav a[aria-current="page"]')).toHaveText("Dashboard");
    await pw(page.locator("#next-title")).toContainText("Review");

    // S1/S2 pages still carry their features under the Orbital shell
    await page.click('.app-nav a[href="/resumes"]');
    await pw(page.locator("#resumes tr .state")).toHaveText("PROPOSED");
    await page.click("text=Review facts");
    await pw(page.locator("#facts tr").first()).toBeVisible();
    await pw(page.locator("ol[aria-label='Breadcrumb'] li, nav[aria-label='Breadcrumb'] li").first()).toBeVisible();
    await page.click('.app-nav a[href="/roles"]');
    await pw(page.locator('.role-card[data-role="soc-analyst"]')).toBeVisible();
    await pw(page.locator('input[name="role"][value="soc-analyst"]')).toBeVisible();

    // S3: the page starts honestly empty, with the saved selection as the snapshot
    await page.click('.app-nav a[href="/jobs"]');
    await pw(page.locator('.app-nav a[aria-current="page"]')).toHaveText("Jobs");
    await pw(page.locator("#plan-roles [data-role='soc-analyst']")).toHaveText("SOC Analyst");
    await pw(page.locator("#plan-body")).toContainText("Saved selection revision 1");
    await pw(page.locator("#results-empty")).toContainText("No listings yet");
    await pw(page.locator("#start-run")).toBeVisible();
    expect(await page.locator("#start-run").isEnabled()).toBe(true);
    await saveShot(page, "jobs-before-run-1440.png", true);

    // run it (slow boards, so progress is observable)
    replies = Object.fromEntries(Object.entries(DEFAULT_REPLIES).map(([k, v]) => [k, { ...(v as object), delayMs: 450 }]));
    boardCalls = [];
    await page.click("#start-run");
    await pw(page.locator("#run-card")).toBeVisible();
    await expect.poll(async () => (await page.locator("#run-status").getAttribute("data-status")) ?? "", { timeout: 15_000 }).toMatch(/QUEUED|RUNNING/);
    expect(await page.locator("#start-run").isDisabled()).toBe(true); // one run at a time
    await pw(page.locator("#cancel-run")).toBeVisible();
    await expect.poll(async () => (await page.locator("#run-status").getAttribute("data-status")) ?? "", { timeout: 30_000 }).toBe("PARTIAL");
    replies = { ...DEFAULT_REPLIES };

    await pw(page.locator("#run-counts")).toContainText("Verified official");
    await pw(page.locator('#run-counts .count.hl .n')).toHaveText("5");
    await pw(page.locator('#boards-body tr[data-board="greenhouse:blockedco"]')).toContainText("blocked by the source");
    await pw(page.locator('#boards-body tr[data-board="greenhouse:goneinc"]')).toContainText("BOARD_NOT_FOUND");
    await pw(page.locator("#results .job")).toHaveCount(5);
    await pw(page.locator("#results-total")).toHaveText("5 listings");

    // a listing shows the official source, honest flags and NO eligibility claim
    const acme = page.locator('.job[data-req="1001"]');
    await pw(acme).toContainText("SOC Analyst I");
    await pw(acme).toContainText("Official source verified");
    await pw(acme).toContainText("Asks for 2+ years: inside your window");
    await pw(acme).toContainText("Eligibility not evaluated yet");
    expect(await acme.locator('a[data-action="official"]').getAttribute("href")).toBe("https://boards.greenhouse.io/acmesec/jobs/1001");
    expect(await acme.locator('a[data-action="official"]').getAttribute("rel")).toBe("noopener noreferrer");
    const text = (await page.locator("#results").textContent()) ?? "";
    expect(text).not.toMatch(/\d+\s*%|\$\s*\d|you qualify|you are eligible|great match/i);
    await saveShot(page, "jobs-after-run-1440.png", true);

    // filters (server-side)
    await page.selectOption("#f-band", "OUTSIDE");
    await page.click('#filters button[type="submit"]');
    await pw(page.locator("#results .job")).toHaveCount(1);
    await pw(page.locator("#results .job").first()).toContainText("outside your window");
    await page.selectOption("#f-band", "");
    await page.fill("#f-company", "globex");
    await page.click('#filters button[type="submit"]');
    await pw(page.locator("#results .job")).toHaveCount(1);
    await page.fill("#f-company", "");
    await page.click('#filters button[type="submit"]');
    await pw(page.locator("#results .job")).toHaveCount(5);

    // full job description, verbatim, with identity and version
    await acme.locator('button[data-action="detail"]').click();
    await pw(page.locator("#detail-card")).toBeVisible();
    await pw(page.locator("#jd-text")).toContainText("2+ years of experience in a security operations center");
    await pw(page.locator("#d-identity")).toHaveText("greenhouse:acmesec:1001");
    await page.click("#detail-close");
    await pw(page.locator("#detail-card")).toBeHidden();

    // persistence across reload
    await page.reload();
    await pw(page.locator("#app")).toBeVisible();
    await pw(page.locator("#results .job")).toHaveCount(5);
    await pw(page.locator("#run-status")).toHaveText("Partial");
    await pw(page.locator("#start-run")).toBeVisible();

    // the dashboard now reports real S3 numbers, and still no eligibility claim
    await page.goto(web("/dashboard"));
    await pw(page.locator('#pipeline li[data-step="S3"]')).toHaveAttribute("data-status", "done");
    await pw(page.locator("#s3-card")).toContainText("5 verified official listings");

    // safety: only the board APIs were read, with GET; no apply/submit; only the run start was a state-changing request
    expect(boardCalls.length).toBeGreaterThan(0);
    for (const c of boardCalls) expect(c).toMatch(/^GET https:\/\/(boards-api\.greenhouse\.io|api\.lever\.co)\//);
    const writes = seen.apiCalls.filter((c) => !c.startsWith("GET "));
    expect(writes.filter((c) => !/\/api\/v1\/discovery-runs$/.test(c) && !/\/api\/v1\/session$/.test(c))).toEqual([]);
    expect(seen.apiCalls.some((c) => /apply|submit/i.test(c))).toBe(false);
    await page.close();
  }, 300_000);

  it("with Fastify stopped, /jobs shows a recoverable error (not a blank page), and recovers when the API returns", async () => {
    const page = await context.newPage();
    track(page);
    await signedIn(page, "/jobs");
    await pw(page.locator("#results .job")).toHaveCount(5);
    await stopApi();
    await page.reload();
    await pw(page.locator("#gate-status")).toHaveAttribute("data-state", "unavailable");
    await pw(page.locator("#gate-retry")).toBeVisible();
    await pw(page.locator("#app")).toBeHidden();
    await pw(page.locator('header a[href="/roles"]')).toBeVisible();
    await saveShot(page, "jobs-fastify-stopped-1440.png");
    await startApi();
    for (let attempt = 0; attempt < 4 && !(await page.locator("#app").isVisible()); attempt += 1) {
      await page.click("#gate-retry");
      await page.waitForSelector("#app:not([hidden]), #gate-retry:not([hidden])", { timeout: 40_000 });
    }
    await pw(page.locator("#results .job")).toHaveCount(5); // persisted in PostgreSQL across the API restart
    await page.close();
  }, 240_000);

  it("a blocked employer is a visible, typed failure and never hides the other boards", async () => {
    // Block every board. The run fails truthfully; earlier listings stay.
    replies = Object.fromEntries(Object.keys(DEFAULT_REPLIES).map((k) => [k, { status: 429, body: {} }]));
    const page = await context.newPage();
    track(page);
    await signedIn(page, "/jobs");
    await page.click("#start-run");
    await expect.poll(async () => (await page.locator("#run-status").getAttribute("data-status")) ?? "", { timeout: 30_000 }).toBe("FAILED");
    await pw(page.locator('#boards-body tr[data-board="greenhouse:acmesec"]')).toContainText("blocked by the source");
    await pw(page.locator("#results .job")).toHaveCount(5); // listings from the earlier run are untouched
    replies = { ...DEFAULT_REPLIES };
    await page.close();
  }, 120_000);

  it("every Orbital screen fits 1440, 768, 390 and 360 px without horizontal scroll, and is keyboard- and reduced-motion-safe", async () => {
    const routes: Array<[string, string]> = [
      ["landing", "/"], ["dashboard", "/dashboard"], ["resumes", "/resumes"], ["review", `/review?id=${resumeId}`], ["roles", "/roles"], ["jobs", "/jobs"], ["profile", "/profile"],
    ];
    const page = await context.newPage();
    track(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signedIn(page, "/dashboard");
    for (const [name, route] of routes) {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(web(route));
        if (name === "landing") await pw(page.locator("h1#hero-title")).toBeVisible();
        else {
          await page.waitForSelector("#app:not([hidden])", { timeout: 30_000 });
          await page.waitForLoadState("networkidle").catch(() => undefined);
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `${name} at ${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(1);
        await saveShot(page, `${name}-${width}.png`, width === 1440 || width === 390);
      }
    }

    // keyboard only: Tab reaches the Start button on /jobs and shows a visible focus ring
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(web("/jobs"));
    await page.waitForSelector("#app:not([hidden])", { timeout: 30_000 });
    let reached = false;
    for (let i = 0; i < 60 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.id === "start-run");
    }
    expect(reached).toBe(true);
    const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement!); return [s.outlineStyle, parseFloat(s.outlineWidth)] as const; });
    expect(ring[0]).not.toBe("none");
    expect(ring[1]).toBeGreaterThanOrEqual(2);

    // reduced motion: animated elements are still
    await page.goto(web("/"));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".orbit-spin")!).animationName)).toBe("none");
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".floating-pill")!).animationName)).toBe("none");
    await page.close();
    expect(external).toEqual([]);
    expect(problems.filter((p2) => p2.startsWith("pageerror"))).toEqual([]);
  }, 600_000);
});

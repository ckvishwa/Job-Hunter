import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright";
import { createAiClient, type AiClient } from "../../../src/ai/client.js";
import { closePersistentChrome, launchPersistentChrome } from "../../../src/browser/launcher.js";
import {
  buildResumeFixtures, dbAvailable, freePort, getJson, login, postJson, pythonAvailable, startAiService, startHarness, upload,
  type AiService, type Harness,
} from "../../helpers/s1-harness.js";
import { ensureWebBuild, waitForPreview } from "../../helpers/web-build.js";
import { BOARDS, DEFAULT_REPLIES, fakeBoardFetch } from "../../helpers/s3-fixtures.js";
import { readFileSync } from "node:fs";

// Offline browser E2E for the home dashboard (/): headed Chrome drives the REAL Astro build -> real Fastify API -> real Python
// extractor -> real PostgreSQL (throwaway database). It covers the dashboard with the API up, with the API stopped and recovered,
// signed out, expired, brand new, populated, and when one section or the whole session call fails. Every non-loopback request is
// aborted and counted. No real resume, job site or application is involved.

function pw(locator: Locator) {
  const poll = <T>(read: () => Promise<T>, timeout = 15_000) => expect.poll(read, { timeout, interval: 100 });
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
const ready = (await dbAvailable()) && pythonAvailable() && existsSync(ASTRO);
const suite = ready ? describe : describe.skip;
const EN_DASH = "–";

suite("Home dashboard (headed Chrome)", () => {
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
  const external: string[] = [];
  const problems: string[] = [];
  const previewLog: string[] = [];
  const web = (p = "/") => `http://127.0.0.1:${webPort}${p}`;

  let store: { dbName: string; uploadDir: string } | undefined;
  const startApi = async (): Promise<void> => {
    // Only the (re)connection is retried: loopback connects on this machine can stall (docs/KNOWN_FLAKES.md, seventh entry). No assertion is retried.
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        h = await startHarness(ai, { env: { JH_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://127.0.0.1:4321`, JH_API_PORT: String(apiPort) }, serverDeps: { boards: () => BOARDS, runnerOptions: { fetchImpl: fakeBoardFetch(DEFAULT_REPLIES), delayMs: 0 } }, ...(store ? { existing: store } : {}) });
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
  /** Stops Fastify and its pool (the database and uploads stay), so the UI server's proxy sees a dead API. */
  const stopApi = async (): Promise<void> => {
    await h.close();
    apiUp = false;
  };

  beforeAll(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), "jh-dash-fixtures-"));
    buildResumeFixtures(fixtureDir);
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
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-dash-profile-"));
    context = await launchPersistentChrome(profileDir, { headless: false });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    // Warm-up: the first navigation of a fresh Chrome profile pays the cold-start/loopback cost (docs/KNOWN_FLAKES.md). Nothing is asserted here.
    const warm = await context.newPage();
    await warm.goto(web("/dashboard")).catch(() => undefined);
    await warm.waitForSelector("#signin-panel:not([hidden]), #gate-status:not([hidden])", { timeout: 40_000 }).catch(() => undefined);
    await warm.close();
  }, 180_000);

  afterAll(async () => {
    if (context) await closePersistentChrome(context, profileDir).catch(() => undefined);
    preview?.kill();
    service?.stop();
    if (apiUp) await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
    for (const dir of [fixtureDir, profileDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  // A failed test must not leave the API stopped for the next one (ordered tests would otherwise cascade).
  beforeEach(async () => {
    if (!apiUp) await startApi();
  }, 60_000);

  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail") console.log("BROWSER DIAGNOSTICS", JSON.stringify({ problems, external, apiUp, previewLog: previewLog.join("").slice(-1500) }, null, 1));
  });

  const track = (page: Page) => {
    const sessionGets: string[] = [];
    const apiCalls: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith("/api/")) return;
      apiCalls.push(`${r.method()} ${u.pathname}`);
      if (u.pathname === "/api/v1/session" && r.method() === "GET") sessionGets.push(r.url());
    });
    return { sessionGets, apiCalls };
  };
  const signInUi = async (page: Page, token = "a".repeat(40)) => {
    await page.fill("#token", token);
    await page.click("#signin");
  };
  const gateState = (page: Page) => page.locator("#gate-status");
  /** Waits for either the page or the sign-in form, and signs in only if the form is what appeared. */
  const ensureSignedIn = async (page: Page) => {
    await page.waitForSelector("#app:not([hidden]), #signin-panel:not([hidden])", { timeout: 15_000 });
    if (await page.locator("#signin-panel").isVisible()) await signInUi(page);
  };

  it("signed out: the page is never blank, shows a sign-in, and requests no private data", async () => {
    const page = await context.newPage();
    const seen = track(page);
    await page.goto(web("/dashboard"));
    await pw(page.locator("#signin-panel")).toBeVisible();
    await pw(page.locator("#app")).toBeHidden();
    await pw(page.locator('header a[href="/roles"]')).toBeVisible(); // navigation is present
    await pw(page.locator("#signin-note")).toBeHidden(); // a first visit is "signed out", not "expired"
    expect(await page.locator("#app").textContent()).not.toMatch(/Approved|Pending|Rejected|SOC/); // nothing private was rendered into the hidden app
    expect(seen.apiCalls).toEqual(["GET /api/v1/session"]); // exactly one request, and no data endpoint

    const direct = await page.evaluate(async () => {
      const res = await fetch("/api/v1/resumes");
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    });
    expect(direct).toEqual([401, "UNAUTHENTICATED"]);

    await signInUi(page, "x".repeat(40)); // wrong token: visible error, still signed out
    await pw(page.locator("#signin-msg")).toContainText("not correct");
    await pw(page.locator("#app")).toBeHidden();
    await page.close();
  }, 60_000);

  it("brand-new user: the dashboard shows honest empty states, a next step and an upcoming S3", async () => {
    const page = await context.newPage();
    track(page);
    await page.goto(web("/dashboard"));
    await signInUi(page);
    await pw(page.locator("#app")).toBeVisible();
    await pw(page.locator("#next-title")).toHaveText("Upload your resume");
    await pw(page.locator("#next-link")).toHaveAttribute("href", "/resumes");
    for (const key of ["approved", "pending", "rejected"]) await pw(page.locator(`[data-count="${key}"] .n`)).toHaveText("0");
    await pw(page.locator('#pipeline li[data-step="S1"]')).toHaveAttribute("data-status", "not-started");
    await pw(page.locator('#pipeline li[data-step="S2"]')).toHaveAttribute("data-status", "not-started");
    await pw(page.locator('#pipeline li[data-step="S3"]')).toHaveAttribute("data-status", "not-started"); // no selection yet
    await pw(page.locator("#exp-summary")).toHaveText("No experience is counted yet.");
    await pw(page.locator("#roles-empty")).toBeVisible();
    await pw(page.locator("#sel-empty")).toBeVisible();
    await pw(page.locator("#s3-card")).toContainText("Starts once you save a role selection");
    await pw(page.locator("#resume-line")).toContainText("No resume uploaded yet");
    const text = (await page.locator("#app").textContent()) ?? "";
    expect(text).not.toMatch(/\d+\s*%/); // no fit percentages
    expect(text).not.toMatch(/\$\s*\d/); // no salaries
    expect(text).not.toMatch(/\d+ (open )?jobs? (found|matched)/i);

    // the buttons lead to the existing pages
    await page.click("#next-link");
    await pw(page.locator("#file")).toBeVisible(); // /resumes
    expect(new URL(page.url()).pathname).toBe("/resumes");
    await page.goto(web("/dashboard"));
    await page.click('#roles-card a[href="/roles"]');
    await pw(page.locator("#experience-status")).toBeVisible();
    await page.close();
  }, 90_000);

  it("API stopped: a visible 'cannot reach API' state with Retry, one session request per attempt, and recovery without a reload", async () => {
    const page = await context.newPage();
    const seen = track(page);
    await page.goto(web("/dashboard"));
    await pw(page.locator("#app")).toBeVisible(); // signed in from the previous test's cookie
    await stopApi();

    seen.sessionGets.length = 0;
    await page.reload();
    await pw(gateState(page)).toBeVisible();
    await pw(gateState(page)).toHaveAttribute("data-state", "unavailable");
    await pw(page.locator("#gate-title")).toContainText("Can't reach the Job Hunter API");
    await pw(page.locator("#gate-text")).toContainText("npm run dev:stack");
    await pw(page.locator("#gate-retry")).toBeVisible();
    await pw(page.locator("#app")).toBeHidden();
    await pw(page.locator("#signin-panel")).toBeHidden(); // an outage is not a login problem
    await pw(page.locator('header a[href="/roles"]')).toBeVisible();
    expect(seen.sessionGets).toHaveLength(1);

    await page.click("#gate-retry"); // still down: same state, exactly one more request
    await pw(gateState(page)).toHaveAttribute("data-state", "unavailable");
    await pw(page.locator("#gate-retry")).toBeVisible();
    await expect.poll(() => seen.sessionGets.length, { timeout: 10_000 }).toBe(2);

    await startApi(); // the API comes back
    // Loopback connects on this machine can stall for seconds (docs/KNOWN_FLAKES.md); the UI times a request out and shows Try again, and a
    // person would press it. Each attempt waits for a definite outcome, so a stall costs time but never correctness.
    for (let attempt = 0; attempt < 4 && !(await page.locator("#app").isVisible()); attempt += 1) {
      await page.click("#gate-retry");
      await page.waitForSelector("#app:not([hidden]), #gate-retry:not([hidden])", { timeout: 40_000 });
    }
    await pw(page.locator("#app")).toBeVisible();
    await pw(page.locator("#next-title")).toHaveText("Upload your resume");
    await pw(gateState(page)).toBeHidden();
    await page.close();
  }, 240_000);

  it("expired or cleared session shows an 'expired' sign-in, not a blank page, and signing in restores the dashboard", async () => {
    const page = await context.newPage();
    track(page);
    await page.goto(web("/dashboard"));
    await pw(page.locator("#app")).toBeVisible();
    await context.clearCookies();
    await page.reload();
    await pw(page.locator("#signin-panel")).toBeVisible();
    await pw(page.locator("#signin-note")).toContainText("expired");
    await pw(page.locator("#app")).toBeHidden();
    await signInUi(page);
    await pw(page.locator("#app")).toBeVisible();
    await pw(page.locator("#signin-panel")).toBeHidden();
    await page.close();
  }, 60_000);

  it("offline is its own state, and coming back online re-checks once without a click", async () => {
    const page = await context.newPage();
    const seen = track(page);
    await page.goto(web("/dashboard"));
    await pw(page.locator("#app")).toBeVisible();
    await stopApi();
    await page.reload();
    await pw(gateState(page)).toHaveAttribute("data-state", "unavailable");

    await context.setOffline(true);
    try {
      await page.click("#gate-retry");
      await pw(gateState(page)).toHaveAttribute("data-state", "offline");
      await pw(page.locator("#gate-title")).toContainText("offline");
      await pw(page.locator("#gate-retry")).toBeVisible();
    } finally {
      await startApi();
      seen.sessionGets.length = 0;
      await context.setOffline(false); // the browser's "online" event triggers one automatic re-check
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await page.waitForSelector("#app:not([hidden]), #gate-retry:not([hidden])", { timeout: 40_000 });
      if (await page.locator("#app").isVisible()) break;
      await page.click("#gate-retry");
    }
    await pw(page.locator("#app")).toBeVisible();
    expect(seen.sessionGets.length).toBeGreaterThanOrEqual(1);
    await page.close();
  }, 240_000);

  it("an unexpected server error, a proxy-style outage and a recovered API are three different states", async () => {
    const page = await context.newPage();
    track(page);
    await page.goto(web("/dashboard"));
    await pw(page.locator("#app")).toBeVisible();

    await page.route("**/api/v1/session", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }) }));
    await page.reload();
    await pw(gateState(page)).toHaveAttribute("data-state", "error");
    await pw(page.locator("#gate-title")).toContainText("unexpected error");
    await pw(page.locator("#gate-retry")).toBeVisible();
    await pw(page.locator("#signin-panel")).toBeHidden();

    await page.unroute("**/api/v1/session");
    await page.route("**/api/v1/session", (route) => route.fulfill({ status: 500, contentType: "text/plain", body: "" })); // what a dead upstream looks like through the proxy
    await page.click("#gate-retry");
    await pw(gateState(page)).toHaveAttribute("data-state", "unavailable");

    await page.unroute("**/api/v1/session");
    await page.click("#gate-retry");
    await pw(page.locator("#app")).toBeVisible();
    await page.close();
  }, 60_000);

  it("one failing section does not blank the dashboard; its own retry recovers it", async () => {
    const page = await context.newPage();
    track(page);
    await page.route("**/api/v1/roles/recommendations", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "boom" } }) }));
    await page.goto(web("/dashboard"));
    await pw(page.locator("#app")).toBeVisible();
    await pw(page.locator("#partial")).toBeVisible();
    await pw(page.locator("#partial-text")).toContainText("roles");
    await pw(page.locator("#roles-error")).toBeVisible();
    await pw(page.locator("#sel-error")).toBeVisible();
    await pw(page.locator("#next-title")).toHaveText("Upload your resume"); // sections that did load still work
    await page.unroute("**/api/v1/roles/recommendations");
    await page.click("#partial-retry");
    await pw(page.locator("#partial")).toBeHidden();
    await pw(page.locator("#roles-empty")).toBeVisible();
    await page.close();
  }, 60_000);

  it("populated user: counts, experience, roles and selection match the API and database, survive reload, and S3 stays upcoming", async () => {
    // --- set up through the API (the same API the UI uses), then judge the UI against the database -----------------------------------
    const s = await login(h);
    const up = await upload(h, s, readFileSync(path.join(fixtureDir, "c01-soc-analyst-docx.docx")));
    expect(up.statusCode).toBe(202);
    const { resumeId } = up.json() as { resumeId: string };
    await expect.poll(async () => ((await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body as { state: string }).state, { timeout: 30_000 }).toBe("PROPOSED");
    const facts = async () => ((await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body as { facts: Array<{ factId: string; kind: string; value: string; attributes: Record<string, unknown>; contentDigest: string; approvalStatus: string }> }).facts;
    const review = (factId: string, action: string, extra: Record<string, unknown> = {}) =>
      facts().then((all) => postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, { factId, action, expectedDigest: all.find((f) => f.factId === factId)!.contentDigest, ...extra }));

    for (const f of (await facts()).filter((x) => x.kind === "employment")) {
      expect((await review(f.factId, "edit", { edit: { value: f.value, attributes: { ...f.attributes, employmentType: "professional" } } })).status).toBe(200);
      expect((await review(f.factId, "approve")).status).toBe(200);
    }
    for (const [kind, value] of [["skill", "Splunk"], ["skill", "Microsoft Sentinel"], ["certification", "CompTIA Security+"]] as const) {
      const f = (await facts()).find((x) => x.kind === kind && x.value === value)!;
      expect((await review(f.factId, "approve")).status).toBe(200);
    }
    expect((await review((await facts()).find((x) => x.kind === "skill" && x.value === "SQL")!.factId, "reject")).status).toBe(200);

    const rolesState = (await getJson(h, s, "/api/v1/roles/recommendations")).body as {
      catalogVersion: number; experience: { buckets: { professional: { monthsLower: number; monthsUpper: number } } };
      recommendations: Array<{ roleSlug: string; title: string; familyTier: string }>;
    };
    const cyber = rolesState.recommendations.filter((r) => r.familyTier === "primary");
    expect(cyber.map((r) => r.roleSlug)).toContain("soc-analyst");
    const saved = await postJson(h, s, "/api/v1/roles/selections", {
      expectedRevision: 0, expectedCatalogVersion: rolesState.catalogVersion, targetFamilies: ["soc-blue-team"], roleSlugs: ["soc-analyst"],
      locations: [{ kind: "country", value: "United States" }, { kind: "remote", value: "Remote" }], workModes: ["remote"], seniorityLevels: ["junior"], searchBand: { minYears: 0, maxYears: 5 },
    });
    expect(saved.status).toBe(200);

    const counts = async () => {
      const rows = (await h.pool.query("SELECT approval_status, count(*)::int AS n FROM candidate_facts WHERE proposed_by <> 'user' GROUP BY 1")).rows as Array<{ approval_status: string; n: number }>;
      const n = (k: string) => rows.find((r) => r.approval_status === k)?.n ?? 0;
      return { approved: n("approved"), pending: n("pending"), rejected: n("rejected") };
    };
    const db = await counts();
    expect(db.approved).toBeGreaterThanOrEqual(5);
    expect(db.pending).toBeGreaterThan(0);
    expect(db.rejected).toBe(1);

    // --- the dashboard, in the browser ----------------------------------------------------------------------------------------------------------
    const page = await context.newPage();
    track(page);
    await page.goto(web("/dashboard"));
    await ensureSignedIn(page);
    await pw(page.locator("#app")).toBeVisible();
    const verifyDashboard = async (expected: { approved: number; pending: number; rejected: number }) => {
      for (const key of ["approved", "pending", "rejected"] as const) await pw(page.locator(`[data-count="${key}"] .n`)).toHaveText(String(expected[key]));
    };
    await verifyDashboard(db);
    await pw(page.locator("#resume-line")).toContainText("1 resume uploaded");
    await pw(page.locator('#pipeline li[data-step="S1"]')).toHaveAttribute("data-status", "in-progress"); // facts are still pending
    await pw(page.locator('#pipeline li[data-step="S2"]')).toHaveAttribute("data-status", "done"); // a role selection is saved
    await pw(page.locator('#pipeline li[data-step="S3"]')).toHaveAttribute("data-status", "not-started"); // selection saved, no discovery run yet
    await pw(page.locator("#next-title")).toHaveText(`Review ${db.pending} proposed fact${db.pending === 1 ? "" : "s"}`);
    await pw(page.locator("#next-link")).toHaveAttribute("href", `/review?id=${resumeId}`);

    const pro = rolesState.experience.buckets.professional;
    expect(pro.monthsLower).toBeGreaterThan(0);
    await pw(page.locator("#exp-summary")).toContainText(pro.monthsLower === pro.monthsUpper ? `${pro.monthsLower} months` : `${pro.monthsLower}${EN_DASH}${pro.monthsUpper} months`);
    await pw(page.locator("#exp-uncertainty")).toContainText("range, not an exact figure");

    await pw(page.locator('#roles-list [data-role="soc-analyst"]')).toBeVisible();
    await pw(page.locator("#roles-list article")).toHaveCount(Math.min(cyber.length, 6));
    await pw(page.locator('#sel-roles [data-role="soc-analyst"]')).toHaveText("SOC Analyst");
    await pw(page.locator("#sel-body")).toContainText("United States, Remote");
    await pw(page.locator("#sel-body")).toContainText("0–5 years requested");
    await pw(page.locator("#s3-card")).toContainText("Ready: read official employer boards for your selected roles");
    expect(((await page.locator("#app").textContent()) ?? "")).not.toMatch(/\d+\s*%|\$\s*\d/);
    if (process.env.JH_SHOT_DIR) await page.screenshot({ path: path.join(process.env.JH_SHOT_DIR, "dashboard-populated.png"), fullPage: true });

    // --- reload persistence: the same numbers come back from the database -------------------------------------------------------------
    await page.reload();
    await pw(page.locator("#app")).toBeVisible();
    await verifyDashboard(db);
    await pw(page.locator('#sel-roles [data-role="soc-analyst"]')).toBeVisible();

    // --- finishing review moves S1 to done and the next step to "nothing needed" -------------------------------------------------------------
    for (const f of (await facts()).filter((x) => x.approvalStatus === "pending")) expect((await review(f.factId, "reject")).status).toBe(200);
    const after = await counts();
    expect(after.pending).toBe(0);
    await page.reload();
    await verifyDashboard(after);
    await pw(page.locator('#pipeline li[data-step="S1"]')).toHaveAttribute("data-status", "done");
    await pw(page.locator("#next-title")).toHaveText("Find official openings for your roles");
    await pw(page.locator("#next-reason")).toContainText("official employer boards");
    await pw(page.locator("#next-link")).toHaveAttribute("href", "/jobs");

    // --- the buttons to the existing pages work ------------------------------------------------------------------------------------------------------
    await page.click("#link-review");
    await pw(page.locator("#facts tr").first()).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/review");
    await page.goto(web("/dashboard"));
    await page.click("#link-statements");
    await pw(page.locator("#attest-form")).toBeVisible();
    await page.close();

    expect(external).toEqual([]);
    expect(problems.filter((p) => p.startsWith("pageerror"))).toEqual([]);
  }, 180_000);
});

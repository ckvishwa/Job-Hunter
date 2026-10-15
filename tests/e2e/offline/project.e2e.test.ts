import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { registerProjectRoutes } from "../../../src/api/project-routes.js";
import { closePersistentChrome, launchPersistentChrome } from "../../../src/browser/launcher.js";
import { createProjectSources, type ProjectSources } from "../../../src/project/sources.js";
import { freePort } from "../../helpers/s1-harness.js";
import { makeProjectRoot, type ProjectRoot } from "../../helpers/project-fixtures.js";
import { ensureWebBuild, waitForHttp } from "../../helpers/web-build.js";

// Offline browser E2E for /project. Headed Chrome drives the REAL Astro build; its /api proxy points at a small Fastify app that
// mounts the REAL project routes over a synthetic checkout (no database, no Python, no candidate data, no network). The session
// endpoint is a stand-in so signed-out behavior can be exercised. The real session enforcement is covered in
// tests/project/project-auth.test.ts. Every non-loopback request is aborted and counted.

const WEB_DIR = path.resolve("web");
const ASTRO = path.join(WEB_DIR, "node_modules", "astro", "bin", "astro.mjs");
const suite = existsSync(ASTRO) ? describe : describe.skip;

suite("Project command center (headed Chrome)", { timeout: 40_000 }, () => {
  let api: FastifyInstance;
  let preview: ChildProcess;
  let context: BrowserContext;
  let profileDir: string;
  let webPort: number;
  let signedIn = true;
  let root: ProjectRoot;
  let empty: ProjectRoot;
  let activeSources: ProjectSources;
  const projectRequests: string[] = [];
  const external: string[] = [];
  const web = (p = "/project") => `http://127.0.0.1:${webPort}${p}`;

  beforeAll(async () => {
    root = makeProjectRoot();
    empty = makeProjectRoot({ ledgerRaw: null });
    activeSources = createProjectSources(root.root);
    const sources: ProjectSources = { readFixed: (n) => activeSources.readFixed(n), readOptional: (f) => activeSources.readOptional(f) };
    api = Fastify();
    api.get("/api/v1/session", async () => (signedIn ? { authenticated: true, csrfToken: "t", user: { handle: "local" } } : { authenticated: false }));
    api.post("/api/v1/session", async () => { signedIn = true; return { authenticated: true, csrfToken: "t", user: { handle: "local" } }; });
    api.addHook("preHandler", async (req, reply) => {
      if (req.url.startsWith("/api/v1/project")) {
        projectRequests.push(req.url);
        if (!signedIn) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in first." } });
      }
    });
    registerProjectRoutes(api, { project: { sources, repoUrl: "https://github.com/acme/repo" }, send: (reply, status, code, message) => reply.code(status).send({ error: { code, message } }) });
    await api.listen({ host: "127.0.0.1", port: await freePort() });
    const apiPort = (api.server.address() as { port: number }).port;
    webPort = await freePort();
    await ensureWebBuild();
    preview = spawn(process.execPath, [ASTRO, "preview", "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JH_API_URL: `http://127.0.0.1:${apiPort}` },
    });
    preview.stdout?.on("data", () => undefined);
    preview.stderr?.on("data", () => undefined);
    await waitForHttp(`http://127.0.0.1:${webPort}/`, "The Astro preview server");
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-project-profile-"));
    context = await launchPersistentChrome(profileDir, { headless: false });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
  }, 180_000);

  afterAll(async () => {
    if (context) await closePersistentChrome(context, profileDir).catch(() => undefined);
    preview?.kill();
    await api?.close().catch(() => undefined);
    for (const dir of [profileDir]) if (dir) rmSync(dir, { recursive: true, force: true });
    root?.cleanup();
    empty?.cleanup();
  }, 60_000);

  async function open(url = web(), viewport?: { width: number; height: number }): Promise<Page> {
    signedIn = true;
    activeSources = createProjectSources(root.root);
    const page = await context.newPage();
    if (viewport) await page.setViewportSize(viewport);
    await page.addInitScript(() => { (window as unknown as { __xss: number }).__xss = 0; });
    await page.goto(url);
    return page;
  }
  const ready = (page: Page) => page.waitForSelector("#pj-main:not([hidden]) #panel-overview .pj-stats", { timeout: 20_000 });
  const text = async (page: Page, selector: string) => ((await page.locator(selector).first().textContent()) ?? "").replace(/\s+/g, " ").trim();

  it("shows counts, a verified-only progress bar and a BLOCKED gate computed from the ledger", async () => {
    projectRequests.length = 0;
    const page = await open();
    try {
      await ready(page);
      const stat = (key: string) => text(page, `.pj-stat[data-key="${key}"] .n`);
      expect({ phases: await stat("phases"), tasks: await stat("tasks"), verified: await stat("verified"), inProgress: await stat("in_progress"), blocked: await stat("blocked"), planned: await stat("planned"), qa: await stat("qa") })
        .toEqual({ phases: "7", tasks: "10", verified: "2", inProgress: "1", blocked: "1", planned: "2", qa: "1" });
      expect(await page.getAttribute("#panel-overview [role=progressbar]", "aria-valuenow")).toBe("20");
      expect(await text(page, ".pj-gate .state")).toBe("BLOCKED");
      expect(await text(page, ".pj-gate")).toContain("Gate is red");
      expect(await text(page, "#panel-overview")).toContain("A0-01"); // next eligible task
      expect(await page.locator('a[href="https://github.com/acme/repo/pull/7"]').count()).toBeGreaterThan(0);
      // The fake VERIFIED task is surfaced as a ledger problem, not hidden.
      expect(await text(page, "#panel-overview")).toContain("A4-01: VERIFIED must cite a PASS result");
      await page.waitForTimeout(1500); // no polling: exactly one request per resource
      expect(projectRequests.sort()).toEqual(["/api/v1/project/overview", "/api/v1/project/phases", "/api/v1/project/tasks"]);
    } finally { await page.close(); }
  });

  it("keeps the existing navigation and marks Project as current", async () => {
    const page = await open();
    try {
      await ready(page);
      const nav = await page.locator(".app-nav a").allTextContents();
      expect(nav).toEqual(["Dashboard", "Résumés", "Career paths", "Jobs", "Matches", "Statements", "Project"]);
      expect(await page.getAttribute('.app-nav a[href="/project"]', "aria-current")).toBe("page");
      for (const route of ["/dashboard", "/resumes", "/roles", "/jobs", "/matches", "/profile"]) {
        // Only the connection is retried (loopback connects can stall on this machine, docs/KNOWN_FLAKES.md); the status is asserted once.
        let status = 0;
        for (let attempt = 0; attempt < 4 && status === 0; attempt += 1) {
          status = await page.request.get(web(route)).then((r) => r.status(), () => 0);
        }
        expect(status, route).toBe(200);
      }
    } finally { await page.close(); }
  });

  it("roadmap shows real phases with dependency waiting, blockers and phase tasks on click", async () => {
    const page = await open(web("/project#/roadmap"));
    try {
      await page.waitForSelector(".pj-phase");
      expect(await page.locator(".pj-phase").count()).toBe(7);
      expect(await text(page, '[data-phase-id="A2"]')).toContain("Waiting on A0");
      expect(await text(page, '[data-phase-id="A0"]')).toContain("Blocker: Gate is red");
      expect(await page.getAttribute('[data-phase-id="A1"] [role=progressbar]', "aria-valuenow")).toBe("100");
      expect(await page.getAttribute('[data-phase-id="A4"] [role=progressbar]', "aria-valuenow")).toBe("0");
      await page.click('[data-phase="A2"]');
      await page.waitForSelector("#phase-tasks-A2:not([hidden]) .row");
      expect(await text(page, "#phase-tasks-A2")).toContain("A2-02");
      expect(await text(page, "#phase-tasks-A2")).toContain("QA review");
      expect(page.url()).toContain("#/roadmap/A2");
    } finally { await page.close(); }
  });

  it("board has the six status columns, filters, and never shows rejected evidence as verified", async () => {
    const page = await open(web("/project#/board"));
    try {
      await page.waitForSelector(".pj-col");
      expect(await page.locator(".pj-col").count()).toBe(6);
      const countOf = async (col: string) => Number(await text(page, `.pj-col[data-col="${col}"] h3 span:last-child`));
      expect([await countOf("planned"), await countOf("reported_unverified"), await countOf("in_progress"), await countOf("qa_review"), await countOf("blocked"), await countOf("verified")]).toEqual([2, 2, 1, 1, 1, 3]);
      expect(await page.locator('.pj-task[data-task-id="A4-01"]').getAttribute("data-s")).toBe("rejected");
      expect(await text(page, '.pj-task[data-task-id="A4-01"]')).toContain("evidence not accepted");
      expect(await page.locator('.pj-task[data-task-id="A1-01"]').getAttribute("data-s")).toBe("verified");
      expect(await page.locator('.pj-task[data-task-id="A0-01"] a[href="https://github.com/acme/repo/issues/2"]').count()).toBe(1);
      expect(await page.locator(".pj-board [draggable=true]").count()).toBe(0); // read-only

      await page.fill("#task-search", "a4");
      expect(await text(page, "#board-count")).toBe("3 of 10 tasks shown.");
      await page.fill("#task-search", "");
      await page.selectOption("#filter-phase", "A2");
      expect(await text(page, "#board-count")).toBe("2 of 10 tasks shown.");
      await page.selectOption("#filter-status", "QA_REVIEW");
      expect(await text(page, "#board-count")).toBe("1 of 10 tasks shown.");
      await page.click("#filter-reset");
      expect(await text(page, "#board-count")).toBe("10 of 10 tasks shown.");
      await page.selectOption("#filter-owner", "DEVELOPER");
      await page.selectOption("#filter-status", "QA_REVIEW");
      expect(await text(page, "#board-count")).toBe("1 of 10 tasks shown.");
      await page.click("#filter-reset");
      await page.fill("#task-search", "no-such-task");
      expect(await text(page, "#board-count")).toBe("0 of 10 tasks shown.");
      expect(await text(page, '.pj-col[data-col="planned"]')).toContain("No tasks");
    } finally { await page.close(); }
  });

  it("task detail separates missing evidence from accepted evidence and closes with Escape", async () => {
    const page = await open(web("/project#/board"));
    try {
      await page.waitForSelector(".pj-col");
      await page.click('button[data-task="A0-01"]');
      await page.waitForSelector("dialog[open]");
      const dlg = text(page, "#pj-dialog");
      expect(await dlg).toContain("Evidence partly recorded");
      expect(await dlg).toContain("Phase blockerGate is red");
      expect(await dlg).not.toContain("null");
      expect(await page.locator('#pj-dialog a[href="https://github.com/acme/repo/commit/deadbee"]').count()).toBe(1);
      expect(await page.locator('#pj-dialog a[href="https://github.com/acme/repo/pull/7"]').count()).toBe(1);
      expect(await page.locator("#pj-dialog .pj-evidence .pj-missing").count()).toBeGreaterThanOrEqual(5); // test_command … notes
      expect(await page.locator("#pj-dialog a", { hasText: "LOCAL_SETUP.md" }).count()).toBe(1); // KT link from a real mention
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 0);
      expect(await page.locator("dialog[open]").count()).toBe(0);
      expect(page.url()).toContain("#/board");

      await page.goto(web("/project#/task/A1-01"));
      await page.waitForSelector("dialog[open]");
      expect(await text(page, "#pj-dialog")).toContain("Evidence accepted");
      expect(await text(page, "#pj-dialog")).toContain("Next action");
      await page.goto(web("/project#/task/NOPE-1"));
      await page.waitForSelector("dialog[open]");
      expect(await text(page, "#pj-dialog")).toContain("The ledger has no task");
    } finally { await page.close(); }
  });

  it("PRD explorer navigates, searches and renders hostile text as inert text", async () => {
    projectRequests.length = 0;
    const page = await open(web("/project#/prd"));
    try {
      await page.waitForSelector(".pj-outline a");
      expect(await page.locator(".pj-outline a").allTextContents()).toEqual(["SYNTH PRODUCT", "1. Overview", "1.1 Goals", "2. Baseline", "12. Roadmap"]);
      expect(await text(page, "#panel-prd")).toContain("locked hash matches");
      expect(await text(page, "#panel-prd")).toContain("version 9.9 (synthetic)");
      await page.click('.pj-outline a:has-text("1. Overview")');
      await page.waitForSelector(".pj-doc h2:has-text('1. Overview')");
      expect(await text(page, ".pj-doc")).toContain("<script>alert('prd')</script>"); // literal text
      expect(await page.locator("#panel-prd script").count()).toBe(0);
      expect(await page.locator('#panel-prd a[href^="javascript"]').count()).toBe(0);
      expect(await text(page, ".pj-doc")).toContain("(javascript:alert(1))");
      expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);

      await page.fill("#prd-search", "FR-0001");
      await page.waitForFunction(() => document.querySelectorAll(".pj-outline a").length === 1);
      expect(await text(page, ".pj-outline a")).toContain("1.1 Goals");
      expect(await page.locator(".pj-doc mark").count()).toBeGreaterThan(0);
      expect(await page.inputValue("#prd-search")).toBe("FR-0001"); // typing is not interrupted by re-rendering

      // Task requirement links open the matching section / a search.
      await page.goto(web("/project#/roadmap/A2"));
      await page.waitForSelector('[data-prd-ref="PRD §12"]');
      await page.click('[data-prd-ref="PRD §12"]');
      await page.waitForSelector(".pj-doc h2:has-text('12. Roadmap')");
      const before = projectRequests.filter((u) => u.endsWith("/prd")).length;
      await page.click('#tab-overview');
      await page.click('#tab-prd');
      await page.waitForSelector(".pj-outline a");
      expect(projectRequests.filter((u) => u.endsWith("/prd")).length).toBe(before); // cached after the first load
    } finally { await page.close(); }
  });

  it("team workspace uses the ledger's roles and shows review queues, blockers and KT links", async () => {
    const page = await open(web("/project#/team"));
    try {
      await page.waitForSelector(".pj-person");
      expect(await page.locator(".pj-person").count()).toBe(2);
      const dev = text(page, '[data-member="dev-user"]');
      const qa = text(page, '[data-member="qa-user"]');
      expect(await dev).toContain("Technical Lead");
      expect(await qa).toContain("Senior AI/ML & SDET Intern");
      expect(await qa).toContain("A2-02"); // QA_REVIEW task awaiting this reviewer
      expect(await page.locator('[data-member="dev-user"] a[href="https://github.com/dev-user"]').count()).toBe(1);
      expect(await dev).toContain("A0-01");
      expect(await dev).toContain("LOCAL_SETUP.md");
    } finally { await page.close(); }
  });

  it("notebook renders dated entries as text only", async () => {
    const page = await open(web("/project#/notebook"));
    try {
      await page.waitForSelector(".pj-entry");
      expect(await page.locator(".pj-entry").count()).toBe(2);
      expect(await page.locator(".pj-entry summary").first().textContent()).toContain("Second session"); // newest first
      expect(await page.locator("#panel-notebook img").count()).toBe(0);
      expect(await text(page, "#panel-notebook")).toContain("<img src=x onerror=alert(1)>");
      expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);
    } finally { await page.close(); }
  });

  it("fits a phone screen on every tab without horizontal page scrolling", async () => {
    const page = await open(web("/project"), { width: 390, height: 800 });
    try {
      await ready(page);
      for (const tab of ["overview", "prd", "roadmap", "board", "team", "notebook"]) {
        await page.click(`#tab-${tab}`);
        await page.waitForSelector(`#panel-${tab}:not([hidden]) > *`);
        await page.waitForTimeout(200);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, tab).toBeLessThanOrEqual(1);
      }
    } finally { await page.close(); }
  });

  it("supports keyboard tab navigation", async () => {
    const page = await open();
    try {
      await ready(page);
      await page.focus("#tab-overview");
      await page.keyboard.press("ArrowRight");
      await page.waitForSelector("#panel-prd:not([hidden])");
      expect(await page.getAttribute("#tab-prd", "aria-selected")).toBe("true");
      expect(await page.getAttribute("#tab-overview", "aria-selected")).toBe("false");
      await page.keyboard.press("End");
      await page.waitForSelector("#panel-notebook:not([hidden])");
    } finally { await page.close(); }
  });

  it("shows nothing and asks for sign-in when there is no session", async () => {
    const page = await open();
    try {
      await ready(page);
      signedIn = false;
      await page.reload();
      await page.waitForSelector("#signin-panel:not([hidden])");
      expect(await page.locator("#app").isHidden()).toBe(true);
      expect(await page.content()).not.toContain("Synthetic ledger");
      expect(await page.locator("#pj-main").isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  it("shows a clear unavailable state when the ledger file is missing, then recovers", async () => {
    const page = await open();
    try {
      await ready(page);
      activeSources = createProjectSources(empty.root);
      await page.reload();
      await page.waitForSelector("#pj-unavailable:not([hidden])");
      expect(await text(page, "#pj-unavailable")).toContain("PROJECT_SOURCE_MISSING");
      expect(await page.locator("#pj-main").isVisible()).toBe(false);
      activeSources = createProjectSources(root.root);
      await page.click("#pj-unavailable-retry");
      await ready(page);
    } finally { await page.close(); }
  });

  it("made no request to a non-loopback host", () => {
    expect(external).toEqual([]);
  });
});

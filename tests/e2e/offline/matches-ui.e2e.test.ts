import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Locator } from "playwright";
import { closePersistentChrome, launchPersistentChrome } from "../../../src/browser/launcher.js";
import { JobsRepo } from "../../../src/db/jobs-repo.js";
import { RolesRepo } from "../../../src/db/roles-repo.js";
import { createLiveImportRun } from "../../../src/jobs/import.js";
import { DiscoveryRunner } from "../../../src/jobs/runner.js";
import { BOARDS, fakeBoardFetch, ghBody, longJd } from "../../helpers/s3-fixtures.js";
import { FakeAi, dbAvailable, freePort, startHarness, type Harness } from "../../helpers/s1-harness.js";
import { ensureWebBuild, waitForHttp } from "../../helpers/web-build.js";

// Offline browser E2E for the S4 matches page: headed Chrome (production launcher, temporary dedicated profile) -> real Astro build -> real Fastify API ->
// real PostgreSQL (throwaway database). The stored posting comes from an IMPORT run answered by a fake board fetch; every non-loopback request is aborted
// and counted. No résumé, employer or job site is touched.

function pw(locator: Locator) {
  const poll = <T>(read: () => Promise<T>, timeout = 15_000) => expect.poll(read, { timeout, interval: 100 });
  return {
    toBeVisible: () => poll(() => locator.first().isVisible().catch(() => false)).toBe(true),
    toBeHidden: () => poll(() => locator.first().isHidden().catch(() => true)).toBe(true),
    toContainText: (text: string) => poll(async () => (await locator.first().textContent().catch(() => null)) ?? "").toContain(text),
    toHaveCount: (n: number) => poll(() => locator.count()).toBe(n),
    toHaveCountAtLeast: (n: number) => poll(() => locator.count()).toBeGreaterThanOrEqual(n),
  };
}

const WEB_DIR = path.resolve("web");
const ASTRO = path.join(WEB_DIR, "node_modules", "astro", "bin", "astro.mjs");
const ready = (await dbAvailable()) && existsSync(ASTRO);
const suite = ready ? describe : describe.skip;

suite("S4 matches page (headed Chrome)", () => {
  let h: Harness;
  let preview: ChildProcess;
  let context: BrowserContext;
  let profileDir: string;
  let webPort: number;
  const external: string[] = [];
  const problems: string[] = [];
  const previewLog: string[] = [];

  beforeAll(async () => {
    webPort = await freePort();
    const apiPort = await freePort();
    h = await startHarness(new FakeAi(() => { throw new Error("no AI in this test"); }), { env: { JH_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`, JH_API_PORT: String(apiPort), JH_DEMO_PROFILE: "0" } });
    await h.app.listen({ host: "127.0.0.1", port: apiPort });

    const userId = (await h.repo.findUser("local"))!.id;
    const roles = new RolesRepo(h.pool);
    await roles.seedCatalog();
    const cat = await roles.getCatalog();
    const jobs = new JobsRepo(h.pool);
    const ctx = { repo: jobs, userId, catalogRoles: cat.roles, catalogVersion: cat.catalogVersion, roleSlugs: ["soc-analyst"], boards: BOARDS.companies };
    const { runId } = await createLiveImportRun(ctx, ["greenhouse:acmesec"]);
    const body = ghBody("acmesec", [{ id: 1001, title: "SOC Analyst I", location: "Austin, TX", html: longJd("Requirements: Experience with Splunk. Must be a US citizen.") }]);
    const runner = new DiscoveryRunner({ repo: jobs, boards: () => BOARDS, fetchImpl: fakeBoardFetch({ acmesec: { body } }), delayMs: 0 });
    runner.enqueue(runId);
    await runner.idle();

    await ensureWebBuild();
    preview = spawn(process.execPath, [ASTRO, "preview", "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JH_API_URL: `http://127.0.0.1:${apiPort}` },
    });
    preview.stdout?.on("data", (d: Buffer) => previewLog.push(String(d)));
    preview.stderr?.on("data", (d: Buffer) => previewLog.push(String(d)));
    await waitForHttp(`http://127.0.0.1:${webPort}/`, "The Astro preview server");
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-matches-ui-profile-"));
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
    await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  }, 60_000);

  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail") console.log("BROWSER DIAGNOSTICS", JSON.stringify({ problems, external, previewLog: previewLog.join("").slice(-3000) }, null, 1));
  });

  const web = (p = "/") => `http://127.0.0.1:${webPort}${p}`;

  it("lists the saved posting, computes an evidence-grounded match with an honest empty-evidence state, and records a flag", async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

    await page.goto(web("/dashboard"));
    await page.fill("#token", "a".repeat(40));
    await page.click("#signin");
    await pw(page.locator("#app")).toBeVisible();

    await page.goto(web("/matches"));
    await pw(page.locator(".mrow")).toHaveCount(1);
    await pw(page.locator("#m-disclaimer")).toContainText("not a score");
    await pw(page.locator(".mrow")).toContainText("SOC Analyst I");
    await pw(page.locator(".mrow")).toContainText("No match computed yet");

    await page.click(".mrow [data-action=open]");
    await pw(page.locator("#m-detail")).toBeVisible();
    await pw(page.locator("#m-no-evidence")).toBeVisible(); // nothing approved: nothing can be supported, and the page says so
    await pw(page.locator(".req").first()).toBeVisible();
    await pw(page.locator(".req .jdq")).toHaveCountAtLeast(1); // every requirement quotes the posting
    await pw(page.locator(".req[data-status=SUPPORTED]")).toHaveCount(0);
    await pw(page.locator("[data-empty-evidence]")).toHaveCountAtLeast(1);

    // eligibility is a separate, quoted condition, never folded into a score
    await pw(page.locator("[data-condition=citizenship]")).toBeVisible();

    const text = (await page.locator("#app").textContent()) ?? "";
    expect(text).not.toMatch(/\b\d{1,3}\s?%\s*(?:match|fit)|match score|hiring probability/i);
    expect(await page.locator("button, a.button").filter({ hasText: /auto.?apply|submit application|apply now/i }).count()).toBe(0);

    // flag an incorrect interpretation
    await page.locator(".req [data-action=flag]").first().click();
    await page.locator(".req .flagbox textarea").first().fill("This is a preference, not a requirement.");
    await page.locator(".req [data-action=send-flag]").first().click();
    await pw(page.locator(".req .flagbox [role=status]").first()).toContainText("Recorded for review");
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_flags")).rows[0].n)).toBe(1);

    expect(problems).toEqual([]);
    expect(external).toEqual([]);
  });
});

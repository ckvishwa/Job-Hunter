import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright";
import { createAiClient } from "../../../src/ai/client.js";
import { closePersistentChrome, launchPersistentChrome } from "../../../src/browser/launcher.js";
import {
  buildResumeFixtures, dbAvailable, freePort, pythonAvailable, startAiService, startHarness, type AiService, type Harness,
} from "../../helpers/s1-harness.js";
import { ensureWebBuild, waitForPreview } from "../../helpers/web-build.js";

// Offline browser E2E for S1: headed Chrome (production launcher, temporary dedicated profile) drives the REAL Astro build
// -> real Fastify API -> real Python service -> real PostgreSQL (throwaway database). Every non-loopback request is aborted
// and counted. This proves the human workflow wiring; it says nothing about any real resume or employer site.


/** Locator assertions with vitest's expect.poll (the Playwright test runner's matchers are not available under vitest). */
function pw(locator: Locator) {
  const poll = <T>(read: () => Promise<T>, timeout = 15_000) => expect.poll(read, { timeout, interval: 100 });
  return {
    toBeVisible: () => poll(() => locator.first().isVisible().catch(() => false)).toBe(true),
    toBeHidden: () => poll(() => locator.first().isHidden().catch(() => true)).toBe(true),
    toBeDisabled: () => poll(() => locator.first().isDisabled()).toBe(true),
    toBeEnabled: () => poll(() => locator.first().isEnabled()).toBe(true),
    toContainText: (text: string) => poll(async () => (await locator.first().textContent().catch(() => null)) ?? "").toContain(text),
    toHaveText: (text: string, options: { timeout?: number } = {}) => poll(async () => ((await locator.first().textContent().catch(() => null)) ?? "").trim(), options.timeout).toBe(text),
    toHaveCount: (n: number) => poll(() => locator.count()).toBe(n),
    toHaveAttribute: (name: string, value: string) => poll(() => locator.first().getAttribute(name).catch(() => null)).toBe(value),
  };
}

const WEB_DIR = path.resolve("web");
const ASTRO = path.join(WEB_DIR, "node_modules", "astro", "bin", "astro.mjs");
const ready = (await dbAvailable()) && pythonAvailable() && existsSync(ASTRO);
const suite = ready ? describe : describe.skip;

suite("S1 UI workflow (headed Chrome)", () => {
  let service: AiService;
  let h: Harness;
  let preview: ChildProcess;
  let context: BrowserContext;
  let profileDir: string;
  let fixtureDir: string;
  let webPort: number;
  const external: string[] = [];
  const problems: string[] = [];
  const netDiag: string[] = [];
  const previewLog: string[] = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), "jh-s1-ui-fixtures-"));
    buildResumeFixtures(fixtureDir);
    service = await startAiService();
    webPort = await freePort();
    const apiPort = await freePort();
    const ai = createAiClient({ baseUrl: `http://127.0.0.1:${service.port}`, serviceToken: service.token, timeoutMs: 60_000 });
    h = await startHarness(ai, { env: { JH_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`, JH_API_PORT: String(apiPort) } });
    await h.app.listen({ host: "127.0.0.1", port: apiPort });

    await ensureWebBuild();
    preview = spawn(process.execPath, [ASTRO, "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JH_API_URL: `http://127.0.0.1:${apiPort}` },
    });
    preview.stdout?.on("data", (d: Buffer) => previewLog.push(String(d)));
    preview.stderr?.on("data", (d: Buffer) => previewLog.push(String(d)));
    await waitForPreview(`http://127.0.0.1:${webPort}/`, preview, previewLog);
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-s1-ui-profile-"));
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
    service?.stop();
    await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
    for (const dir of [fixtureDir, profileDir]) if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail" || process.env.JH_UI_DIAG === "1") console.log("BROWSER DIAGNOSTICS", JSON.stringify({ problems, netDiag, external, previewLog: previewLog.join("").slice(-3000) }, null, 1));
  });

  const web = (p = "/") => `http://127.0.0.1:${webPort}${p}`;
  const factRow = (page: Page, kind: string, value: string) =>
    page.locator(`#facts tr[data-kind="${kind}"]`).filter({ has: page.locator("td.value > div:first-child", { hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });

  it("signs in, uploads, reviews, approves, edits, attests and signs out, with only safe state changes", async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      problems.push(`console: ${m.text()}`);
      const loc = m.location();
      netDiag.push(`console-error: ${m.text()} @ ${loc.url}:${loc.lineNumber}:${loc.columnNumber}`);
    });
    // Diagnostic-only side channel (never asserted): what URL each console error and failed request came from.
    page.on("requestfailed", (r) => netDiag.push(`requestfailed: ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
    page.on("response", (r) => { if (r.status() >= 400) netDiag.push(`http-${r.status()}: ${r.request().method()} ${r.url()} (frame ${r.frame()?.url()})`); });

    // --- sign in -------------------------------------------------------------------------------------------------------
    await page.goto(web("/dashboard"));
    await pw(page.locator("#signin-panel")).toBeVisible();
    await pw(page.locator("#app")).toBeHidden();
    await page.fill("#token", "x".repeat(40));
    await page.click("#signin");
    await pw(page.locator("#signin-msg")).toContainText("not correct");
    await page.fill("#token", "a".repeat(40));
    await page.click("#signin");
    await pw(page.locator("#app")).toBeVisible(); // the dashboard; upload now lives at /resumes
    await page.goto(web("/resumes"));
    await pw(page.locator("#file")).toBeVisible();

    // --- upload (and upload again) ----------------------------------------------------------------------------------------
    const resume = path.join(fixtureDir, "c01-soc-analyst-docx.docx");
    await page.setInputFiles("#file", resume);
    await page.click("#upload");
    await pw(page.locator("#upload-msg")).toContainText("Uploaded.");
    await pw(page.locator("#resumes tr .state")).toHaveText("PROPOSED", { timeout: 30_000 });
    await page.setInputFiles("#file", resume);
    await page.click("#upload");
    await pw(page.locator("#upload-msg")).toContainText("nothing was duplicated");
    await pw(page.locator("#resumes tr")).toHaveCount(1);

    // --- review ------------------------------------------------------------------------------------------------------------------
    await page.click("text=Review facts");
    await pw(page.locator("#state")).toHaveText("PROPOSED");
    await pw(page.locator("#facts tr")).toHaveCount(12);
    expect(await page.locator("#facts tr:not([data-status=pending])").count()).toBe(0); // nothing is approved by processing
    await pw(page.locator("#warnings li")).toHaveCount(0);
    const resumeId = new URL(page.url()).searchParams.get("id")!;

    await factRow(page, "skill", "Splunk").locator("td").first().click();
    await pw(page.locator("#source-text mark")).toHaveText("Splunk");

    // a normal fact: approve
    await factRow(page, "skill", "Python").locator("[data-action=approve]").click();
    await pw(factRow(page, "skill", "Python")).toHaveAttribute("data-status", "approved");

    // a sensitive fact: approval is impossible until the user explicitly confirms
    const email = factRow(page, "email", "jordan.rivers@example.com");
    await pw(email.locator("[data-action=approve]")).toBeDisabled();
    await email.locator(".confirm-sensitive").check();
    await pw(email.locator("[data-action=approve]")).toBeEnabled();
    await email.locator("[data-action=approve]").click();
    await pw(email).toHaveAttribute("data-status", "approved");

    // the API refuses a forged write that lacks the CSRF token, even from inside the signed-in page
    const forged = await page.evaluate(async (id) => {
      const res = await fetch(`/api/v1/resumes/${id}/facts/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ factId: "f-x", action: "reject", expectedDigest: "0".repeat(64) }) });
      return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
    }, resumeId);
    expect(forged).toEqual([403, "BAD_CSRF"]);

    // an edit makes a new revision and puts the fact back to pending
    const job = factRow(page, "employment", "Northwind Traders — SOC Analyst I");
    await job.locator("[data-action=edit]").click();
    await page.fill('form.edit input[name="employer"]', "Northwind Traders Inc");
    await page.click('form.edit button[type="submit"]');
    await pw(page.locator("#msg")).toContainText("new revision");
    const edited = page.locator('#facts tr[data-kind="employment"]').filter({ hasText: "Northwind Traders Inc" });
    await pw(edited).toHaveAttribute("data-status", "pending");
    await edited.locator("[data-action=history]").click();
    await pw(edited.locator(".history li")).toHaveCount(2);
    await pw(edited.locator(".history")).toContainText("EDIT");

    // reject another
    await factRow(page, "skill", "SQL").locator("[data-action=reject]").click();
    await pw(factRow(page, "skill", "SQL")).toHaveAttribute("data-status", "rejected");

    // --- explicit statement ---------------------------------------------------------------------------------------------------
    await page.click('.app-nav a[href="/profile"]');
    await pw(page.locator("#attest-submit")).toBeDisabled();
    await page.selectOption("#attest-kind", "citizenship");
    await page.selectOption("#attest-polarity", "lacks");
    await page.fill("#attest-value", "U.S. citizen");
    await page.check("#attest-confirm");
    await pw(page.locator("#attest-submit")).toBeEnabled();
    await page.click("#attest-submit");
    await pw(page.locator("#attested tr")).toHaveCount(1);
    await pw(page.locator("#attested tr")).toContainText("NOT: U.S. citizen");
    await pw(page.locator("#revisions tr").first()).toContainText("ATTEST");

    // --- persistence across reload ------------------------------------------------------------------------------------------------
    await page.goto(web(`/review?id=${resumeId}`));
    await pw(factRow(page, "skill", "Python")).toHaveAttribute("data-status", "approved");
    await pw(factRow(page, "skill", "SQL")).toHaveAttribute("data-status", "rejected");

    // --- sign out ----------------------------------------------------------------------------------------------------------------------
    await page.click("#signout");
    await pw(page.locator("#signin-panel")).toBeVisible();
    await page.goto(web(`/review?id=${resumeId}`));
    await pw(page.locator("#signin-panel")).toBeVisible(); // redirected to sign-in; no data shown
    await page.close();

    // --- what the database holds -----------------------------------------------------------------------------------------------------------
    const q = async (sql: string) => (await h.pool.query(sql)).rows;
    expect(await q("SELECT count(*)::int AS n FROM resumes")).toEqual([{ n: 1 }]);
    expect(await q("SELECT approval_status, count(*)::int AS n FROM candidate_facts WHERE proposed_by <> 'user' GROUP BY 1 ORDER BY 1")).toEqual([
      { approval_status: "approved", n: 2 }, { approval_status: "pending", n: 9 }, { approval_status: "rejected", n: 1 },
    ]);
    expect(await q("SELECT proposed_by, kind FROM candidate_facts WHERE kind = 'citizenship'")).toEqual([{ proposed_by: "user", kind: "citizenship" }]);
    expect(await q("SELECT action, explicit_confirmation FROM fact_revisions WHERE action IN ('APPROVE','ATTEST') ORDER BY id")).toEqual([
      { action: "APPROVE", explicit_confirmation: false }, { action: "APPROVE", explicit_confirmation: true }, { action: "ATTEST", explicit_confirmation: true },
    ]);
    expect(await q("SELECT count(*)::int AS n FROM profile_revisions")).toEqual([{ n: 5 }]); // approve, approve, edit, reject, attest

    expect(external).toEqual([]);
    // The only browser errors allowed are the two requests this test deliberately sends to prove they are refused
    // (a wrong access token -> 401, a write without the CSRF token -> 403). Anything else is a defect.
    expect(problems.sort()).toEqual([
      "console: Failed to load resource: the server responded with a status of 401 (Unauthorized)",
      "console: Failed to load resource: the server responded with a status of 403 (Forbidden)",
    ]);
  }, 180_000);
});

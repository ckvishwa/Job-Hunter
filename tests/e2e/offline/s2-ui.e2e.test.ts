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

// Offline browser E2E for S1 -> S2: headed Chrome (production launcher, temporary dedicated profile) drives the REAL Astro build ->
// real Fastify API -> real Python extractor -> real PostgreSQL (throwaway database). A synthetic resume is uploaded, relevant facts
// are approved in the S1 review UI, and the S2 roles page proposes roles from them. Every non-loopback request is aborted and
// counted. Nothing here touches a real resume or a job site.

/** Locator assertions with vitest's expect.poll (the Playwright test-runner matchers are not available under vitest). */
function pw(locator: Locator) {
  const poll = <T>(read: () => Promise<T>, timeout = 15_000) => expect.poll(read, { timeout, interval: 100 });
  return {
    toBeVisible: () => poll(() => locator.first().isVisible().catch(() => false)).toBe(true),
    toBeHidden: () => poll(() => locator.first().isHidden().catch(() => true)).toBe(true),
    toContainText: (text: string) => poll(async () => (await locator.first().textContent().catch(() => null)) ?? "").toContain(text),
    toHaveText: (text: string) => poll(async () => ((await locator.first().textContent().catch(() => null)) ?? "").trim()).toBe(text),
    toHaveCount: (n: number) => poll(() => locator.count()).toBe(n),
    toHaveAttribute: (name: string, value: string) => poll(() => locator.first().getAttribute(name).catch(() => null)).toBe(value),
    toBeChecked: () => poll(() => locator.first().isChecked().catch(() => false)).toBe(true),
  };
}

const WEB_DIR = path.resolve("web");
const ASTRO = path.join(WEB_DIR, "node_modules", "astro", "bin", "astro.mjs");
const ready = (await dbAvailable()) && pythonAvailable() && existsSync(ASTRO);
const suite = ready ? describe : describe.skip;

suite("S1 -> S2 UI workflow (headed Chrome)", () => {
  let service: AiService;
  let h: Harness;
  let preview: ChildProcess;
  let context: BrowserContext;
  let profileDir: string;
  let fixtureDir: string;
  let webPort: number;
  const external: string[] = [];
  const problems: string[] = [];
  const previewLog: string[] = [];

  beforeAll(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), "jh-s2-ui-fixtures-"));
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
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-s2-ui-profile-"));
    context = await launchPersistentChrome(profileDir, { headless: false });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    // Stress knob: delay the fact-list refresh the way a loaded machine does. Used to PROVE the classify() synchronisation below; off by default.
    const delay = Number(process.env.JH_TEST_DELAY_FACTS_MS ?? 0);
    if (delay > 0) {
      await context.route("**/api/v1/resumes/*/facts", async (route) => {
        if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, delay));
        await route.fallback();
      });
    }
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
    if (ctx.task.result?.state === "fail") console.log("BROWSER DIAGNOSTICS", JSON.stringify({ problems, external, previewLog: previewLog.join("").slice(-3000) }, null, 1));
  });

  const web = (p = "/") => `http://127.0.0.1:${webPort}${p}`;
  const factRow = (page: Page, kind: string, value: string) =>
    page.locator(`#facts tr[data-kind="${kind}"]`).filter({ has: page.locator("td.value > div:first-child", { hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
  const card = (page: Page, slug: string) => page.locator(`.role-card[data-role="${slug}"]`);

  it("uploads a synthetic resume, approves facts, and gets persisted, evidence-linked role suggestions and a manual selection", async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });

    // --- S1: sign in and upload ---------------------------------------------------------------------------------------
    await page.goto(web("/dashboard"));
    await page.fill("#token", "a".repeat(40));
    await page.click("#signin");
    await pw(page.locator("#app")).toBeVisible();
    await page.goto(web("/resumes"));
    await page.setInputFiles("#file", path.join(fixtureDir, "c01-soc-analyst-docx.docx"));
    await page.click("#upload");
    await pw(page.locator("#resumes tr .state")).toHaveText("PROPOSED");

    // --- S2 before any approval: nothing is suggested ----------------------------------------------------------------------
    await page.goto(web("/roles"));
    await pw(page.locator("#no-recs")).toBeVisible();
    await pw(page.locator(".role-card")).toHaveCount(0);
    await pw(page.locator("#experience-status")).toHaveText("no approved experience yet");
    await pw(page.locator("#disclaimer")).toContainText("not a hiring chance");
    await pw(page.locator("#nomatch-summary")).toContainText("(12)");

    // --- S1: approve and classify ------------------------------------------------------------------------------------------
    await page.goto(web("/resumes"));
    await page.click("text=Review facts");
    await pw(page.locator("#facts tr")).toHaveCount(12);
    for (const [kind, value] of [["skill", "Splunk"], ["skill", "Microsoft Sentinel"], ["certification", "CompTIA Security+"]] as const) {
      await factRow(page, kind, value).locator("[data-action=approve]").click();
      await pw(factRow(page, kind, value)).toHaveAttribute("data-status", "approved");
    }
    const classify = async (value: string) => {
      const row = factRow(page, "employment", value);
      await row.locator("[data-action=edit]").click();
      await page.selectOption('form.edit select[name="employmentType"]', "professional");
      await page.click('form.edit button[type="submit"]');
      await pw(page.locator("#msg")).toContainText("new revision");
      // Synchronise on the RE-RENDERED row (it now shows the saved type), not on data-status: an unclassified employment fact is already "pending" before the edit,
      // so that wait is satisfied by the OLD row and the approve click used the pre-edit digest (409 STALE_FACT) whenever the refresh was slow.
      await pw(factRow(page, "employment", value)).toContainText("type: professional");
      await pw(factRow(page, "employment", value)).toHaveAttribute("data-status", "pending");
      await factRow(page, "employment", value).locator("[data-action=approve]").click();
      await pw(factRow(page, "employment", value)).toHaveAttribute("data-status", "approved");
    };
    await classify("Northwind Traders — SOC Analyst I");
    await classify("Contoso Labs — IT Support Technician");
    const resumeId = new URL(page.url()).searchParams.get("id")!;

    // --- S2: link from review, suggestions with evidence ------------------------------------------------------------------
    await page.click("#to-roles");
    await pw(card(page, "soc-analyst")).toBeVisible();
    await pw(card(page, "soc-analyst")).toHaveAttribute("data-support", "SUPPORTED");
    await pw(card(page, "soc-analyst")).toHaveAttribute("data-status", "PROPOSED");
    // Cybersecurity first: the first card is a primary-family role.
    await pw(page.locator(".role-card").first()).toContainText("primary focus");
    // No unsupported role is invented.
    await pw(card(page, "sdet")).toHaveCount(0);
    await pw(card(page, "cloud-engineer-associate")).toHaveCount(0);
    // Experience: Contoso Labs Jun 2020-Dec 2021 + Northwind Jan 2022-present, asOf 2026-10-09 (hand-computed 75-77 months).
    await pw(page.locator('#experience tr[data-bucket="professional"] .months')).toContainText("75-77 months");
    await pw(page.locator("#experience-status")).toHaveText("ok");
    await pw(page.locator("#experience-counts")).toContainText("2 skill mentions");
    await pw(card(page, "soc-analyst").locator('li[data-req="siem"]')).toContainText("skill mention only");
    await pw(card(page, "soc-analyst").locator('li[data-req="alert-triage"]')).toContainText("[job]");

    // An evidence link goes back to the approved fact, highlighted in its source text.
    await card(page, "soc-analyst").locator("a.evidence-link", { hasText: "Northwind Traders — SOC Analyst I" }).first().click();
    await pw(page.locator("#facts tr.selected")).toHaveCount(1);
    await pw(page.locator("#source-text mark")).toContainText("SOC Analyst I");
    await page.goBack();
    await pw(card(page, "soc-analyst")).toBeVisible();

    // --- decisions: approve one, dismiss another ------------------------------------------------------------------------------
    await card(page, "soc-analyst").locator("[data-action=approve]").click();
    await pw(card(page, "soc-analyst")).toHaveAttribute("data-status", "APPROVED");
    await card(page, "incident-response-analyst").locator("[data-action=dismiss]").click();
    await pw(card(page, "incident-response-analyst")).toHaveAttribute("data-status", "DISMISSED");

    // --- manual selection: includes a role with no supporting evidence (the user's choice governs) --------------------------------
    await page.check('input[name="family"][value="soc-blue-team"]');
    await page.check('input[name="role"][value="soc-analyst"]');
    await page.check('input[name="role"][value="sdet"]');
    await page.fill("#loc-countries", "United States");
    await page.check("#loc-remote");
    await page.check('input[name="workMode"][value="remote"]');
    await page.check('input[name="seniority"][value="entry"]');
    await page.fill("#band-max", "3");
    await page.click("#save-selection");
    await pw(page.locator("#selection-msg")).toContainText("Saved as revision 1");

    // --- persistence across a full reload ------------------------------------------------------------------------------------------
    await page.reload();
    await pw(card(page, "soc-analyst")).toHaveAttribute("data-status", "APPROVED");
    await pw(card(page, "incident-response-analyst")).toHaveAttribute("data-status", "DISMISSED");
    await pw(page.locator('input[name="role"][value="sdet"]')).toBeChecked();
    expect(await page.inputValue("#loc-countries")).toBe("United States");
    expect(await page.inputValue("#band-max")).toBe("3");
    await pw(page.locator("#selection-revision")).toContainText("Saved revision 1");

    // --- a stale view cannot clobber a newer selection ---------------------------------------------------------------------------------
    await h.pool.query(
      `INSERT INTO search_preferences (user_id, revision_no, target_families, role_slugs, locations, work_modes, seniority_levels, search_band, catalog_version, actor)
       SELECT user_id, 2, target_families, role_slugs, locations, work_modes, seniority_levels, search_band, catalog_version, 'user:other-window' FROM search_preferences WHERE revision_no = 1`,
    );
    await page.check('input[name="seniority"][value="junior"]');
    await page.click("#save-selection");
    await pw(page.locator("#selection-msg")).toContainText("STALE_SELECTION");
    expect((await h.pool.query("SELECT count(*)::int AS n FROM search_preferences")).rows[0].n).toBe(2);

    // --- changed evidence invalidates the decision, visibly ------------------------------------------------------------------------------
    await page.goto(web(`/review?id=${resumeId}`));
    const job = factRow(page, "employment", "Northwind Traders — SOC Analyst I");
    await job.locator("[data-action=edit]").click();
    await page.fill('form.edit input[name="title"]', "SOC Analyst II");
    await page.click('form.edit button[type="submit"]');
    await pw(page.locator("#msg")).toContainText("new revision");
    await page.goto(web("/roles"));
    await pw(card(page, "soc-analyst")).toHaveAttribute("data-status", "PROPOSED");
    await pw(card(page, "soc-analyst")).toHaveAttribute("data-support", "PARTIAL");
    await pw(page.locator('.stale-decision[data-role="soc-analyst"]')).toContainText("no longer applies");
    await pw(page.locator('#experience tr[data-bucket="professional"] .months')).toContainText("18-19 months"); // only Contoso Labs remains approved
    await page.close();

    // --- what the database holds ---------------------------------------------------------------------------------------------------------
    const q = async (sql: string) => (await h.pool.query(sql)).rows;
    expect(await q("SELECT role_slug, status FROM candidate_role_recommendations WHERE superseded_at IS NULL ORDER BY role_slug")).toEqual([
      { role_slug: "incident-response-analyst", status: "DISMISSED" }, { role_slug: "soc-analyst", status: "PROPOSED" },
    ]);
    expect(await q("SELECT status FROM candidate_role_recommendations WHERE role_slug='soc-analyst' AND superseded_at IS NOT NULL ORDER BY created_at")).toEqual([{ status: "APPROVED" }]);
    expect(await q("SELECT count(*)::int AS n FROM candidate_facts WHERE approval_status='approved'")).toEqual([{ n: 4 }]); // Splunk, Sentinel, Security+, Contoso Labs (Northwind went back to pending)
    expect(external).toEqual([]);
    expect(problems.sort()).toEqual([
      "console: Failed to load resource: the server responded with a status of 409 (Conflict)", // the deliberate stale selection save
    ]);
  }, 240_000);
});

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
import type { ExtractResponse } from "../../../src/ai/contracts.js";
import { ProfileRepo } from "../../../src/db/profile-repo.js";
import { FakeAi, dbAvailable, docxBytes, freePort, getJson, login, postJson, sha256, startHarness, upload, type Harness } from "../../helpers/s1-harness.js";
import { ensureWebBuild, waitForPreview } from "../../helpers/web-build.js";

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
// CI sets JH_REQUIRE_DB_E2E=1 where PostgreSQL and the web build exist: a missing prerequisite must fail there, not skip silently.
if (process.env.JH_REQUIRE_DB_E2E === "1" && !ready) throw new Error("JH_REQUIRE_DB_E2E=1 but PostgreSQL (infra/.env) or the Astro install is missing: the matches UI suites cannot run.");
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
    preview = spawn(process.execPath, [ASTRO, "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JH_API_URL: `http://127.0.0.1:${apiPort}` },
    });
    preview.stdout?.on("data", (d: Buffer) => previewLog.push(String(d)));
    preview.stderr?.on("data", (d: Buffer) => previewLog.push(String(d)));
    await waitForPreview(`http://127.0.0.1:${webPort}/`, preview, previewLog);
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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// JH-REPO-001 R7.1: approved fact -> stored match -> GET -> headed Chrome, with expectations written by hand BEFORE the matcher ran.
// Fictional candidate "Casey Real" and a fictional posting. Resume R1 lists Splunk, Python, Kubernetes, Wireshark; resume R2 lists Splunk again.
// Approved by a person: R1 Splunk, R1 Python, R1 Kubernetes. Left PENDING: R1 Wireshark and the identical R2 Splunk.
//   JD line                                      expected (hand-written, not computed by the matcher)
//   "Familiarity with Splunk."                    SUPPORTED, by the APPROVED R1 Splunk fact only (the identical PENDING R2 fact adds nothing). Per docs/S4A-MATCHING.md a familiarity cue is met by an approved skill mention; "experience with" would demand demonstrated use.
//   "Hands-on Python scripting experience."       PARTIAL (an approved skills-list mention does not show hands-on use)
//   "Familiarity with Wireshark."                 UNSUPPORTED (the only Wireshark fact is PENDING)
//   "Familiarity with Kubernetes or Terraform."   OR group SUPPORTED through Kubernetes; Terraform alone has no evidence
//   "Must be a US citizen."                       citizenship condition stays UNKNOWN: no eligibility fact exists and none may be inferred
// Oracle check: JH_ORACLE_FLIP=1 leaves the Splunk fact PENDING; this suite must then FAIL (run once, then unset).
// ---------------------------------------------------------------------------------------------------------------------------------------------
const FLIP = process.env.JH_ORACLE_FLIP === "1";
const JD_LINES = ["Familiarity with Splunk.", "Hands-on Python scripting experience.", "Familiarity with Wireshark.", "Familiarity with Kubernetes or Terraform.", "Must be a US citizen."];
const RESUME_R1 = ["Casey Real", "casey@real.test", "SKILLS", "Splunk, Python, Kubernetes, Wireshark"].join("\n");
const RESUME_R2 = ["Casey Real", "SKILLS", "Splunk"].join("\n");

function extraction(text: string, skills: string[]): ExtractResponse {
  return {
    schemaRevision: 1, parserRevision: "resume-rules@2", fileType: "docx", text, textSha256: sha256(text), warnings: [],
    facts: skills.map((value) => { const start = text.indexOf(value); if (start < 0) throw new Error(`quote not found: ${value}`); return { kind: "skill" as const, value, attributes: {} as never, span: { start, end: start + value.length, quote: value }, proposedBy: "rules" as const }; }),
    stats: { pageCount: 1, characterCount: text.length, deterministicFacts: skills.length, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
  };
}

suite("S4 matches page: approved evidence reaches a visible SUPPORTED card (headed Chrome, real PostgreSQL)", () => {
  let h: Harness;
  let preview: ChildProcess;
  let context: BrowserContext;
  let profileDir: string;
  let webPort: number;
  let jobId = "";
  const ids: Record<"r1" | "r2", string> = { r1: "", r2: "" };
  const factIds: Record<string, string> = {};
  const external: string[] = [];
  const problems: string[] = [];
  const submitLike: string[] = [];
  const previewLog: string[] = [];

  beforeAll(async () => {
    webPort = await freePort();
    const apiPort = await freePort();
    const responses: Record<string, ExtractResponse> = { r1: extraction(RESUME_R1, ["Splunk", "Python", "Kubernetes", "Wireshark"]), r2: extraction(RESUME_R2, ["Splunk"]) };
    h = await startHarness(new FakeAi((bytes) => responses[Object.keys(responses).find((k) => Buffer.from(bytes).toString("latin1").includes(`#${k}#`)) ?? "r1"]!), { env: { JH_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://127.0.0.1:4321`, JH_API_PORT: String(apiPort), JH_DEMO_PROFILE: "0" } }); // 4321 is the harness origin used by login()/upload() below
    await h.app.listen({ host: "127.0.0.1", port: apiPort });

    const s = await login(h);
    ids.r1 = (await upload(h, s, docxBytes("#r1#"), "r1.docx")).json().resumeId as string;
    ids.r2 = (await upload(h, s, docxBytes("#r2#"), "r2.docx")).json().resumeId as string;
    await h.queue.idle();
    const userId = (await h.repo.findUser("local"))!.id;
    const profiles = new ProfileRepo(h.pool);
    await profiles.ensureActive(userId, "personal", "Casey");
    for (const resumeId of [ids.r1, ids.r2]) await profiles.classify(userId, { resumeId, provenance: "personal", authorized: true, basis: "fictional candidate (test)", actor: "t" });
    const today = new Date().toISOString().slice(0, 10);
    const factOf = async (resume: "r1" | "r2", value: string) => (await h.repo.listFacts(userId, ids[resume])).find((f) => f.value === value)!;
    for (const [resume, value] of [["r1", "Splunk"], ["r1", "Python"], ["r1", "Kubernetes"], ["r1", "Wireshark"], ["r2", "Splunk"]] as const) factIds[`${resume}:${value}`] = (await factOf(resume, value)).factId;
    const approve = async (resume: "r1" | "r2", value: string) => {
      const f = await factOf(resume, value);
      await h.repo.applyReview(userId, "local", f.factId, { action: "approve", actor: "local", today, expectedDigest: f.contentDigest, confirmSensitive: true });
    };
    if (!FLIP) await approve("r1", "Splunk");
    await approve("r1", "Python");
    await approve("r1", "Kubernetes");

    const roles = new RolesRepo(h.pool);
    await roles.seedCatalog();
    const cat = await roles.getCatalog();
    const jobs = new JobsRepo(h.pool);
    const ctx = { repo: jobs, userId, catalogRoles: cat.roles, catalogVersion: cat.catalogVersion, roleSlugs: ["soc-analyst"], boards: BOARDS.companies };
    const { runId } = await createLiveImportRun(ctx, ["greenhouse:acmesec"]);
    const html = `${longJd()}<h3>Requirements</h3><ul>${JD_LINES.map((l) => `<li>${l}</li>`).join("")}</ul>`;
    const body = ghBody("acmesec", [{ id: 2002, title: "SOC Analyst II", location: "Austin, TX", html }]);
    const runner = new DiscoveryRunner({ repo: jobs, boards: () => BOARDS, fetchImpl: fakeBoardFetch({ acmesec: { body } }), delayMs: 0 });
    runner.enqueue(runId);
    await runner.idle();
    jobId = ((await getJson<any>(h, s, "/api/v1/matches")).body.jobs[0] as { jobId: string }).jobId;

    await ensureWebBuild();
    preview = spawn(process.execPath, [ASTRO, "preview", "--ignore-lock", "--host", "127.0.0.1", "--port", String(webPort)], {
      cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JH_API_URL: `http://127.0.0.1:${apiPort}` },
    });
    preview.stdout?.on("data", (d: Buffer) => previewLog.push(String(d)));
    preview.stderr?.on("data", (d: Buffer) => previewLog.push(String(d)));
    await waitForPreview(`http://127.0.0.1:${webPort}/`, preview, previewLog);
    profileDir = mkdtempSync(path.join(os.tmpdir(), "jh-matches-r71-profile-"));
    context = await launchPersistentChrome(profileDir, { headless: false });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (/\b(apply|submit)\b/i.test(url.pathname) && route.request().method() !== "GET") submitLike.push(`${route.request().method()} ${url.pathname}`);
      if (["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
  }, 240_000);

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
  const signIn = async (page: import("playwright").Page) => {
    await page.goto(web("/dashboard"));
    await page.fill("#token", "a".repeat(40));
    await page.click("#signin");
    await pw(page.locator("#app")).toBeVisible();
  };

  it("POST -> stored match -> GET returns the hand-written verdicts, cites only the APPROVED fact, and never a PENDING one", { timeout: 60_000 }, async () => {
    const s = await login(h);
    const created = await postJson<any>(h, s, `/api/v1/jobs/${jobId}/match`, {});
    expect(created.status).toBe(201);
    const got = await getJson<any>(h, s, `/api/v1/jobs/${jobId}/match`);
    expect(got.status).toBe(200);
    expect(got.body.match.id).toBe(created.body.match.id);
    const report = got.body.match.report;
    expect(report.status).toBe("COMPLETE");
    const byValue = (v: string) => (report.requirements as any[]).filter((r) => String(r.value).toLowerCase() === v.toLowerCase());
    const statusOf = (v: string) => byValue(v).map((r) => r.status);

    expect(statusOf("Splunk")).toEqual(["SUPPORTED"]);
    expect(statusOf("Python")).toEqual(["PARTIAL"]);
    expect(statusOf("Wireshark")).toEqual(["UNSUPPORTED"]);
    expect(statusOf("Kubernetes")).toEqual(["SUPPORTED"]);
    expect(statusOf("Terraform")).toEqual(["UNSUPPORTED"]);
    const kube = byValue("Kubernetes")[0];
    const group = (report.alternativeGroups as any[]).find((g) => g.groupId === kube.groupId);
    expect(group?.status).toBe("SUPPORTED"); // one satisfied branch satisfies the OR group
    expect(byValue("Terraform")[0].groupId).toBe(kube.groupId);

    // exact approved evidence and provenance: the approved R1 Splunk fact, never the identical PENDING R2 one
    const splunk = byValue("Splunk")[0];
    expect(splunk.jd.quote).toContain("Familiarity with Splunk.");
    expect(splunk.matchedFactIds).toEqual([factIds["r1:Splunk"]]);
    expect(splunk.matchedFactIds).not.toContain(factIds["r2:Splunk"]);
    expect(splunk.support).toHaveLength(1);
    expect(splunk.support[0]).toMatchObject({ factId: factIds["r1:Splunk"], value: "Splunk", category: "skill", strength: "mention" });
    const status = async (factId: string) => (await h.pool.query("SELECT approval_status FROM candidate_facts WHERE fact_id = $1", [factId])).rows[0].approval_status;
    expect(await status(factIds["r1:Splunk"]!)).toBe("approved");
    expect(await status(factIds["r2:Splunk"]!)).toBe("pending");
    expect(await status(factIds["r1:Wireshark"]!)).toBe("pending");
    const everyCited = (report.requirements as any[]).flatMap((r) => r.matchedFactIds ?? []);
    expect(everyCited).not.toContain(factIds["r1:Wireshark"]);
    expect(everyCited).not.toContain(factIds["r2:Splunk"]);
    expect(byValue("Wireshark")[0].support).toEqual([]);

    // the hard constraint stays UNKNOWN: no eligibility fact exists, so nothing is inferred and nothing is a pass
    const citizenship = (report.conditions as any[]).find((c) => c.type === "citizenship");
    expect(citizenship).toMatchObject({ result: "UNKNOWN" });
    expect(citizenship.candidateFactIds).toEqual([]);
    expect(JSON.stringify({ ...created.body, match: { ...created.body.match, decision: undefined } })).not.toMatch(/"(?:score|percent|probability|matchScore)"/i);
  });

  it("the page shows the SUPPORTED card with the exact JD quote and the exact approved fact, and no score, probability or apply control", { timeout: 90_000 }, async () => {
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
    await signIn(page);
    await page.goto(web("/matches"));
    await pw(page.locator(".mrow")).toHaveCount(1);
    await page.click(".mrow [data-action=open]");
    await pw(page.locator("#m-detail")).toBeVisible();

    const splunk = page.locator(".req[data-status=SUPPORTED]").filter({ hasText: "Splunk" });
    await pw(splunk).toBeVisible();
    await pw(splunk.locator(".jdq")).toContainText("Familiarity with Splunk.");
    expect(await splunk.first().locator(".ev").count()).toBe(1); // only the approved fact; the identical PENDING one adds no second line
    await pw(splunk.locator(".ev")).toContainText("Your approved evidence (skill): Splunk");
    await pw(page.locator(".req[data-status=PARTIAL]").filter({ hasText: "Python" })).toBeVisible();
    const wireshark = page.locator(".req[data-status=UNSUPPORTED]").filter({ hasText: "Wireshark" });
    await pw(wireshark).toBeVisible();
    expect(await wireshark.first().locator(".ev").count()).toBe(0);
    await pw(wireshark.locator("[data-empty-evidence]")).toBeVisible();
    await pw(page.locator("[data-condition=citizenship][data-result=UNKNOWN]")).toBeVisible();
    await pw(page.locator("#m-no-evidence")).toBeHidden();
    // R7.2: one source sentence that yields two cards with opposite verdicts appears once, as a group with its overall state
    const group = page.locator(".itemgroup").filter({ hasText: "Familiarity with Kubernetes or Terraform." });
    await pw(group).toHaveCount(1);
    await pw(group.locator("[data-rollup=SUPPORTED]")).toBeVisible();
    expect(((await group.first().textContent()) ?? "").split("Familiarity with Kubernetes or Terraform.").length - 1).toBe(1);
    expect(await group.first().locator(".req").count()).toBe(2);
    await pw(group.locator(".req[data-status=SUPPORTED]").filter({ hasText: "Kubernetes" })).toBeVisible();
    await pw(group.locator(".req[data-status=UNSUPPORTED]").filter({ hasText: "Terraform" })).toBeVisible();

    const text = (await page.locator("#app").textContent()) ?? "";
    expect(text).not.toMatch(/\b\d{1,3}\s?%|match score|hiring probability|ats score/i);
    expect(await page.locator("button, a.button, input[type=submit]").filter({ hasText: /auto.?apply|submit|apply now/i }).count()).toBe(0);

    // review/flag state on a card
    await page.locator(".req[data-status=UNSUPPORTED]").filter({ hasText: "Wireshark" }).locator("[data-action=flag]").click();
    await page.locator(".req[data-status=UNSUPPORTED]").filter({ hasText: "Wireshark" }).locator(".flagbox textarea").fill("Wireshark is mentioned on the resume but not approved yet.");
    await page.locator(".req[data-status=UNSUPPORTED]").filter({ hasText: "Wireshark" }).locator("[data-action=send-flag]").click();
    await pw(page.locator(".req .flagbox [role=status]").filter({ hasText: "Recorded for review" })).toBeVisible();
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_flags")).rows[0].n)).toBe(1);

    expect(problems).toEqual([]);
    expect(external).toEqual([]);
    expect(submitLike).toEqual([]);
  });

  it("covers the loading, empty and error states of the list", { timeout: 90_000 }, async () => {
    const page = await context.newPage();
    // loading: the gate shows its loading state while the list request is slow
    await page.route("**/api/v1/matches", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
    await page.goto(web("/matches"));
    await pw(page.locator("#gate-status[data-state=loading]")).toBeVisible();
    await pw(page.locator(".mrow")).toHaveCount(1);
    await page.unroute("**/api/v1/matches");
    // empty: no saved postings
    await page.route("**/api/v1/matches", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ disclaimer: "Orbital is not a hiring prediction.", total: 0, jobs: [] }) }));
    await page.goto(web("/matches"));
    await pw(page.locator("#m-empty")).toBeVisible();
    await page.unroute("**/api/v1/matches");
    // error: the API cannot be reached
    await page.route("**/api/v1/matches", (route) => route.abort());
    await page.goto(web("/matches"));
    await pw(page.locator("#gate-status:is([data-state=offline],[data-state=error],[data-state=unavailable])")).toBeVisible();
    await pw(page.locator("#gate-retry")).toBeVisible();
    await page.unroute("**/api/v1/matches");
    await page.click("#gate-retry"); // the API is reachable again: Try again recovers the list
    await pw(page.locator(".mrow")).toHaveCount(1);
    expect(external).toEqual([]);
  });
});

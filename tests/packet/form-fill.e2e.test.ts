import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { closePersistentChrome, launchPersistentChrome } from "../../src/browser/launcher.js";
import { inspectApplicationForm } from "../../src/pipeline/application-form.js";
import { fillPlannedForm, type ExpectedTarget } from "../../src/packet/form-fill.js";
import { planForm } from "../../src/packet/form-plan.js";
import { installNetworkGuard, prepareApplicationForm } from "../../src/packet/form-session.js";
import { fact, profile } from "../helpers/decision-fixtures.js";

// Offline headed Chrome against a loopback page that imitates a Greenhouse application (labeled text inputs,
// react-select style comboboxes, a file input, an attestation, a submit button). Synthetic applicant only. The
// server counts every submit request; every test asserts it stays at zero.

const AS_OF = "2026-10-09";
const PROFILE = profile([
  fact({ factId: "f-name", kind: "legal_name", value: "Alex Q Example", attributes: { givenName: "Alex", familyName: "Example" } }),
  fact({ factId: "f-email", kind: "email", value: "alex@example.test" }),
  fact({ factId: "f-phone", kind: "phone", value: "5550100" }),
  fact({ factId: "f-auth", kind: "work_authorization", value: "Yes" }),
  fact({ factId: "f-spon", kind: "sponsorship_need", value: "No" }),
]);
const SENTINEL_EMAIL = "alex@example.test";

function pageHtml(variant: string, prefill: Record<string, string>, mutate: string): string {
  const combo = (id: string, label: string, options: string[], required = true) => `
    <div class="field"><label for="${id}">${label}${required ? "*" : ""}</label>
      <div class="select__control"><div class="select__value-container">
        <div class="select__single-value" data-for="${id}" style="display:none"></div>
        <div class="select__input-container"><input id="${id}" role="combobox" type="text" ${required ? "required" : ""} aria-controls="${id}-lb" autocomplete="off"></div>
      </div></div>
      <div role="listbox" id="${id}-lb" hidden>${options.map((o) => `<div role="option">${o}</div>`).join("")}</div></div>`;
  const text = (id: string, label: string, type = "text", required = true) => `<div class="field"><label for="${id}">${label}${required ? "*" : ""}</label><input id="${id}" name="${id}" type="${type}" ${required ? "required" : ""} value="${prefill[id] ?? ""}"></div>`;
  return `<!doctype html><html><head><title>Job Application for QA Analyst at Acme</title></head><body>
  <h1>Apply: QA Analyst</h1>
  <form id="app" action="/submit" method="post">
    ${text("first_name", "First Name")}${text("last_name", "Last Name")}${text("email", "Email", "text")}${text("phone", "Phone", "tel")}
    ${combo("country", "Country", ["United States", "United Kingdom", "Canada"])}
    ${combo("authorized", "Are you legally authorized to work in the United States?", ["Yes", "No", "Yes, with conditions"])}
    ${combo("sponsor", "Will you now or in the future require sponsorship?", ["Yes", "No"])}
    <div class="field"><label for="resume">Attach</label><input id="resume" name="resume" type="file"></div>
    ${text("hear", "How did you hear about this job?")}
    <div class="field"><label for="attest">I confirm that the information submitted in this application is accurate</label><input id="attest" type="checkbox" required></div>
    ${variant === "b" ? text("extra_required", "A brand new required question") : ""}
    <button type="submit" id="go">Submit application</button>
  </form>
  <script>
    document.querySelectorAll('input[role=combobox]').forEach(function (input) {
      var lb = document.getElementById(input.getAttribute('aria-controls'));
      input.addEventListener('input', function () {
        var q = input.value.toLowerCase();
        lb.hidden = false;
        lb.querySelectorAll('[role=option]').forEach(function (o) { o.style.display = o.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none'; });
      });
      lb.querySelectorAll('[role=option]').forEach(function (o) {
        o.addEventListener('click', function () {
          var shown = document.querySelector('.select__single-value[data-for=' + input.id + ']');
          shown.textContent = o.textContent; shown.style.display = ''; input.value = ''; lb.hidden = true;
        });
      });
    });
    ${mutate ? `document.getElementById('${mutate}').addEventListener('change', function () { var el = this; setTimeout(function () { el.value = 'changed-by-page'; }, 30); });` : ""}
  </script></body></html>`;
}

let server: ReturnType<typeof createServer>;
let origin = "";
let submitCount = 0;
let context: BrowserContext;
let profileDir = "";
let tmp = "";

const readBody = (req: IncomingMessage) => new Promise<void>((resolve) => { req.on("data", () => {}); req.on("end", () => resolve()); });

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "job-hunter-packet-e2e-"));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/embed/job_app") {
      const prefill: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k.startsWith("prefill_")) prefill[k.slice(8)] = v;
      res.setHeader("content-type", "text/html");
      res.end(pageHtml(url.searchParams.get("variant") ?? "a", prefill, url.searchParams.get("mutate") ?? ""));
    } else if (url.pathname === "/submit" && req.method === "POST") {
      await readBody(req); submitCount += 1; res.statusCode = 204; res.end();
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  profileDir = path.join(tmp, "chrome");
  context = await launchPersistentChrome(profileDir, { headless: false, args: ["--disable-background-networking", "--no-first-run"] });
}, 60_000);

afterAll(async () => {
  await closePersistentChrome(context, profileDir);
  await new Promise<void>((r) => server.close(() => r()));
});

const EXPECTED: ExpectedTarget = { company: "Acme", title: "QA Analyst", board: "acme", jobId: 1, additionalAllowedHosts: ["127.0.0.1"] };
const resumePath = () => { const p = path.join(tmp, "resume.pdf"); writeFileSync(p, Buffer.from("%PDF-1.4 synthetic resume bytes")); return p; };
async function open(query = ""): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${origin}/embed/job_app?for=acme&token=1${query}`, { waitUntil: "domcontentloaded" });
  return page;
}
const resumeInfo = (approved: boolean) => ({ sha256: "a".repeat(64), fileName: "resume.pdf", path: resumePath(), approved });
const value = (page: Page, id: string) => page.locator(`#${id}`).inputValue();
const shown = (page: Page, id: string) => page.locator(`.select__single-value[data-for=${id}]`).innerText().catch(() => "");

describe("headed form preparation against a Greenhouse-style loopback page", () => {
  it("read-only inspection plans every control and writes nothing", async () => {
    const page = await open();
    const evidence = await prepareApplicationForm({ page, expected: EXPECTED, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: false });
    expect(evidence.target.ok).toBe(true);
    expect(evidence.fill).toBeNull();
    expect(evidence.plan.entries.filter((e) => e.disposition === "ANSWER").map((e) => e.label)).toEqual(["First Name", "Last Name", "Email", "Phone", "Are you legally authorized to work in the United States?", "Will you now or in the future require sponsorship?"]);
    expect(evidence.plan.blockers.some((b) => b.startsWith("Country"))).toBe(true);
    for (const id of ["first_name", "last_name", "email", "phone"]) expect(await value(page, id)).toBe("");
    expect(submitCount).toBe(0);
    await page.close();
  });

  it("fills only approved answers, reads every one back from the live control, verifies the upload, and does not submit", async () => {
    const page = await open();
    const guard = await installNetworkGuard(context);
    const evidence = await prepareApplicationForm({ page, expected: EXPECTED, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: true });
    const fill = evidence.fill!;
    expect(fill.mismatches).toEqual([]);
    expect(fill.fields.map((f) => [f.label, f.expected, f.actual, f.verified])).toEqual([
      ["First Name", "Alex", "Alex", true], ["Last Name", "Example", "Example", true], ["Email", SENTINEL_EMAIL, SENTINEL_EMAIL, true], ["Phone", "5550100", "5550100", true],
      ["Are you legally authorized to work in the United States?", "Yes", "Yes", true], ["Will you now or in the future require sponsorship?", "No", "No", true],
    ]);
    expect(fill.upload).toMatchObject({ fileName: "resume.pdf", pageFileName: "resume.pdf", verified: true });
    // Required questions with no approved answer remain untouched and keep the form short of verified.
    expect(fill.state).toBe("FORM_PREPARED");
    expect(await value(page, "hear")).toBe("");
    expect(await page.locator("#attest").isChecked()).toBe(false);
    expect(await shown(page, "country")).toBe("");
    // The exact option was chosen, not a substring match such as "Yes, with conditions".
    expect(await shown(page, "authorized")).toBe("Yes");
    // Trying to submit through the keyboard or the button does nothing.
    await page.locator("#email").press("Enter");
    await page.locator("#go").click({ force: true, timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(300);
    expect(submitCount).toBe(0);
    expect(guard.blockedWrites).toEqual([]);
    await page.close();
  });

  it("is idempotent: a second run finds every value already correct, rewrites nothing, and the upload is not repeated", async () => {
    const page = await open();
    const first = (await prepareApplicationForm({ page, expected: EXPECTED, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: true })).fill!;
    const second = (await prepareApplicationForm({ page, expected: EXPECTED, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: true })).fill!;
    expect(first.fields.every((f) => !f.skippedBecauseAlreadyCorrect)).toBe(true);
    expect(second.fields.every((f) => f.skippedBecauseAlreadyCorrect && f.verified)).toBe(true);
    expect(second.mismatches).toEqual([]);
    expect(submitCount).toBe(0);
    await page.close();
  });

  it("blocks readiness when the final reconciliation readback disagrees (the page rewrote a value after it was set)", async () => {
    const page = await open("&mutate=email");
    const fill = (await prepareApplicationForm({ page, expected: EXPECTED, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: true })).fill!;
    expect(fill.state).toBe("BLOCKED");
    expect(fill.mismatches.join(" ")).toContain("Final readback differs from the approved value: Email");
    expect(fill.fields.find((f) => f.label === "Email")!.verified).toBe(true); // it read back correctly at write time
    expect(submitCount).toBe(0);
    await page.close();
  });

  it("never overwrites a field that already holds a different value", async () => {
    const page = await open("&prefill_first_name=Someone");
    const fill = (await prepareApplicationForm({ page, expected: EXPECTED, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: true })).fill!;
    expect(fill.state).toBe("BLOCKED");
    expect(fill.mismatches.join(" ")).toContain("not overwritten");
    expect(await value(page, "first_name")).toBe("Someone");
    // Stopped at the conflict: nothing after it was written.
    expect(await value(page, "email")).toBe("");
    expect(fill.fields).toEqual([]);
    await page.close();
  });

  it("refuses to write when the page is not the intended employer's application", async () => {
    const page = await open();
    const evidence = await prepareApplicationForm({ page, expected: { ...EXPECTED, board: "other" }, profile: PROFILE, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(true), write: true });
    expect(evidence.target.ok).toBe(false);
    expect(evidence.fill).toBeNull();
    for (const id of ["first_name", "email"]) expect(await value(page, id)).toBe("");
    // And fillPlannedForm itself refuses even if called directly.
    const inspection = await inspectApplicationForm(page);
    const plan = planForm({ inspection, profile: PROFILE, asOf: AS_OF, resume: null });
    const direct = await fillPlannedForm({ page, plan, expected: { ...EXPECTED, jobId: 999 }, artifactPath: null });
    expect(direct.state).toBe("BLOCKED");
    expect(direct.mismatches.join(" ")).toContain("Refusing to write");
    expect(await value(page, "first_name")).toBe("");
    await page.close();
  });

  it("blocks when the live form changed after it was planned (new required question)", async () => {
    const planned = await open();
    const plan = planForm({ inspection: await inspectApplicationForm(planned), profile: PROFILE, asOf: AS_OF, resume: null });
    await planned.close();
    const changed = await open("&variant=b");
    const fill = await fillPlannedForm({ page: changed, plan, expected: EXPECTED, artifactPath: null });
    expect(fill.state).toBe("BLOCKED");
    expect(fill.mismatches.join(" ")).toContain("differs from the planned form");
    expect(await value(changed, "first_name")).toBe("");
    await changed.close();
  });

  it("an interrupted run (page closed) is reported as blocked and never as success", async () => {
    const page = await open();
    const plan = planForm({ inspection: await inspectApplicationForm(page), profile: PROFILE, asOf: AS_OF, resume: null });
    await page.close();
    const fill = await fillPlannedForm({ page, plan, expected: EXPECTED, artifactPath: null });
    expect(fill.state).toBe("BLOCKED");
    expect(fill.interrupted).not.toBeNull();
    expect(fill.mismatches.join(" ")).toContain("re-inspected");
  });

  it("does not upload an unapproved resume and never writes sensitive answers without approved facts", async () => {
    const page = await open();
    const empty = profile([]);
    const evidence = await prepareApplicationForm({ page, expected: EXPECTED, profile: empty, asOf: AS_OF, jdHash: "j".repeat(64), resume: resumeInfo(false), write: true });
    expect(evidence.fill!.fields).toEqual([]);
    expect(evidence.fill!.upload).toBeNull();
    expect(await page.locator("#resume").evaluate((el) => (el as HTMLInputElement).files!.length)).toBe(0);
    expect(await shown(page, "authorized")).toBe("");
    expect(await shown(page, "sponsor")).toBe("");
    await page.close();
  });

  it("the network guard aborts any non-GET request, so even a forced submit cannot reach the server", async () => {
    const page = await open();
    const guard = await installNetworkGuard(context);
    const result = await page.evaluate(async () => { try { await fetch("/submit", { method: "POST", body: "x" }); return "sent"; } catch { return "blocked"; } });
    expect(result).toBe("blocked");
    expect(guard.blockedWrites.length).toBe(1);
    expect(submitCount).toBe(0);
    await page.close();
  });
});

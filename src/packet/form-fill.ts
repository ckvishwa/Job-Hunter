import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { inspectApplicationForm, type ApplicationInspection, type ObservedControl } from "../pipeline/application-form.js";
import { formFingerprint, type FormPlan, type PlanEntry } from "./form-plan.js";

// Executes a FormPlan in an already-open headed page. Hard rules enforced here:
//   * the page must be the intended employer/job application before anything is written;
//   * only ANSWER and UPLOAD entries are written, only with the planned value;
//   * a field that already holds a different value is never overwritten (conflict, not a guess);
//   * every write is read back from the live control and compared to the expected value;
//   * nothing here clicks a submit-like control or presses Enter; an in-page guard also blocks form submission;
//   * any failure or interruption stops immediately and reports what is verified; there is no retry loop.

export interface ExpectedTarget {
  company: string;
  title: string;
  board: string;
  jobId: number;
  /** Extra hosts treated as Greenhouse application hosts. For loopback test fixtures only; production code never sets it. */
  additionalAllowedHosts?: string[];
}

const norm = (text: string): string => text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
const GREENHOUSE_HOSTS = new Set(["job-boards.greenhouse.io", "boards.greenhouse.io"]);

export function greenhouseFormUrl(board: string, jobId: number): string {
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${jobId}`;
}

/** Pure: does an observed page belong to the intended employer's Greenhouse application for this exact job? */
export function verifyFormTarget(inspection: Pick<ApplicationInspection, "url" | "title">, expected: ExpectedTarget): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let url: URL | null = null;
  try { url = new URL(inspection.url); } catch { reasons.push("page URL is not a valid URL"); }
  if (url) {
    const fixtureHost = (expected.additionalAllowedHosts ?? []).includes(url.hostname);
    if (url.protocol !== "https:" && !fixtureHost) reasons.push("page is not served over https");
    if (!GREENHOUSE_HOSTS.has(url.hostname) && !fixtureHost) reasons.push("page host is not a Greenhouse application host");
    else {
      const embedBoard = url.searchParams.get("for");
      const embedToken = url.searchParams.get("token");
      const pathMatch = /^\/([^/]+)\/jobs\/(\d+)\/?$/.exec(url.pathname);
      const board = url.pathname === "/embed/job_app" ? embedBoard : pathMatch?.[1] ?? null;
      const id = url.pathname === "/embed/job_app" ? embedToken : pathMatch?.[2] ?? null;
      if (board?.toLowerCase() !== expected.board.toLowerCase()) reasons.push("page belongs to a different employer board");
      if (id !== String(expected.jobId)) reasons.push("page is for a different job id");
    }
  }
  const title = norm(inspection.title);
  if (!title.includes(norm(expected.title))) reasons.push("page title does not name the approved job title");
  if (!title.includes(norm(expected.company))) reasons.push("page title does not name the employer");
  return { ok: reasons.length === 0, reasons };
}

/** Blocks form submission from the page itself, as a last resort behind the fact that this module never clicks submit. */
export async function installSubmitGuard(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const form of Array.from(document.forms)) {
      form.addEventListener("submit", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
      for (const control of Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[type=submit], input[type=submit]"))) control.disabled = true;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) event.preventDefault();
    }, true);
  });
}

export interface FieldProof {
  controlId: string;
  label: string;
  factId: string | null;
  expected: string;
  /** Value found in the control just before the write ("" when empty). */
  before: string;
  /** Value read back from the control after the write. */
  actual: string;
  verified: boolean;
  skippedBecauseAlreadyCorrect: boolean;
}

export interface UploadProof {
  controlId: string;
  fileName: string;
  localSha256: string;
  localBytes: number;
  /** Name and size reported by the page's own file list for the chosen file. */
  pageFileName: string | null;
  pageBytes: number | null;
  verified: boolean;
}

export type FillState = "FORM_PREPARED" | "FORM_VERIFIED" | "BLOCKED";

export interface FillResult {
  state: FillState;
  targetOk: boolean;
  fields: FieldProof[];
  upload: UploadProof | null;
  mismatches: string[];
  /** Required controls the plan could not answer; any entry keeps the form short of ready. */
  unresolved: string[];
  interrupted: string | null;
  submitControlsBefore: number;
  submitControlsAfter: number;
  formFingerprintBefore: string;
  formFingerprintAfter: string;
}

async function locate(page: Page, control: ObservedControl): Promise<Locator | null> {
  const synthetic = /^control-\d+$/.test(control.id);
  const byId = synthetic ? null : page.locator(`[id="${control.id.replace(/["\\]/g, "\\$&")}"], [name="${control.id.replace(/["\\]/g, "\\$&")}"]`);
  if (byId && (await byId.count()) === 1) return byId;
  if (control.label) {
    const byLabel = page.getByLabel(control.label, { exact: true });
    if ((await byLabel.count()) === 1) return byLabel;
  }
  return null;
}

async function readValue(locator: Locator, control: ObservedControl): Promise<string> {
  if (control.type === "select-one") return locator.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.label ?? "");
  if (control.role === "combobox") {
    return locator.evaluate((el) => {
      // react-select keeps the chosen value in a sibling of the input's own container: walk up to the nearest
      // ancestor that holds exactly one shown value and read only that.
      let node: Element | null = el.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const shown = node.querySelectorAll('[class*="single-value"], [class*="singleValue"]');
        if (shown.length === 1) return (shown[0]!.textContent ?? "").trim();
        if (shown.length > 1) break;
      }
      return "";
    });
  }
  return locator.inputValue();
}

async function writeValue(page: Page, locator: Locator, control: ObservedControl, value: string): Promise<void> {
  if (control.type === "select-one") { await locator.selectOption({ label: value }); return; }
  if (control.role === "combobox") {
    await locator.click();
    await locator.pressSequentially(value, { delay: 15 });
    const options = page.getByRole("option");
    await options.first().waitFor({ state: "visible", timeout: 4_000 });
    const texts = await options.allInnerTexts();
    const matching = texts.map((t, i) => ({ t, i })).filter((x) => norm(x.t) === norm(value));
    if (matching.length !== 1) throw new Error(`Dropdown does not offer exactly one option equal to the approved value (found ${matching.length}).`);
    await options.nth(matching[0]!.i).click();
    return;
  }
  if (["text", "email", "tel", "textarea", "url", "search"].includes(control.type)) { await locator.fill(value); return; }
  throw new Error(`Control type ${control.type} is not a supported write target.`);
}

async function fileProof(locator: Locator): Promise<{ name: string | null; size: number | null }> {
  return locator.evaluate((el) => {
    const file = (el as HTMLInputElement).files?.[0];
    return { name: file?.name ?? null, size: file?.size ?? null };
  });
}

export async function fillPlannedForm(input: { page: Page; plan: FormPlan; expected: ExpectedTarget; artifactPath: string | null }): Promise<FillResult> {
  const { page, plan, expected } = input;
  const fields: FieldProof[] = [];
  let upload: UploadProof | null = null;
  const mismatches: string[] = [];
  const base = { fields, upload, mismatches, unresolved: [...plan.blockers], interrupted: null as string | null, submitControlsBefore: 0, submitControlsAfter: 0, formFingerprintBefore: "", formFingerprintAfter: "" };
  const blocked = (reason: string, targetOk: boolean): FillResult => ({ ...base, state: "BLOCKED", targetOk, upload, mismatches: [...mismatches, reason] });
  let before: ApplicationInspection;
  try {
    before = await inspectApplicationForm(page);
    base.submitControlsBefore = before.submitControls;
    base.formFingerprintBefore = formFingerprint(before);
    const target = verifyFormTarget(before, expected);
    if (!target.ok) return blocked(`Refusing to write: ${target.reasons.join("; ")}.`, false);
    if (before.verificationDetected) return blocked("Human verification is present; stop for the applicant.", true);
    if (base.formFingerprintBefore !== plan.formFingerprint) return blocked("The live form differs from the planned form; re-inspect and re-plan before writing.", true);
    await installSubmitGuard(page);

    const controls = new Map(before.controls.map((c) => [c.id, c]));
    for (const entry of plan.entries) {
      if (entry.disposition === "ANSWER") {
        const control = controls.get(entry.controlId);
        const locator = control ? await locate(page, control) : null;
        if (!control || !locator) { mismatches.push(`Control not found uniquely: ${entry.label || entry.controlId}.`); break; }
        const current = (await readValue(locator, control)).trim();
        if (current !== "" && norm(current) !== norm(entry.expected!)) { mismatches.push(`Field already holds a different value and was not overwritten: ${entry.label}.`); break; }
        let skipped = false;
        if (norm(current) === norm(entry.expected!) && current !== "") skipped = true;
        else await writeValue(page, locator, control, entry.expected!);
        const actual = (await readValue(locator, control)).trim();
        const verified = norm(actual) === norm(entry.expected!);
        fields.push({ controlId: entry.controlId, label: entry.label, factId: entry.factId ?? null, expected: entry.expected!, before: current, actual, verified, skippedBecauseAlreadyCorrect: skipped });
        if (!verified) { mismatches.push(`Readback differs from the approved value: ${entry.label}.`); break; }
      } else if (entry.disposition === "UPLOAD") {
        if (!input.artifactPath) { mismatches.push("An upload is planned but no approved artifact path was supplied."); break; }
        const control = controls.get(entry.controlId);
        const locator = control ? await locate(page, control) : null;
        if (!control || !locator) { mismatches.push(`Upload control not found uniquely: ${entry.label || entry.controlId}.`); break; }
        const bytes = readFileSync(input.artifactPath);
        const existing = await fileProof(locator);
        const sameAlready = existing.name === path.basename(input.artifactPath) && existing.size === bytes.length;
        if (!sameAlready) await locator.setInputFiles(input.artifactPath);
        const proof = await fileProof(locator);
        const verified = proof.name === path.basename(input.artifactPath) && proof.size === statSync(input.artifactPath).size;
        upload = { controlId: entry.controlId, fileName: path.basename(input.artifactPath), localSha256: createHash("sha256").update(bytes).digest("hex"), localBytes: bytes.length, pageFileName: proof.name, pageBytes: proof.size, verified };
        if (!verified) { mismatches.push("The page's file list does not show the approved resume."); break; }
      }
    }

    // Reconcile from the live DOM: same form, same submit controls, every written value still in place.
    const after = await inspectApplicationForm(page);
    base.submitControlsAfter = after.submitControls;
    base.formFingerprintAfter = formFingerprint(after);
    const targetAfter = verifyFormTarget(after, expected);
    if (!targetAfter.ok) mismatches.push(`After writing, the page no longer matches the intended application: ${targetAfter.reasons.join("; ")}.`);
    if (after.submitControls !== before.submitControls) mismatches.push("The number of submit controls changed while filling.");
    if (after.verificationDetected) mismatches.push("A verification challenge appeared while filling.");
    const afterControls = new Map(after.controls.map((c) => [c.id, c]));
    for (const field of fields) {
      const control = afterControls.get(field.controlId);
      const locator = control ? await locate(page, control) : null;
      const value = locator && control ? (await readValue(locator, control)).trim() : "";
      if (norm(value) !== norm(field.expected)) mismatches.push(`Final readback differs from the approved value: ${field.label}.`);
    }
    const verifiedAll = mismatches.length === 0 && fields.every((f) => f.verified) && (upload === null || upload.verified);
    const planned = plan.entries.filter((e) => e.disposition === "ANSWER" || e.disposition === "UPLOAD").length;
    const performed = fields.length + (upload ? 1 : 0);
    const state: FillState = !verifiedAll ? "BLOCKED" : performed === planned && plan.blockers.length === 0 ? "FORM_VERIFIED" : "FORM_PREPARED";
    return { ...base, state, targetOk: true, upload };
  } catch (error) {
    // Never assume the interrupted write succeeded; report exactly what was verified before the interruption.
    return { ...base, state: "BLOCKED", targetOk: false, upload, interrupted: error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "interrupted", mismatches: [...mismatches, "The fill was interrupted; current page state must be re-inspected before any further write."] };
  }
}

export function planEntryLabel(entry: PlanEntry): string {
  return entry.label || entry.controlId;
}

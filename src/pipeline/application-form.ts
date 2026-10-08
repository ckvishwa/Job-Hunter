import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { factUsability, type CandidateProfile } from "../domain/candidate-profile.js";

export interface ObservedControl {
  id: string;
  label: string;
  help: string;
  type: string;
  required: boolean;
  disabled: boolean;
  options: string[];
  accept: string | null;
}

export interface ApplicationInspection {
  url: string;
  title: string;
  controls: ObservedControl[];
  submitControls: number;
  verificationDetected: boolean;
}

export type FormResult =
  | { state: "READY_TO_SUBMIT"; inspection: ApplicationInspection; readback: Array<{ controlId: string; factId: string; value: string }>; upload: { fileName: string; sha256: string; bytes: number; verifiedByPage: boolean }; unresolved: [] }
  | { state: "WAITING_FOR_USER"; inspection: ApplicationInspection; readback: Array<{ controlId: string; factId: string; value: string }>; upload: { fileName: string; sha256: string; bytes: number; verifiedByPage: boolean } | null; unresolved: string[] };

function normalize(text: string): string {
  return text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
}

function answerFactKind(label: string): string | null {
  const value = normalize(label);
  if (/full name|legal name|first name|last name/.test(value)) return "legal_name";
  if (/email/.test(value)) return "email";
  if (/phone|telephone|mobile/.test(value)) return "phone";
  if (/work authorization|authorized to work|legally authorized/.test(value)) return "work_authorization";
  if (/sponsor|sponsorship|visa support/.test(value)) return "sponsorship_need";
  return null;
}

function isAttestation(label: string): boolean {
  return /attest|certify|consent|agree|truthful|electronic signature|background check|terms and conditions/i.test(label);
}

function resolveFact(profile: CandidateProfile, kind: string, asOf: string): Array<{ id: string; value: string }> {
  return profile.facts.filter((fact) => fact.kind === kind && factUsability(fact, asOf).usable).map((fact) => ({ id: fact.factId, value: fact.value }));
}

/** Inspects and safely fills one labeled Greenhouse-style application form. It never submits. */
export async function inspectAndFillApplication(input: {
  page: Page;
  profile: CandidateProfile;
  artifactPath: string;
  asOf: string;
  admitted: boolean;
}): Promise<FormResult> {
  const { page } = input;
  const inspection = await inspectApplicationForm(page);
  const readback: Array<{ controlId: string; factId: string; value: string }> = [];
  let upload: FormResult["upload"] = null;
  const unresolved: string[] = [];

  if (!input.admitted) unresolved.push("Deterministic decision is not ELIGIBLE; no application fields were filled.");
  if (inspection.verificationDetected) unresolved.push("Human verification is present; stop for user review.");

  // Install a last-resort guard after observation. The adapter never clicks a button or presses Enter.
  await page.evaluate(() => {
    for (const form of Array.from(document.forms)) {
      form.addEventListener("submit", (event) => event.preventDefault(), true);
      for (const control of Array.from(form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[type=submit], input[type=submit]"))) control.disabled = true;
    }
    document.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement)) event.preventDefault();
    }, true);
  });

  if (input.admitted && !inspection.verificationDetected) {
    for (const control of inspection.controls) {
      if (control.disabled || control.type === "hidden" || control.type === "submit" || control.type === "button") continue;
      if (isAttestation(control.label)) {
        if (control.required) unresolved.push(`Required attestation needs your review: ${control.label || control.id}.`);
        continue;
      }
      if (control.type === "file") {
        const proof = await uploadArtifact(page, control, input.artifactPath);
        if (proof.ok) upload = proof.value;
        else if (control.required) unresolved.push(proof.reason);
        continue;
      }
      const kind = answerFactKind(`${control.label} ${control.help}`);
      if (!kind) {
        if (control.required) unresolved.push(`Required control is unsupported: ${control.label || control.id} (${control.type}).`);
        continue;
      }
      const matches = resolveFact(input.profile, kind, input.asOf);
      const values = [...new Set(matches.map((match) => match.value))];
      if (values.length !== 1) {
        if (control.required) unresolved.push(values.length === 0 ? `No approved current ${kind} fact resolves required control: ${control.label}.` : `Conflicting approved ${kind} facts for required control: ${control.label}.`);
        continue;
      }
      const chosen = matches.find((match) => match.value === values[0])!;
      const locator = page.getByLabel(control.label, { exact: true });
      if (await locator.count() !== 1) {
        if (control.required) unresolved.push(`Required control label is absent or ambiguous: ${control.label}.`);
        continue;
      }
      if (control.type === "select-one") {
        const option = control.options.find((item) => normalize(item) === normalize(chosen.value));
        if (!option) {
          if (control.required) unresolved.push(`Approved ${kind} fact does not exactly match an available option for: ${control.label}.`);
          continue;
        }
        await locator.selectOption({ label: option });
      } else if (["text", "email", "tel", "textarea"].includes(control.type)) {
        await locator.fill(chosen.value);
      } else {
        if (control.required) unresolved.push(`Required control type is not supported: ${control.label} (${control.type}).`);
        continue;
      }
      let observed = "";
      try { observed = await locator.inputValue(); } catch { observed = await locator.textContent() ?? ""; }
      if (normalize(observed) !== normalize(chosen.value)) {
        unresolved.push(`Control readback did not match the approved fact for: ${control.label}.`);
        continue;
      }
      readback.push({ controlId: control.id, factId: chosen.id, value: observed });
    }
  }

  if (inspection.controls.some((control) => control.required && control.type === "file") && !upload) {
    unresolved.push("Required resume attachment is not verified by the page.");
  }
  if (!upload) unresolved.push("Resume artifact was not uploaded and verified.");
  if (!input.admitted && !unresolved.some((item) => item.startsWith("Deterministic decision"))) unresolved.push("Application is not admitted for filling.");

  // Reconcile from the live DOM after every fill/upload. A READY state is only written when the
  // original form is still present, every supported answer reads back, required controls remain
  // understood, and the upload's server-confirmed hash is still attached.
  const finalInspection = await inspectApplicationForm(page);
  const before = new Map(inspection.controls.map((control) => [control.id, control]));
  const after = new Map(finalInspection.controls.map((control) => [control.id, control]));
  if (inspection.url !== finalInspection.url || inspection.title !== finalInspection.title) unresolved.push("Application page changed during form reconciliation; review the current page.");
  for (const control of inspection.controls) {
    const current = after.get(control.id);
    if (!current) {
      if (control.required) unresolved.push(`Required control disappeared during reconciliation: ${control.label || control.id}.`);
      continue;
    }
    if (control.required && (!current.required || current.disabled !== control.disabled || current.type !== control.type || current.label !== control.label || current.options.join("\n") !== control.options.join("\n"))) {
      unresolved.push(`Required control changed during reconciliation: ${control.label || control.id}.`);
    }
  }
  for (const control of finalInspection.controls) {
    if (control.required && !before.has(control.id)) unresolved.push(`A new required control needs review: ${control.label || control.id}.`);
  }
  if (finalInspection.verificationDetected) unresolved.push("A verification challenge appeared during form reconciliation.");
  if (finalInspection.submitControls !== inspection.submitControls) unresolved.push("Submit controls changed during reconciliation; review the page before proceeding.");
  for (const item of readback) {
    const control = finalInspection.controls.find((candidate) => candidate.id === item.controlId);
    const locator = control?.label ? page.getByLabel(control.label, { exact: true }) : null;
    const value = locator && await locator.count() === 1 ? await locator.inputValue().catch(() => "") : "";
    if (normalize(value) !== normalize(item.value)) unresolved.push(`Final control readback does not match the approved fact for: ${control?.label || item.controlId}.`);
  }
  if (upload) {
    const currentDigest = await page.locator("[data-upload-state]").getAttribute("data-uploaded-sha256").catch(() => null);
    const currentName = await page.locator("[data-upload-state]").getAttribute("data-uploaded-file-name").catch(() => null);
    if (currentDigest !== upload.sha256 || currentName !== upload.fileName) unresolved.push("Uploaded resume attachment changed during final reconciliation.");
  }

  return unresolved.length === 0 && upload
    ? { state: "READY_TO_SUBMIT", inspection: finalInspection, readback, upload, unresolved: [] }
    : { state: "WAITING_FOR_USER", inspection: finalInspection, readback, upload, unresolved };
}

export async function inspectApplicationForm(page: Page): Promise<ApplicationInspection> {
  const observed = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"));
    return {
      controls: controls.filter((control) => !["hidden", "submit", "button", "reset"].includes(control.type)).map((control, index) => {
        const id = control.id || control.name || `control-${index + 1}`;
        const label = control.labels ? Array.from(control.labels).map((item) => item.innerText).join(" ").trim() : "";
        const helpIds = control.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
        const help = helpIds.map((helpId) => document.getElementById(helpId)?.innerText ?? "").join(" ").trim();
        const options = control instanceof HTMLSelectElement ? Array.from(control.options).map((option) => option.label).filter(Boolean) : [];
        return { id, label: label || control.getAttribute("aria-label") || "", help, type: control.type, required: control.required || control.getAttribute("aria-required") === "true", disabled: control.disabled, options, accept: control instanceof HTMLInputElement ? control.accept || null : null };
      }),
      submitControls: document.querySelectorAll("button[type=submit],input[type=submit]").length,
      verificationDetected: /captcha|verify you are human|security challenge/i.test(document.body.innerText),
      title: document.title,
      url: location.href,
    };
  });
  return observed;
}

async function uploadArtifact(page: Page, control: ObservedControl, artifactPath: string): Promise<{ ok: true; value: NonNullable<FormResult["upload"]> } | { ok: false; reason: string }> {
  const locator = control.label ? page.getByLabel(control.label, { exact: true }) : page.locator(`input[type="file"][name="${control.id.replace(/["\\]/g, "\\$&")}"]`);
  if (await locator.count() !== 1) return { ok: false, reason: `Resume upload control is absent or ambiguous: ${control.label || control.id}.` };
  const bytes = await stat(artifactPath);
  const fileName = path.basename(artifactPath);
  const sha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  await locator.setInputFiles(artifactPath);
  // A supported uploader must show both the selected filename and a server-confirmed content digest.
  try {
    await page.waitForFunction(({ name, hash }) => {
      const root = document.querySelector("[data-upload-state]") ?? document.body;
      return root.getAttribute("data-uploaded-file-name") === name && root.getAttribute("data-uploaded-sha256") === hash;
    }, { name: fileName, hash: sha256 }, { timeout: 5_000 });
  } catch {
    return { ok: false, reason: `Resume file was selected, but the page did not confirm its content hash (${fileName}).` };
  }
  return { ok: true, value: { fileName, sha256, bytes: bytes.size, verifiedByPage: true } };
}

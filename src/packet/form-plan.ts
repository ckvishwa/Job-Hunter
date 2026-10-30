import { createHash } from "node:crypto";
import { factUsability, type CandidateFact, type CandidateProfile } from "../domain/candidate-profile.js";
import type { ApplicationInspection, ObservedControl } from "../pipeline/application-form.js";

// Pure planning for one application form: every observed control gets exactly one disposition. Nothing here
// touches a browser. An answer exists only when an approved, current candidate fact resolves it unambiguously;
// everything legally significant, ambiguous or unsupported is left for a person. The plan is what the packet
// reports as "proposed form answers", and what the filler is later allowed to write.

export type Disposition = "ANSWER" | "UPLOAD" | "HUMAN_REVIEW" | "UNRESOLVED" | "SKIP";
export type Category = "contact" | "authorization" | "employment" | "resume" | "attestation" | "self_identification" | "missing_fact" | "unsupported" | "companion" | "optional" | "inactive";

export interface PlanEntry {
  controlId: string;
  label: string;
  type: string;
  required: boolean;
  disposition: Disposition;
  category: Category;
  /** The exact value the filler may write. Present only for ANSWER. */
  expected?: string;
  /** Approved fact that supplies `expected`. Present only for ANSWER. */
  factId?: string;
  reason?: string;
}

export interface FormPlan {
  entries: PlanEntry[];
  /** Required controls nobody has approved an answer for, with the reason. Non-empty blocks readiness. */
  blockers: string[];
  /** Fingerprint of the observed form structure (labels, types, options, required flags): changes when the form changes. */
  formFingerprint: string;
  /** Digest of what would be written (control, expected value, fact). Changes when any proposed answer changes. */
  answersDigest: string;
}

const norm = (text: string): string => text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();

export function formFingerprint(inspection: ApplicationInspection): string {
  const material = inspection.controls.map((c) => [c.id, norm(c.label), c.type, c.required, c.disabled, c.options.map(norm).join("|"), c.accept ?? ""]);
  return createHash("sha256").update(JSON.stringify({ controls: material, submitControls: inspection.submitControls })).digest("hex");
}

const SELF_ID = /\b(gender|race|racial|ethnic|ethnicity|hispanic|latino|veteran|disability|pronoun|sexual orientation|transgender)\b/;
const ATTESTATION = /\b(attest|certify|consent|agree|acknowledge|acknowledg|truthful|electronic signature|background check|terms and conditions|privacy notice|arbitration|confirm receipt|i confirm|confirm that|accurately represents|is true and|i understand|ai tools?|at least 18|years of age)\b/;
const LEGAL_QUESTION = /\b(government official|relative|referred|previously employed|non compete|restrictive covenant|criminal|convicted|export control|security clearance|clearance)\b/;

function usable(profile: CandidateProfile, kind: CandidateFact["kind"], asOf: string): CandidateFact[] {
  return profile.facts.filter((f) => f.kind === kind && f.polarity === "has" && factUsability(f, asOf).usable);
}

function single(facts: CandidateFact[], pick: (f: CandidateFact) => string | undefined): { fact: CandidateFact; value: string } | { error: string } {
  const withValue = facts.map((fact) => ({ fact, value: pick(fact) })).filter((x): x is { fact: CandidateFact; value: string } => !!x.value);
  const distinct = [...new Set(withValue.map((x) => x.value))];
  if (withValue.length === 0) return { error: "no approved current fact supplies this value" };
  if (distinct.length !== 1) return { error: "approved facts disagree" };
  return withValue[0]!;
}

function entry(control: ObservedControl, disposition: Disposition, category: Category, extra: Partial<PlanEntry> = {}): PlanEntry {
  return { controlId: control.id, label: control.label.replace(/\s*\*\s*$/, "").trim(), type: control.type, required: control.required, disposition, category, ...extra };
}

export function planForm(input: { inspection: ApplicationInspection; profile: CandidateProfile; asOf: string; resume: { approved: boolean; fileName: string; sha256: string } | null }): FormPlan {
  const { inspection, profile, asOf } = input;
  const entries: PlanEntry[] = [];
  for (const control of inspection.controls) {
    const text = norm(`${control.label} ${control.help}`);
    const label = norm(control.label);
    const answer = (category: Category, resolved: { fact: CandidateFact; value: string } | { error: string }, what: string): PlanEntry => {
      if ("error" in resolved) return entry(control, control.required ? "UNRESOLVED" : "SKIP", "missing_fact", { reason: `${what}: ${resolved.error}` });
      if (control.options.length > 0 && !control.options.some((o) => norm(o) === norm(resolved.value))) return entry(control, control.required ? "UNRESOLVED" : "SKIP", "unsupported", { reason: `${what}: the approved value is not one of the available options` });
      return entry(control, "ANSWER", category, { expected: resolved.value, factId: resolved.fact.factId });
    };

    if (control.disabled || control.type === "hidden" || control.type === "submit" || control.type === "button") { entries.push(entry(control, "SKIP", "inactive")); continue; }
    // react-select style helper inputs: no label, synthetic id; the labeled combobox that owns them is planned on its own.
    if (!control.label && /^control-\d+$/.test(control.id)) { entries.push(entry(control, "SKIP", "companion", { reason: "unlabeled helper input of a labeled control" })); continue; }

    if (control.type === "file") {
      if (/cover/.test(`${control.id} ${label}`)) { entries.push(entry(control, control.required ? "UNRESOLVED" : "SKIP", control.required ? "unsupported" : "optional", control.required ? { reason: "a cover letter is required but no approved cover letter is prepared" } : {})); continue; }
      if (!input.resume) entries.push(entry(control, "HUMAN_REVIEW", "resume", { reason: "no tailored resume has been prepared" }));
      else if (!input.resume.approved) entries.push(entry(control, "HUMAN_REVIEW", "resume", { reason: "the tailored resume has not been approved by the applicant" }));
      else entries.push(entry(control, "UPLOAD", "resume", { expected: input.resume.fileName }));
      continue;
    }

    if (SELF_ID.test(text)) { entries.push(entry(control, control.required ? "HUMAN_REVIEW" : "SKIP", control.required ? "self_identification" : "optional", { reason: "voluntary self-identification is never answered by software" })); continue; }
    if (ATTESTATION.test(text) || LEGAL_QUESTION.test(text)) { entries.push(entry(control, control.required ? "HUMAN_REVIEW" : "SKIP", control.required ? "attestation" : "optional", { reason: "attestation, consent or legally significant question: the applicant answers it" })); continue; }

    if (/\b(preferred|nick ?name|chosen name)\b/.test(label)) { entries.push(entry(control, control.required ? "UNRESOLVED" : "SKIP", control.required ? "missing_fact" : "optional", { reason: "preferred name is not a legal-name fact; the applicant supplies it" })); continue; }
    if (/\b(first name|given name|legal first)\b/.test(label)) { entries.push(answer("contact", single(usable(profile, "legal_name", asOf), (f) => f.attributes.givenName), "legal first name"));  continue; }
    if (/\b(last name|family name|surname|legal last)\b/.test(label)) { entries.push(answer("contact", single(usable(profile, "legal_name", asOf), (f) => f.attributes.familyName), "legal last name")); continue; }
    if (/^(full name|legal name|name)$/.test(label)) { entries.push(answer("contact", single(usable(profile, "legal_name", asOf), (f) => f.value), "legal name")); continue; }
    if (/\bemail\b/.test(label)) { entries.push(answer("contact", single(usable(profile, "email", asOf), (f) => f.value), "email")); continue; }
    if (/\b(phone|telephone|mobile)\b/.test(label) && !/country code/.test(label)) { entries.push(answer("contact", single(usable(profile, "phone", asOf), (f) => f.value), "phone")); continue; }
    // Current work authorization and future sponsorship are separate facts and are never derived from each other.
    if (/sponsor|visa support/.test(text)) { entries.push(answer("authorization", single(usable(profile, "sponsorship_need", asOf), (f) => f.value), "future sponsorship need")); continue; }
    if (/work authorization|authorized to work|legally authorized|eligible to work|right to work/.test(text)) { entries.push(answer("authorization", single(usable(profile, "work_authorization", asOf), (f) => f.value), "current work authorization")); continue; }
    if (/^(company name|employer|company)$/.test(label)) { entries.push(answer("employment", single(usable(profile, "employment", asOf), (f) => f.attributes.employer), "employer")); continue; }
    if (/^(title|job title)$/.test(label) && !/question_/.test(control.id)) { entries.push(answer("employment", single(usable(profile, "employment", asOf), (f) => f.attributes.title), "job title")); continue; }

    entries.push(control.required
      ? entry(control, "UNRESOLVED", "unsupported", { reason: "required question with no approved answer source; the applicant answers it" })
      : entry(control, "SKIP", "optional"));
  }

  const blockers = entries
    .filter((e) => e.required && (e.disposition === "HUMAN_REVIEW" || e.disposition === "UNRESOLVED"))
    .map((e) => `${e.label || e.controlId}: ${e.reason ?? "needs the applicant"}`);
  const answersDigest = createHash("sha256").update(JSON.stringify(entries.filter((e) => e.disposition === "ANSWER" || e.disposition === "UPLOAD").map((e) => [e.controlId, e.disposition, e.expected ?? "", e.factId ?? "", input.resume?.sha256 ?? ""]))).digest("hex");
  return { entries, blockers, formFingerprint: formFingerprint(inspection), answersDigest };
}

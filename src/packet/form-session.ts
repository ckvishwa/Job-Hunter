import type { BrowserContext, Page } from "playwright";
import type { CandidateProfile } from "../domain/candidate-profile.js";
import { inspectApplicationForm } from "../pipeline/application-form.js";
import type { FormEvidenceFile } from "./build.js";
import { fillPlannedForm, verifyFormTarget, type ExpectedTarget } from "./form-fill.js";
import { planForm } from "./form-plan.js";

// One pass over an open application page: verify it is the intended employer's form for the approved job, inspect
// it, plan every control, and (only when asked, and only after the caller has checked the approval gates) write the
// planned answers and read them back. Never submits.

export interface NetworkGuard {
  blockedWrites: string[];
  /** URL patterns (regex source) of non-GET requests that are allowed through, e.g. a known upload endpoint. Empty by default. */
  allowedWritePatterns: string[];
}

/** Aborts every non-GET request that is not explicitly allowed, so a stray click cannot send an application. */
export async function installNetworkGuard(context: BrowserContext, allowedWritePatterns: string[] = []): Promise<NetworkGuard> {
  const guard: NetworkGuard = { blockedWrites: [], allowedWritePatterns };
  const allow = allowedWritePatterns.map((p) => new RegExp(p));
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "HEAD" || request.method() === "OPTIONS") return route.continue();
    if (allow.some((re) => re.test(request.url()))) return route.continue();
    guard.blockedWrites.push(`${request.method()} ${new URL(request.url()).host}`);
    return route.abort();
  });
  return guard;
}

export async function prepareApplicationForm(input: {
  page: Page;
  expected: ExpectedTarget;
  profile: CandidateProfile;
  asOf: string;
  jdHash: string;
  /** The tailored resume as prepared; `approved` must reflect a currently valid human approval. */
  resume: { sha256: string; fileName: string; path: string; approved: boolean } | null;
  /** True only when the caller has verified every gate that allows writing. False means read-only inspection. */
  write: boolean;
  now?: () => string;
}): Promise<FormEvidenceFile> {
  const inspection = await inspectApplicationForm(input.page);
  const target = verifyFormTarget(inspection, input.expected);
  const plan = planForm({ inspection, profile: input.profile, asOf: input.asOf, resume: input.resume ? { approved: input.resume.approved, fileName: input.resume.fileName, sha256: input.resume.sha256 } : null });
  const fill = input.write && target.ok ? await fillPlannedForm({ page: input.page, plan, expected: input.expected, artifactPath: input.resume?.approved ? input.resume.path : null }) : null;
  return {
    capturedAt: (input.now ?? (() => new Date().toISOString()))(),
    inspection,
    jdHash: input.jdHash,
    plan,
    resume: input.resume ? { sha256: input.resume.sha256, fileName: input.resume.fileName, approved: input.resume.approved } : null,
    target: { ok: target.ok, reasons: target.reasons, url: inspection.url },
    fill,
  };
}

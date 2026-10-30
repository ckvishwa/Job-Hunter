import { createHash } from "node:crypto";
import { candidateFactSchema, type CandidateFact } from "../domain/candidate-profile.js";
import type { CandidateRepo, FactView } from "../db/candidate-repo.js";
import { FactRuleError, reviewFact } from "./fact-lifecycle.js";
import type { ReviewFact, ReviewFile } from "./fact-review-file.js";

// Imports explicit decisions from a review file. Every change goes through CandidateRepo.applyReview (the same guarded, transactional,
// append-only path as the browser reviewer); nothing here writes approval status directly. Planning is read-only and uses the very same
// reviewFact() rules, so a dry run predicts what the real run will do.

export type PlanStatus = "WILL_APPLY" | "ALREADY_APPLIED" | "CONFLICT";
export type ConflictCode =
  | "UNKNOWN_FACT" | "WRONG_RESUME" | "STALE_CONTENT" | "STALE_REVISION" | "CONFIRMATION_REQUIRED" | "NOT_ALLOWED" | "RULE_REFUSED" | "EMPLOYMENT_CONFLICT_OPEN";

export interface PlanItem {
  factId: string;
  kind: string;
  decision: "approve" | "reject";
  reason: string | null;
  from: FactView["approvalStatus"] | null;
  to: "approved" | "rejected";
  status: PlanStatus;
  code?: ConflictCode;
  message?: string;
  expectedHeadRevision: number;
  /** Shown to the person; masked for sensitive facts. */
  label: string;
}

export interface Plan {
  batchId: string;
  fileProblems: string[];
  items: PlanItem[];
  /** Facts with decision null: untouched. */
  skipped: number;
}

export interface PlanOptions {
  actor: string;
  today: string;
  confirmSensitive: boolean;
  /** Employment facts that currently disagree with another record. Approving one needs `acceptEmploymentConflicts` (rejecting never does). */
  employmentConflictFactIds?: ReadonlySet<string>;
  acceptEmploymentConflicts?: boolean;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function toCandidateFact(f: FactView): CandidateFact {
  return candidateFactSchema.parse({
    factId: f.factId, kind: f.kind, value: f.value, polarity: f.polarity, attributes: f.attributes, source: f.source,
    verification: f.verification, approvalStatus: f.approvalStatus, sensitivity: f.sensitivity, ...(f.notes ? { notes: f.notes } : {}),
  });
}

/** Stable identity of the decisions in a file; the same decisions always produce the same batch id. */
export function batchIdFor(file: ReviewFile): string {
  const decided = file.facts.filter((f) => f.decision !== null).map((f) => `${f.factId}:${f.decision}`).sort();
  return sha256(`${file.resumeId}|${decided.join(",")}`).slice(0, 16);
}

export async function planApply(repo: CandidateRepo, userId: string, file: ReviewFile, options: PlanOptions): Promise<Plan> {
  const batchId = batchIdFor(file);
  const fileProblems: string[] = [];
  const source = await repo.getResumeSource(userId, file.resumeId);
  if (!source) fileProblems.push("This résumé does not exist for this user, or has no completed extraction.");
  else {
    if (source.versionId !== file.resumeVersionId) fileProblems.push("The résumé was re-extracted since the export (version changed). Export again.");
    if (source.textSha256 !== file.sourceTextSha256) fileProblems.push("The extracted résumé text changed since the export (source digest differs). Export again.");
  }
  const seen = new Set<string>();
  for (const f of file.facts) {
    if (seen.has(f.factId)) fileProblems.push(`Fact ${f.factId} appears more than once in the file.`);
    seen.add(f.factId);
  }

  const current = new Map<string, FactView>((source ? await repo.listFacts(userId, file.resumeId) : []).map((f) => [f.factId, f]));
  const items: PlanItem[] = [];
  let skipped = 0;
  for (const f of file.facts) {
    if (f.decision === null) {
      skipped += 1;
      continue;
    }
    items.push(planOne(f, file.resumeId, current.get(f.factId) ?? null, options));
  }
  return { batchId, fileProblems, items, skipped };
}

function planOne(f: ReviewFact, resumeId: string, now: FactView | null, options: PlanOptions): PlanItem {
  const decision = f.decision as "approve" | "reject";
  const to = decision === "approve" ? "approved" : "rejected";
  const base = {
    factId: f.factId, kind: f.kind, decision, reason: f.reason ?? null, to, expectedHeadRevision: f.headRevision,
    from: now?.approvalStatus ?? null, label: f.valueMasked ? f.value : f.value.slice(0, 80),
  } as const;
  const conflict = (code: ConflictCode, message: string): PlanItem => ({ ...base, status: "CONFLICT", code, message });
  if (f.resumeId !== resumeId) return conflict("WRONG_RESUME", "The record names a different résumé than the file.");
  if (!now) return conflict("UNKNOWN_FACT", "No such fact for this user and résumé.");
  if (now.contentDigest !== f.contentDigest) return conflict("STALE_CONTENT", "The fact's content changed since it was exported.");
  if (now.headRevision !== f.headRevision) {
    // The only benign revision change is this same decision having already been applied (a repeat or an interrupted batch).
    return now.approvalStatus === to
      ? { ...base, status: "ALREADY_APPLIED", message: "Already in the requested state." }
      : conflict("STALE_REVISION", `The fact was changed by someone else since export (now ${now.approvalStatus}).`);
  }
  if (decision === "approve" && now.kind === "employment" && now.approvalStatus !== "approved" && options.employmentConflictFactIds?.has(f.factId) && !options.acceptEmploymentConflicts) {
    return conflict("EMPLOYMENT_CONFLICT_OPEN", "This employment record disagrees with another record. Confirm the truth from documents first, then re-run with --accept-employment-conflicts.");
  }
  try {
    const outcome = reviewFact(toCandidateFact(now), {
      action: decision, actor: options.actor, today: options.today, expectedDigest: now.contentDigest, confirmSensitive: options.confirmSensitive,
    });
    return outcome.revisionAction === null ? { ...base, status: "ALREADY_APPLIED", message: "Already in the requested state." } : { ...base, status: "WILL_APPLY" };
  } catch (error) {
    if (error instanceof FactRuleError) {
      const code: ConflictCode = error.code === "CONFIRMATION_REQUIRED" ? "CONFIRMATION_REQUIRED" : error.code === "NOT_ALLOWED" ? "NOT_ALLOWED" : error.code === "STALE_FACT" ? "STALE_CONTENT" : "RULE_REFUSED";
      return conflict(code, error.code === "CONFIRMATION_REQUIRED" ? "Sensitive fact: approving needs --confirm-sensitive." : error.message);
    }
    throw error;
  }
}

export interface ApplyResult {
  batchId: string;
  /** True only when every decided record is now in its requested state. Never true after an abort or a failure. */
  complete: boolean;
  aborted: boolean;
  applied: string[];
  alreadyApplied: string[];
  conflicts: Array<{ factId: string; code: string; message: string }>;
  failed: Array<{ factId: string; code: string; message: string }>;
  skippedUndecided: number;
  fileProblems: string[];
}

export async function applyPlan(
  repo: CandidateRepo, userId: string, userHandle: string, file: ReviewFile, plan: Plan, options: PlanOptions & { skipConflicts: boolean },
): Promise<ApplyResult> {
  const result: ApplyResult = {
    batchId: plan.batchId, complete: false, aborted: false, applied: [], alreadyApplied: [], conflicts: [], failed: [], skippedUndecided: plan.skipped, fileProblems: plan.fileProblems,
  };
  result.conflicts = plan.items.filter((i) => i.status === "CONFLICT").map((i) => ({ factId: i.factId, code: i.code!, message: i.message! }));
  result.alreadyApplied = plan.items.filter((i) => i.status === "ALREADY_APPLIED").map((i) => i.factId);
  // Nothing is mutated if the file itself is unsafe, or if any record conflicts and the person did not opt in to skipping those.
  if (plan.fileProblems.length || (result.conflicts.length && !options.skipConflicts)) {
    result.aborted = true;
    return result;
  }
  for (const item of plan.items.filter((i) => i.status === "WILL_APPLY")) {
    try {
      const out = await repo.applyReview(userId, userHandle, item.factId, {
        action: item.decision, actor: options.actor, today: options.today,
        expectedDigest: file.facts.find((f) => f.factId === item.factId)!.contentDigest,
        confirmSensitive: options.confirmSensitive, expectedHeadRevision: item.expectedHeadRevision,
        provenance: { channel: "cli-json", reason: item.reason, batchId: plan.batchId },
      });
      (out.changed ? result.applied : result.alreadyApplied).push(item.factId);
    } catch (error) {
      const code = error instanceof FactRuleError ? error.code : "ERROR";
      result.failed.push({ factId: item.factId, code, message: (error as Error).message.split("\n")[0]!.slice(0, 200) });
    }
  }
  result.complete = result.failed.length === 0 && result.conflicts.length === 0;
  return result;
}

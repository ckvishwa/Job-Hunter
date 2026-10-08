import { randomBytes } from "node:crypto";
import type { JobPosting } from "../adapters/types.js";
import { computeJdContentHash } from "../domain/canonical-job.js";
import {
  STRUCTURED_PARSER_VERSION,
  buildSemanticFailure,
  validateStructuredProposal,
  type SemanticIssue,
  type SemanticParseFailure,
  type StructuredJob,
  type TrustedParseContext,
} from "../domain/structured-job.js";
import { appendJsonlRecords } from "../storage/jsonl-store.js";
import { upsertStructuredJob } from "../storage/structured-store.js";
import { AnnotationValidationError } from "./compact-annotations.js";
import type { JobSemanticProvider } from "./provider.js";

// Production boundary for Slice 2:
//   saved canonical JD -> provider proposal -> runtime schema -> source-evidence validation
//   -> accepted StructuredJob (durably stored) | SEMANTIC_PARSE_FAILED.
// Every proposal, from any provider, goes through validateStructuredProposal. A rejected
// proposal is rejected as a whole: nothing partial is stored or returned as accepted.

export interface ParseOptions {
  /** Cancellation propagates to providers that support it; cleanup uses a separate signal. */
  signal?: AbortSignal;
  /** Where accepted results are stored (locked, atomic). Omit to validate without persisting. */
  structuredPath?: string;
  /** Append-only SEMANTIC_PARSE_FAILED log. Omit to skip logging. */
  failuresPath?: string;
  runId?: string;
  now?: string;
}

export type ParseResult =
  | { ok: true; structured: StructuredJob; persisted: boolean }
  | { ok: false; failure: SemanticParseFailure };

function newRunId(): string {
  return `parse-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

export async function parseCanonicalJob(job: JobPosting, provider: JobSemanticProvider, options: ParseOptions = {}): Promise<ParseResult> {
  const runId = options.runId ?? newRunId();
  const now = options.now ?? new Date().toISOString();
  const trusted: TrustedParseContext = {
    jobId: job.id,
    jdHash: job.jdContentHash ?? "",
    parserVersion: STRUCTURED_PARSER_VERSION,
    providerRevision: provider.revision,
    now,
  };

  const fail = (code: SemanticParseFailure["code"], issues: SemanticIssue[], retryable?: boolean): ParseResult => {
    const failure = buildSemanticFailure({ code, issues, runId, trusted, retryable, at: now });
    if (options.failuresPath) appendJsonlRecords(options.failuresPath, [failure]);
    return { ok: false, failure };
  };

  // Only a resolved canonical job with an intact hash is parseable.
  if (job.resolutionStatus !== "resolved" || !job.jdContentHash || computeJdContentHash(job.descriptionText) !== job.jdContentHash) {
    return fail("STALE_SOURCE", [
      { code: "STALE_SOURCE", path: "(job)", message: "job is not a resolved canonical job whose stored JD matches its recorded hash" },
    ]);
  }

  let output: unknown;
  try {
    output = await provider.extractJob({ rawJd: job.descriptionText, jdHash: job.jdContentHash, signal: options.signal });
  } catch (err) {
    // The provider answered but its output failed source validation: not a provider failure.
    // Message omitted: it quotes model output and JD text. Deterministic at temperature 0, so not retryable.
    if (err instanceof AnnotationValidationError) return fail("EVIDENCE_INVALID", [{ code: "EVIDENCE_INVALID", path: "(provider annotations)", message: "provider annotations failed source-evidence validation after bounded repair" }], false);
    // Class name only: an error message could echo provider or JD content.
    const name = err instanceof Error ? err.name : "UnknownError";
    const retryable = name !== "FixtureNotFoundError" && name !== "FixtureInputMismatchError";
    return fail("PROVIDER_FAILED", [{ code: "PROVIDER_FAILED", path: "(provider)", message: `provider threw ${name}` }], retryable);
  }

  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return fail("MALFORMED_JSON", [{ code: "MALFORMED_JSON", path: "(provider output)", message: "provider output is not valid JSON" }]);
    }
  }

  let outcome = validateStructuredProposal(job.descriptionText, trusted, output);
  if (!outcome.ok && provider.repairJob) {
    try {
      const repaired = await provider.repairJob({
        rawJd: job.descriptionText,
        jdHash: job.jdContentHash,
        proposal: output,
        issues: outcome.issues.map(({ code, path, message }) => ({ code, path, message })),
      });
      outcome = validateStructuredProposal(job.descriptionText, trusted, repaired);
    } catch (err) {
      if (err instanceof AnnotationValidationError) return fail("EVIDENCE_INVALID", [{ code: "EVIDENCE_INVALID", path: "(provider repair annotations)", message: "provider repair failed source-evidence validation" }], false);
      const name = err instanceof Error ? err.name : "UnknownError";
      return fail("PROVIDER_FAILED", [{ code: "PROVIDER_FAILED", path: "(provider repair)", message: `provider repair threw ${name}` }]);
    }
  }
  if (!outcome.ok) return fail(outcome.code, outcome.issues);

  // A posting always asks something of the candidate. A structurally valid result with no requirements means
  // the source sections were not recognized (or the model returned nothing); it must never read as "no requirements".
  if (outcome.job.requirements.length === 0) {
    return fail("NO_REQUIREMENTS", [{ code: "NO_REQUIREMENTS", path: "requirements", message: "extraction produced no requirements; the posting's qualification sections were not recognized or nothing was extracted" }], false);
  }

  // Persist before reporting success. A storage failure throws (JobStoreError) and is NOT a parse failure.
  if (options.structuredPath) {
    await upsertStructuredJob(options.structuredPath, outcome.job);
  }
  return { ok: true, structured: outcome.job, persisted: options.structuredPath !== undefined };
}

import type { JobPosting } from "../../adapters/types.js";
import type { RoleConfig } from "../../types.js";
import { evaluateRelevance } from "../../discovery/relevance.js";
import { buildPlaceholder } from "../../discovery/resolve-phase.js";
import type { JobSource, SourceDiscoveryOptions, SourceDiscoveryResult } from "../job-source.js";
import { runCareerOpsScan, type CareerOpsRunResult } from "./careerops-runner.js";
import { validateOffers } from "./careerops-schema.js";
import { mapCareerOpsOffer } from "./careerops-mapper.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SINCE_DAYS = 7;

// No real JD resolution yet (vertical slice) -- every returned job is honestly labeled via the
// existing UNRESOLVED_PLACEHOLDER_PREFIX convention (buildPlaceholder), the same one native
// discovery's own resolver-timeout/error path already uses. scoring.ts/report-rows.ts already
// treat that convention as "missing evidence," not a fabricated empty description.
const NOT_YET_RESOLVED_REASON = "CareerOps resolver enrichment not implemented yet (vertical slice)";

function describeRunFailure(run: CareerOpsRunResult): string {
  switch (run.kind) {
    case "invalid-options":
      return `invalid options: ${run.message}`;
    case "preflight-failed":
      return `preflight failed: ${run.preflight.errors.map((e) => e.message).join("; ")}`;
    case "spawn-error":
      return `spawn error: ${run.message}`;
    case "timeout":
      return `timed out after ${run.timeoutMs}ms`;
    case "non-zero-exit":
      return `exited with code ${run.exitCode}: ${run.stderr || "(no stderr)"}`;
    case "empty-stdout":
      return `empty stdout: ${run.stderr || "(no stderr)"}`;
    case "invalid-json":
      return `invalid JSON stdout: ${run.parseError}`;
    case "invalid-scan-result":
      return `invalid top-level scan result: ${run.issues.join("; ")}`;
    default:
      return "unknown failure";
  }
}

export interface CareerOpsSourceOptions {
  careerOpsHome: string;
  roles: RoleConfig[];
  timeoutMs?: number;
  runScanFn?: typeof runCareerOpsScan;
}

export class CareerOpsSource implements JobSource {
  readonly id = "careerops";

  constructor(private readonly opts: CareerOpsSourceOptions) {}

  async discover(options: SourceDiscoveryOptions): Promise<SourceDiscoveryResult> {
    const runScanFn = this.opts.runScanFn ?? runCareerOpsScan;

    const run = await runScanFn({
      careerOpsHome: this.opts.careerOpsHome,
      sinceDays: options.days ?? DEFAULT_SINCE_DAYS,
      atsCompanyLimit: options.limit,
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    if (run.kind !== "success") {
      return {
        jobs: [],
        health: { attempted: 1, succeeded: 0, failed: 1 },
        errors: [{ source: "careerops", message: describeRunFailure(run) }],
      };
    }

    const { valid, invalid } = validateOffers(run.result.offers);

    const jobs: JobPosting[] = [];
    let mapFailures = 0;

    for (const offer of valid) {
      const mapped = mapCareerOpsOffer(offer);
      if (!mapped.ok) {
        mapFailures += 1;
        continue;
      }
      const candidate = mapped.job;

      // Same relevance evaluation native discovery runs -- CareerOps' own broad title_filter is
      // never trusted as our relevance decision.
      const evaluation = evaluateRelevance(
        { title: candidate.title, department: candidate.department, location: candidate.location, descriptionSnippet: candidate.descriptionSnippet },
        this.opts.roles,
      );

      const requestedMatches = options.profileIds?.length
        ? evaluation.matchedProfiles.filter((p) => options.profileIds!.includes(p))
        : evaluation.matchedProfiles;

      if (!evaluation.matched || requestedMatches.length === 0) continue;

      candidate.matchedProfiles = requestedMatches;
      candidate.matchedKeywords = evaluation.matchedKeywords;
      candidate.matchedFields = evaluation.matchedFields;
      candidate.relevanceReason = evaluation.relevanceReason;
      candidate.searchedProfile = options.profileIds?.length ? options.profileIds.join(",") : null;

      jobs.push(buildPlaceholder(candidate, NOT_YET_RESOLVED_REASON));
    }

    return {
      jobs,
      health: { attempted: valid.length + invalid.length, succeeded: jobs.length, failed: invalid.length + mapFailures },
      errors: [],
    };
  }
}

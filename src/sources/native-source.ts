import { runDiscover, type DiscoverFilters } from "../discovery/orchestrator.js";
import type { JobSource, SourceDiscoveryOptions, SourceDiscoveryResult } from "./job-source.js";

type RunDiscoverFn = (
  paths: Parameters<typeof runDiscover>[0],
  filters: DiscoverFilters,
) => ReturnType<typeof runDiscover>;

export class NativeSource implements JobSource {
  readonly id = "native";

  constructor(
    private readonly paths: Parameters<typeof runDiscover>[0],
    private readonly runDiscoverFn: RunDiscoverFn = runDiscover,
  ) {}

  async discover(options: SourceDiscoveryOptions): Promise<SourceDiscoveryResult> {
    const summary = await this.runDiscoverFn(this.paths, {
      profileIds: options.profileIds,
      limit: options.limit,
      dryRun: options.dryRun,
    });

    return {
      // Native discovery already resolves, dedupes, and persists jobs to jobsStorePath
      // internally (see orchestrator.ts's Phase 3) -- there is nothing left for a caller to
      // merge, so an empty array here is honest, not a placeholder.
      jobs: [],
      health: {
        attempted: summary.sourcesAttempted,
        succeeded: summary.sourcesSucceeded,
        failed: summary.sourcesFailed,
      },
      errors: summary.errors,
    };
  }
}

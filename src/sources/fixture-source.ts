import type { JobPosting } from "../adapters/types.js";
import type { JobSource, SourceDiscoveryOptions, SourceDiscoveryResult } from "./job-source.js";

// Test-only JobSource: returns exactly the jobs it was constructed with, no I/O. Lets the
// hunt pipeline (and future source-selection tests) be exercised end-to-end without a real
// process spawn or browser launch.
export class FixtureSource implements JobSource {
  readonly id = "fixture";

  constructor(private readonly jobs: JobPosting[]) {}

  async discover(_options: SourceDiscoveryOptions): Promise<SourceDiscoveryResult> {
    return {
      jobs: this.jobs,
      health: { attempted: this.jobs.length, succeeded: this.jobs.length, failed: 0 },
      errors: [],
    };
  }
}

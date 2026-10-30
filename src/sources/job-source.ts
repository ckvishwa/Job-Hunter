import type { JobPosting } from "../adapters/types.js";

export interface SourceDiscoveryOptions {
  profileIds?: string[];
  days?: number;
  limit?: number;
  dryRun?: boolean;
}

export interface SourceHealth {
  attempted: number;
  succeeded: number;
  failed: number;
  // Source-specific raw counters (e.g. CareerOps' companiesScanned/capHit) -- never required
  // reporting, only extra context a caller may log.
  details?: Record<string, unknown>;
}

export interface SourceError {
  source: string;
  message: string;
}

export interface SourceDiscoveryResult {
  jobs: JobPosting[];
  health: SourceHealth;
  errors: SourceError[];
}

export interface JobSource {
  readonly id: string;
  discover(options: SourceDiscoveryOptions): Promise<SourceDiscoveryResult>;
}

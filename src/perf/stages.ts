export const PIPELINE_STAGES = [
  "source-discovery",
  "pagination",
  "network-wait",
  "browser-navigation",
  "jd-retrieval",
  "normalization",
  "deduplication",
  "ml-inference",
  "matching",
  "database-writes",
  "export-generation",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface StageSummary {
  stage: PipelineStage;
  count: number;
  failures: number;
  retries: number;
  wallMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
  throughputPerSecond: number | null;
}

/** Nearest-rank percentile. The input is sorted by this function. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1;
  return sorted[index] ?? null;
}

export class StageProfiler {
  private readonly samples = new Map<PipelineStage, number[]>();
  private readonly failureCounts = new Map<PipelineStage, number>();
  private readonly retryCounts = new Map<PipelineStage, number>();

  record(stage: PipelineStage, durationMs: number, outcome: { failed?: boolean; retries?: number } = {}): void {
    const samples = this.samples.get(stage) ?? [];
    samples.push(durationMs);
    this.samples.set(stage, samples);
    if (outcome.failed) this.failureCounts.set(stage, (this.failureCounts.get(stage) ?? 0) + 1);
    if (outcome.retries) this.retryCounts.set(stage, (this.retryCounts.get(stage) ?? 0) + outcome.retries);
  }

  async time<T>(stage: PipelineStage, work: () => Promise<T>, outcome: { failed?: boolean; retries?: number } = {}): Promise<T> {
    const started = performance.now();
    try {
      const value = await work();
      this.record(stage, performance.now() - started, outcome);
      return value;
    } catch (error) {
      this.record(stage, performance.now() - started, { ...outcome, failed: true });
      throw error;
    }
  }

  measure<T>(stage: PipelineStage, work: () => T): T {
    const started = performance.now();
    try {
      const value = work();
      this.record(stage, performance.now() - started);
      return value;
    } catch (error) {
      this.record(stage, performance.now() - started, { failed: true });
      throw error;
    }
  }

  report(): { stages: StageSummary[]; measuredStages: number } {
    const stages = PIPELINE_STAGES.map((stage) => {
      const samples = this.samples.get(stage) ?? [];
      const wallMs = samples.reduce((sum, value) => sum + value, 0);
      return {
        stage,
        count: samples.length,
        failures: this.failureCounts.get(stage) ?? 0,
        retries: this.retryCounts.get(stage) ?? 0,
        wallMs,
        p50Ms: percentile(samples, 50),
        p95Ms: percentile(samples, 95),
        throughputPerSecond: wallMs > 0 ? samples.length / (wallMs / 1000) : null,
      };
    });
    return { stages, measuredStages: stages.filter((stage) => stage.count > 0).length };
  }
}

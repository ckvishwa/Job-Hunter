export interface LatencySummary {
  count: number;
  averageMs: number | null;
  p95Ms: number | null;
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil((q / 100) * ordered.length) - 1));
  return ordered[index]!;
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, averageMs: null, p95Ms: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return { count: values.length, averageMs: total / values.length, p95Ms: percentile(values, 95) };
}

export interface ThroughputReport {
  condition: "live" | "synthetic";
  requests: number;
  uniqueVerifiedRelevantPerMinute: number | null;
  falseDuplicateRate: number | null;
  latency: LatencySummary;
  notes: string;
}

export function throughput(input: {
  condition: "live" | "synthetic";
  requests: number;
  durationsMs: readonly number[];
  uniqueVerifiedRelevant: number;
  wallMs: number;
  falseDuplicates: number;
  comparisons: number;
  notes: string;
}): ThroughputReport {
  const minutes = input.wallMs / 60_000;
  return {
    condition: input.condition,
    requests: input.requests,
    uniqueVerifiedRelevantPerMinute: minutes > 0 ? input.uniqueVerifiedRelevant / minutes : null,
    falseDuplicateRate: input.comparisons > 0 ? input.falseDuplicates / input.comparisons : null,
    latency: summarizeLatency(input.durationsMs),
    notes: input.notes,
  };
}

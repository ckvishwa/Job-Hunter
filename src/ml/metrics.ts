export interface Scored { score: number; label: boolean; family?: string | null; /** Inverse inclusion probability of this row (stratified random sample). Absent = 1. */ weight?: number }

export interface BinaryMetrics {
  n: number; positives: number; negatives: number; threshold: number;
  tp: number; fp: number; fn: number; tn: number;
  precision: number | null; recall: number | null; f1: number | null; falsePositiveRate: number | null;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function binaryMetrics(rows: readonly Scored[], threshold: number): BinaryMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const pred = r.score >= threshold;
    if (pred && r.label) tp++; else if (pred) fp++; else if (r.label) fn++; else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { n: rows.length, positives: tp + fn, negatives: fp + tn, threshold, tp, fp, fn, tn, precision, recall, f1, falsePositiveRate: ratio(fp, fp + tn) };
}

/** Threshold that maximises F1 on the rows given (call with TRAIN rows only). Ties go to the higher threshold. */
export function bestF1Threshold(rows: readonly Scored[]): number {
  const cuts = [...new Set(rows.map((r) => r.score))].sort((a, b) => a - b);
  let best = { t: cuts[0] ?? 0.5, f: -1 };
  for (const t of cuts) {
    const f = binaryMetrics(rows, t).f1 ?? -1;
    if (f >= best.f) best = { t, f };
  }
  return best.t;
}

export function precisionAtK(rows: readonly Scored[], k: number): number | null {
  const top = [...rows].sort((a, b) => b.score - a.score).slice(0, k);
  return top.length === 0 ? null : top.filter((r) => r.label).length / top.length;
}

export function recallAtK(rows: readonly Scored[], k: number): number | null {
  const positives = rows.filter((r) => r.label).length;
  if (positives === 0) return null;
  return [...rows].sort((a, b) => b.score - a.score).slice(0, k).filter((r) => r.label).length / positives;
}

/** Only meaningful when scores are probabilities (the logistic model), never for raw cosine similarity. */
export function calibration(rows: readonly Scored[], bins = 10): { brier: number | null; ece: number | null } {
  if (rows.length === 0) return { brier: null, ece: null };
  const brier = rows.reduce((s, r) => s + (r.score - (r.label ? 1 : 0)) ** 2, 0) / rows.length;
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const inBin = rows.filter((r) => Math.min(bins - 1, Math.floor(r.score * bins)) === b);
    if (inBin.length === 0) continue;
    const conf = inBin.reduce((s, r) => s + r.score, 0) / inBin.length;
    const acc = inBin.filter((r) => r.label).length / inBin.length;
    ece += (inBin.length / rows.length) * Math.abs(conf - acc);
  }
  return { brier, ece };
}

export function byFamily(rows: readonly Scored[], threshold: number): Record<string, BinaryMetrics> {
  const out: Record<string, BinaryMetrics> = {};
  for (const family of new Set(rows.map((r) => r.family ?? "unknown"))) out[family] = binaryMetrics(rows.filter((r) => (r.family ?? "unknown") === family), threshold);
  return out;
}

export interface WeightedMetrics { effectiveN: number; precision: number | null; recall: number | null; f1: number | null; falsePositiveRate: number | null }

/** Horvitz-Thompson style metrics for rows drawn by stratified random sampling: each row stands for `weight` pool pairs. */
export function weightedMetrics(rows: readonly Scored[], threshold: number): WeightedMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0, w = 0;
  for (const r of rows) {
    const x = r.weight ?? 1;
    w += x;
    const pred = r.score >= threshold;
    if (pred && r.label) tp += x; else if (pred) fp += x; else if (r.label) fn += x; else tn += x;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null ? null : precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { effectiveN: w, precision, recall, f1, falsePositiveRate: ratio(fp, fp + tn) };
}

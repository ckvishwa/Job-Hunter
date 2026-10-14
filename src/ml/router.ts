import { CONFIDENT, jdCompleteness, labelOnce, type LlmProvider, type RoleBrief } from "./llm-label.js";

export interface MlAcceptance { score: number; calibrated: boolean; acceptanceValidated: boolean; band: [number, number] }
export interface RoutedPrediction { path: "ML" | "QWEN" | "REVIEW"; decision: "relevant" | "irrelevant" | "unknown"; reason: string; evidence: string[]; elapsedMs: number }

/** Explicit shadow callers only. Does not write labels, rank jobs or approve applications. */
export async function routePrediction(posting: { title: string; company: string; description: string }, role: RoleBrief, ml: MlAcceptance | null, qwen: LlmProvider): Promise<RoutedPrediction> {
  const started = performance.now();
  const result = (path: RoutedPrediction["path"], decision: RoutedPrediction["decision"], reason: string, evidence: string[] = []): RoutedPrediction => ({ path, decision, reason, evidence, elapsedMs: performance.now() - started });
  if (!jdCompleteness(posting.description).ok) return result("REVIEW", "unknown", "INCOMPLETE_JD");
  if (ml && ml.calibrated && ml.acceptanceValidated && Number.isFinite(ml.score) && ml.score >= 0 && ml.score <= 1 && ml.band[0] >= 0 && ml.band[0] < 0.5 && ml.band[1] > 0.5 && ml.band[1] <= 1) {
    if (ml.score <= ml.band[0]) return result("ML", "irrelevant", "Validated calibrated acceptance");
    if (ml.score >= ml.band[1]) return result("ML", "relevant", "Validated calibrated acceptance");
  }
  const answer = await labelOnce(qwen, "A", role, posting);
  if (!answer.ok) return result("REVIEW", "unknown", answer.reason);
  if (answer.output.confidence < CONFIDENT || !["relevant", "irrelevant"].includes(answer.output.relevance)) return result("REVIEW", "unknown", "Qwen abstained or proposed a nonbinary class", answer.quotes);
  return result("QWEN", answer.output.relevance as "relevant" | "irrelevant", "Provisional evidence-grounded fallback; not a human label", answer.quotes);
}

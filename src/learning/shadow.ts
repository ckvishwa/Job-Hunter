import { evaluateRelevance, type RelevanceEvaluation } from "../discovery/relevance.js";
import type { RoleConfig } from "../types.js";
import type { LearningManifest } from "./labels.js";

export interface ShadowPrediction {
  jobId: string;
  score: number;
  band: "LIKELY" | "UNCERTAIN" | "UNLIKELY";
  hardReject: false;
  evidence: string;
}

/** A shadow score annotates a listing. It never removes the listing. */
export function shadowRelevance(
  job: { jobId: string; title: string; department?: string | null; location?: string | null; descriptionSnippet?: string | null },
  roles: readonly RoleConfig[],
): ShadowPrediction {
  if (!job.title.trim() || roles.length === 0) {
    return { jobId: job.jobId, score: 0.5, band: "UNCERTAIN", hardReject: false, evidence: "The title or the role configuration is missing, so the score stays uncertain." };
  }
  const evaluation: RelevanceEvaluation = evaluateRelevance(
    { title: job.title, department: job.department, location: job.location, descriptionSnippet: job.descriptionSnippet },
    [...roles],
  );
  if (!evaluation.matched) {
    return { jobId: job.jobId, score: 0.2, band: "UNLIKELY", hardReject: false, evidence: evaluation.relevanceReason };
  }
  return { jobId: job.jobId, score: 0.8, band: "LIKELY", hardReject: false, evidence: evaluation.relevanceReason };
}

export interface ShadowEvaluation {
  status: "WITHHELD" | "REPORTED";
  reason: string;
  m4ScenarioLabelsUsedAsTruth: false;
  promoted: false;
  metrics: null | {
    precision: number;
    recall: number;
    falseNegativeRate: number;
    labeled: number;
  };
}

/**
 * Reports shadow metrics only for a frozen independent split.
 * Scenario-authored M4 labels are not accepted by the caller that builds the manifest.
 */
export function evaluateShadow(manifest: LearningManifest, labels: ReadonlyMap<string, string>, predictions: readonly ShadowPrediction[]): ShadowEvaluation {
  if (manifest.status !== "READY" || !manifest.heldoutFrozen || !manifest.heldoutSha256) {
    return {
      status: "WITHHELD",
      reason: manifest.reason,
      m4ScenarioLabelsUsedAsTruth: false,
      promoted: false,
      metrics: null,
    };
  }
  let relevant = 0;
  let predictedRelevant = 0;
  let truePositive = 0;
  let falseNegative = 0;
  for (const id of manifest.heldoutIds) {
    const label = labels.get(id);
    const prediction = predictions.find((item) => item.jobId === id);
    if (!label || !prediction || prediction.hardReject !== false) continue;
    const isRelevant = label === "RELEVANT" || label === "ADJACENT";
    const called = prediction.band === "LIKELY";
    if (isRelevant) relevant += 1;
    if (called) predictedRelevant += 1;
    if (isRelevant && called) truePositive += 1;
    if (isRelevant && !called) falseNegative += 1;
  }
  return {
    status: "REPORTED",
    reason: "Shadow metrics on the frozen held-out ids. The model is not promoted.",
    m4ScenarioLabelsUsedAsTruth: false,
    promoted: false,
    metrics: {
      precision: predictedRelevant === 0 ? 0 : truePositive / predictedRelevant,
      recall: relevant === 0 ? 0 : truePositive / relevant,
      falseNegativeRate: relevant === 0 ? 0 : falseNegative / relevant,
      labeled: manifest.heldoutIds.length,
    },
  };
}

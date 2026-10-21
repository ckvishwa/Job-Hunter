import type { LearningManifest } from "./owner-labels.js";

export interface MlEvaluation {
  status: "NOT_EVALUATED";
  trained: false;
  promoted: false;
  reason: string;
  scenarioLabelsUsedAsTruth: false;
  metrics: null;
}

export function evaluateMl(manifest: LearningManifest): MlEvaluation {
  return {
    status: "NOT_EVALUATED",
    trained: false,
    promoted: false,
    reason: manifest.reason,
    scenarioLabelsUsedAsTruth: false,
    metrics: null,
  };
}

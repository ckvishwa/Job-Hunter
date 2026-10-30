export interface SkillGateInput {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  sourceEvidenceValid: number;
  sourceEvidenceChecked: number;
  routineApprovals: number;
  processingFailures: number;
  independentReviewer: boolean;
  frozenBeforeScoring: boolean;
  tunedOnThisSet: boolean;
  sampleSize: number;
}

export interface SkillGateResult {
  status: "MET" | "NOT_MET";
  precision: number | null;
  recall: number | null;
  precisionLower95: number | null;
  recallLower95: number | null;
  sourceEvidenceValidity: number | null;
  reasons: string[];
}

function wilsonLower(successes: number, trials: number): number | null {
  if (trials <= 0) return null;
  const z = 1.96;
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return (center - margin) / denom;
}

export function skillExtractionGate(input: SkillGateInput): SkillGateResult {
  const predicted = input.truePositives + input.falsePositives;
  const relevant = input.truePositives + input.falseNegatives;
  const precision = predicted === 0 ? null : input.truePositives / predicted;
  const recall = relevant === 0 ? null : input.truePositives / relevant;
  const precisionLower95 = wilsonLower(input.truePositives, predicted);
  const recallLower95 = wilsonLower(input.truePositives, relevant);
  const sourceEvidenceValidity = input.sourceEvidenceChecked === 0 ? null : input.sourceEvidenceValid / input.sourceEvidenceChecked;
  const reasons: string[] = [];
  if (!input.independentReviewer) reasons.push("Labels do not have an independent reviewer.");
  if (!input.frozenBeforeScoring) reasons.push("The evaluation set was not frozen before scoring.");
  if (input.tunedOnThisSet) reasons.push("The extractor was tuned on this set.");
  if (input.processingFailures > 0) reasons.push("A processing failure is not a perfect score.");
  if (input.routineApprovals !== 0) reasons.push("Routine user approvals are still required.");
  if (sourceEvidenceValidity !== 1) reasons.push("Source-evidence validity is below 100%.");
  if (precision === null || precision < 0.99 || precisionLower95 === null || precisionLower95 < 0.99) {
    reasons.push("Skill precision does not clear 99% with a 95% Wilson lower bound.");
  }
  if (recall === null || recall < 0.99 || recallLower95 === null || recallLower95 < 0.99) {
    reasons.push("Skill recall does not clear 99% with a 95% Wilson lower bound.");
  }
  if (input.sampleSize < relevant) reasons.push("Sample size is smaller than the labeled skill count.");
  return {
    status: reasons.length === 0 ? "MET" : "NOT_MET",
    precision,
    recall,
    precisionLower95,
    recallLower95,
    sourceEvidenceValidity,
    reasons,
  };
}

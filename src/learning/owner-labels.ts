export const LABEL_VALUES = ["RELEVANT", "ADJACENT", "IRRELEVANT", "UNSURE"] as const;
export type OwnerLabelValue = (typeof LABEL_VALUES)[number];

export interface OwnerLabel {
  jobId: string;
  label: OwnerLabelValue;
  reason: string | null;
  roleRelevance: string | null;
  jdSha256: string | null;
  jdVersion: string | null;
  reviewer: string;
  labeledAt: string;
  searchSource: string | null;
  provenance: "human";
}

export function parseOwnerLabel(raw: unknown): OwnerLabel {
  if (!raw || typeof raw !== "object") throw new Error("A label must be an object.");
  const row = raw as Record<string, unknown>;
  if (typeof row.jobId !== "string" || !row.jobId.trim()) throw new Error("A label needs a job id.");
  if (typeof row.label !== "string" || !LABEL_VALUES.includes(row.label as OwnerLabelValue)) {
    throw new Error("A label must be RELEVANT, ADJACENT, IRRELEVANT, or UNSURE.");
  }
  if (row.provenance !== "human") throw new Error("Synthetic or model labels cannot enter the human label file.");
  if (typeof row.reviewer !== "string" || !row.reviewer.trim()) throw new Error("A label needs a reviewer.");
  if (typeof row.labeledAt !== "string" || Number.isNaN(Date.parse(row.labeledAt))) throw new Error("A label needs a labeling time.");
  return {
    jobId: row.jobId.trim(),
    label: row.label as OwnerLabelValue,
    reason: typeof row.reason === "string" ? row.reason : null,
    roleRelevance: typeof row.roleRelevance === "string" ? row.roleRelevance : null,
    jdSha256: typeof row.jdSha256 === "string" ? row.jdSha256 : null,
    jdVersion: typeof row.jdVersion === "string" ? row.jdVersion : null,
    reviewer: row.reviewer.trim(),
    labeledAt: row.labeledAt,
    searchSource: typeof row.searchSource === "string" ? row.searchSource : null,
    provenance: "human",
  };
}

export interface LearningManifest {
  status: "WITHHELD";
  reason: string;
  humanLabels: number;
  minimumIndependentLabels: number;
  scenarioLabelsUsedAsTruth: false;
}

export function prepareLearningSet(labels: readonly OwnerLabel[]): LearningManifest {
  return {
    status: "WITHHELD",
    reason: labels.length === 0
      ? "No human labels exist. Training stays off."
      : "Human labels exist, but no frozen employer-and-time split has been locked. Training stays off.",
    humanLabels: labels.length,
    minimumIndependentLabels: 50,
    scenarioLabelsUsedAsTruth: false,
  };
}

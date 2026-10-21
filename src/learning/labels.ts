import { createHash } from "node:crypto";

export const HUMAN_LABELS = ["RELEVANT", "ADJACENT", "IRRELEVANT", "UNSURE"] as const;
export type HumanLabelValue = (typeof HUMAN_LABELS)[number];

export interface HumanLabel {
  jobId: string;
  jdSha256: string | null;
  queryProvenance: { searchRunId: string | null; source: string | null; keyword: string | null };
  label: HumanLabelValue;
  reason: string;
  labeledAt: string;
  labeler: "owner";
  origin: "human";
}

export interface LearningJob {
  jobId: string;
  employer: string | null;
  title: string;
  location: string | null;
  jdSha256: string | null;
  capturedAt: string | null;
  source?: string | null;
}

export interface LearningManifest {
  status: "READY" | "WITHHELD";
  reason: string;
  independentLabels: number;
  rejectedScenarioLabels: number;
  rejectedUnmatched: number;
  rejectedDuplicates: number;
  trainIds: string[];
  heldoutIds: string[];
  heldoutFrozen: boolean;
  heldoutSha256: string | null;
  leakage: { employers: string[]; sources: string[]; chronological: boolean; trainLatest: string | null; heldoutEarliest: string | null };
  m4ScenarioLabelsUsedAsTruth: false;
}

export const MIN_INDEPENDENT_LABELS = 40;
export const MIN_HELDOUT_LABELS = 12;

const norm = (value: string | null | undefined): string => (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function nearDuplicateKey(job: Pick<LearningJob, "employer" | "title" | "location">): string {
  return `${norm(job.employer)}|${norm(job.title)}|${norm(job.location)}`;
}

export function isIndependentHumanLabel(label: { origin?: string; labeler?: string; label?: string }): boolean {
  return label.origin === "human" && label.labeler === "owner" && HUMAN_LABELS.includes(label.label as HumanLabelValue);
}

export function prepareLearningSet(labels: readonly Record<string, unknown>[], jobs: readonly LearningJob[]): LearningManifest {
  const byId = new Map(jobs.map((job) => [job.jobId, job]));
  let rejectedScenarioLabels = 0;
  let rejectedUnmatched = 0;
  const accepted: Array<HumanLabel & { key: string }> = [];
  for (const raw of labels) {
    if (!isIndependentHumanLabel(raw as unknown as HumanLabel)) {
      rejectedScenarioLabels += 1;
      continue;
    }
    const label = raw as unknown as HumanLabel;
    const job = byId.get(label.jobId);
    if (!job || (label.jdSha256 && job.jdSha256 && label.jdSha256 !== job.jdSha256)) {
      rejectedUnmatched += 1;
      continue;
    }
    accepted.push({ ...label, key: nearDuplicateKey(job) });
  }
  accepted.sort((a, b) => a.labeledAt.localeCompare(b.labeledAt));
  const seen = new Set<string>();
  const unique: typeof accepted = [];
  let rejectedDuplicates = 0;
  for (const label of accepted) {
    if (seen.has(label.key)) {
      rejectedDuplicates += 1;
      continue;
    }
    seen.add(label.key);
    unique.push(label);
  }
  const heldoutCount = Math.ceil(unique.length * 0.3);
  const train = unique.slice(0, unique.length - heldoutCount);
  const heldout = unique.slice(unique.length - heldoutCount);
  const enough = unique.length >= MIN_INDEPENDENT_LABELS && heldout.length >= MIN_HELDOUT_LABELS && new Set(unique.map((label) => label.label)).size >= 2;
  const employers = overlap(train, heldout, (id) => norm(byId.get(id)?.employer));
  const sources = overlap(train, heldout, (id) => norm(byId.get(id)?.source));
  const trainLatest = train.at(-1)?.labeledAt ?? null;
  const heldoutEarliest = heldout[0]?.labeledAt ?? null;
  const heldoutIds = heldout.map((label) => label.jobId);
  return {
    status: enough ? "READY" : "WITHHELD",
    reason: enough
      ? "Independent owner labels cover more than one class, and the later labels are frozen as held-out."
      : "Independent owner labels are not yet sufficient for training or for an untouched evaluation split.",
    independentLabels: unique.length,
    rejectedScenarioLabels,
    rejectedUnmatched,
    rejectedDuplicates,
    trainIds: enough ? train.map((label) => label.jobId) : [],
    heldoutIds: enough ? heldoutIds : [],
    heldoutFrozen: enough,
    heldoutSha256: enough ? createHash("sha256").update(JSON.stringify(heldoutIds)).digest("hex") : null,
    leakage: { employers, sources, chronological: Boolean(trainLatest && heldoutEarliest && trainLatest > heldoutEarliest), trainLatest, heldoutEarliest },
    m4ScenarioLabelsUsedAsTruth: false,
  };
}

function overlap(train: readonly { jobId: string }[], heldout: readonly { jobId: string }[], value: (jobId: string) => string): string[] {
  const left = new Set(train.map((label) => value(label.jobId)).filter(Boolean));
  const right = new Set(heldout.map((label) => value(label.jobId)).filter(Boolean));
  return [...left].filter((item) => right.has(item)).sort();
}

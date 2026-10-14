import { GATES } from "./types.js";
import type { BuiltDataset } from "./split.js";

// What the reviewer shows the person: what each answer means, what is still missing for the training gates, and which questions are NOT part of relevance.

export const RELEVANCE_DEFINITIONS: ReadonlyArray<{ key: string; value: string; meaning: string; example: string }> = [
  { key: "r", value: "relevant", meaning: "Doing this job would BE the role under review (or a close variant of it). The day-to-day work matches, not only the title.", example: "'Security Operations Analyst' for SOC Analyst" },
  { key: "a", value: "adjacent", meaning: "Related work in the same field that someone in the role could plausibly move to or from, but it is not the role itself.", example: "'Security Engineer' for SOC Analyst; 'Cloud Operations Engineer' for Cloud Security Analyst" },
  { key: "i", value: "irrelevant", meaning: "A different kind of work. The role's skills are not what the job is about.", example: "'Marketing Operations Manager' for NOC Technician" },
  { key: "u", value: "unsure", meaning: "You cannot decide from the posting (too vague or missing text). Unsure pairs are kept but never used for training.", example: "a one-line posting" },
];

export const SEPARATION_NOTE =
  "Judge the ROLE only. Do not let seniority, location or remote/onsite, visa or clearance, your own qualifications, or whether you would be hired change your answer. " +
  "A 'Senior SOC Analyst' is still relevant to SOC Analyst. Record seniority (s) and work mode (w) separately; eligibility is decided elsewhere.";

export interface DeficitReport {
  counts: BuiltDataset["counts"];
  needs: { trainRelevant: number; trainIrrelevant: number; heldoutRelevant: number; heldoutIrrelevant: number; heldoutEmployers: number };
  lines: string[];
  ready: boolean;
}

const need = (have: number, min: number): number => Math.max(0, min - have);

export function deficitReport(counts: BuiltDataset["counts"]): DeficitReport {
  const needs = {
    trainRelevant: need(counts.train.relevant, GATES.minTrainPerClass), trainIrrelevant: need(counts.train.irrelevant, GATES.minTrainPerClass),
    heldoutRelevant: need(counts.heldout.relevant, GATES.minHeldoutPerClass), heldoutIrrelevant: need(counts.heldout.irrelevant, GATES.minHeldoutPerClass),
    heldoutEmployers: need(counts.employers.heldout, GATES.minHeldoutEmployers),
  };
  const row = (label: string, have: number, min: number) => `${label.padEnd(26)} ${String(have).padStart(3)} / ${String(min).padEnd(3)} ${have >= min ? "ok" : `need ${min - have} more`}`;
  const lines = [
    row("train      relevant", counts.train.relevant, GATES.minTrainPerClass),
    row("train      irrelevant", counts.train.irrelevant, GATES.minTrainPerClass),
    row("held-out   relevant", counts.heldout.relevant, GATES.minHeldoutPerClass),
    row("held-out   irrelevant", counts.heldout.irrelevant, GATES.minHeldoutPerClass),
    row("held-out   employers", counts.employers.heldout, GATES.minHeldoutEmployers),
    `adjacent ${counts.train.adjacent + counts.heldout.adjacent}, unsure ${counts.train.unsure + counts.heldout.unsure} (kept, never trained on)`,
  ];
  return { counts, needs, lines, ready: Object.values(needs).every((n) => n === 0) };
}

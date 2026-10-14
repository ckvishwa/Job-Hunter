import { randomUUID } from "node:crypto";
import type { LabelRow, MlRepo } from "./repo.js";

// Safe correction of an earlier human label. The original row is NEVER edited or deleted: a correction is a new, explicit, reviewer-attributed row with a
// reason, written only by a person-invoked command. Nothing here is called from sampling, training or any automatic path.

export const CORRECTION_NOTE = /^CORRECTS #(\d+) \(([a-z_0-9-]+) -> ([a-z_0-9-]+)\): (.+)$/s;

export class CorrectionError extends Error {
  constructor(readonly code: "UNKNOWN_LABEL" | "NOT_CURRENT" | "NO_CHANGE" | "REASON_REQUIRED" | "STALE_TEXT", message: string) {
    super(message);
    this.name = "CorrectionError";
  }
}

export interface CorrectionResult { newLabelId: number; corrected: number; from: string; to: string }

export async function correctLabel(repo: MlRepo, input: { labelId: number; value: string; reviewer: string; reason: string }): Promise<CorrectionResult> {
  const reason = input.reason.trim();
  if (reason.length < 8) throw new CorrectionError("REASON_REQUIRED", "A correction needs a reason of at least 8 characters.");
  const old = await repo.labelById(input.labelId);
  if (!old) throw new CorrectionError("UNKNOWN_LABEL", `There is no label #${input.labelId}.`);
  const history = await repo.labelHistory(old.postingId, old.task, old.roleSlug);
  const newest = history.at(-1)!;
  if (newest.id !== old.id) throw new CorrectionError("NOT_CURRENT", `Label #${old.id} was already superseded by #${newest.id} (${newest.value}). Correct #${newest.id} instead.`);
  if (old.value === input.value) throw new CorrectionError("NO_CHANGE", `Label #${old.id} is already "${old.value}".`);
  const posting = await repo.posting(old.postingId);
  if (!posting || posting.textSha256 !== old.textSha256) throw new CorrectionError("STALE_TEXT", "The posting text changed since this label was made; the label is stale and is not corrected, relabel the pair instead.");
  const saved = await repo.saveLabel({
    postingId: old.postingId, textSha256: old.textSha256, task: old.task as never, roleSlug: old.roleSlug, value: input.value, reviewer: input.reviewer,
    sessionId: `corr-${randomUUID().slice(0, 8)}`, selectionBasis: old.selectionBasis, note: `CORRECTS #${old.id} (${old.value} -> ${input.value}): ${reason}`.slice(0, 500),
  });
  return { newLabelId: saved.id, corrected: old.id, from: old.value, to: input.value };
}

export const correctionOf = (l: Pick<LabelRow, "note">): { corrects: number; from: string; to: string; reason: string } | null => {
  const m = l.note ? CORRECTION_NOTE.exec(l.note) : null;
  return m ? { corrects: Number(m[1]), from: m[2]!, to: m[3]!, reason: m[4]! } : null;
};

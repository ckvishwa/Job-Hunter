import { createHash } from "node:crypto";

export interface ScanCheckpoint {
  version: 1;
  sourceRunId: string;
  completedEmployerIds: string[];
  sha256: string;
}

export function sealCheckpoint(sourceRunId: string, completedEmployerIds: string[]): ScanCheckpoint {
  const body = JSON.stringify({ version: 1, sourceRunId, completedEmployerIds });
  return { version: 1, sourceRunId, completedEmployerIds, sha256: createHash("sha256").update(body).digest("hex") };
}

export function openCheckpoint(raw: unknown): ScanCheckpoint {
  if (!raw || typeof raw !== "object") throw new Error("Checkpoint is not an object.");
  const row = raw as ScanCheckpoint;
  if (row.version !== 1 || !Array.isArray(row.completedEmployerIds) || typeof row.sha256 !== "string") {
    throw new Error("Checkpoint shape is corrupt.");
  }
  const expected = sealCheckpoint(row.sourceRunId, row.completedEmployerIds).sha256;
  if (expected !== row.sha256) throw new Error("Checkpoint hash does not match its contents.");
  return row;
}

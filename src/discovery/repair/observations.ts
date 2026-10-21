import { createHash } from "node:crypto";

export interface RawObservation {
  provider: string;
  employer: string;
  title: string | null;
  sourceUrl: string;
  sourcePostingId: string | null;
  requisitionId: string | null;
  location: string | null;
  postedAt: string | null;
  postingDatePrecision: "exact" | "approximate" | "unknown";
  discoveredAt: string;
  descriptionText: string | null;
  descriptionStatus: "retrieved" | "missing" | "unchanged";
  outcome: string;
  contentHash: string | null;
}

export function contentHash(text: string | null): string | null {
  if (!text) return null;
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

export function observationKey(row: Pick<RawObservation, "provider" | "employer" | "requisitionId" | "sourceUrl">): string {
  if (row.requisitionId) return `${row.provider}::${row.employer.toLowerCase()}::${row.requisitionId}`;
  return `${row.provider}::url::${row.sourceUrl}`;
}

/** Keep an existing description when a repeat observation does not include one. Update the discovery timestamp. */
export function mergeObservations(existing: readonly RawObservation[], incoming: readonly RawObservation[]): RawObservation[] {
  const byKey = new Map(existing.map((row) => [observationKey(row), row]));
  for (const row of incoming) {
    const key = observationKey(row);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const description = row.descriptionText ?? prev.descriptionText;
    byKey.set(key, {
      ...row,
      descriptionText: description,
      descriptionStatus: description && row.descriptionText === prev.descriptionText ? "unchanged" : row.descriptionStatus,
      contentHash: contentHash(description),
      discoveredAt: row.discoveredAt,
    });
  }
  return [...byKey.values()];
}

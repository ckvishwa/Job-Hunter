import { appendJsonlRecords } from "../storage/jsonl-store.js";
import { existsSync, readFileSync, statSync } from "node:fs";

/** Identity and decision for one listing, captured before a candidate filter can drop it. */
export interface ListingProvenance {
  kind: "listing";
  capturedAt: string;
  searchRunId: string;
  source: string;
  keyword: string | null;
  searchLocation: string | null;
  title: string;
  employer: string | null;
  location: string | null;
  salary: string | null;
  resultUrl: string | null;
  officialUrl: string | null;
  applicationUrl: string | null;
  externalId: string | null;
  /** Text the source supplied. This is not treated as a verified posting date. */
  sourceDateText: string | null;
  postingDate: null;
  postingDateStatus: "unknown";
  relevanceMatched: boolean;
  matchedProfiles: string[];
  relevanceReason: string;
  disposition: "retained" | "filtered";
  filterReason: string | null;
  descriptionText: string | null;
  descriptionComplete: boolean;
}

export interface ProvenanceGap {
  kind: "provenance-gap";
  capturedAt: string;
  reason: "file-limit";
  dropped: number;
}

export type ProvenanceLine = ListingProvenance | ProvenanceGap;

export const PROVENANCE_FILE_LIMIT_BYTES = 32 * 1024 * 1024;

export function listingProvenance(input: Omit<ListingProvenance, "kind" | "postingDate" | "postingDateStatus">): ListingProvenance {
  if (!input.title.trim()) throw new Error("A provenance record needs a title.");
  if (input.disposition !== "retained" && input.disposition !== "filtered") throw new Error("A provenance record needs a disposition.");
  return { ...input, kind: "listing", postingDate: null, postingDateStatus: "unknown", title: input.title.trim() };
}

function fileBytes(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).size : 0;
}

/** Append-only. A full file keeps its existing lines and records one gap instead of growing without a bound. */
export function appendProvenance(
  filePath: string,
  records: readonly ListingProvenance[],
  limitBytes = PROVENANCE_FILE_LIMIT_BYTES,
  now = new Date(),
): { written: number; dropped: number } {
  if (records.length === 0) return { written: 0, dropped: 0 };
  for (const record of records) {
    if (record.kind !== "listing" || !record.title.trim()) throw new Error("Refusing to append an invalid provenance record.");
  }
  if (fileBytes(filePath) > limitBytes) return { written: 0, dropped: records.length };
  const payload = Buffer.byteLength(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  if (fileBytes(filePath) + payload > limitBytes) {
    appendJsonlRecords(filePath, [gap(now, records.length)]);
    return { written: 0, dropped: records.length };
  }
  appendJsonlRecords(filePath, records);
  return { written: records.length, dropped: 0 };
}

function gap(now: Date, dropped: number): ProvenanceGap {
  return { kind: "provenance-gap", capturedAt: now.toISOString(), reason: "file-limit", dropped };
}

let queue: Promise<void> = Promise.resolve();

/** Serializes appends in this process so concurrent callers cannot tear a line. */
export function appendProvenanceQueued(
  filePath: string,
  records: readonly ListingProvenance[],
  limitBytes = PROVENANCE_FILE_LIMIT_BYTES,
): Promise<{ written: number; dropped: number }> {
  const run = queue.then(() => appendProvenance(filePath, records, limitBytes));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

export function readProvenance(filePath: string): { records: ListingProvenance[]; gaps: ProvenanceGap[]; tornTail: boolean } {
  if (!existsSync(filePath)) return { records: [], gaps: [], tornTail: false };
  const raw = readFileSync(filePath, "utf8");
  if (raw.length === 0) return { records: [], gaps: [], tornTail: false };
  const lines = raw.split("\n");
  const tornTail = lines[lines.length - 1] !== "";
  const complete = tornTail ? lines.slice(0, -1) : lines;
  const records: ListingProvenance[] = [];
  const gaps: ProvenanceGap[] = [];
  for (const line of complete) {
    if (!line) continue;
    const parsed = JSON.parse(line) as ProvenanceLine;
    if (parsed.kind === "provenance-gap") gaps.push(parsed);
    else records.push(parsed);
  }
  return { records, gaps, tornTail };
}

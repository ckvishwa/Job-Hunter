// Raw shape of `node scan-ats-full.mjs --json` stdout, confirmed empirically against career-ops
// commit 7bb0460c469642033dd5e90c4ead39940157e4f2 (docs/plans/2026-07-29-careerops-integration.md
// records the exact commands run and captured output). A single top-level JSON object, not
// JSONL -- `offers` is the nested array of job records. No `description` field exists anywhere
// in this contract; never assume one.
export interface CareerOpsOfferRaw {
  company: string;
  title: string;
  url: string;
  location: string | null;
  postedAt: string | null;
  dateStatus: string;
  blacklisted: boolean;
  note: string | null;
  source: string;
}

export interface CareerOpsScanResultRaw {
  date: string;
  sources: string[];
  resumed: boolean;
  sinceDays: number;
  companiesAvailable: number;
  companiesScanned: number;
  capHit: boolean;
  datasetStatus: Record<string, string>;
  postingsKept: number;
  postingsDroppedNoDate: number;
  postingsFilteredBlacklist: number;
  postingsAnnotatedBlacklisted: number;
  postingsDroppedContent: number;
  unreachableBoards: number;
  cappedBoards: number;
  saved: boolean;
  offers: CareerOpsOfferRaw[];
}

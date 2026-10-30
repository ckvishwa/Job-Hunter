export interface FreshnessInfo {
  postingAgeDays: number | null;
  isNew: boolean;
  isUpdated: boolean;
  isStale: boolean;
}

export interface FreshnessJobFields {
  discoveredAt: string;
  lastSeenAt: string;
  postingDate: string | null;
}

export interface FreshnessOptions {
  now: string;
  // null = no previous successful hunt on record (bootstrap run) -- everything counts as new.
  previousHuntAt: string | null;
  staleDays: number;
}

const DAY_MS = 86_400_000;

export function computeFreshness(job: FreshnessJobFields, opts: FreshnessOptions): FreshnessInfo {
  const nowMs = Date.parse(opts.now);

  const postingAgeDays = job.postingDate ? Math.floor((nowMs - Date.parse(job.postingDate)) / DAY_MS) : null;

  const previousHuntMs = opts.previousHuntAt !== null ? Date.parse(opts.previousHuntAt) : null;
  const isNew = previousHuntMs === null || Date.parse(job.discoveredAt) > previousHuntMs;
  const isUpdated = !isNew && previousHuntMs !== null && Date.parse(job.lastSeenAt) > previousHuntMs;
  const isStale = (nowMs - Date.parse(job.lastSeenAt)) / DAY_MS > opts.staleDays;

  return { postingAgeDays, isNew, isUpdated, isStale };
}

export type PostingDatePrecision = "exact" | "approximate" | "unknown";

/** Classify a source date string. Discovery time is never a posting date. */
export function postingDatePrecision(sourceDate: string | null | undefined): { postedAt: string | null; precision: PostingDatePrecision } {
  if (!sourceDate || !sourceDate.trim()) return { postedAt: null, precision: "unknown" };
  const value = sourceDate.trim();
  if (/ago|today|yesterday|posted\s+\d+/i.test(value)) return { postedAt: value, precision: "approximate" };
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) return { postedAt: value, precision: "exact" };
  return { postedAt: value, precision: "unknown" };
}

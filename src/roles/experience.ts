import { factUsability, type CandidateFact } from "../domain/candidate-profile.js";

// S2: grounded experience summary. Pure and deterministic. Only APPROVED, usable facts count, and an employment fact counts only
// toward the bucket a person classified it into (attributes.employmentType). Nothing here is inferred from a title, a skill
// mention, a project or a degree.
//
// Date convention (month precision only; days are never invented):
//   * A range is [start month, end month). The end month is NOT counted in the LOWER bound (conservative).
//   * The UPPER bound counts both the start and end month, i.e. [start, end + 1). The truth lies between the two.
//   * A current job (endDate explicitly null) ends at the month of `asOf`: the lower bound counts complete months before it, the
//     upper bound includes the `asOf` month. A MISSING end date is unknown, not "current": it is reported and not counted.
//   * Overlapping or touching ranges are merged (a concurrent job is counted once). A gap is reported from the UPPER bound, so
//     a gap means at least one whole month is definitely uncovered; "ends 2020-06, starts 2020-07" is NOT a gap.

export const EXPERIENCE_BUCKETS = ["professional", "internship", "academic", "volunteer"] as const;
export type ExperienceBucket = (typeof EXPERIENCE_BUCKETS)[number];

export type ExperienceIssueCode =
  | "UNCLASSIFIED_EMPLOYMENT"
  | "INVALID_DATE_RANGE"
  | "MISSING_END_DATE"
  | "FUTURE_START"
  | "END_AFTER_AS_OF"
  | "PENDING_EMPLOYMENT"
  | "OVERLAP_SAME_EMPLOYER";

export interface ExperienceIssue {
  code: ExperienceIssueCode;
  /** "review": the summary cannot be trusted until a person acts. "warning": counted, but worth a look. */
  severity: "review" | "warning";
  factId?: string;
  message: string;
}

export interface ExperienceEntry {
  factId: string;
  bucket: ExperienceBucket | "education";
  employer: string | null;
  title: string | null;
  start: string;
  /** null = current. */
  end: string | null;
  counted: boolean;
}

export interface MonthGap {
  /** First and last uncovered month (YYYY-MM). */
  from: string;
  to: string;
  months: number;
}

export interface BucketSummary {
  bucket: ExperienceBucket;
  factIds: string[];
  monthsLower: number;
  monthsUpper: number;
  gaps: MonthGap[];
}

export interface ExperienceSummary {
  asOf: string;
  precision: "month";
  convention: string;
  status: "NO_DATA" | "OK" | "REVIEW";
  buckets: Record<ExperienceBucket, BucketSummary>;
  /** Approved education facts that carry dates. Study is never added to professional experience. */
  academicStudy: { factIds: string[]; monthsLower: number; monthsUpper: number };
  /** Counts only. Projects and skill mentions never turn into months or years. */
  counts: { projects: number; skillMentions: number; certifications: number; education: number };
  entries: ExperienceEntry[];
  issues: ExperienceIssue[];
}

export const EXPERIENCE_CONVENTION =
  "Month precision. Lower bound counts [start, end) months; upper bound counts [start, end] inclusive. Overlaps are merged. " +
  "A current job ends at the asOf month. Only approved, classified employment counts; projects, study and skill mentions never add professional time.";

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const monthIndex = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
export function monthLabel(index: number): string {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

interface Span {
  factId: string;
  start: number;
  /** Exclusive end month index for the lower bound. */
  endLower: number;
}

/** Union of half-open month ranges: total months and the merged ranges. */
export function unionRanges(ranges: ReadonlyArray<readonly [number, number]>): { total: number; merged: Array<[number, number]> } {
  const sorted = ranges.filter(([s, e]) => e > s).map(([s, e]) => [s, e] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return { total: merged.reduce((sum, [s, e]) => sum + (e - s), 0), merged };
}

function bucketSummary(bucket: ExperienceBucket, spans: Span[]): BucketSummary {
  const lower = unionRanges(spans.map((s) => [s.start, s.endLower] as const));
  // The upper bound includes the end month; a zero-length lower range (same start and end month) still occupied one month.
  const upper = unionRanges(spans.map((s) => [s.start, s.endLower + 1] as const));
  const gaps: MonthGap[] = [];
  for (let i = 1; i < upper.merged.length; i += 1) {
    const from = upper.merged[i - 1]![1];
    const to = upper.merged[i]![0];
    if (to > from) gaps.push({ from: monthLabel(from), to: monthLabel(to - 1), months: to - from });
  }
  return { bucket, factIds: [...new Set(spans.map((s) => s.factId))].sort(), monthsLower: lower.total, monthsUpper: upper.total, gaps };
}

const norm = (s: string | undefined): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * `facts` may contain any status; only approved, usable facts count. `asOf` is an ISO date (YYYY-MM-DD) and is the only clock.
 */
export function summarizeExperience(facts: ReadonlyArray<CandidateFact>, asOf: string): ExperienceSummary {
  if (!/^\d{4}-\d{2}-\d{2}/.test(asOf)) throw new Error("asOf must be an ISO date (YYYY-MM-DD).");
  const asOfIndex = monthIndex(asOf.slice(0, 7));
  const issues: ExperienceIssue[] = [];
  const entries: ExperienceEntry[] = [];
  const spans: Record<ExperienceBucket, Span[]> = { professional: [], internship: [], academic: [], volunteer: [] };
  const studySpans: Span[] = [];
  const counts = { projects: 0, skillMentions: 0, certifications: 0, education: 0 };
  const employmentByEmployer = new Map<string, Array<{ factId: string; start: number; end: number }>>();

  const rangeOf = (fact: CandidateFact, severity: ExperienceIssue["severity"] = "review"): { start: number; endLower: number } | null => {
    const { startDate, endDate } = fact.attributes;
    if (!startDate || !MONTH.test(startDate)) {
      return null;
    }
    const start = monthIndex(startDate);
    if (start > asOfIndex) {
      issues.push({ code: "FUTURE_START", severity: "review", factId: fact.factId, message: `Starts ${startDate}, after the as-of month ${monthLabel(asOfIndex)}; not counted.` });
      return null;
    }
    // null is an explicit "current". A missing end date is UNKNOWN and is never turned into "until today".
    if (endDate === undefined) {
      issues.push({ code: "MISSING_END_DATE", severity, factId: fact.factId, message: `Starts ${startDate} but has no end date and is not marked current; not counted.` });
      return null;
    }
    if (endDate === null) return { start, endLower: asOfIndex };
    if (!MONTH.test(endDate)) return null;
    const end = monthIndex(endDate);
    if (end < start) {
      issues.push({ code: "INVALID_DATE_RANGE", severity: "review", factId: fact.factId, message: `Ends ${endDate} before it starts ${startDate}; not counted.` });
      return null;
    }
    if (end > asOfIndex) {
      issues.push({ code: "END_AFTER_AS_OF", severity: "warning", factId: fact.factId, message: `Ends ${endDate}, after the as-of month; counted only up to ${monthLabel(asOfIndex)}.` });
      return { start, endLower: asOfIndex };
    }
    return { start, endLower: end };
  };

  for (const fact of facts) {
    if (fact.polarity !== "has") continue;
    const usable = factUsability(fact, asOf).usable;
    if (fact.kind === "employment" && fact.approvalStatus === "pending") {
      issues.push({ code: "PENDING_EMPLOYMENT", severity: "warning", factId: fact.factId, message: "Employment awaiting approval; not counted." });
      continue;
    }
    if (!usable) continue;
    switch (fact.kind) {
      case "project":
        counts.projects += 1;
        break;
      case "skill":
        counts.skillMentions += 1;
        break;
      case "certification":
        counts.certifications += 1;
        break;
      case "education": {
        counts.education += 1;
        if (fact.attributes.startDate) {
          const r = rangeOf(fact, "warning");
          if (r) {
            studySpans.push({ factId: fact.factId, ...r });
            entries.push({ factId: fact.factId, bucket: "education", employer: fact.attributes.employer ?? null, title: fact.attributes.title ?? null, start: fact.attributes.startDate, end: fact.attributes.endDate ?? null, counted: true });
          }
        }
        break;
      }
      case "employment": {
        const type = fact.attributes.employmentType;
        const entryBase = { factId: fact.factId, employer: fact.attributes.employer ?? null, title: fact.attributes.title ?? null, start: fact.attributes.startDate ?? "", end: fact.attributes.endDate ?? null };
        if (!type) {
          issues.push({
            code: "UNCLASSIFIED_EMPLOYMENT", severity: "review", factId: fact.factId,
            message: "Approved employment has no classification (professional, internship, academic or volunteer). It is not counted until you classify it.",
          });
          entries.push({ ...entryBase, bucket: "professional", counted: false });
          break;
        }
        const r = rangeOf(fact);
        if (!r) {
          entries.push({ ...entryBase, bucket: type, counted: false });
          break;
        }
        spans[type].push({ factId: fact.factId, ...r });
        entries.push({ ...entryBase, bucket: type, counted: true });
        const key = norm(fact.attributes.employer);
        if (key && type === "professional") {
          const list = employmentByEmployer.get(key) ?? [];
          list.push({ factId: fact.factId, start: r.start, end: r.endLower + 1 });
          employmentByEmployer.set(key, list);
        }
        break;
      }
      default:
        break;
    }
  }

  // Two approved professional entries at the same employer that overlap are either concurrent roles or a duplicate. Counted once either way.
  for (const list of employmentByEmployer.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.start < b.end && b.start < a.end) {
          issues.push({ code: "OVERLAP_SAME_EMPLOYER", severity: "warning", factId: b.factId, message: `Overlaps ${a.factId} at the same employer; counted once. Check whether it is a duplicate.` });
        }
      }
    }
  }

  const buckets = Object.fromEntries(EXPERIENCE_BUCKETS.map((b) => [b, bucketSummary(b, spans[b])])) as Record<ExperienceBucket, BucketSummary>;
  const study = bucketSummary("academic", studySpans);
  const anyCounted = EXPERIENCE_BUCKETS.some((b) => buckets[b].factIds.length > 0) || studySpans.length > 0;
  const status: ExperienceSummary["status"] = issues.some((i) => i.severity === "review") ? "REVIEW" : anyCounted ? "OK" : "NO_DATA";
  issues.sort((a, b) => a.code.localeCompare(b.code) || (a.factId ?? "").localeCompare(b.factId ?? ""));
  entries.sort((a, b) => a.start.localeCompare(b.start) || a.factId.localeCompare(b.factId));
  return {
    asOf: asOf.slice(0, 10), precision: "month", convention: EXPERIENCE_CONVENTION, status, buckets,
    academicStudy: { factIds: study.factIds, monthsLower: study.monthsLower, monthsUpper: study.monthsUpper },
    counts, entries, issues,
  };
}

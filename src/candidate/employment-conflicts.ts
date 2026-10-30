import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseCandidateProfile } from "../domain/candidate-profile.js";

// Detects employment records that disagree about the SAME employer (different title, dates or category). It never decides which record
// is right: a conflict is reported with both sides and stays open until a person confirms from documents or states the truth explicitly.

export interface EmploymentRecord {
  /** Stable label shown to the reader: a fact id, or "prior:<file>#<factId>". */
  ref: string;
  origin: "resume-fact" | "prior-record" | "confirmed-statement";
  factId: string | null;
  resumeId: string | null;
  status: string;
  employer: string | null;
  title: string | null;
  /** Full text of the record (the fact value), used to find an employer that was never separated from its title. */
  text: string;
  startDate: string | null;
  /** null = current; undefined = unknown. */
  endDate: string | null | undefined;
  employmentType: string | null;
}

export type ConflictField = "title" | "startDate" | "endDate" | "employmentType";

export interface EmploymentConflict {
  code: "EMPLOYMENT_CONFLICT";
  employer: string;
  records: Array<{ ref: string; origin: EmploymentRecord["origin"]; status: string; resumeId: string | null }>;
  differences: Array<{ field: ConflictField; values: [string, string] }>;
  /** Always the same: neither version may be silently selected. */
  required: string;
}

const STOP = new Set(["inc", "llc", "ltd", "corp", "corporation", "co", "company", "the", "plc", "gmbh"]);
const tokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t && !STOP.has(t));
const phrase = (s: string): string => ` ${tokens(s).join(" ")} `;

const REQUIRED =
  "Neither version is selected. Confirm from documents (offer letter, HR or payroll record) or state explicitly which is correct, then record it with facts:correct. Until then the disputed record stays pending/under review.";

function sameEmployer(a: EmploymentRecord, b: EmploymentRecord): string | null {
  const ea = a.employer ? phrase(a.employer) : null;
  const eb = b.employer ? phrase(b.employer) : null;
  if (ea && eb && ea === eb) return a.employer;
  if (ea && ea.trim() && phrase(b.text).includes(ea)) return a.employer;
  if (eb && eb.trim() && phrase(a.text).includes(eb)) return b.employer;
  return null;
}

/** A known title counts as matching when it equals the other side's title or appears inside the other side's text. */
function titlesAgree(a: EmploymentRecord, b: EmploymentRecord): boolean {
  const ta = a.title ? phrase(a.title) : null;
  const tb = b.title ? phrase(b.title) : null;
  if (ta && tb) return ta === tb;
  if (ta) return phrase(b.text).includes(ta);
  if (tb) return phrase(a.text).includes(tb);
  return true; // neither side states a title: nothing to compare
}

const monthIdx = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;

/**
 * Two records can only describe the same stretch of employment if their month ranges intersect (a promotion at the same employer is a
 * later, non-overlapping record, not a conflict). An unknown range cannot be excluded, so it counts as overlapping.
 */
function rangesCanCoincide(a: EmploymentRecord, b: EmploymentRecord): boolean {
  if (!a.startDate || !b.startDate || a.endDate === undefined || b.endDate === undefined) return true;
  const open = 9999 * 12;
  const aEnd = a.endDate === null ? open : monthIdx(a.endDate);
  const bEnd = b.endDate === null ? open : monthIdx(b.endDate);
  return monthIdx(a.startDate) <= bEnd && monthIdx(b.startDate) <= aEnd;
}

const endLabel = (e: string | null | undefined): string => (e === undefined ? "unknown" : e === null ? "current" : e);

export function detectEmploymentConflicts(records: readonly EmploymentRecord[]): EmploymentConflict[] {
  const live = records.filter((r) => r.status !== "rejected");
  const out: EmploymentConflict[] = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.factId && a.factId === b.factId) continue;
      const employer = sameEmployer(a, b);
      if (!employer || !rangesCanCoincide(a, b)) continue;
      const differences: EmploymentConflict["differences"] = [];
      if (!titlesAgree(a, b)) differences.push({ field: "title", values: [a.title ?? "(not separated from employer)", b.title ?? "(not separated from employer)"] });
      if (a.startDate && b.startDate && a.startDate !== b.startDate) differences.push({ field: "startDate", values: [a.startDate, b.startDate] });
      if (a.endDate !== undefined && b.endDate !== undefined && a.endDate !== b.endDate) differences.push({ field: "endDate", values: [endLabel(a.endDate), endLabel(b.endDate)] });
      if (a.employmentType && b.employmentType && a.employmentType !== b.employmentType) differences.push({ field: "employmentType", values: [a.employmentType, b.employmentType] });
      if (!differences.length) continue;
      out.push({
        code: "EMPLOYMENT_CONFLICT", employer,
        records: [a, b].map((r) => ({ ref: r.ref, origin: r.origin, status: r.status, resumeId: r.resumeId })),
        differences, required: REQUIRED,
      });
    }
  }
  return out.sort((x, y) => x.records[0]!.ref.localeCompare(y.records[0]!.ref) || x.records[1]!.ref.localeCompare(y.records[1]!.ref));
}

interface FactLike {
  factId: string;
  kind: string;
  value: string;
  approvalStatus: string;
  attributes: { employer?: string; title?: string; startDate?: string; endDate?: string | null; employmentType?: string };
}

/** The candidate's own confirmed-employment statements (profile reference rows). */
export function confirmedStatementRecords(rows: ReadonlyArray<{ id: string; employer: string; title: string; start_date: string; end_date: string | null; employment_type: string }>): EmploymentRecord[] {
  return rows.map((r) => ({
    ref: `confirmed:${r.id.slice(0, 8)}`, origin: "confirmed-statement" as const, factId: null, resumeId: null, status: "confirmed-by-candidate",
    employer: r.employer, title: r.title, text: `${r.employer} \u2014 ${r.title}`, startDate: r.start_date, endDate: r.end_date, employmentType: r.employment_type,
  }));
}

export function employmentRecordsFromFacts(facts: readonly FactLike[], resumeId: string | null): EmploymentRecord[] {
  return facts
    .filter((f) => f.kind === "employment")
    .map((f) => ({
      ref: f.factId, origin: "resume-fact" as const, factId: f.factId, resumeId, status: f.approvalStatus,
      employer: f.attributes.employer ?? null, title: f.attributes.title ?? null, text: f.value,
      startDate: f.attributes.startDate ?? null, endDate: f.attributes.endDate, employmentType: f.attributes.employmentType ?? null,
    }));
}

/** Earlier user-reviewed profile (a candidate-profile JSON). Only its APPROVED employment facts are used, labelled by file name only. */
export function loadPriorEmploymentRecords(file: string): EmploymentRecord[] {
  const profile = parseCandidateProfile(JSON.parse(readFileSync(path.resolve(file), "utf8")));
  const name = path.basename(file);
  return profile.facts
    .filter((f) => f.kind === "employment" && f.approvalStatus === "approved")
    .map((f) => ({
      ref: `prior:${name}#${f.factId}`, origin: "prior-record" as const, factId: null, resumeId: null, status: "prior-approved",
      employer: f.attributes.employer ?? null, title: f.attributes.title ?? null, text: f.value,
      startDate: f.attributes.startDate ?? null, endDate: f.attributes.endDate, employmentType: f.attributes.employmentType ?? null,
    }));
}

/** Newest `candidate-profile.reviewed-<n>.json` in a directory, or null. The file is only read, and only its name is ever reported. */
export function findLatestPriorProfile(dir = path.resolve("private-runtime", "candidate")): string | null {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir)
    .map((name) => ({ name, n: Number(/^candidate-profile\.reviewed-(\d+)\.json$/.exec(name)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => b.n - a.n)[0];
  return found ? path.join(dir, found.name) : null;
}

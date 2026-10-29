import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { GATES, sha256 } from "./types.js";
import type { Split } from "./split.js";

// Frozen employer -> side registry. With only ~25 employers a plain hash split is high-variance (it can put every security-heavy employer on one side).
// The proposal below is DETERMINISTIC and uses only UNLABELED corpus facts (posting counts and the share of postings the existing rules admit), never a
// label or a model result. It is a proposal until a person freezes it (ml:splits freeze); the frozen file is the authority for all later dataset versions.

export const SIDES_SCHEMA = "orbital-ml-employer-sides/1";
export const SIDES_FILE = path.resolve(process.env.JH_ML_SIDES_FILE ?? path.join("config", "ml-employer-sides.json"));

export interface EmployerStat { company: string; postings: number; /** share of the employer's postings that at least one catalog-role rule admits (0..1) */ ruleShare: number }

export interface SideEntry { company: string; side: Split; stratum: "high" | "mid" | "low"; ruleShare: number; postings: number }

const u = (salt: string, company: string): number => parseInt(sha256(`${salt}|${company.toLowerCase()}`).slice(0, 8), 16) / 0x1_0000_0000;

/** Terciles by rule share (ties broken by name); inside each tercile the lowest-hash employers are held out (about GATES.heldoutFraction of each). */
export function proposeSides(stats: readonly EmployerStat[], salt: string, fraction: number = GATES.heldoutFraction): SideEntry[] {
  const ordered = [...stats].sort((a, b) => b.ruleShare - a.ruleShare || a.company.localeCompare(b.company));
  const n = ordered.length;
  const out: SideEntry[] = [];
  const bands: Array<SideEntry["stratum"]> = ["high", "mid", "low"];
  for (let b = 0; b < 3; b++) {
    const slice = ordered.slice(Math.floor((n * b) / 3), Math.floor((n * (b + 1)) / 3));
    const heldCount = slice.length >= 3 ? Math.max(1, Math.round(slice.length * fraction)) : 0;
    const byHash = [...slice].sort((x, y) => u(salt, x.company) - u(salt, y.company) || x.company.localeCompare(y.company));
    const held = new Set(byHash.slice(0, heldCount).map((s) => s.company));
    for (const s of slice) out.push({ company: s.company, side: held.has(s.company) ? "heldout" : "train", stratum: bands[b]!, ruleShare: Number(s.ruleShare.toFixed(4)), postings: s.postings });
  }
  return out.sort((a, b) => a.company.localeCompare(b.company));
}

const entrySchema = z.object({ company: z.string().min(1), side: z.enum(["train", "heldout"]), stratum: z.enum(["high", "mid", "low"]), ruleShare: z.number(), postings: z.number() }).strict();
export const sidesFileSchema = z
  .object({ schema: z.literal(SIDES_SCHEMA), version: z.number().int().min(1), salt: z.string(), frozenAt: z.string(), frozenBy: z.string().min(1), method: z.string(), employers: z.array(entrySchema).min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type SidesFile = z.infer<typeof sidesFileSchema>;

export class SidesError extends Error {
  constructor(readonly code: "INVALID" | "TAMPERED" | "EXISTS", message: string) {
    super(message);
    this.name = "SidesError";
  }
}

const digestOf = (f: Omit<SidesFile, "sha256">): string => createHash("sha256").update(JSON.stringify({ ...f, employers: [...f.employers].sort((a, b) => a.company.localeCompare(b.company)) })).digest("hex");

export function loadSides(file: string = path.resolve(process.env.JH_ML_SIDES_FILE ?? path.join("config", "ml-employer-sides.json"))): { map: Map<string, Split>; file: SidesFile } | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new SidesError("INVALID", "The employer-sides file is not valid JSON."); }
  const parsed = sidesFileSchema.safeParse(raw);
  if (!parsed.success) throw new SidesError("INVALID", `The employer-sides file is invalid: ${parsed.error.issues[0]?.message ?? "?"}.`);
  const { sha256: recorded, ...rest } = parsed.data;
  if (digestOf(rest) !== recorded) throw new SidesError("TAMPERED", "The employer-sides file changed after it was frozen (hash mismatch).");
  return { map: new Map(parsed.data.employers.map((e) => [e.company.toLowerCase(), e.side])), file: parsed.data };
}

/** Writes a NEW frozen registry. Refuses to overwrite: a frozen split is never silently replaced. */
export function freezeSides(entries: readonly SideEntry[], salt: string, frozenBy: string, file: string = path.resolve(process.env.JH_ML_SIDES_FILE ?? path.join("config", "ml-employer-sides.json"))): SidesFile {
  if (existsSync(file)) throw new SidesError("EXISTS", "An employer-sides registry is already frozen. It is never overwritten.");
  const body: Omit<SidesFile, "sha256"> = {
    schema: SIDES_SCHEMA, version: 1, salt, frozenAt: new Date().toISOString(), frozenBy,
    method: "terciles of rule-admitted share (unlabeled corpus facts only); lowest-hash employers per tercile held out", employers: [...entries],
  };
  const full: SidesFile = { ...body, sha256: digestOf(body) };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(full, null, 1));
  return full;
}

export function sideSummary(entries: readonly SideEntry[]): { employers: Record<Split, number>; postings: Record<Split, number>; heldoutPostingShare: number; byStratum: Record<string, Record<Split, number>> } {
  const employers = { train: 0, heldout: 0 }, postings = { train: 0, heldout: 0 };
  const byStratum: Record<string, Record<Split, number>> = {};
  for (const e of entries) {
    employers[e.side]++; postings[e.side] += e.postings;
    (byStratum[e.stratum] ??= { train: 0, heldout: 0 })[e.side]++;
  }
  const total = postings.train + postings.heldout;
  return { employers, postings, heldoutPostingShare: total ? Number((postings.heldout / total).toFixed(3)) : 0, byStratum };
}

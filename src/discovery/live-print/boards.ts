import { readFileSync } from "node:fs";
import { z } from "zod";
import { BoardError } from "../../pipeline/discovery/board-discoverer.js";
import { namesMatch } from "../../pipeline/discovery/board-verify.js";

// Batched employer-board targets for `npm run live-jobs`. A board is only trusted after the employer-to-ATS
// relationship is confirmed; an unconfirmed or unreachable board is recorded and skipped, never persisted.

export const liveBoardSchema = z.object({
  company: z.string().trim().min(1).max(120),
  ats: z.enum(["greenhouse", "lever"]),
  board: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  employerCareersUrl: z.string().url().refine((u) => u.startsWith("https://"), "careers URL must be https"),
  /** Only for Greenhouse boards whose posting URLs live on the employer's own domain (?gh_jid=...). */
  corporateDomain: z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i).optional(),
  /** Set only when the linkage was checked by hand against the employer's own page; the note records how. */
  manualOwnershipNote: z.string().trim().min(10).max(300).optional(),
}).strict();

export const liveBoardConfigSchema = z.object({
  version: z.literal(1),
  batches: z.array(z.object({ name: z.string().regex(/^[a-z0-9-]{1,40}$/), companies: z.array(liveBoardSchema).min(1).max(40) }).strict()).min(1),
}).strict().superRefine((cfg, ctx) => {
  const seen = new Set<string>();
  cfg.batches.forEach((batch, b) => batch.companies.forEach((c, i) => {
    const key = `${c.ats}:${c.board.toLowerCase()}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["batches", b, "companies", i], message: `duplicate board ${key}` });
    seen.add(key);
  }));
});

export type LiveBoard = z.infer<typeof liveBoardSchema>;
export type LiveBoardConfig = z.infer<typeof liveBoardConfigSchema>;

export function loadLiveBoards(filePath: string): LiveBoardConfig {
  return liveBoardConfigSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

export function selectBatches(cfg: LiveBoardConfig, names: readonly string[] | null, maxBoards: number): LiveBoard[] {
  const wanted = names && names.length ? names : cfg.batches.map((b) => b.name);
  const unknown = wanted.filter((n) => !cfg.batches.some((b) => b.name === n));
  if (unknown.length) throw new Error(`Unknown batch name(s): ${unknown.join(", ")}`);
  return cfg.batches.filter((b) => wanted.includes(b.name)).flatMap((b) => b.companies).slice(0, Math.max(1, maxBoards));
}

export type OwnershipStatus = "CONFIRMED" | "UNCONFIRMED";
export interface Ownership {
  status: OwnershipStatus;
  method: "manual-careers-page" | "greenhouse-board-name" | "careers-page-link" | "none";
  detail: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the employer's own HTML references this exact provider board (host-anchored, token-exact). */
export function pageLinksToBoard(html: string, ats: LiveBoard["ats"], board: string): boolean {
  const token = escapeRe(board);
  const pattern = ats === "greenhouse"
    ? new RegExp(`(?:boards|job-boards)(?:\\.eu)?\\.greenhouse\\.io/(?:embed/job_board\\?for=)?${token}(?![A-Za-z0-9._-])`, "i")
    : new RegExp(`jobs(?:\\.eu)?\\.lever\\.co/${token}(?![A-Za-z0-9._-])`, "i");
  return pattern.test(html);
}

async function getText(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ status: number; body: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { Accept: "text/html,application/json" }, signal: controller.signal, redirect: "follow" });
    return { status: response.status, body: (await response.text()).slice(0, 3_000_000) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Employer-to-ATS ownership. Never trusts a token because it merely returns postings. */
export async function confirmOwnership(entry: LiveBoard, fetchImpl: typeof fetch, timeoutMs = 15_000): Promise<Ownership> {
  if (entry.manualOwnershipNote) return { status: "CONFIRMED", method: "manual-careers-page", detail: entry.manualOwnershipNote };
  if (entry.ats === "greenhouse") {
    const named = await getText(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(entry.board)}`, fetchImpl, timeoutMs);
    if (named?.status === 200) {
      try {
        const name = (JSON.parse(named.body) as { name?: unknown }).name;
        if (typeof name === "string" && namesMatch(entry.company, name)) return { status: "CONFIRMED", method: "greenhouse-board-name", detail: `Greenhouse board is named "${name}"` };
      } catch { /* fall through to the careers-page check */ }
    }
  }
  const page = await getText(entry.employerCareersUrl, fetchImpl, timeoutMs);
  if (page && page.status >= 200 && page.status < 400 && pageLinksToBoard(page.body, entry.ats, entry.board)) {
    return { status: "CONFIRMED", method: "careers-page-link", detail: `Employer careers page ${entry.employerCareersUrl} links to the ${entry.ats} board` };
  }
  return { status: "UNCONFIRMED", method: "none", detail: "No board-name match and the employer careers page did not reference this board; not trusted." };
}

export type BoardFailureKind = "INVALID_TOKEN" | "RATE_LIMITED" | "UNREACHABLE" | "PARSE_FAILURE" | "UNCONFIRMED_OWNER";

export function classifyBoardFailure(error: unknown): { kind: BoardFailureKind; detail: string } {
  if (error instanceof BoardError) {
    if (error.code === "BOARD_NOT_FOUND") return { kind: "INVALID_TOKEN", detail: error.message };
    if (error.code === "BOARD_RESPONSE_INVALID") return { kind: "PARSE_FAILURE", detail: error.message };
    if (/HTTP 429/.test(error.message)) return { kind: "RATE_LIMITED", detail: error.message };
    return { kind: "UNREACHABLE", detail: error.message };
  }
  return { kind: "UNREACHABLE", detail: error instanceof Error ? error.name : "UnknownError" };
}

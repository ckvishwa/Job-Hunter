import type { JobPosting } from "../adapters/types.js";
import { computeJdContentHash, evaluatePersistable, verifyOfficialPosting } from "../domain/canonical-job.js";
import type { BoardCompany } from "../pipeline/discovery/board-discoverer.js";
import { registryEntryFor } from "../pipeline/discovery/board-discoverer.js";
import type { BoardRef, JobsRepo, PersistItem, RunLimits } from "../db/jobs-repo.js";
import { buildPlan, bandStatus, matchRoles, senioritySignal, statedYears, type CatalogRoleLike, type DiscoveryPlan } from "./planner.js";
import { boardKeyOf } from "./runner.js";

// S3 -> S4 bridge. The S3 PostgreSQL tables (jobs, job_revisions, job_observations, discovery_runs) stay the ONLY authoritative job store. This module gets postings INTO
// them by the same rules S3 uses: official-employer/board verification, a complete-JD gate, the (ats_identity, jd_sha256) revision rule and per-run observation
// uniqueness, so a rerun creates no duplicate posting or revision. Two sources:
//   saved  : postings an earlier verified run already stored (canonical JSONL). Offline. Re-checked here, flagged liveConfirmed:false.
//   live   : an IMPORT run handed to the existing DiscoveryRunner (read-only GETs to the public ATS board APIs). Only when the owner asks for it explicitly.
// An import run has no saved role selection behind it (selection revision 0); the roles come from explicit arguments and are never stored as the owner's preference.

export type ImportOutcome = {
  atsIdentity: string | null;
  company: string;
  title: string;
  outcome: "NEW" | "CHANGED_JD" | "UNCHANGED" | "REJECTED";
  code?: string;
  detail?: string;
};

export interface ImportContext {
  repo: JobsRepo;
  userId: string;
  catalogRoles: CatalogRoleLike[];
  catalogVersion: number;
  roleSlugs: string[];
  boards: BoardCompany[];
  now?: () => Date;
}

const LIMITS: RunLimits = { maxBoards: 50, maxCandidates: 200, maxMatchedPerBoard: 25 };

export function importPlan(ctx: Pick<ImportContext, "catalogRoles" | "catalogVersion" | "roleSlugs">): DiscoveryPlan {
  const plan = buildPlan({
    selection: { revisionNo: 1, roleSlugs: ctx.roleSlugs, targetFamilies: [], locations: [], workModes: [], seniorityLevels: [], searchBand: { minYears: 0, maxYears: 30 }, catalogVersion: ctx.catalogVersion },
    catalogRoles: ctx.catalogRoles, catalogVersion: ctx.catalogVersion,
  });
  return { ...plan, selectionRevisionNo: 0 };
}

const IDENTITY = /^(greenhouse|lever):([a-z0-9._-]+):([a-z0-9._-]+)$/;

/** Offline re-check of one saved posting. Returns the persistable item or a typed rejection. */
export function checkSavedPosting(p: JobPosting, boards: BoardCompany[], plan: DiscoveryPlan, nowIso: string): { ok: true; item: PersistItem; board: BoardCompany } | { ok: false; code: string; detail: string } {
  const reject = (code: string, detail: string) => ({ ok: false as const, code, detail });
  const gate = evaluatePersistable(p);
  if (!gate.ok) return reject(gate.failure.code, gate.failure.detail);
  const posting = gate.posting;
  if (!posting.jdContentHash || computeJdContentHash(posting.descriptionText) !== posting.jdContentHash) return reject("JD_HASH_MISMATCH", "The saved JD text no longer matches its recorded hash.");
  const m = posting.atsIdentity ? IDENTITY.exec(posting.atsIdentity) : null;
  if (!posting.atsIdentity || !m) return reject("JOB_ID_MISSING", "The saved posting has no official requisition identity.");
  const [, ats, boardToken, jobId] = m as unknown as [string, "greenhouse" | "lever", string, string];
  const board = boards.find((b) => b.ats === ats && b.board.toLowerCase() === boardToken);
  if (!board) return reject("UNVERIFIED_EMPLOYER", `No board-list entry for ${ats}:${boardToken}; the employer cannot be re-verified offline.`);
  const obs = posting.sourceObservations ?? [];
  const last = obs[obs.length - 1];
  if (!last) return reject("UNVERIFIED_EMPLOYER", "The saved posting records no source observation.");
  if (posting.company.toLowerCase().replace(/[^a-z0-9]/g, "") !== board.company.toLowerCase().replace(/[^a-z0-9]/g, "")) return reject("EMPLOYER_MISMATCH", `Posting employer "${posting.company}" is not the board's employer "${board.company}".`);
  const urlHasId = new RegExp(`(?:^|[/?=&])${jobId}(?:[/?&#]|$)`).test(last.finalUrl);
  const verdict = verifyOfficialPosting({ finalUrl: last.finalUrl, discoveredCompany: posting.company, registryEntry: registryEntryFor(board), confirmedGreenhouseJobId: ats === "greenhouse" && urlHasId ? jobId : null });
  if (!verdict.ok || verdict.atsIdentity !== posting.atsIdentity) return reject(verdict.failure?.code ?? "JOB_ID_MISMATCH", verdict.failure?.detail ?? "The re-derived identity differs from the saved one.");
  const roles = matchRoles(posting.title, plan);
  if (roles.roleSlugs.length === 0) return reject("NOT_A_SELECTED_ROLE", "The title matches none of the requested roles; it is not stored.");
  const years = statedYears(posting.descriptionText);
  return {
    ok: true, board,
    item: {
      atsIdentity: posting.atsIdentity, company: posting.company, ats, board: board.board, requisitionId: posting.requisitionId ?? jobId, title: posting.title, location: posting.location,
      department: posting.department, employmentType: posting.employmentType, postingDate: posting.postingDate, canonicalUrl: posting.canonicalUrl, descriptionText: posting.descriptionText,
      jdSha256: posting.jdContentHash,
      observation: {
        observedUrl: last.observedUrl, finalUrl: last.finalUrl, sourceKind: last.sourceKind, extractionMethod: last.extractionMethod === "browser-dom" ? "browser-dom" : "ats-api",
        verification: {
          method: "saved-posting-recheck", board: boardKeyOf(board), employer: board.company, employerMatchedBoard: true, atsIdentity: posting.atsIdentity, jdGate: "passed",
          hostKind: verdict.hostKind ?? null, originalObservedAt: last.observedAt, observationsOnRecord: obs.length,
          liveConfirmed: false, note: "Re-checked offline from the saved record; not a fresh visit. A posting seen earlier is not evidence that it is open today.",
        },
        matchedRoles: roles.roleSlugs, matchedPhrases: roles.phrases, locationStatus: "UNSPECIFIED", bandStatus: bandStatus(years.years, plan.searchBand), statedYears: years.years, yearsQuote: years.quote,
        senioritySignal: senioritySignal(posting.title), observedAt: nowIso,
      },
    },
  };
}

export async function importSavedPostings(ctx: ImportContext, postings: JobPosting[]): Promise<{ runId: string | null; outcomes: ImportOutcome[] }> {
  const nowIso = (ctx.now ?? (() => new Date()))().toISOString();
  const plan = importPlan(ctx);
  const outcomes: ImportOutcome[] = [];
  const byBoard = new Map<string, { board: BoardCompany; items: PersistItem[] }>();
  for (const p of postings) {
    const r = checkSavedPosting(p, ctx.boards, plan, nowIso);
    if (!r.ok) { outcomes.push({ atsIdentity: p.atsIdentity ?? null, company: p.company, title: p.title, outcome: "REJECTED", code: r.code, detail: r.detail }); continue; }
    const key = boardKeyOf(r.board);
    byBoard.set(key, { board: r.board, items: [...(byBoard.get(key)?.items ?? []), r.item] });
  }
  if (byBoard.size === 0) return { runId: null, outcomes };

  const known = await ctx.repo.existingRevisionHashes([...byBoard.values()].flatMap((b) => b.items.map((i) => i.atsIdentity)));
  const refs: BoardRef[] = [...byBoard.entries()].map(([boardKey, v]) => ({ boardKey, company: v.board.company, ats: v.board.ats, board: v.board.board }));
  const { runId } = await ctx.repo.createRun(ctx.userId, plan, refs, LIMITS, "import");
  await ctx.repo.markRunning(runId);
  for (const [boardKey, v] of byBoard) {
    await ctx.repo.startBoard(runId, boardKey);
    const unique = [...new Map(v.items.map((i) => [i.atsIdentity, i])).values()];
    await ctx.repo.persistBoard(runId, boardKey, { fetched: v.items.length, titleMatched: v.items.length, locationExcluded: 0, seniorityExcluded: 0 }, unique, []);
    for (const i of unique) {
      const prior = known.get(i.atsIdentity);
      outcomes.push({ atsIdentity: i.atsIdentity, company: i.company, title: i.title, outcome: prior === undefined ? "NEW" : prior === i.jdSha256 ? "UNCHANGED" : "CHANGED_JD" });
    }
  }
  await ctx.repo.finishRun(runId, "COMPLETED");
  return { runId, outcomes };
}

/** Creates a QUEUED import run for a live, read-only refresh of the named boards. The caller hands the run id to the existing DiscoveryRunner. */
export async function createLiveImportRun(ctx: ImportContext, boardKeys: string[]): Promise<{ runId: string; boards: string[] }> {
  const plan = importPlan(ctx);
  const chosen = ctx.boards.filter((b) => boardKeys.includes(boardKeyOf(b)));
  if (chosen.length === 0) throw new Error("None of the requested boards is in the board list.");
  const refs: BoardRef[] = chosen.map((b) => ({ boardKey: boardKeyOf(b), company: b.company, ats: b.ats, board: b.board }));
  const { runId } = await ctx.repo.createRun(ctx.userId, plan, refs, { ...LIMITS, maxBoards: refs.length }, "import");
  return { runId, boards: refs.map((r) => r.boardKey) };
}

import { existsSync } from "node:fs";
import path from "node:path";
import type { JobPosting } from "../adapters/types.js";
import { buildJobFailure, evaluatePersistable, stampResolution, type JobFailureCode } from "../domain/canonical-job.js";
import {
  BoardError, boardApiUrl, fetchBoardPostings, loadBoardList, registryEntryFor, toPosting, type BoardCompany,
} from "../pipeline/discovery/board-discoverer.js";
import type { BoardRef, Counters, FailureInput, JobsRepo, PersistItem } from "../db/jobs-repo.js";
import { bandStatus, screenPosting, senioritySignal, statedYears, type DiscoveryPlan } from "./planner.js";

// S3 runner: drives the EXISTING official Greenhouse/Lever board reader (fetchBoardPostings), the EXISTING official-employer and
// JD verification (stampResolution + evaluatePersistable) and stores the result in PostgreSQL. It never opens an application form,
// never submits anything, and never decides eligibility. One worker, one board at a time, bounded by the run's limits.

export interface BoardsConfig {
  companies: BoardCompany[];
  excludeTitleKeywords: string[];
}

export const boardKeyOf = (c: Pick<BoardCompany, "ats" | "board">): string => `${c.ats}:${c.board}`;

export const DEFAULT_BOARDS_FILE = path.join("config", "company-boards.json");

/** Reads the owner's board list (company -> ATS board token). Returns null when no list is configured. */
export function loadBoardsConfig(filePath: string = process.env.JH_BOARDS_FILE ?? DEFAULT_BOARDS_FILE): BoardsConfig | null {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) return null;
  const list = loadBoardList(resolved);
  return { companies: list.companies, excludeTitleKeywords: list.excludeTitleKeywords ?? [] };
}

export interface RunnerEvent {
  at: string;
  kind: "run-start" | "board-start" | "board-end" | "run-end" | "run-error";
  runId: string;
  boardKey?: string;
  status?: string;
  code?: string;
}

export interface RunnerDeps {
  repo: JobsRepo;
  /** Re-read at run time, so the board list can change between start and recovery. */
  boards: () => BoardsConfig | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Pause between boards; the public APIs are polled politely. */
  delayMs?: number;
  timeoutMs?: number;
  onEvent?: (e: RunnerEvent) => void;
}

const BLOCKED_RE = /HTTP (401|403|429)\b/;

const failureOf = (error: unknown): { code: JobFailureCode; detail: string; retryable: boolean; blocked: boolean } => {
  if (error instanceof BoardError) {
    const blocked = BLOCKED_RE.test(error.message);
    return { code: error.code, detail: error.message, retryable: error.code === "BOARD_FETCH_FAILED", blocked };
  }
  return { code: "BOARD_FETCH_FAILED", detail: "Unexpected error while reading the board.", retryable: true, blocked: false };
};

export class DiscoveryRunner {
  private readonly queue: string[] = [];
  private draining: Promise<void> | null = null;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly deps: RunnerDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private emit(e: Omit<RunnerEvent, "at">): void {
    this.deps.onEvent?.({ at: this.now().toISOString(), ...e });
  }

  enqueue(runId: string): void {
    if (this.queue.includes(runId) || this.controllers.has(runId)) return;
    this.queue.push(runId);
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
  }

  cancel(runId: string): void {
    this.controllers.get(runId)?.abort();
  }

  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Resumes runs a previous process left active. Finished boards are kept; pending ones continue. */
  async recover(): Promise<number> {
    const runs = await this.deps.repo.activeRunsForRecovery();
    for (const r of runs) this.enqueue(r.runId);
    return runs.length;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const runId = this.queue.shift()!;
      const controller = new AbortController();
      this.controllers.set(runId, controller);
      try {
        await this.process(runId, controller.signal);
      } catch (error) {
        this.emit({ kind: "run-error", runId, code: error instanceof Error ? error.name : "UnknownError" });
        await this.deps.repo.finishRun(runId, "FAILED", { errorCode: "STORAGE_FAILED", errorDetail: "The run stopped because its results could not be stored." }).catch(() => undefined);
      } finally {
        this.controllers.delete(runId);
      }
    }
  }

  private async process(runId: string, signal: AbortSignal): Promise<void> {
    const { repo } = this.deps;
    const snap = await repo.runSnapshot(runId);
    if (!snap || !(await repo.markRunning(runId))) return;
    this.emit({ kind: "run-start", runId });
    const config = this.deps.boards();
    let limitReached: "MAX_CANDIDATES" | null = null;

    for (const ref of await repo.pendingBoards(runId)) {
      if (signal.aborted || !(await repo.isActive(runId))) return; // cancelled: the cancel call already closed the run
      const verified = (await repo.runSnapshot(runId))!.counters.verified;
      if (verified >= snap.limits.maxCandidates) {
        limitReached = "MAX_CANDIDATES";
        break;
      }
      await this.processBoard(runId, ref, snap.plan, snap.limits, snap.limits.maxCandidates - verified, config, signal);
      await new Promise((r) => setTimeout(r, signal.aborted ? 0 : this.deps.delayMs ?? 400));
    }
    if (signal.aborted || !(await repo.isActive(runId))) return;

    const counts = await repo.boardStatusCounts(runId);
    if (limitReached) await repo.skipPending(runId);
    const failed = counts.FAILED ?? 0;
    const ok = counts.OK ?? 0;
    const status = failed === 0 ? "COMPLETED" : ok > 0 ? "PARTIAL" : "FAILED";
    await repo.finishRun(runId, status, { limitReached });
    this.emit({ kind: "run-end", runId, status });
  }

  private async processBoard(runId: string, ref: BoardRef, plan: DiscoveryPlan, limits: { maxMatchedPerBoard: number }, budget: number, config: BoardsConfig | null, signal: AbortSignal): Promise<void> {
    const { repo } = this.deps;
    const company = config?.companies.find((c) => boardKeyOf(c) === ref.boardKey);
    await repo.startBoard(runId, ref.boardKey);
    this.emit({ kind: "board-start", runId, boardKey: ref.boardKey });
    const counters: Counters = { fetched: 0, titleMatched: 0, locationExcluded: 0, seniorityExcluded: 0 };
    if (!company) {
      await repo.persistBoard(runId, ref.boardKey, counters, [], [], { code: "BOARD_CONFIG_MISSING", detail: "This board is no longer in the configured board list.", retryable: false, blocked: false });
      this.emit({ kind: "board-end", runId, boardKey: ref.boardKey, status: "FAILED", code: "BOARD_CONFIG_MISSING" });
      return;
    }
    const failures: FailureInput[] = [];
    const items: PersistItem[] = [];
    try {
      const postings = await fetchBoardPostings(company, this.deps.fetchImpl ?? fetch, this.deps.timeoutMs, signal);
      counters.fetched = postings.length;
      const nowIso = this.now().toISOString();
      const registryEntry = registryEntryFor(company);
      const exclude = config?.excludeTitleKeywords ?? [];
      const candidates: Array<{ p: (typeof postings)[number]; roleSlugs: string[]; phrases: string[]; signal: ReturnType<typeof senioritySignal>; location: "MATCH" | "UNKNOWN" | "UNSPECIFIED" }> = [];
      for (const p of postings) {
        const screen = screenPosting({ title: p.title, description: p.descriptionText, location: p.location, excludeTitleKeywords: exclude, plan });
        if (screen.gate === "EXCLUDED_KEYWORD" || screen.gate === "NO_ROLE") continue;
        if (screen.basis === "title") counters.titleMatched += 1;
        if (screen.gate === "SENIORITY") {
          counters.seniorityExcluded += 1;
          continue;
        }
        if (screen.gate === "LOCATION") {
          counters.locationExcluded += 1;
          continue;
        }
        candidates.push({ p, roleSlugs: screen.roleSlugs, phrases: screen.phrases, signal: senioritySignal(p.title), location: screen.location });
      }
      for (const { p, roleSlugs, phrases, signal: sig, location } of candidates.slice(0, Math.min(limits.maxMatchedPerBoard, budget))) {
        const stamped: JobPosting = stampResolution(toPosting(company, p, phrases, [], "", nowIso), {
          sourceKind: "board-api", observedUrl: boardApiUrl(company), observedAt: nowIso, finalUrl: p.url, extractionMethod: "ats-api",
          discoveredCompany: company.company, registryEntry, apiJobId: p.externalId,
          confirmedGreenhouseJobId: company.ats === "greenhouse" ? p.externalId : null, now: nowIso,
        });
        const gate = evaluatePersistable(stamped);
        const reject = (code: JobFailureCode, detail: string) => {
          const f = buildJobFailure({ code, stage: "resolution", runId, targetUrl: p.url, company: company.company, title: p.title, sourceJobId: p.externalId, detail, at: nowIso });
          failures.push({ boardKey: ref.boardKey, stage: "resolution", code, category: f.category, retryable: f.retryable, company: company.company, title: p.title, sourceJobId: p.externalId, targetUrl: f.targetUrl, detail: f.detail, at: nowIso });
        };
        if (!gate.ok) {
          reject(gate.failure.code, gate.failure.detail);
          continue;
        }
        const posting = gate.posting;
        if (!posting.atsIdentity || !posting.jdContentHash) {
          reject("JOB_ID_MISSING", "The posting has no stable official requisition identity.");
          continue;
        }
        const years = statedYears(posting.descriptionText);
        items.push({
          atsIdentity: posting.atsIdentity, company: posting.company, ats: company.ats, board: company.board, requisitionId: posting.requisitionId ?? p.externalId,
          title: posting.title, location: posting.location, department: posting.department, employmentType: posting.employmentType, postingDate: posting.postingDate,
          canonicalUrl: posting.canonicalUrl, descriptionText: posting.descriptionText, jdSha256: posting.jdContentHash,
          observation: {
            observedUrl: boardApiUrl(company), finalUrl: p.url, sourceKind: "board-api", extractionMethod: "ats-api",
            verification: { method: "official-board-api", board: `${company.ats}:${company.board}`, employer: company.company, employerMatchedBoard: true, atsIdentity: posting.atsIdentity, jdGate: "passed" },
            matchedRoles: roleSlugs, matchedPhrases: phrases, locationStatus: location, bandStatus: bandStatus(years.years, plan.searchBand),
            statedYears: years.years, yearsQuote: years.quote, senioritySignal: sig, observedAt: nowIso,
          },
        });
      }
      const result = await repo.persistBoard(runId, ref.boardKey, counters, items, failures);
      this.emit({ kind: "board-end", runId, boardKey: ref.boardKey, status: result ? "OK" : "STOPPED" });
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof BoardError) {
        const f = failureOf(error);
        await repo.persistBoard(runId, ref.boardKey, counters, [], failures, f);
        this.emit({ kind: "board-end", runId, boardKey: ref.boardKey, status: "FAILED", code: f.code });
        return;
      }
      throw error; // storage or programming error: the run fails visibly
    }
  }
}

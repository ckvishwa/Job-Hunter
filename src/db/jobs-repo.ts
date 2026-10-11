import type pg from "pg";
import type { DiscoveryPlan } from "../jobs/planner.js";

// S3 persistence. PostgreSQL is authoritative for runs, official jobs, JD revisions, observations and failures. Every write of a
// board's results is ONE transaction that also re-checks the run is still RUNNING, so a cancelled or finished run can never receive
// late data, and a board is OK only if its data committed. Reads are scoped to the user through their own runs' observations.

export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export const ACTIVE_STATUSES: readonly RunStatus[] = ["QUEUED", "RUNNING"];

export type JobsRuleCode = "RUN_IN_PROGRESS" | "UNKNOWN_RUN" | "UNKNOWN_JOB" | "RUN_NOT_ACTIVE";

export class JobsRuleError extends Error {
  constructor(readonly code: JobsRuleCode, message: string, readonly runId?: string) {
    super(message);
    this.name = "JobsRuleError";
  }
}

export interface RunLimits {
  maxBoards: number;
  maxCandidates: number;
  maxMatchedPerBoard: number;
}

export interface BoardRef {
  boardKey: string;
  company: string;
  ats: "greenhouse" | "lever";
  board: string;
}

export interface Counters {
  fetched: number;
  titleMatched: number;
  locationExcluded: number;
  seniorityExcluded: number;
}

export interface PersistItem {
  atsIdentity: string;
  company: string;
  ats: "greenhouse" | "lever";
  board: string;
  requisitionId: string;
  title: string;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  postingDate: string | null;
  canonicalUrl: string;
  descriptionText: string;
  jdSha256: string;
  observation: {
    observedUrl: string;
    finalUrl: string;
    sourceKind: string;
    extractionMethod: "ats-api" | "browser-dom";
    verification: Record<string, unknown>;
    matchedRoles: string[];
    matchedPhrases: string[];
    locationStatus: "MATCH" | "UNKNOWN" | "UNSPECIFIED";
    bandStatus: "WITHIN" | "OUTSIDE" | "UNSTATED";
    statedYears: number | null;
    yearsQuote: string | null;
    senioritySignal: "ENTRY" | "SENIOR" | "UNSPECIFIED";
    observedAt: string;
  };
}

export interface FailureInput {
  boardKey: string | null;
  stage: "plan" | "search" | "resolution" | "persistence";
  code: string;
  category?: string | null;
  retryable: boolean;
  blocked?: boolean;
  company?: string | null;
  title?: string | null;
  sourceJobId?: string | null;
  targetUrl?: string | null;
  detail: string;
  at?: string;
}

export interface BoardPersistResult {
  stored: number;
  newJobs: number;
  changedJd: number;
  unchanged: number;
  duplicates: number;
}

export interface JobFilters {
  role?: string;
  company?: string;
  location?: string;
  q?: string;
  runId?: string;
  locationStatus?: "MATCH" | "UNKNOWN" | "UNSPECIFIED";
  bandStatus?: "WITHIN" | "OUTSIDE" | "UNSTATED";
  limit?: number;
  offset?: number;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
const clip = (s: string | null | undefined, n: number): string | null => (s == null ? null : s.slice(0, n));

export class JobsRepo {
  constructor(readonly pool: pg.Pool) {}

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // --- runs ---------------------------------------------------------------------------------------------------------------------

  async createRun(userId: string, plan: DiscoveryPlan, boards: BoardRef[], limits: RunLimits, kind: "discovery" | "import" = "discovery"): Promise<{ runId: string }> {
    try {
      return await this.tx(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO discovery_runs (user_id, status, selection_revision_no, catalog_version, snapshot, limits, boards_total, run_kind)
           VALUES ($1, 'QUEUED', $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING id`,
          [userId, plan.selectionRevisionNo, plan.catalogVersion, JSON.stringify(plan), JSON.stringify(limits), boards.length, kind],
        );
        const runId = rows[0]!.id;
        let position = 0;
        for (const b of boards) {
          await c.query(
            `INSERT INTO discovery_run_boards (run_id, board_key, position, company, ats, board) VALUES ($1,$2,$3,$4,$5,$6)`,
            [runId, b.boardKey, position, b.company, b.ats, b.board],
          );
          position += 1;
        }
        return { runId };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505" && String((error as { constraint?: string }).constraint).includes("one_active")) {
        const { rows } = await this.pool.query<{ id: string }>("SELECT id FROM discovery_runs WHERE user_id=$1 AND status IN ('QUEUED','RUNNING') LIMIT 1", [userId]);
        throw new JobsRuleError("RUN_IN_PROGRESS", "A discovery run is already in progress. Wait for it to finish or cancel it.", rows[0]?.id);
      }
      throw error;
    }
  }

  /** ats_identity -> sha256 of the job's CURRENT stored JD revision, for the identities that already exist. */
  async existingRevisionHashes(atsIdentities: string[]): Promise<Map<string, string>> {
    if (atsIdentities.length === 0) return new Map();
    const { rows } = await this.pool.query<{ ats_identity: string; jd_sha256: string }>(
      `SELECT j.ats_identity, r.jd_sha256 FROM jobs j JOIN job_revisions r ON r.id = j.current_revision_id WHERE j.ats_identity = ANY($1::text[])`, [atsIdentities]);
    return new Map(rows.map((r) => [r.ats_identity, r.jd_sha256.trim()]));
  }

  async markRunning(runId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE discovery_runs SET status='RUNNING', started_at=COALESCE(started_at, now()), updated_at=now() WHERE id=$1 AND status IN ('QUEUED','RUNNING')`, [runId]);
    return (r.rowCount ?? 0) > 0;
  }

  async isActive(runId: string): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT 1 FROM discovery_runs WHERE id=$1 AND status IN ('QUEUED','RUNNING')", [runId]);
    return rows.length > 0;
  }

  /** Terminal transition; only applies while the run is still active, so a cancel is never overwritten by a late finish. */
  async finishRun(runId: string, status: Exclude<RunStatus, "QUEUED" | "RUNNING">, extra: { limitReached?: "MAX_CANDIDATES" | "MAX_BOARDS" | null; errorCode?: string | null; errorDetail?: string | null } = {}): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE discovery_runs SET status=$2, finished_at=now(), updated_at=now(), limit_reached=COALESCE($3, limit_reached), error_code=$4, error_detail=$5
        WHERE id=$1 AND status IN ('QUEUED','RUNNING')`,
      [runId, status, extra.limitReached ?? null, extra.errorCode ?? null, clip(extra.errorDetail, 400)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async cancelRun(userId: string, runId: string): Promise<void> {
    const r = await this.pool.query(
      `UPDATE discovery_runs SET status='CANCELLED', finished_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('QUEUED','RUNNING')`, [runId, userId]);
    if ((r.rowCount ?? 0) === 0) {
      const { rows } = await this.pool.query("SELECT status FROM discovery_runs WHERE id=$1 AND user_id=$2", [runId, userId]);
      if (rows.length === 0) throw new JobsRuleError("UNKNOWN_RUN", "Unknown discovery run.");
      throw new JobsRuleError("RUN_NOT_ACTIVE", "That run has already finished.");
    }
    await this.pool.query(`UPDATE discovery_run_boards SET status='SKIPPED', finished_at=now() WHERE run_id=$1 AND status IN ('PENDING','RUNNING')`, [runId]);
  }

  /** Runs left QUEUED/RUNNING by a previous process. They are resumed (their finished boards are kept; pending ones continue). */
  async activeRunsForRecovery(): Promise<Array<{ runId: string; userId: string }>> {
    const { rows } = await this.pool.query<{ id: string; user_id: string }>("SELECT id, user_id FROM discovery_runs WHERE status IN ('QUEUED','RUNNING') ORDER BY created_at");
    return rows.map((r) => ({ runId: r.id, userId: r.user_id }));
  }

  async runSnapshot(runId: string): Promise<{ userId: string; plan: DiscoveryPlan; limits: RunLimits; counters: { verified: number } } | null> {
    const { rows } = await this.pool.query("SELECT user_id, snapshot, limits, verified FROM discovery_runs WHERE id=$1", [runId]);
    const r = rows[0];
    return r ? { userId: r.user_id, plan: r.snapshot as DiscoveryPlan, limits: r.limits as RunLimits, counters: { verified: r.verified } } : null;
  }

  async pendingBoards(runId: string): Promise<BoardRef[]> {
    const { rows } = await this.pool.query(
      `SELECT board_key, company, ats, board FROM discovery_run_boards WHERE run_id=$1 AND status IN ('PENDING','RUNNING') ORDER BY position`, [runId]);
    return rows.map((r) => ({ boardKey: r.board_key, company: r.company, ats: r.ats, board: r.board }));
  }

  async boardStatusCounts(runId: string): Promise<Record<string, number>> {
    const { rows } = await this.pool.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM discovery_run_boards WHERE run_id=$1 GROUP BY status", [runId]);
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async skipPending(runId: string): Promise<void> {
    await this.pool.query(`UPDATE discovery_run_boards SET status='SKIPPED', finished_at=now() WHERE run_id=$1 AND status IN ('PENDING','RUNNING')`, [runId]);
  }

  async startBoard(runId: string, boardKey: string): Promise<void> {
    await this.pool.query(`UPDATE discovery_run_boards SET status='RUNNING', started_at=now() WHERE run_id=$1 AND board_key=$2 AND status='PENDING'`, [runId, boardKey]);
  }

  /** Atomically stores one board's verified postings and closes the board. Returns null (and writes nothing) if the run is no longer RUNNING. */
  async persistBoard(runId: string, boardKey: string, counters: Counters, items: PersistItem[], failures: FailureInput[], boardFailure?: { code: string; detail: string; retryable: boolean; blocked: boolean }): Promise<BoardPersistResult | null> {
    return this.tx(async (c) => {
      const run = await c.query<{ status: string }>("SELECT status FROM discovery_runs WHERE id=$1 FOR UPDATE", [runId]);
      if (run.rows[0]?.status !== "RUNNING") return null;
      const result: BoardPersistResult = { stored: 0, newJobs: 0, changedJd: 0, unchanged: 0, duplicates: 0 };
      for (const item of items) {
        const existing = await c.query<{ id: string; current_revision_id: string | null }>("SELECT id, current_revision_id FROM jobs WHERE ats_identity=$1 FOR UPDATE", [item.atsIdentity]);
        let jobId: string;
        let isNew = false;
        if (existing.rows[0]) {
          jobId = existing.rows[0].id;
        } else {
          const ins = await c.query<{ id: string }>(
            `INSERT INTO jobs (ats_identity, company, ats, board, requisition_id, title, location, department, employment_type, posting_date, canonical_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [item.atsIdentity, item.company, item.ats, item.board, item.requisitionId, item.title, item.location, item.department, item.employmentType, item.postingDate, item.canonicalUrl]);
          jobId = ins.rows[0]!.id;
          isNew = true;
        }
        const rev = await c.query<{ id: string }>(
          `INSERT INTO job_revisions (job_id, jd_sha256, title, location, description_text) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (job_id, jd_sha256) DO NOTHING RETURNING id`,
          [jobId, item.jdSha256, item.title, item.location, item.descriptionText]);
        const revisionId = rev.rows[0]?.id ?? (await c.query<{ id: string }>("SELECT id FROM job_revisions WHERE job_id=$1 AND jd_sha256=$2", [jobId, item.jdSha256])).rows[0]!.id;
        const changed = !isNew && existing.rows[0]!.current_revision_id !== revisionId;
        await c.query(
          `UPDATE jobs SET title=$2, location=$3, department=$4, employment_type=$5, posting_date=$6, canonical_url=$7, current_revision_id=$8, last_seen_at=now() WHERE id=$1`,
          [jobId, item.title, item.location, item.department, item.employmentType, item.postingDate, item.canonicalUrl, revisionId]);
        const o = item.observation;
        const obs = await c.query(
          `INSERT INTO job_observations (run_id, job_id, revision_id, observed_url, final_url, source_kind, extraction_method, verification, matched_roles, matched_phrases,
             location_status, band_status, stated_years, years_quote, seniority_signal, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (run_id, job_id) DO NOTHING`,
          [runId, jobId, revisionId, o.observedUrl, o.finalUrl, o.sourceKind, o.extractionMethod, JSON.stringify(o.verification), o.matchedRoles, o.matchedPhrases,
            o.locationStatus, o.bandStatus, o.statedYears, clip(o.yearsQuote, 600), o.senioritySignal, o.observedAt]);
        if ((obs.rowCount ?? 0) === 0) {
          result.duplicates += 1; // the same requisition twice in one run
          continue;
        }
        result.stored += 1;
        if (isNew) result.newJobs += 1;
        else if (changed) result.changedJd += 1;
        else result.unchanged += 1;
      }
      for (const f of failures) await this.insertFailure(c, runId, f);
      if (boardFailure) await this.insertFailure(c, runId, { boardKey, stage: "search", code: boardFailure.code, retryable: boardFailure.retryable, blocked: boardFailure.blocked, detail: boardFailure.detail });
      await c.query(
        `UPDATE discovery_run_boards SET status=$3, finished_at=now(), fetched=$4, title_matched=$5, location_excluded=$6, seniority_excluded=$7, stored=$8, new_jobs=$9,
           changed_jd=$10, unchanged=$11, duplicates=$12, rejected=$13, failure_code=$14, failure_detail=$15, blocked=$16, retryable=$17 WHERE run_id=$1 AND board_key=$2`,
        [runId, boardKey, boardFailure ? "FAILED" : "OK", counters.fetched, counters.titleMatched, counters.locationExcluded, counters.seniorityExcluded, result.stored,
          result.newJobs, result.changedJd, result.unchanged, result.duplicates, failures.filter((f) => f.stage === "resolution").length,
          boardFailure?.code ?? null, clip(boardFailure?.detail, 400), boardFailure?.blocked ?? false, boardFailure?.retryable ?? false]);
      await c.query(
        `UPDATE discovery_runs SET boards_done=boards_done+1, fetched=fetched+$2, title_matched=title_matched+$3, location_excluded=location_excluded+$4,
           seniority_excluded=seniority_excluded+$5, verified=verified+$6, new_jobs=new_jobs+$7, changed_jd=changed_jd+$8, unchanged=unchanged+$9, duplicates=duplicates+$10,
           rejected=rejected+$11, updated_at=now() WHERE id=$1`,
        [runId, counters.fetched, counters.titleMatched, counters.locationExcluded, counters.seniorityExcluded, result.stored, result.newJobs, result.changedJd, result.unchanged,
          result.duplicates, failures.filter((f) => f.stage === "resolution").length]);
      return result;
    });
  }

  private async insertFailure(c: pg.PoolClient, runId: string, f: FailureInput): Promise<void> {
    await c.query(
      `INSERT INTO discovery_failures (run_id, board_key, stage, code, category, retryable, blocked, company, title, source_job_id, target_url, detail, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now()))`,
      [runId, f.boardKey, f.stage, f.code, f.category ?? null, f.retryable, f.blocked ?? false, clip(f.company, 200), clip(f.title, 300), clip(f.sourceJobId, 100), clip(f.targetUrl, 500), f.detail.slice(0, 400), f.at ?? null]);
  }

  async recordPlanFailure(runId: string, f: FailureInput): Promise<void> {
    const c = await this.pool.connect();
    try {
      await this.insertFailure(c, runId, f);
    } finally {
      c.release();
    }
  }

  // --- reads (always scoped to the user) ----------------------------------------------------------------------------------------

  private runRow(r: Record<string, any>) {
    return {
      runId: r.id as string, status: r.status as RunStatus, selectionRevisionNo: r.selection_revision_no as number, catalogVersion: r.catalog_version as number,
      limits: r.limits as RunLimits, limitReached: (r.limit_reached ?? null) as string | null, errorCode: (r.error_code ?? null) as string | null, errorDetail: (r.error_detail ?? null) as string | null,
      createdAt: iso(r.created_at), startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
      progress: {
        boardsTotal: r.boards_total as number, boardsDone: r.boards_done as number, fetched: r.fetched as number, titleMatched: r.title_matched as number,
        locationExcluded: r.location_excluded as number, seniorityExcluded: r.seniority_excluded as number, verified: r.verified as number, newJobs: r.new_jobs as number,
        changedJd: r.changed_jd as number, unchanged: r.unchanged as number, duplicates: r.duplicates as number, rejected: r.rejected as number,
      },
    };
  }

  async listRuns(userId: string, limit = 10) {
    const { rows } = await this.pool.query("SELECT * FROM discovery_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2", [userId, Math.min(Math.max(limit, 1), 50)]);
    return rows.map((r) => this.runRow(r));
  }

  async getRun(userId: string, runId: string) {
    const { rows } = await this.pool.query("SELECT * FROM discovery_runs WHERE id=$1 AND user_id=$2", [runId, userId]);
    if (!rows[0]) return null;
    const boards = await this.pool.query(
      `SELECT board_key, company, ats, board, status, fetched, title_matched, location_excluded, seniority_excluded, stored, new_jobs, changed_jd, unchanged, duplicates, rejected,
              failure_code, failure_detail, blocked, retryable FROM discovery_run_boards WHERE run_id=$1 ORDER BY position`, [runId]);
    const failures = await this.pool.query(
      `SELECT board_key, stage, code, retryable, blocked, company, title, source_job_id, target_url, detail, at FROM discovery_failures WHERE run_id=$1 ORDER BY id LIMIT 200`, [runId]);
    return {
      ...this.runRow(rows[0]),
      snapshot: rows[0].snapshot as DiscoveryPlan,
      boards: boards.rows.map((b) => ({
        boardKey: b.board_key as string, company: b.company as string, ats: b.ats as string, board: b.board as string, status: b.status as string,
        fetched: b.fetched, titleMatched: b.title_matched, locationExcluded: b.location_excluded, seniorityExcluded: b.seniority_excluded, stored: b.stored, newJobs: b.new_jobs,
        changedJd: b.changed_jd, unchanged: b.unchanged, duplicates: b.duplicates, rejected: b.rejected, failureCode: b.failure_code as string | null,
        failureDetail: b.failure_detail as string | null, blocked: b.blocked as boolean, retryable: b.retryable as boolean,
      })),
      failures: failures.rows.map((f) => ({
        boardKey: f.board_key as string | null, stage: f.stage as string, code: f.code as string, retryable: f.retryable as boolean, blocked: f.blocked as boolean,
        company: f.company as string | null, title: f.title as string | null, sourceJobId: f.source_job_id as string | null, targetUrl: f.target_url as string | null,
        detail: f.detail as string, at: iso(f.at),
      })),
    };
  }

  async listJobs(userId: string, filters: JobFilters = {}) {
    const where: string[] = [];
    const args: unknown[] = [userId];
    const add = (sql: string, value: unknown) => {
      args.push(value);
      where.push(sql.replace("?", `$${args.length}`));
    };
    if (filters.runId) add("o.run_id = ?", filters.runId);
    if (filters.role) add("? = ANY(o.matched_roles)", filters.role);
    if (filters.locationStatus) add("o.location_status = ?", filters.locationStatus);
    if (filters.bandStatus) add("o.band_status = ?", filters.bandStatus);
    if (filters.company) add("j.company ILIKE '%' || ? || '%'", filters.company);
    if (filters.location) add("j.location ILIKE '%' || ? || '%'", filters.location);
    if (filters.q) add("j.title ILIKE '%' || ? || '%'", filters.q);
    const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
    const offset = Math.max(filters.offset ?? 0, 0);
    // Latest observation of each job within the user's own runs.
    const base = `
      FROM jobs j
      JOIN LATERAL (
        SELECT o.* FROM job_observations o JOIN discovery_runs r ON r.id = o.run_id
         WHERE o.job_id = j.id AND r.user_id = $1 ${where.length ? "AND " + where.join(" AND ") : ""}
         ORDER BY o.observed_at DESC, o.id DESC LIMIT 1
      ) o ON true`;
    const total = (await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n ${base}`, args)).rows[0]!.n;
    const { rows } = await this.pool.query(
      `SELECT j.id, j.ats_identity, j.company, j.ats, j.board, j.requisition_id, j.title, j.location, j.department, j.employment_type, j.posting_date, j.canonical_url,
              j.first_seen_at, j.last_seen_at, o.run_id, o.matched_roles, o.matched_phrases, o.location_status, o.band_status, o.stated_years, o.years_quote, o.seniority_signal,
              o.observed_at, o.verification, o.source_kind, o.final_url,
              (SELECT count(*)::int FROM job_revisions v WHERE v.job_id = j.id) AS revision_count
       ${base} ORDER BY o.observed_at DESC, j.company, j.title LIMIT ${limit} OFFSET ${offset}`, args);
    return {
      total: Number(total), limit, offset,
      jobs: rows.map((r) => ({
        jobId: r.id as string, atsIdentity: r.ats_identity as string, company: r.company as string, ats: r.ats as string, board: r.board as string,
        requisitionId: r.requisition_id as string, title: r.title as string, location: r.location as string | null, department: r.department as string | null,
        employmentType: r.employment_type as string | null, postingDate: r.posting_date as string | null, officialUrl: r.canonical_url as string,
        firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at), observedAt: iso(r.observed_at), runId: r.run_id as string,
        matchedRoles: r.matched_roles as string[], matchedPhrases: r.matched_phrases as string[], locationStatus: r.location_status as string, bandStatus: r.band_status as string,
        statedYears: r.stated_years as number | null, yearsQuote: r.years_quote as string | null, senioritySignal: r.seniority_signal as string,
        verification: r.verification as Record<string, unknown>, sourceKind: r.source_kind as string, revisionCount: r.revision_count as number,
      })),
    };
  }

  async getJob(userId: string, jobId: string) {
    const owned = await this.pool.query("SELECT 1 FROM job_observations o JOIN discovery_runs r ON r.id=o.run_id WHERE o.job_id=$1 AND r.user_id=$2 LIMIT 1", [jobId, userId]);
    if (owned.rows.length === 0) return null; // other users' jobs are indistinguishable from unknown ones
    const job = (await this.pool.query("SELECT * FROM jobs WHERE id=$1", [jobId])).rows[0];
    if (!job) return null;
    const current = (await this.pool.query("SELECT id, jd_sha256, description_text, first_seen_at FROM job_revisions WHERE id=$1", [job.current_revision_id])).rows[0];
    const revisions = (await this.pool.query("SELECT id, jd_sha256, first_seen_at FROM job_revisions WHERE job_id=$1 ORDER BY first_seen_at", [jobId])).rows;
    const observations = (await this.pool.query(
      `SELECT o.id, o.run_id, o.revision_id, o.observed_url, o.final_url, o.source_kind, o.extraction_method, o.verification, o.matched_roles, o.matched_phrases, o.location_status,
              o.band_status, o.stated_years, o.years_quote, o.seniority_signal, o.observed_at
         FROM job_observations o JOIN discovery_runs r ON r.id=o.run_id WHERE o.job_id=$1 AND r.user_id=$2 ORDER BY o.observed_at DESC, o.id DESC LIMIT 20`, [jobId, userId])).rows;
    return {
      jobId: job.id as string, atsIdentity: job.ats_identity as string, company: job.company as string, ats: job.ats as string, board: job.board as string,
      requisitionId: job.requisition_id as string, title: job.title as string, location: job.location as string | null, department: job.department as string | null,
      employmentType: job.employment_type as string | null, postingDate: job.posting_date as string | null, officialUrl: job.canonical_url as string,
      firstSeenAt: iso(job.first_seen_at), lastSeenAt: iso(job.last_seen_at),
      currentRevision: current ? { revisionId: current.id as string, jdSha256: current.jd_sha256 as string, firstSeenAt: iso(current.first_seen_at), descriptionText: current.description_text as string } : null,
      revisions: revisions.map((v) => ({ revisionId: v.id as string, jdSha256: v.jd_sha256 as string, firstSeenAt: iso(v.first_seen_at) })),
      observations: observations.map((o) => ({
        observationId: Number(o.id), runId: o.run_id as string, revisionId: o.revision_id as string, observedUrl: o.observed_url as string, finalUrl: o.final_url as string,
        sourceKind: o.source_kind as string, extractionMethod: o.extraction_method as string, verification: o.verification as Record<string, unknown>,
        matchedRoles: o.matched_roles as string[], matchedPhrases: o.matched_phrases as string[], locationStatus: o.location_status as string, bandStatus: o.band_status as string,
        statedYears: o.stated_years as number | null, yearsQuote: o.years_quote as string | null, senioritySignal: o.seniority_signal as string, observedAt: iso(o.observed_at),
      })),
    };
  }
}

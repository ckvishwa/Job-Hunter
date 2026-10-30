import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { JobsRepo, RunLimits } from "../db/jobs-repo.js";
import { JobsRuleError } from "../db/jobs-repo.js";
import type { RolesRepo } from "../db/roles-repo.js";
import { PlanError, buildPlan } from "../jobs/planner.js";
import { boardKeyOf, type BoardsConfig, type DiscoveryRunner } from "../jobs/runner.js";

// S3 routes: start/inspect/cancel an official discovery run and read the verified postings it stored. Same session, Origin and CSRF
// protection as every route (shared preHandler hook). Nothing here evaluates eligibility, fills a form or submits anything.

export const DISCOVERY_DISCLAIMER =
  "These are official postings found for the roles you selected. They are not matches, scores or eligibility decisions: whether you qualify is not evaluated yet, and nothing here applies to any job.";

export interface DiscoveryLimits extends RunLimits {
  delayMs: number;
}

export const defaultLimits = (env: Record<string, string | undefined> = process.env): DiscoveryLimits => ({
  maxBoards: Number(env.JH_DISCOVERY_MAX_BOARDS ?? 25),
  maxCandidates: Number(env.JH_DISCOVERY_MAX_CANDIDATES ?? 50),
  maxMatchedPerBoard: Number(env.JH_DISCOVERY_MAX_PER_BOARD ?? 50),
  delayMs: Number(env.JH_DISCOVERY_DELAY_MS ?? 400),
});

const startBody = z
  .object({ expectedSelectionRevision: z.number().int().min(1), boardKeys: z.array(z.string().regex(/^(greenhouse|lever):[A-Za-z0-9._-]{1,64}$/)).min(1).max(100).optional() })
  .strict();

const listQuery = z
  .object({
    role: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64).optional(),
    company: z.string().trim().max(80).optional(),
    location: z.string().trim().max(80).optional(),
    q: z.string().trim().max(80).optional(),
    runId: z.string().uuid().optional(),
    locationStatus: z.enum(["MATCH", "UNKNOWN", "UNSPECIFIED"]).optional(),
    bandStatus: z.enum(["WITHIN", "OUTSIDE", "UNSTATED"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const uuid = z.string().uuid();

export interface JobsRouteDeps {
  jobs: JobsRepo;
  roles: RolesRepo;
  runner: DiscoveryRunner;
  boards: () => BoardsConfig | null;
  limits: RunLimits;
  user: { id: string; handle: string };
  send: (reply: FastifyReply, status: number, code: string, message: string) => FastifyReply;
}

const PLAN_STATUS: Record<string, number> = { NO_SELECTION: 422, EMPTY_SELECTION: 422, INACTIVE_ROLE: 409, STALE_SELECTION: 409, STALE_CATALOG: 409 };

export function registerJobsRoutes(app: FastifyInstance, deps: JobsRouteDeps): void {
  const { jobs, roles, runner, boards, limits, user, send } = deps;

  const planFor = async (expectedRevision?: number) => {
    const [selection, catalog] = await Promise.all([roles.getSelection(user.id), roles.getCatalog()]);
    return buildPlan({ selection, catalogRoles: catalog.roles, catalogVersion: catalog.catalogVersion, expectedRevision });
  };

  /** What discovery would use right now, so the page can show the snapshot and explain a blocked Start. */
  app.get("/api/v1/discovery/overview", async () => {
    const config = boards();
    let plan = null;
    let planError: { code: string; message: string } | null = null;
    try {
      plan = await planFor();
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      planError = { code: error.code, message: error.message };
    }
    const active = (await jobs.listRuns(user.id, 1))[0];
    return {
      disclaimer: DISCOVERY_DISCLAIMER,
      boardsConfigured: config !== null,
      boards: (config?.companies ?? []).map((c) => ({ boardKey: boardKeyOf(c), company: c.company, ats: c.ats })),
      limits, plan, planError,
      latestRun: active ?? null,
    };
  });

  app.post("/api/v1/discovery-runs", async (req, reply) => {
    const body = startBody.parse(req.body);
    const plan = await planFor(body.expectedSelectionRevision);
    const config = boards();
    if (!config || config.companies.length === 0) {
      return send(reply, 422, "NO_BOARDS", "No official employer boards are configured. Add config/company-boards.json (see config/company-boards.example.json).");
    }
    let chosen = config.companies;
    if (body.boardKeys) {
      const known = new Set(config.companies.map(boardKeyOf));
      const unknown = body.boardKeys.find((k) => !known.has(k));
      if (unknown) return send(reply, 422, "UNKNOWN_BOARD", `"${unknown}" is not in the configured board list.`);
      chosen = config.companies.filter((c) => body.boardKeys!.includes(boardKeyOf(c)));
    }
    const truncated = Math.max(0, chosen.length - limits.maxBoards);
    chosen = chosen.slice(0, limits.maxBoards);
    const { runId } = await jobs.createRun(user.id, plan, chosen.map((c) => ({ boardKey: boardKeyOf(c), company: c.company, ats: c.ats, board: c.board })), limits);
    runner.enqueue(runId);
    return reply.code(202).send({ runId, status: "QUEUED", boards: chosen.length, truncatedBoards: truncated, selectionRevision: plan.selectionRevisionNo });
  });

  app.get("/api/v1/discovery-runs", async () => ({ runs: await jobs.listRuns(user.id, 10) }));

  app.get("/api/v1/discovery-runs/:id", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const run = id.success ? await jobs.getRun(user.id, id.data) : null;
    if (!run) return send(reply, 404, "UNKNOWN_RUN", "Unknown discovery run.");
    return run;
  });

  app.post("/api/v1/discovery-runs/:id/cancel", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return send(reply, 404, "UNKNOWN_RUN", "Unknown discovery run.");
    await jobs.cancelRun(user.id, id.data);
    runner.cancel(id.data);
    return { runId: id.data, status: "CANCELLED" };
  });

  app.get("/api/v1/jobs", async (req) => {
    const q = listQuery.parse(req.query);
    return { disclaimer: DISCOVERY_DISCLAIMER, ...(await jobs.listJobs(user.id, q)) };
  });

  app.get("/api/v1/jobs/:id", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const job = id.success ? await jobs.getJob(user.id, id.data) : null;
    if (!job) return send(reply, 404, "UNKNOWN_JOB", "Unknown job.");
    return { disclaimer: DISCOVERY_DISCLAIMER, job };
  });
}

export const PLAN_ERROR_STATUS = PLAN_STATUS;
export const JOBS_ERROR_STATUS: Record<string, number> = { RUN_IN_PROGRESS: 409, UNKNOWN_RUN: 404, UNKNOWN_JOB: 404, RUN_NOT_ACTIVE: 409 };
export { JobsRuleError, PlanError };

import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { ZodError, z } from "zod";
import { FactRuleError, attestFact, type FactRuleCode } from "../candidate/fact-lifecycle.js";
import { SENSITIVE_FACT_KINDS } from "../domain/candidate-profile.js";
import type { CandidateRepo } from "../db/candidate-repo.js";
import { RolesRepo } from "../db/roles-repo.js";
import { ProfileRepo } from "../db/profile-repo.js";
import { JobsRepo } from "../db/jobs-repo.js";
import { DiscoveryRunner, loadBoardsConfig, type BoardsConfig, type RunnerDeps } from "../jobs/runner.js";
import { registerMatchRoutes } from "./match-routes.js";
import { MatchStore } from "../match/store.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { JOBS_ERROR_STATUS, JobsRuleError, PLAN_ERROR_STATUS, PlanError, defaultLimits, registerJobsRoutes } from "./jobs-routes.js";
import { RoleRuleError, type RoleRuleCode } from "../roles/errors.js";
import { registerRoleRoutes } from "./roles-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { createProjectSources } from "../project/sources.js";
import type { ProjectOptions } from "../project/views.js";
import { fileURLToPath } from "node:url";
import { SESSION_COOKIE, createLoginLimiter, createSessionCodec, safeEqual } from "./auth.js";
import type { ApiConfig } from "./config.js";
import type { ExtractionQueue } from "./extraction.js";
import type { FileStore } from "./file-store.js";

declare module "fastify" {
  interface FastifyInstance {
    discoveryRunner: DiscoveryRunner;
  }
}

export interface ApiDeps {
  config: ApiConfig;
  repo: CandidateRepo;
  files: FileStore;
  queue: ExtractionQueue;
  /** Defaults to a RolesRepo on the same pool as `repo`. */
  roles?: RolesRepo;
  /** S3. Defaults: a JobsRepo on the same pool, a DiscoveryRunner reading the configured board list, and the limits from the environment. */
  jobsRepo?: JobsRepo;
  runner?: DiscoveryRunner;
  boards?: () => BoardsConfig | null;
  /** Test seam: inject fetch/delay/clock into the default runner. */
  runnerOptions?: Partial<Pick<RunnerDeps, "fetchImpl" | "delayMs" | "timeoutMs" | "now" | "onEvent">>;
  discoveryLimits?: { maxBoards: number; maxCandidates: number; maxMatchedPerBoard: number };
  /** Project dashboard sources. Default: the docs of this repository checkout (read-only). Test seam: a temporary root. */
  project?: ProjectOptions;
  now?: () => Date;
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set(["AI_UNAVAILABLE", "AI_TIMEOUT", "INTERNAL_ERROR", "EXTRACTOR_UNAVAILABLE", "STORED_FILE_MISSING"]);
export { RETRYABLE_CODES };

const RULE_STATUS: Record<FactRuleCode, number> = {
  CONFIRMATION_REQUIRED: 422, STALE_FACT: 409, CONFLICTING_FACT: 409, INVALID_EDIT: 422, INVALID_ATTESTATION: 422, NOT_ALLOWED: 403,
};

const ROLE_STATUS: Record<RoleRuleCode, number> = {
  UNKNOWN_RECOMMENDATION: 404, UNKNOWN_ROLE: 404, STALE_RECOMMENDATION: 409, STALE_SELECTION: 409, STALE_CATALOG: 409, STALE_ROLE: 409,
  INVALID_SELECTION: 400, INVALID_ROLE_DEFINITION: 400,
};

const reviewBody = z
  .object({
    factId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    action: z.enum(["approve", "reject", "edit"]),
    expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    confirmSensitive: z.boolean().optional(),
    edit: z.object({ value: z.string().max(300).optional(), attributes: z.record(z.unknown()).optional() }).strict().optional(),
  })
  .strict();

const attestBody = z
  .object({
    kind: z.enum(SENSITIVE_FACT_KINDS as unknown as [string, ...string[]]),
    value: z.string().min(1).max(300),
    polarity: z.enum(["has", "lacks"]),
    confirm: z.boolean(),
  })
  .strict();

const loginBody = z.object({ accessToken: z.string().min(1).max(512) }).strict();
const uuid = z.string().uuid();

function sniffType(bytes: Buffer): "pdf" | "docx" | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "docx";
  return null;
}

export async function buildServer(deps: ApiDeps): Promise<FastifyInstance> {
  const { config, repo, files, queue } = deps;
  const clock = deps.now ?? (() => new Date());
  const today = (): string => clock().toISOString().slice(0, 10);
  const codec = createSessionCodec(config.sessionSecret, config.sessionTtlSeconds, () => clock().getTime());
  const limiter = createLoginLimiter();
  const roles = deps.roles ?? new RolesRepo(repo.pool);
  const jobsRepo = deps.jobsRepo ?? new JobsRepo(repo.pool);
  const boards = deps.boards ?? (() => loadBoardsConfig());
  const discovery = defaultLimits();
  const runner = deps.runner ?? new DiscoveryRunner({ repo: jobsRepo, boards, delayMs: discovery.delayMs, ...(deps.runnerOptions ?? {}) });
  const user = await repo.ensureUser(config.userHandle);
  await roles.seedCatalog(); // idempotent; never overwrites a role a person edited
  const profiles = new ProfileRepo(repo.pool);
  // Demo mode only: a DEMO profile that accepts fixture uploads. A real (personal) profile is never touched by it.
  if (config.demoProfile) await profiles.ensureActive(user.id, "demo", "demo fixtures");
  const allowedHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  app.decorate("discoveryRunner", runner);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4, parts: 6, headerPairs: 50 } });

  const send = (reply: FastifyReply, status: number, code: string, message: string): FastifyReply =>
    reply.code(status).send({ error: { code, message } });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  });

  // DNS-rebinding guard: only loopback host names are served.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!allowedHosts.has(host)) return send(reply, 403, "FORBIDDEN_HOST", "Forbidden host.");
  });

  const sessionOf = (req: FastifyRequest) => codec.verify(req.cookies[SESSION_COOKIE]);

  const originOk = (req: FastifyRequest): boolean => {
    const origin = req.headers.origin;
    return typeof origin === "string" && config.allowedOrigins.includes(origin);
  };

  // Every route except health and session bootstrap requires a valid session. Writes also require a trusted Origin and CSRF token.
  app.addHook("preHandler", async (req, reply) => {
    const url = req.url.split("?")[0]!;
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (url === "/api/v1/healthz") return;
    if (url === "/api/v1/session" && req.method !== "DELETE") {
      if (isWrite && !originOk(req)) return send(reply, 403, "BAD_ORIGIN", "Untrusted origin.");
      return;
    }
    const session = sessionOf(req);
    if (!session) return send(reply, 401, "UNAUTHENTICATED", "Sign in first.");
    if (isWrite) {
      if (!originOk(req)) return send(reply, 403, "BAD_ORIGIN", "Untrusted origin.");
      const supplied = req.headers["x-csrf-token"];
      if (typeof supplied !== "string" || !safeEqual(supplied, session.csrfToken)) return send(reply, 403, "BAD_CSRF", "Missing or invalid CSRF token.");
    }
  });

  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, req, reply) => {
    if (error instanceof ZodError) return send(reply, 400, "INVALID_REQUEST", "The request body is not valid.");
    if (error instanceof PlanError) return send(reply, PLAN_ERROR_STATUS[error.code] ?? 409, error.code, error.message);
    if (error instanceof JobsRuleError) {
      const status = JOBS_ERROR_STATUS[error.code] ?? 409;
      return reply.code(status).send({ error: { code: error.code, message: error.message }, ...(error.runId ? { runId: error.runId } : {}) });
    }
    if (error instanceof RoleRuleError) return send(reply, ROLE_STATUS[error.code], error.code, error.message);
    if (error instanceof FactRuleError) return send(reply, RULE_STATUS[error.code], error.code, error.message);
    if (error.code === "FST_REQ_FILE_TOO_LARGE") return send(reply, 413, "FILE_TOO_LARGE", `The file exceeds ${config.maxUploadBytes} bytes.`);
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return send(reply, 413, "BODY_TOO_LARGE", "The request body is too large.");
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) return send(reply, error.statusCode, "BAD_REQUEST", "The request could not be processed.");
    // An unexpected failure: record WHERE and WHAT KIND (route, error class, code) so it can be diagnosed. Never the request body, headers, cookies or the message text.
    console.error(`[api] 500 ${req.method} ${req.routeOptions?.url ?? "(unrouted)"} ${error.name}${error.code ? ` ${error.code}` : ""}`);
    return send(reply, 500, "INTERNAL_ERROR", "Something went wrong.");
  });

  // --- health & session -----------------------------------------------------------------------------------------------
  app.get("/api/v1/healthz", async () => ({ ok: true }));

  app.post("/api/v1/session", async (req, reply) => {
    if (!limiter.allow(req.ip)) return send(reply, 429, "TOO_MANY_ATTEMPTS", "Too many sign-in attempts. Wait a minute.");
    const body = loginBody.parse(req.body);
    if (!safeEqual(body.accessToken, config.accessToken)) return send(reply, 401, "BAD_ACCESS_TOKEN", "The access token is not correct.");
    const issued = codec.issue();
    reply.setCookie(SESSION_COOKIE, issued.cookie, { httpOnly: true, sameSite: "strict", path: "/", maxAge: issued.maxAgeSeconds });
    return { authenticated: true, csrfToken: issued.csrfToken, user: { handle: user.handle } };
  });

  app.get("/api/v1/session", async (req) => {
    const session = sessionOf(req);
    return session ? { authenticated: true, csrfToken: session.csrfToken, user: { handle: user.handle } } : { authenticated: false };
  });

  app.delete("/api/v1/session", async (req, reply) => {
    const session = sessionOf(req);
    if (!session) return { authenticated: false };
    if (!originOk(req)) return send(reply, 403, "BAD_ORIGIN", "Untrusted origin.");
    const supplied = req.headers["x-csrf-token"];
    if (typeof supplied !== "string" || !safeEqual(supplied, session.csrfToken)) return send(reply, 403, "BAD_CSRF", "Missing or invalid CSRF token.");
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { authenticated: false };
  });

  // --- resumes ------------------------------------------------------------------------------------------------------
  app.post("/api/v1/resumes", async (req, reply) => {
    if (!req.isMultipart()) return send(reply, 415, "UNSUPPORTED_MEDIA_TYPE", "Send the resume as multipart/form-data with a file field.");
    const part = await req.file();
    if (!part) return send(reply, 400, "NO_FILE", "No file was uploaded.");
    const bytes = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the limit
    if (bytes.length === 0) return send(reply, 400, "EMPTY_FILE", "The file is empty.");
    const fileType = sniffType(bytes);
    if (!fileType) return send(reply, 415, "UNSUPPORTED_FILE_TYPE", "Only PDF and DOCX resumes are accepted.");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageRef = files.save(sha256, fileType, bytes);
    const result = await repo.registerResume({ userId: user.id, sha256, fileType, byteSize: bytes.length, storageRef, retryableErrorCodes: RETRYABLE_CODES });
    if (result.version.state === "UPLOADED" || result.version.state === "EXTRACTING") queue.enqueue(result.version.id);
    // Without demo mode a new upload is UNVERIFIED (no classification) and is excluded from career scoring until the owner classifies it.
    if (config.demoProfile && (await profiles.active(user.id))?.kind === "demo") {
      await profiles.classify(user.id, { resumeId: result.resume.id, provenance: "fixture", authorized: true, basis: "demo mode (JH_DEMO_PROFILE=1): uploads are fixtures", actor: "demo-mode" });
    }
    return reply.code(202).send({
      resumeId: result.resume.id, versionId: result.version.id, state: result.version.state,
      duplicate: !result.created, requeued: result.requeued,
    });
  });

  app.get("/api/v1/resumes", async () => ({ resumes: await repo.listResumes(user.id) }));

  app.get("/api/v1/resumes/:id", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    if (!id.success) return send(reply, 404, "NOT_FOUND", "Unknown resume.");
    const detail = await repo.getResumeDetail(user.id, id.data);
    if (!detail) return send(reply, 404, "NOT_FOUND", "Unknown resume.");
    const { text: _text, ...rest } = detail;
    return { ...rest, hasText: detail.text !== null };
  });

  app.get("/api/v1/resumes/:id/text", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const detail = id.success ? await repo.getResumeDetail(user.id, id.data) : null;
    if (!detail) return send(reply, 404, "NOT_FOUND", "Unknown resume.");
    if (detail.text === null) return send(reply, 409, "NOT_READY", "The resume has not been extracted yet.");
    return { text: detail.text };
  });

  app.get("/api/v1/resumes/:id/facts", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const detail = id.success ? await repo.getResumeDetail(user.id, id.data) : null;
    if (!detail) return send(reply, 404, "NOT_FOUND", "Unknown resume.");
    return {
      state: detail.version.state, errorCode: detail.version.errorCode, errorDetail: detail.version.errorDetail,
      warnings: detail.version.warnings, parserRevision: detail.version.parserRevision,
      facts: await repo.listFacts(user.id, detail.resumeId),
    };
  });

  app.post("/api/v1/resumes/:id/facts/review", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const detail = id.success ? await repo.getResumeDetail(user.id, id.data) : null;
    if (!detail) return send(reply, 404, "NOT_FOUND", "Unknown resume.");
    const body = reviewBody.parse(req.body);
    const owned = (await repo.listFacts(user.id, detail.resumeId)).some((f) => f.factId === body.factId);
    if (!owned) return send(reply, 404, "NOT_FOUND", "That fact does not belong to this resume.");
    const result = await repo.applyReview(user.id, user.handle, body.factId, {
      action: body.action, actor: user.handle, today: today(), expectedDigest: body.expectedDigest,
      confirmSensitive: body.confirmSensitive, edit: body.edit,
    });
    return { changed: result.changed, fact: result.fact };
  });

  app.get("/api/v1/facts/:factId/revisions", async (req, reply) => {
    const factId = (req.params as { factId: string }).factId;
    if (!(await repo.getFact(user.id, factId))) return send(reply, 404, "NOT_FOUND", "Unknown fact.");
    return { revisions: await repo.listRevisions(user.id, factId) };
  });

  // --- explicit user attestation of sensitive facts -------------------------------------------------------------------
  app.get("/api/v1/profile/attested-facts", async () => ({ facts: await repo.listAttestedFacts(user.id) }));

  app.post("/api/v1/profile/attested-facts", async (req, reply) => {
    const body = attestBody.parse(req.body);
    const draft = attestFact({ kind: body.kind as never, value: body.value, polarity: body.polarity, actor: user.handle, today: today(), confirm: body.confirm });
    const result = await repo.attest(user.id, user.handle, draft, today());
    return reply.code(result.created ? 201 : 200).send({ created: result.created, fact: result.fact });
  });

  app.get("/api/v1/profile/revisions", async () => ({ revisions: await repo.listProfileRevisions(user.id) }));

  // --- S2: roles ------------------------------------------------------------------------------------------------------
  registerRoleRoutes(app, { roles, user, today, send });

  // --- S3: official discovery ------------------------------------------------------------------------------------------------
  registerJobsRoutes(app, {
    jobs: jobsRepo, roles, runner, boards, user, send,
    limits: deps.discoveryLimits ?? { maxBoards: discovery.maxBoards, maxCandidates: discovery.maxCandidates, maxMatchedPerBoard: discovery.maxMatchedPerBoard },
  });

  // --- S4: evidence-grounded matches -----------------------------------------------------------------------------------------
  // Deterministic baseline by default; JH_MATCH_ENCODER=minilm adds the local MiniLM ranker (no network at match time once the model is cached).
  const matchStore = new MatchStore({ pool: repo.pool, candidates: repo, jobs: jobsRepo, encoder: process.env.JH_MATCH_ENCODER === "minilm" ? () => new LocalTransformerEncoder() : null });
  registerMatchRoutes(app, { store: matchStore, user, send });

  // --- Project command center (read-only, internal engineering view) ---------------------------------------------------------
  registerProjectRoutes(app, { project: deps.project ?? { sources: createProjectSources(fileURLToPath(new URL("../../", import.meta.url))) }, send });

  return app;
}

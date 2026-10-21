import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { MatchStore } from "../match/store.js";

// S4 routes: read or compute the persisted, versioned match of a stored official posting against the user's APPROVED, authorized candidate evidence.
// Same session, Origin and CSRF protection as every route (shared preHandler hook). Nothing here edits a candidate fact, scores a job, applies, or submits.

export const MATCH_DISCLAIMER =
  "This compares what the posting asks for with evidence you approved. The evidence report is not a score. The M4 ranking score orders reviewed opportunities; it is not a hiring prediction. 'No supporting evidence' means no approved evidence was found, not that you lack the qualification. Nothing here applies to any job.";

const uuid = z.string().uuid();
const flagBody = z.object({ requirementId: z.string().trim().min(1).max(80), note: z.string().trim().min(3).max(1000) }).strict();

export interface MatchRouteDeps {
  store: MatchStore;
  user: { id: string };
  send: (reply: FastifyReply, status: number, code: string, message: string) => FastifyReply;
}

export function registerMatchRoutes(app: FastifyInstance, { store, user, send }: MatchRouteDeps): void {
  app.get("/api/v1/matches", async () => ({ disclaimer: MATCH_DISCLAIMER, ...(await store.list(user.id, 100)) }));
  app.get("/api/v1/shortlist", async () => ({ disclaimer: MATCH_DISCLAIMER, ...(await store.shortlist(user.id, 100)) }));

  app.get("/api/v1/jobs/:id/match", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const got = id.success ? await store.get(user.id, id.data) : null;
    if (!got) return send(reply, 404, "UNKNOWN_JOB", "Unknown job.");
    return { disclaimer: MATCH_DISCLAIMER, ...got };
  });

  app.post("/api/v1/jobs/:id/match", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const out = id.success ? await store.compute(user.id, id.data) : null;
    if (!out) return send(reply, 404, "UNKNOWN_JOB", "Unknown job.");
    return reply.code(out.computed ? 201 : 200).send({ disclaimer: MATCH_DISCLAIMER, computed: out.computed, current: true, staleReasons: [], match: out.match });
  });

  app.post("/api/v1/matches/:id/flags", async (req, reply) => {
    const id = uuid.safeParse((req.params as { id: string }).id);
    const body = flagBody.parse(req.body);
    const out = id.success ? await store.flag(user.id, id.data, body.requirementId, body.note) : null;
    if (!out) return send(reply, 404, "UNKNOWN_MATCH", "Unknown match.");
    return reply.code(201).send({ flagId: out.id });
  });
}

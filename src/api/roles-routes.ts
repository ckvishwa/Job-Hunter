import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { roleEditSchema } from "../roles/catalog.js";
import type { RolesRepo } from "../db/roles-repo.js";
import { selectionInputSchema } from "../db/roles-repo.js";

// S2 routes: role catalog, grounded recommendations, human decisions and the explicit role selection. Same session, Origin and CSRF
// protection as S1 (enforced by the shared preHandler hook). Nothing here changes a candidate fact.

const decisionBody = z
  .object({
    recommendationId: z.string().uuid(),
    decision: z.enum(["approve", "dismiss", "reset"]),
    expectedInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const catalogEditBody = z.object({ expectedRevision: z.number().int().min(1), changes: roleEditSchema }).strict();
const slugParam = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(64);

export const RECOMMENDATION_DISCLAIMER =
  "These suggestions are exploratory. They are not a hiring chance, an ATS score or a promise of eligibility, and they do not apply to any job. Only facts you approved are used; your own selection decides what is searched.";

export function registerRoleRoutes(
  app: FastifyInstance,
  deps: { roles: RolesRepo; user: { id: string; handle: string }; today: () => string; send: (reply: FastifyReply, status: number, code: string, message: string) => FastifyReply },
): void {
  const { roles, user, today, send } = deps;

  app.get("/api/v1/roles/catalog", async () => roles.getCatalog());

  app.put("/api/v1/roles/catalog/:roleSlug", async (req, reply) => {
    const slug = slugParam.safeParse((req.params as { roleSlug: string }).roleSlug);
    if (!slug.success) return send(reply, 404, "UNKNOWN_ROLE", "Unknown role.");
    const body = catalogEditBody.parse(req.body);
    return roles.editRole(slug.data, body.expectedRevision, body.changes, user.handle);
  });

  app.get("/api/v1/roles/recommendations", async () => ({ ...(await roles.getRecommendations(user.id, today())), disclaimer: RECOMMENDATION_DISCLAIMER }));

  app.post("/api/v1/roles/recommendations/decisions", async (req) => {
    const body = decisionBody.parse(req.body);
    return roles.decide(user.id, user.handle, body, today());
  });

  app.get("/api/v1/roles/selections", async () => ({ selection: await roles.getSelection(user.id) }));

  app.post("/api/v1/roles/selections", async (req) => {
    const body = selectionInputSchema.parse(req.body);
    return roles.saveSelection(user.id, user.handle, body);
  });
}

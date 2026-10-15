import type { FastifyInstance, FastifyReply } from "fastify";
import { ProjectSourceError } from "../project/sources.js";
import { notebookView, overviewView, phasesView, prdView, tasksView, type ProjectOptions } from "../project/views.js";

// Read-only Project (engineering management) API. Authentication is the shared session preHandler hook in server.ts, which covers
// every /api/v1 route except health and session bootstrap. There is no write route and no route takes a path or file name:
// the five sources are fixed in src/project/sources.ts.

export function registerProjectRoutes(
  app: FastifyInstance,
  deps: { project: ProjectOptions; send: (reply: FastifyReply, status: number, code: string, message: string) => FastifyReply },
): void {
  const { project, send } = deps;

  const route = (url: string, build: (opts: ProjectOptions) => Promise<unknown>): void => {
    app.get(url, async (_req, reply) => {
      try {
        return await build(project);
      } catch (error) {
        // 404/422, not 5xx: the UI proxy treats 502-504 as "API down", and a missing or unusable source is a precise, expected state.
        if (error instanceof ProjectSourceError) return send(reply, error.code === "PROJECT_SOURCE_MISSING" ? 404 : 422, error.code, error.message);
        throw error;
      }
    });
  };

  route("/api/v1/project/overview", overviewView);
  route("/api/v1/project/phases", phasesView);
  route("/api/v1/project/tasks", tasksView);
  route("/api/v1/project/prd", prdView);
  route("/api/v1/project/notebook", notebookView);
}

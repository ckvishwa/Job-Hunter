import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectSources } from "../../src/project/sources.js";
import { FakeAi, HOST, authHeaders, dbAvailable, getJson, login, startHarness, type Harness, type Session } from "../helpers/s1-harness.js";
import { makeProjectRoot, type ProjectRoot } from "../helpers/project-fixtures.js";

// Session enforcement for the Project API on the REAL server (real Fastify hooks, throwaway PostgreSQL). The project sources are a
// temporary synthetic checkout.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

suite("Project API authentication", { timeout: 30_000 }, () => {
  let h: Harness;
  let s: Session;
  let root: ProjectRoot;
  const urls = ["overview", "phases", "tasks", "prd", "notebook"].map((n) => `/api/v1/project/${n}`);

  beforeAll(async () => {
    root = makeProjectRoot();
    h = await startHarness(new FakeAi(() => { throw new Error("AI is not used by the project API"); }), {
      serverDeps: { project: { sources: createProjectSources(root.root), repoUrl: "https://github.com/acme/repo" } },
    });
    s = await login(h);
  });
  afterAll(async () => {
    await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
    root?.cleanup();
  });

  it("rejects every project route without a session", async () => {
    for (const url of urls) {
      const res = await h.app.inject({ method: "GET", url, headers: { host: HOST } });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
      expect(res.body).not.toContain("Synthetic ledger");
    }
  });

  it("rejects a forged or tampered session cookie", async () => {
    const res = await h.app.inject({ method: "GET", url: urls[0]!, headers: { host: HOST, cookie: `${s.cookie}x` } });
    expect(res.statusCode).toBe(401);
  });

  it("serves them to a signed-in session and sets no-store", async () => {
    for (const url of urls) {
      const res = await getJson(h, s, url);
      expect(res.status, url).toBe(200);
    }
    const raw = await h.app.inject({ method: "GET", url: urls[0]!, headers: { host: HOST, cookie: s.cookie } });
    expect(raw.headers["cache-control"]).toBe("no-store");
  });

  it("offers no write method even with a valid session, origin and CSRF token", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await h.app.inject({ method, url: urls[1]!, headers: authHeaders(s, { "content-type": "application/json" }), payload: "{}" });
      expect(res.statusCode, method).toBe(404);
    }
  });
});

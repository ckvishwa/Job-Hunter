import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerProjectRoutes } from "../../src/api/project-routes.js";
import { splitNotebook, splitSections } from "../../src/project/markdown.js";
import { createProjectSources } from "../../src/project/sources.js";
import { makeProjectRoot, type ProjectRoot } from "../helpers/project-fixtures.js";

// The five read-only endpoints against a temporary synthetic checkout. Session enforcement is proven separately, against the real
// server, in tests/project/project-auth.test.ts.

const roots: ProjectRoot[] = [];
afterEach(() => { while (roots.length) roots.pop()!.cleanup(); });

async function appFor(over: Parameters<typeof makeProjectRoot>[0] = {}) {
  const p = makeProjectRoot(over);
  roots.push(p);
  const app = Fastify();
  registerProjectRoutes(app, {
    project: { sources: createProjectSources(p.root), repoUrl: "https://github.com/acme/repo" },
    send: (reply, status, code, message) => reply.code(status).send({ error: { code, message } }),
  });
  return { app, p };
}

describe("GET /api/v1/project/*", () => {
  it("serves overview, phases, tasks, prd and notebook", async () => {
    const { app } = await appFor();
    const get = async (u: string) => {
      const res = await app.inject({ method: "GET", url: u });
      return { status: res.statusCode, body: res.json() as any };
    };
    const overview = await get("/api/v1/project/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.counts.tasks).toBe(10);
    expect((await get("/api/v1/project/phases")).body.phases).toHaveLength(7);
    expect((await get("/api/v1/project/tasks")).body.tasks).toHaveLength(10);
    const prd = (await get("/api/v1/project/prd")).body;
    expect(prd.title).toBe("SYNTH PRODUCT");
    expect(prd.version).toBe("9.9 (synthetic)");
    expect(prd.hashMatches).toBe(true);
    expect(prd.sections.map((s: any) => [s.number, s.title])).toEqual([[null, "SYNTH PRODUCT"], ["1", "1. Overview"], ["1.1", "1.1 Goals"], ["2", "2. Baseline"], ["12", "12. Roadmap"]]);
    const notebook = (await get("/api/v1/project/notebook")).body;
    expect(notebook.entries.map((e: any) => e.date)).toEqual(["2026-01-02", "2026-01-03"]);
  });

  it("has no write routes and takes no file path", async () => {
    const { app } = await appFor();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await app.inject({ method, url: "/api/v1/project/tasks" })).statusCode).toBe(404);
    }
    // A path-like query or segment cannot select a file: it is either ignored or an unknown route.
    expect((await app.inject({ method: "GET", url: "/api/v1/project/prd?file=../../.env" })).json().title).toBe("SYNTH PRODUCT");
    expect((await app.inject({ method: "GET", url: "/api/v1/project/..%2f..%2fpackage.json" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/project/notebook/..%2F..%2F.env" })).statusCode).toBe(404);
  });

  it("returns a typed unavailable state when the ledger is missing", async () => {
    const { app } = await appFor({ ledgerRaw: null });
    const res = await app.inject({ method: "GET", url: "/api/v1/project/overview" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PROJECT_SOURCE_MISSING");
    expect(res.body).not.toContain(os.tmpdir()); // no filesystem path in the message
  });

  it("returns a typed invalid state for malformed JSON and for a bad structure", async () => {
    for (const raw of ["{ not json", JSON.stringify({ phases: [{ id: "A", name: "n", tasks: "oops" }] }), JSON.stringify({ phases: [] })]) {
      const { app } = await appFor({ ledgerRaw: raw });
      for (const u of ["overview", "phases", "tasks"]) {
        const res = await app.inject({ method: "GET", url: `/api/v1/project/${u}` });
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe("PROJECT_SOURCE_INVALID");
      }
    }
  });

  it("reports a missing PRD and a PRD hash mismatch instead of hiding them", async () => {
    const missing = await appFor({ prd: null });
    const o1 = (await missing.app.inject({ method: "GET", url: "/api/v1/project/overview" })).json();
    expect(o1.prd.hashMatches).toBe(false);
    expect(o1.validation.ledgerErrors).toContain("Missing docs/PRD.md");
    expect((await missing.app.inject({ method: "GET", url: "/api/v1/project/prd" })).json().error.code).toBe("PROJECT_SOURCE_MISSING");

    const changed = await appFor();
    writeFileSync(path.join(changed.p.root, "docs", "PRD.md"), "# Edited\n");
    const o2 = (await changed.app.inject({ method: "GET", url: "/api/v1/project/overview" })).json();
    expect(o2.prd.hashMatches).toBe(false);
    expect(o2.validation.ok).toBe(false);
  });

  it("reports a missing notebook as unavailable", async () => {
    const { app } = await appFor({ notebook: null });
    const res = await app.inject({ method: "GET", url: "/api/v1/project/notebook" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PROJECT_SOURCE_MISSING");
  });

  it("refuses a source that is a symlink leaving the repository", async () => {
    const { app, p } = await appFor({ notebook: null });
    const outside = path.join(os.tmpdir(), `jh-outside-${Date.now()}.md`);
    writeFileSync(outside, "# secret\n## 2026-01-01 — leaked\nbody\n");
    try {
      symlinkSync(outside, path.join(p.root, "docs", "team", "ENGINEERING_NOTEBOOK.md"));
    } catch {
      return; // symlink creation needs privileges on some Windows setups; the containment rule is also covered by the realpath check
    }
    const res = await app.inject({ method: "GET", url: "/api/v1/project/notebook" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("PROJECT_SOURCE_INVALID");
    expect(res.body).not.toContain("leaked");
  });

  it("does not expose candidate or resume content: only the fixed sources are readable", async () => {
    const { app, p } = await appFor();
    mkdirSync(path.join(p.root, "private-runtime"), { recursive: true });
    writeFileSync(path.join(p.root, "private-runtime", "resume.txt"), "CANDIDATE-RESUME-SECRET");
    for (const u of ["overview", "phases", "tasks", "prd", "notebook"]) {
      expect((await app.inject({ method: "GET", url: `/api/v1/project/${u}` })).body).not.toContain("CANDIDATE-RESUME-SECRET");
    }
  });
});

describe("markdown sectioning", () => {
  it("ignores headings in fenced code and nests parents", () => {
    const { sections } = splitSections("# A\n```\n# fake\n```\n## B\ntext\n# C\n");
    expect(sections.map((s) => [s.title, s.parentId])).toEqual([["A", null], ["B", "a"], ["C", null]]);
    expect(sections[0]!.body).toContain("# fake");
  });

  it("gives duplicate headings unique ids", () => {
    const { sections } = splitSections("# Same\n# Same\n");
    expect(new Set(sections.map((s) => s.id)).size).toBe(2);
  });

  it("splits notebook entries and keeps hostile text as plain text", () => {
    const { entries } = splitNotebook("## 2026-02-03 — <script>x</script>\nbody\n## undated\n");
    expect(entries[0]).toMatchObject({ date: "2026-02-03", title: "2026-02-03 — <script>x</script>" });
    expect(entries[1]!.date).toBeNull();
  });
});

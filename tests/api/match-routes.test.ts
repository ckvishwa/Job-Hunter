import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRepo } from "../../src/db/jobs-repo.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { createLiveImportRun } from "../../src/jobs/import.js";
import { DiscoveryRunner } from "../../src/jobs/runner.js";
import { BOARDS, fakeBoardFetch, ghBody, longJd } from "../helpers/s3-fixtures.js";
import { FakeAi, ORIGIN, HOST, authHeaders, dbAvailable, login, startHarness, type Harness, type Session } from "../helpers/s1-harness.js";

// Authenticated match API on a throwaway database. The stored posting arrives through an IMPORT run answered by a fake board fetch: no employer is contacted.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

suite("match API", { timeout: 60_000 }, () => {
  let h: Harness;
  let s: Session;
  let jobId: string;

  beforeAll(async () => {
    h = await startHarness(new FakeAi(() => { throw new Error("no AI in this test"); }), { env: { JH_DEMO_PROFILE: "0" } });
    s = await login(h);
    const userId = (await h.repo.findUser("local"))!.id;
    const roles = new RolesRepo(h.pool);
    await roles.seedCatalog();
    const cat = await roles.getCatalog();
    const jobs = new JobsRepo(h.pool);
    const ctx = { repo: jobs, userId, catalogRoles: cat.roles, catalogVersion: cat.catalogVersion, roleSlugs: ["soc-analyst"], boards: BOARDS.companies };
    const { runId } = await createLiveImportRun(ctx, ["greenhouse:acmesec"]);
    const body = ghBody("acmesec", [{ id: 1001, title: "SOC Analyst I", location: "Austin, TX", html: longJd("Requirements: Experience with Splunk. Must be a US citizen.") }]);
    const runner = new DiscoveryRunner({ repo: jobs, boards: () => BOARDS, fetchImpl: fakeBoardFetch({ acmesec: { body } }), delayMs: 0 });
    runner.enqueue(runId);
    await runner.idle();
    jobId = (await h.pool.query("SELECT id FROM jobs WHERE ats_identity='greenhouse:acmesec:1001'")).rows[0].id as string;
  }, 90_000);
  afterAll(async () => {
    await h.close().catch(() => undefined);
    await h.dropDatabase().catch(() => undefined);
  }, 60_000);

  const get = (url: string, session: Session | null = s) => h.app.inject({ method: "GET", url, headers: session ? authHeaders(session) : { host: HOST, origin: ORIGIN } });
  const post = (url: string, payload: unknown, headers = authHeaders(s)) => h.app.inject({ method: "POST", url, headers: { ...headers, "content-type": "application/json" }, payload: payload as never });

  it("requires a session", async () => {
    expect((await get("/api/v1/matches", null)).statusCode).toBe(401);
    expect((await get(`/api/v1/jobs/${jobId}/match`, null)).statusCode).toBe(401);
  });

  it("lists stored postings with no match yet, then computes, then reuses", async () => {
    const before = (await get("/api/v1/matches")).json();
    expect(before.disclaimer).toMatch(/not a hiring prediction/i);
    expect(before.jobs[0]).toMatchObject({ jobId, match: null });
    expect((await get(`/api/v1/jobs/${jobId}/match`)).json()).toMatchObject({ match: null, current: false });

    const first = await post(`/api/v1/jobs/${jobId}/match`, {});
    expect(first.statusCode).toBe(201);
    const m = first.json();
    expect(m).toMatchObject({ computed: true, match: { status: "COMPLETE" } });
    // The S4 evidence report still has no numeric score; M4's separate ordering heuristic is explicitly labeled.
    expect(JSON.stringify(m.match.report)).not.toMatch(/"(?:score|percent|probability|rank(?:ing)?Score|matchScore)"/i);
    expect(m.match.decision).toMatchObject({ outcome: "REVIEW_REQUIRED", hardReject: false });
    expect(m.match.decision.ranking.normalization).toMatch(/not a hiring probability/i);
    const second = await post(`/api/v1/jobs/${jobId}/match`, {});
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ computed: false, match: { id: m.match.id } });

    const list = (await get("/api/v1/matches")).json();
    expect(list.jobs[0].match).toMatchObject({ id: m.match.id, current: true });
    expect((await get("/api/v1/shortlist")).json().jobs).toEqual([]);
    const eligibility = (m.match.report.conditions as Array<{ type: string }>).map((c) => c.type);
    expect(eligibility.length).toBeGreaterThan(0);
  });

  it("with no approved evidence nothing is reported as supported", async () => {
    const r = (await get(`/api/v1/jobs/${jobId}/match`)).json().match.report;
    expect(r.evidence.unitsSearched).toBe(0);
    expect((r.requirements as Array<{ status: string }>).every((q) => q.status !== "SUPPORTED")).toBe(true);
  });

  it("rejects bad ids, a missing CSRF token and an unknown match", async () => {
    expect((await get("/api/v1/jobs/not-a-uuid/match")).statusCode).toBe(404);
    expect((await get("/api/v1/jobs/00000000-0000-4000-8000-000000000000/match")).statusCode).toBe(404);
    const noCsrf = { host: HOST, origin: ORIGIN, cookie: s.cookie };
    expect((await post(`/api/v1/jobs/${jobId}/match`, {}, noCsrf)).statusCode).toBe(403);
    expect((await post("/api/v1/matches/00000000-0000-4000-8000-000000000000/flags", { requirementId: "r1", note: "wrong" })).statusCode).toBe(404);
  });

  it("records an incorrect-interpretation flag without changing the report", async () => {
    const got = (await get(`/api/v1/jobs/${jobId}/match`)).json();
    const before = JSON.stringify(got.match.report);
    const reqId = got.match.report.requirements[0].requirementId as string;
    const bad = await post(`/api/v1/matches/${got.match.id}/flags`, { requirementId: reqId, note: "x" });
    expect(bad.statusCode).toBe(400); // too short
    const ok = await post(`/api/v1/matches/${got.match.id}/flags`, { requirementId: reqId, note: "This is a preference, not a requirement." });
    expect(ok.statusCode).toBe(201);
    expect(JSON.stringify((await get(`/api/v1/jobs/${jobId}/match`)).json().match.report)).toBe(before);
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_flags")).rows[0].n)).toBe(1);
  });
});

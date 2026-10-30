import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRepo } from "../../src/db/jobs-repo.js";
import { createPool, pgSettingsFromEnv } from "../../src/db/pool.js";
import { ProfileRepo } from "../../src/db/profile-repo.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { createLiveImportRun } from "../../src/jobs/import.js";
import { DiscoveryRunner } from "../../src/jobs/runner.js";
import { MatchStore } from "../../src/match/store.js";
import { BOARDS, fakeBoardFetch, ghBody } from "../helpers/s3-fixtures.js";
import { FakeAi, authHeaders, dbAvailable, docxBytes, login, postJson, sampleResponse, startHarness, upload, type Harness, type Session } from "../helpers/s1-harness.js";

const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const jd = (skill: string) => `<p>Acme Security seeks a SOC Analyst to investigate alerts and document incidents for customers. Our team provides detection and response across modern environments.</p><h2>Minimum Qualifications</h2><ul><li>${skill}.</li></ul><h2>Responsibilities</h2><p>Investigate alerts, write clear reports, and collaborate with other analysts to improve response workflows.</p>`;

suite("M4 HTTP to PostgreSQL shortlist", { timeout: 60_000 }, () => {
  let h: Harness;
  let s: Session;
  let userId: string;
  let resumeId: string;
  let jobId: string;
  let runner: DiscoveryRunner;

  const collect = async (skill: string) => {
    const jobs = new JobsRepo(h.pool);
    const roles = new RolesRepo(h.pool);
    const cat = await roles.getCatalog();
    const ctx = { repo: jobs, userId, catalogRoles: cat.roles, catalogVersion: cat.catalogVersion, roleSlugs: ["soc-analyst"], boards: BOARDS.companies };
    const { runId } = await createLiveImportRun(ctx, ["greenhouse:acmesec"]);
    runner = new DiscoveryRunner({ repo: jobs, boards: () => BOARDS, fetchImpl: fakeBoardFetch({ acmesec: { body: ghBody("acmesec", [{ id: 2444, title: "SOC Analyst I", location: "Remote", html: jd(skill) }]) } }), delayMs: 0 });
    runner.enqueue(runId);
    await runner.idle();
    return jobs;
  };

  beforeAll(async () => {
    h = await startHarness(new FakeAi(() => sampleResponse()), { env: { JH_DEMO_PROFILE: "0" } });
    s = await login(h);
    userId = (await h.repo.findUser("local"))!.id;
    await new RolesRepo(h.pool).seedCatalog();
    const uploaded = await upload(h, s, docxBytes("m4-resume"), "fictional.docx");
    expect(uploaded.statusCode).toBe(202);
    resumeId = uploaded.json().resumeId as string;
    await h.queue.idle();
    const profiles = new ProfileRepo(h.pool);
    await profiles.ensureActive(userId, "personal", "Fictional M4 Candidate");
    await profiles.classify(userId, { resumeId, provenance: "personal", authorized: true, basis: "fictional owner resume for isolated test", actor: "test" });
    const python = (await h.repo.listFacts(userId, resumeId)).find((f) => f.value === "Python")!;
    await h.repo.applyReview(userId, "local", python.factId, { action: "approve", actor: "local", today: "2026-10-21", expectedDigest: python.contentDigest });
    await collect("Python");
    jobId = (await h.pool.query("SELECT id FROM jobs WHERE ats_identity='greenhouse:acmesec:2444'")).rows[0].id as string;
  }, 90_000);

  afterAll(async () => { await h.close().catch(() => undefined); await h.dropDatabase().catch(() => undefined); }, 60_000);

  it("persists a current, quoted, candidate-scoped shortlist and invalidates it after a JD update", async () => {
    const first = await postJson(h, s, `/api/v1/jobs/${jobId}/match`, {});
    expect(first.status).toBe(201);
    expect(first.body.match.decision).toMatchObject({ outcome: "SHORTLIST", hardReject: false });
    expect(first.body.match.report.requirements.some((r: { value: string; status: string }) => r.value === "Python" && r.status === "SUPPORTED")).toBe(true);
    const req = first.body.match.report.requirements.find((r: { value: string }) => r.value === "Python");
    expect(first.body.match.decision.matched[0].candidateFactIds).toContain(req.matchedFactIds[0]);
    const originalText = (await h.pool.query("SELECT description_text FROM job_revisions WHERE job_id=$1 ORDER BY first_seen_at DESC LIMIT 1", [jobId])).rows[0].description_text as string;
    expect(originalText.slice(req.jd.start, req.jd.end)).toBe(req.jd.quote);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/shortlist", headers: authHeaders(s) })).json().jobs).toHaveLength(1);
    const again = await postJson(h, s, `/api/v1/jobs/${jobId}/match`, {});
    expect(again.body).toMatchObject({ computed: false, match: { id: first.body.match.id } });

    await collect("Splunk");
    const stale = (await h.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/match`, headers: authHeaders(s) })).json();
    expect(stale.current).toBe(false);
    expect(stale.staleReasons).toContain("JD_CHANGED");
    expect((await h.app.inject({ method: "GET", url: "/api/v1/shortlist", headers: authHeaders(s) })).json().jobs).toEqual([]);
    const updated = await postJson(h, s, `/api/v1/jobs/${jobId}/match`, {});
    expect(updated.body.match.decision.outcome).toBe("REVIEW_REQUIRED"); // Splunk is still pending
    expect(updated.body.match.id).not.toBe(first.body.match.id);
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_reports WHERE user_id=$1 AND job_id=$2 AND superseded_at IS NULL", [userId, jobId])).rows[0].n)).toBe(1);
    expect(Number((await h.pool.query("SELECT count(*) n FROM jobs WHERE ats_identity='greenhouse:acmesec:2444'")).rows[0].n)).toBe(1);
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_revisions WHERE job_id=$1", [jobId])).rows[0].n)).toBe(2);
  });

  it("re-evaluates after fact approval and revocation; concurrent requests keep one live row", async () => {
    const splunk = (await h.repo.listFacts(userId, resumeId)).find((f) => f.value === "Splunk")!;
    await h.repo.applyReview(userId, "local", splunk.factId, { action: "approve", actor: "local", today: "2026-10-21", expectedDigest: splunk.contentDigest });
    const stale = (await h.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/match`, headers: authHeaders(s) })).json();
    expect(stale.current).toBe(false);
    const results = await Promise.all([postJson(h, s, `/api/v1/jobs/${jobId}/match`, {}), postJson(h, s, `/api/v1/jobs/${jobId}/match`, {})]);
    expect(results.map((r) => r.body.match.decision.outcome)).toEqual(["SHORTLIST", "SHORTLIST"]);
    expect(new Set(results.map((r) => r.body.match.id)).size).toBe(1);
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_reports WHERE user_id=$1 AND job_id=$2 AND superseded_at IS NULL", [userId, jobId])).rows[0].n)).toBe(1);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/shortlist", headers: authHeaders(s) })).json().jobs).toHaveLength(1);
    await h.pool.query("UPDATE job_observations SET verification=jsonb_set(verification, '{liveConfirmed}', 'false'::jsonb) WHERE job_id=$1", [jobId]);
    const sourceStale = (await h.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/match`, headers: authHeaders(s) })).json();
    expect(sourceStale).toMatchObject({ current: false, staleReasons: ["SOURCE_CHANGED"] });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/shortlist", headers: authHeaders(s) })).json().jobs).toEqual([]);
    expect((await postJson(h, s, `/api/v1/jobs/${jobId}/match`, {})).body.match.decision).toMatchObject({ outcome: "REVIEW_REQUIRED", sourceVerification: { liveConfirmed: false } });
    const approved = (await h.repo.listFacts(userId, resumeId)).find((f) => f.value === "Splunk")!;
    await h.repo.applyReview(userId, "local", approved.factId, { action: "reject", actor: "local", today: "2026-10-21", expectedDigest: approved.contentDigest });
    expect((await h.app.inject({ method: "GET", url: "/api/v1/shortlist", headers: authHeaders(s) })).json().jobs).toEqual([]);
    expect((await postJson(h, s, `/api/v1/jobs/${jobId}/match`, {})).body.match.decision.outcome).toBe("REVIEW_REQUIRED");
  });

  it("never exposes the candidate's shortlist to a different user or an unauthenticated caller", async () => {
    const unauth = await h.app.inject({ method: "GET", url: "/api/v1/shortlist" });
    expect(unauth.statusCode).toBe(401);
    const other = await h.pool.query("INSERT INTO users (handle) VALUES ('other-m4') RETURNING id");
    const otherId = other.rows[0].id as string;
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_reports WHERE user_id=$1", [otherId])).rows[0].n)).toBe(0);
    const store = new MatchStore({ pool: h.pool, candidates: h.repo, jobs: new JobsRepo(h.pool), encoder: null });
    expect(await store.get(otherId, jobId)).toBeNull();
    expect(await store.compute(otherId, jobId)).toBeNull();
    expect((await store.shortlist(otherId)).jobs).toEqual([]);
  });

  it("persists an extractor outage as a failed review, never a successful match", async () => {
    const broken = new MatchStore({ pool: h.pool, candidates: h.repo, jobs: new JobsRepo(h.pool), encoder: null,
      provider: () => ({ revision: "m4-test-worker-outage", extractJob: async () => { throw new Error("simulated worker outage"); } }) });
    const failed = await broken.compute(userId, jobId);
    expect(failed?.match).toMatchObject({ status: "EXTRACTION_FAILED", decision: { outcome: "REVIEW_REQUIRED", hardReject: false } });
    expect((await broken.shortlist(userId)).jobs).toEqual([]);
    const recovered = await postJson(h, s, `/api/v1/jobs/${jobId}/match`, {});
    expect(recovered.body.match).toMatchObject({ status: "COMPLETE", decision: { outcome: "REVIEW_REQUIRED" } });
  });

  it("does not acknowledge a successful evaluation when PostgreSQL is unreachable", async () => {
    const before = await h.pool.query("SELECT id, status, report, decision FROM job_match_reports WHERE user_id=$1 AND job_id=$2 AND superseded_at IS NULL", [userId, jobId]);
    const unavailable = createPool({ ...pgSettingsFromEnv(), port: 1 }, { max: 1, connectTimeoutMs: 1000 });
    try {
      const disconnected = new MatchStore({ pool: unavailable, candidates: h.repo, jobs: new JobsRepo(unavailable), encoder: null });
      await expect(disconnected.compute(userId, jobId)).rejects.toThrow();
    } finally {
      await unavailable.end();
    }
    const after = await h.pool.query("SELECT id, status, report, decision FROM job_match_reports WHERE user_id=$1 AND job_id=$2 AND superseded_at IS NULL", [userId, jobId]);
    expect(after.rows).toEqual(before.rows);
  });

  it("retrieves the same current decision after API restart", async () => {
    const before = (await h.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/match`, headers: authHeaders(s) })).json();
    const oldId = before.match.id;
    h = await h.restart();
    s = await login(h);
    const after = (await h.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/match`, headers: authHeaders(s) })).json();
    expect(after).toMatchObject({ current: true, match: { id: oldId, decision: { outcome: "REVIEW_REQUIRED" } } });
  });
});

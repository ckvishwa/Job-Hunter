import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRepo } from "../../src/db/jobs-repo.js";
import { ProfileRepo } from "../../src/db/profile-repo.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { checkSavedPosting, createLiveImportRun, importPlan, type ImportContext } from "../../src/jobs/import.js";
import { DiscoveryRunner } from "../../src/jobs/runner.js";
import { postingFromStoredJob } from "../../src/match/jd-source.js";
import { MatchStore } from "../../src/match/store.js";
import { PgEmbeddingCache, pruneEmbeddingCache } from "../../src/match/embedding-cache.js";
import { BOARDS, fakeBoardFetch, ghBody, longJd, type BoardReply } from "../helpers/s3-fixtures.js";
import { FakeAi, dbAvailable, startHarness, type Harness } from "../helpers/s1-harness.js";

// S3 -> S4 on a throwaway PostgreSQL database. Boards are answered by a fake fetch: no employer is contacted.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const SLUGS = ["soc-analyst", "incident-response-analyst"];

suite("persisted jobs and versioned matches", { timeout: 60_000 }, () => {
  let h: Harness;
  let userId: string;
  let jobs: JobsRepo;
  let store: MatchStore;
  let ctx: ImportContext;
  let jd1001 = longJd("Requirements: 2+ years of experience in a security operations center. Experience with Splunk.");
  const replies = (): Record<string, BoardReply> => ({
    acmesec: { body: ghBody("acmesec", [{ id: 1001, title: "SOC Analyst I", location: "Austin, TX", html: jd1001 }, { id: 1003, title: "Software Engineer", location: "Austin, TX" }]) },
  });
  const liveImport = async () => {
    const { runId } = await createLiveImportRun(ctx, ["greenhouse:acmesec"]);
    const runner = new DiscoveryRunner({ repo: jobs, boards: () => BOARDS, fetchImpl: fakeBoardFetch(replies()), delayMs: 0 });
    runner.enqueue(runId);
    await runner.idle();
    return runId;
  };
  const counts = async () => ({
    jobs: Number((await h.pool.query("SELECT count(*) n FROM jobs")).rows[0].n),
    revisions: Number((await h.pool.query("SELECT count(*) n FROM job_revisions")).rows[0].n),
  });
  const jobId = async () => (await h.pool.query("SELECT id FROM jobs WHERE ats_identity='greenhouse:acmesec:1001'")).rows[0].id as string;

  beforeAll(async () => {
    h = await startHarness(new FakeAi(() => { throw new Error("no AI in this test"); }), { env: { JH_DEMO_PROFILE: "0" } });
    userId = (await h.repo.findUser("local"))!.id;
    const roles = new RolesRepo(h.pool);
    await roles.seedCatalog();
    const cat = await roles.getCatalog();
    jobs = new JobsRepo(h.pool);
    store = new MatchStore({ pool: h.pool, candidates: h.repo, jobs, encoder: null });
    ctx = { repo: jobs, userId, catalogRoles: cat.roles, catalogVersion: cat.catalogVersion, roleSlugs: SLUGS, boards: BOARDS.companies };
  }, 90_000);
  afterAll(async () => {
    await h.close().catch(() => undefined);
    await h.dropDatabase().catch(() => undefined);
  }, 60_000);

  it("an import run stores only matched, verified postings and a rerun creates no duplicates", async () => {
    const runId = await liveImport();
    const run = await jobs.getRun(userId, runId);
    expect(run?.status).toBe("COMPLETED");
    expect((await h.pool.query("SELECT run_kind, selection_revision_no FROM discovery_runs WHERE id=$1", [runId])).rows[0]).toEqual({ run_kind: "import", selection_revision_no: 0 });
    const first = await counts();
    expect(first).toEqual({ jobs: 1, revisions: 1 }); // "Software Engineer" matches no requested role
    await liveImport();
    expect(await counts()).toEqual(first);
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_observations")).rows[0].n)).toBe(2); // one observation per run, still one posting
  });

  it("a normal discovery run still needs a saved selection revision", async () => {
    await expect(h.pool.query("INSERT INTO discovery_runs (user_id, status, selection_revision_no, catalog_version, snapshot, limits, boards_total) VALUES ($1,'QUEUED',0,1,'{}','{}',0)", [userId])).rejects.toThrow(/discovery_runs_selection_rev_check/);
  });

  it("the offline re-check rejects a missing observation, a tampered JD and an unknown board", async () => {
    const stored = await jobs.getJob(userId, await jobId());
    const base = postingFromStoredJob(stored!);
    const plan = importPlan(ctx);
    const now = new Date().toISOString();
    expect(checkSavedPosting(base, ctx.boards, plan, now).ok).toBe(false); // no recorded observation to re-verify
    expect(checkSavedPosting({ ...base, descriptionText: base.descriptionText + " tampered" }, ctx.boards, plan, now).ok).toBe(false);
    expect(checkSavedPosting({ ...base, atsIdentity: "greenhouse:unknownco:1" }, ctx.boards, plan, now).ok).toBe(false);
  });

  it("computes once, reuses on identical inputs, and supersedes when the JD changes", async () => {
    const id = await jobId();
    const first = await store.compute(userId, id);
    expect(first).toMatchObject({ computed: true, superseded: null });
    expect(first!.match.report.status).toBe("COMPLETE");
    const again = await store.compute(userId, id);
    expect(again).toMatchObject({ computed: false });
    expect(again!.match.id).toBe(first!.match.id);
    expect((await store.get(userId, id))!.current).toBe(true);

    jd1001 = longJd("Requirements: 3+ years of experience with Splunk and Python. Must be a US citizen.");
    await liveImport();
    const stale = await store.get(userId, id);
    expect(stale).toMatchObject({ current: false, staleReasons: ["JD_CHANGED"] });
    const next = await store.compute(userId, id);
    expect(next).toMatchObject({ computed: true });
    expect(next!.superseded!.id).toBe(first!.match.id);
    const rows = (await h.pool.query("SELECT superseded_at, superseded_reason FROM job_match_reports WHERE job_id=$1 ORDER BY created_at", [id])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].superseded_reason).toBe("JD_CHANGED");
    expect(rows[1].superseded_at).toBeNull();
    expect((await counts()).revisions).toBe(2);
  });

  it("another user cannot read, compute or flag a match", async () => {
    const id = await jobId();
    const other = (await h.pool.query("INSERT INTO users (handle) VALUES ('stranger') RETURNING id")).rows[0].id as string;
    expect(await store.get(other, id)).toBeNull();
    expect(await store.compute(other, id)).toBeNull();
    const mine = (await store.liveRow(userId, id))!;
    expect(await store.flag(other, mine.id, "r1", "wrong reading")).toBeNull();
    expect(await store.flag(userId, mine.id, "r1", "wrong reading")).toMatchObject({ id: expect.any(String) });
    expect(Number((await h.pool.query("SELECT count(*) n FROM job_match_flags")).rows[0].n)).toBe(1);
  });

  it("the embedding cache is keyed by fact digest and encoder, and pruning removes vectors for withdrawn evidence", async () => {
    const profileId = (await new ProfileRepo(h.pool).ensureActive(userId, "personal", "Casey")).profile.id;
    const enc = { modelId: "m", modelRevision: "1", preprocess: "p" };
    const unit = { unitId: "u1", text: "Splunk", verification: { contentDigest: "d1" } } as never;
    const cache = new PgEmbeddingCache(h.pool, { userId, profileId }, enc);
    expect(await cache.get(unit)).toBeNull();
    await cache.put(unit, [0.5, 0.25]);
    expect(await cache.get(unit)).toEqual([0.5, 0.25]);
    expect(await new PgEmbeddingCache(h.pool, { userId, profileId }, { ...enc, modelRevision: "2" }).get(unit)).toBeNull();
    expect(await cache.get({ unitId: "u1", text: "Splunk", verification: { contentDigest: "d2" } } as never)).toBeNull();
    expect(await pruneEmbeddingCache(h.pool, userId, profileId, [], enc)).toBe(1);
    expect(await cache.get(unit)).toBeNull();
  });
});

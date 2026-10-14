import { readFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobsRepo, JobsRuleError } from "../../src/db/jobs-repo.js";
import { migrate } from "../../src/db/migrate.js";
import { createPool, pgSettingsFromEnv } from "../../src/db/pool.js";
import { FakeAi, HOST, ORIGIN, dbAvailable, getJson, login, postJson, startHarness, type Harness, type Session } from "../helpers/s1-harness.js";
import { ACME_JOBS, BOARDS, DEFAULT_REPLIES, fakeBoardFetch, ghBody, longJd, type BoardReply } from "../helpers/s3-fixtures.js";

// S3 integration: real Fastify app + real PostgreSQL (throwaway database) + the REAL official-board reader, employer verification and
// JD gate, with only the HTTP fetch to the public board APIs replaced by synthetic Greenhouse/Lever payloads. Every employer, board
// and posting is invented. Expected counts were worked out by hand from the fixtures in tests/helpers/s3-fixtures.ts.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

suite("S3 official discovery API (PostgreSQL)", { timeout: 30_000 }, () => {
  let replies: Record<string, BoardReply> = { ...DEFAULT_REPLIES };
  let fetchCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const f = fakeBoardFetch(replies);
    const out = await f(input, init);
    fetchCalls.push(...f.calls);
    return out;
  }) as typeof fetch;
  let h: Harness;
  let s: Session;
  const owned: Harness[] = [];
  let boardsConfig: typeof BOARDS | null = BOARDS;

  const start = async () => {
    const x = await startHarness(new FakeAi(), { serverDeps: { boards: () => boardsConfig, runnerOptions: { fetchImpl, delayMs: 0 } } });
    owned.push(x);
    return x;
  };

  beforeAll(async () => {
    h = await start();
    s = await login(h);
  }, 60_000);

  afterAll(async () => {
    for (const x of owned) {
      await x.close().catch(() => undefined);
      await x.dropDatabase().catch(() => undefined);
    }
  }, 60_000);

  const api = {
    get: (url: string) => getJson(h, s, url),
    post: (url: string, body: unknown) => postJson(h, s, url, body),
  };
  const count = async (sql: string) => Number((await h.pool.query(sql)).rows[0].n);
  const wait = async (runId: string, timeoutMs = 20_000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const run = (await api.get(`/api/v1/discovery-runs/${runId}`)).body;
      if (!["QUEUED", "RUNNING"].includes(run.status)) return run;
      if (Date.now() > end) throw new Error(`run ${runId} still ${run.status}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const saveSelection = async (over: Record<string, unknown> = {}, expectedRevision = 0) => {
    const catalog = (await api.get("/api/v1/roles/catalog")).body;
    return api.post("/api/v1/roles/selections", {
      expectedRevision, expectedCatalogVersion: catalog.catalogVersion, targetFamilies: ["soc-blue-team"], roleSlugs: ["soc-analyst"],
      locations: [{ kind: "country", value: "United States" }, { kind: "remote", value: "Remote" }], workModes: ["remote"], seniorityLevels: ["entry", "junior"],
      searchBand: { minYears: 0, maxYears: 5 }, ...over,
    });
  };
  const startRun = (revision: number, extra: Record<string, unknown> = {}) => api.post("/api/v1/discovery-runs", { expectedSelectionRevision: revision, ...extra });

  // --- protection ------------------------------------------------------------------------------------------------------------

  describe("authentication and request protection", () => {
    it("every discovery route needs a session", async () => {
      const id = "11111111-1111-4111-8111-111111111111";
      for (const [method, url] of [
        ["GET", "/api/v1/discovery/overview"], ["POST", "/api/v1/discovery-runs"], ["GET", "/api/v1/discovery-runs"], ["GET", `/api/v1/discovery-runs/${id}`],
        ["POST", `/api/v1/discovery-runs/${id}/cancel`], ["GET", "/api/v1/jobs"], ["GET", `/api/v1/jobs/${id}`],
      ] as const) {
        const res = await h.app.inject({ method, url, headers: { host: HOST, origin: ORIGIN }, payload: method === "GET" ? undefined : {} });
        expect([res.statusCode, url]).toEqual([401, url]);
      }
    });

    it("starting or cancelling a run needs a trusted Origin and the CSRF token", async () => {
      const base = { host: HOST, cookie: s.cookie, "content-type": "application/json" };
      for (const url of ["/api/v1/discovery-runs", "/api/v1/discovery-runs/11111111-1111-4111-8111-111111111111/cancel"]) {
        const noCsrf = await h.app.inject({ method: "POST", url, headers: { ...base, origin: ORIGIN }, payload: {} });
        const evil = await h.app.inject({ method: "POST", url, headers: { ...base, origin: "https://evil.example.com", "x-csrf-token": s.csrf }, payload: {} });
        expect([noCsrf.json().error.code, evil.json().error.code], url).toEqual(["BAD_CSRF", "BAD_ORIGIN"]);
      }
    });
  });

  // --- planning -------------------------------------------------------------------------------------------------------------------

  describe("selection-driven planning", () => {
    it("cannot start without a saved selection, and the overview says why", async () => {
      const overview = (await api.get("/api/v1/discovery/overview")).body;
      expect(overview.planError.code).toBe("NO_SELECTION");
      expect(overview.boardsConfigured).toBe(true);
      expect(overview.boards).toHaveLength(5);
      const res = await startRun(1);
      expect([res.status, res.body.error.code]).toEqual([422, "NO_SELECTION"]);
      expect(await count("SELECT count(*) AS n FROM discovery_runs")).toBe(0);
    });

    it("rejects an unknown or stale selection revision and never searches", async () => {
      expect((await saveSelection()).status).toBe(200);
      const stale = await startRun(7);
      expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_SELECTION"]);
      expect(await count("SELECT count(*) AS n FROM discovery_runs")).toBe(0);
      expect(fetchCalls).toEqual([]); // nothing was requested from any employer
    });

    it("rejects unknown boards, a body with extra fields, and a missing board list", async () => {
      expect((await startRun(1, { boardKeys: ["greenhouse:not-configured"] })).body.error.code).toBe("UNKNOWN_BOARD");
      expect((await startRun(1, { surprise: true })).body.error.code).toBe("INVALID_REQUEST");
      boardsConfig = null;
      expect((await startRun(1)).body.error.code).toBe("NO_BOARDS");
      boardsConfig = BOARDS;
      expect(await count("SELECT count(*) AS n FROM discovery_runs")).toBe(0);
    });
  });

  // --- a full run -------------------------------------------------------------------------------------------------------------------

  describe("a run over synthetic official boards", () => {
    let run1: any;

    it("stores verified postings for the SELECTED role only, and reports every count and failure truthfully", async () => {
      fetchCalls = [];
      const res = await startRun(1);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: "QUEUED", boards: 5, selectionRevision: 1 });
      run1 = await wait(res.body.runId);
      expect(run1.status).toBe("PARTIAL"); // two boards failed, three worked
      expect(run1.progress).toMatchObject({
        boardsTotal: 5, boardsDone: 5, fetched: 9, titleMatched: 6, seniorityExcluded: 1, locationExcluded: 0, verified: 5, newJobs: 5, changedJd: 0, unchanged: 0, duplicates: 0, rejected: 0,
      });
      const board = (key: string) => run1.boards.find((b: any) => b.boardKey === key);
      expect(board("greenhouse:acmesec")).toMatchObject({ status: "OK", fetched: 6, titleMatched: 4, seniorityExcluded: 1, stored: 3 });
      expect(board("greenhouse:globexcyber")).toMatchObject({ status: "OK", fetched: 2, titleMatched: 1, stored: 1 });
      expect(board("lever:leverlabs")).toMatchObject({ status: "OK", fetched: 1, titleMatched: 1, stored: 1 });
      expect(board("greenhouse:blockedco")).toMatchObject({ status: "FAILED", failureCode: "BOARD_FETCH_FAILED", blocked: true, retryable: true });
      expect(board("greenhouse:goneinc")).toMatchObject({ status: "FAILED", failureCode: "BOARD_NOT_FOUND", blocked: false, retryable: false });
      expect(run1.failures.map((f: any) => [f.boardKey, f.code, f.stage]).sort()).toEqual([["greenhouse:blockedco", "BOARD_FETCH_FAILED", "search"], ["greenhouse:goneinc", "BOARD_NOT_FOUND", "search"]]);
      // the plan that drove it is frozen on the run
      expect(run1.snapshot.roles.map((r: any) => r.roleSlug)).toEqual(["soc-analyst"]);
      expect(run1.selectionRevisionNo).toBe(1);
    });

    it("only reads official board APIs with GET: no form, no apply URL, no submission", () => {
      expect(fetchCalls.length).toBeGreaterThan(0);
      for (const call of fetchCalls) {
        expect(call).toMatch(/^GET https:\/\/(boards-api\.greenhouse\.io\/v1\/boards\/|api\.lever\.co\/v0\/postings\/)/);
      }
      expect(fetchCalls.some((c) => /apply|submit/i.test(c))).toBe(false);
    });

    it("never stored a posting for an unselected role, a seniority-excluded title or an unrelated title", async () => {
      const titles = (await h.pool.query("SELECT title FROM jobs")).rows.map((r) => r.title as string).sort();
      expect(titles).toEqual(["Cybersecurity Analyst", "SOC Analyst", "SOC Analyst I", "Security Monitoring Analyst", "Security Operations Center Analyst"]);
    });

    it("lists verified listings with the official URL, source, timestamps and honest flags, and filters them", async () => {
      const list = (await api.get("/api/v1/jobs")).body;
      expect(list.total).toBe(5);
      expect(list.disclaimer).toMatch(/not matches, scores or eligibility decisions/);
      const acme1 = list.jobs.find((j: any) => j.requisitionId === "1001");
      expect(acme1).toMatchObject({
        company: "Acme Security", title: "SOC Analyst I", officialUrl: "https://boards.greenhouse.io/acmesec/jobs/1001", atsIdentity: "greenhouse:acmesec:1001",
        matchedRoles: ["soc-analyst"], locationStatus: "MATCH", bandStatus: "WITHIN", statedYears: 2, sourceKind: "board-api",
      });
      expect(acme1.yearsQuote).toContain("2+ years");
      expect(new Date(acme1.observedAt).getTime()).toBeGreaterThan(0);
      expect(acme1.verification).toMatchObject({ method: "official-board-api", employerMatchedBoard: true, jdGate: "passed" });
      // the 7+ years posting is kept and flagged, not dropped
      expect((await api.get("/api/v1/jobs?bandStatus=OUTSIDE")).body.jobs.map((j: any) => j.requisitionId)).toEqual(["1006"]);
      expect((await api.get("/api/v1/jobs?bandStatus=WITHIN")).body.total).toBe(1);
      expect((await api.get("/api/v1/jobs?bandStatus=UNSTATED")).body.total).toBe(3);
      expect((await api.get("/api/v1/jobs?company=acme")).body.total).toBe(3);
      expect((await api.get("/api/v1/jobs?location=new york")).body.total).toBe(1);
      expect((await api.get("/api/v1/jobs?role=soc-analyst&q=monitoring")).body.total).toBe(1);
      expect((await api.get("/api/v1/jobs?role=sdet")).body.total).toBe(0);
      expect((await api.get(`/api/v1/jobs?runId=${run1.runId}&limit=2`)).body.jobs).toHaveLength(2);
      expect((await api.get("/api/v1/jobs?limit=500")).body.error.code).toBe("INVALID_REQUEST");
    });

    it("never presents an eligibility, match score or application field", async () => {
      const list = (await api.get("/api/v1/jobs")).body;
      const keys = new Set(list.jobs.flatMap((j: any) => Object.keys(j)));
      for (const k of keys) expect(String(k), String(k)).not.toMatch(/eligib|score|percent|fit|apply|salary/i);
      const detail = (await api.get(`/api/v1/jobs/${list.jobs[0].jobId}`)).body;
      expect(JSON.stringify(detail.job)).not.toMatch(/applyUrl|apply\/|eligib|salary/i);
    });

    it("returns the full JD, revisions and observations of one job", async () => {
      const list = (await api.get("/api/v1/jobs?q=SOC Analyst I")).body;
      const id = list.jobs.find((j: any) => j.requisitionId === "1001").jobId;
      const { job } = (await api.get(`/api/v1/jobs/${id}`)).body;
      expect(job.currentRevision.descriptionText).toContain("2+ years of experience");
      expect(job.currentRevision.jdSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(job.revisions).toHaveLength(1);
      expect(job.observations).toHaveLength(1);
      expect(job.observations[0].finalUrl).toBe("https://boards.greenhouse.io/acmesec/jobs/1001");
    });

    it("rejects malformed ids and unknown runs and jobs without leaking", async () => {
      for (const url of ["/api/v1/jobs/not-a-uuid", "/api/v1/jobs/22222222-2222-4222-8222-222222222222", "/api/v1/discovery-runs/nope", "/api/v1/discovery-runs/22222222-2222-4222-8222-222222222222"]) {
        const res = await api.get(url);
        expect([res.status, url]).toEqual([404, url]);
      }
    });
  });

  // --- identity, revisions, idempotence ----------------------------------------------------------------------------------------------

  describe("stable identity, JD revisions and reruns", () => {
    it("a rerun creates no duplicate job or revision and counts everything as unchanged", async () => {
      const run = await wait((await startRun(1)).body.runId);
      expect(run.progress).toMatchObject({ newJobs: 0, changedJd: 0, unchanged: 5, verified: 5, duplicates: 0 });
      expect(await count("SELECT count(*) AS n FROM jobs")).toBe(5);
      expect(await count("SELECT count(*) AS n FROM job_revisions")).toBe(5);
      expect(await count("SELECT count(*) AS n FROM job_observations")).toBe(10); // one per run per job
      expect(await count("SELECT count(*) AS n FROM (SELECT ats_identity FROM jobs GROUP BY 1 HAVING count(*) > 1) d")).toBe(0);
    });

    it("a changed JD is a NEW immutable revision of the SAME job; the old text is preserved", async () => {
      const changed = ACME_JOBS.map((j) => (j.id === 1001 ? { ...j, html: longJd("Requirements: 2+ years of experience. Updated: night-shift rotation added.") } : j));
      replies = { ...DEFAULT_REPLIES, acmesec: { body: ghBody("acmesec", changed) } };
      const run = await wait((await startRun(1)).body.runId);
      expect(run.progress).toMatchObject({ newJobs: 0, changedJd: 1, unchanged: 4 });
      expect(await count("SELECT count(*) AS n FROM jobs")).toBe(5);
      const rows = (await h.pool.query(
        "SELECT v.description_text, v.id = j.current_revision_id AS is_current FROM jobs j JOIN job_revisions v ON v.job_id = j.id WHERE j.ats_identity = 'greenhouse:acmesec:1001' ORDER BY v.first_seen_at")).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0].is_current).toBe(false);
      expect(rows[1].is_current).toBe(true);
      expect(rows[0].description_text).not.toContain("night-shift");
      expect(rows[1].description_text).toContain("night-shift");
      await expect(h.pool.query("UPDATE job_revisions SET description_text = 'tampered'")).rejects.toThrow(); // revisions are immutable
      replies = { ...DEFAULT_REPLIES };
    });

    it("a requisition listed twice in one payload is stored once and counted as a duplicate", async () => {
      replies = { ...DEFAULT_REPLIES, acmesec: { body: ghBody("acmesec", [...ACME_JOBS, ACME_JOBS[0]!]) } };
      const run = await wait((await startRun(1, { boardKeys: ["greenhouse:acmesec"] })).body.runId);
      expect(run.progress.duplicates).toBe(1);
      expect(await count("SELECT count(*) AS n FROM jobs")).toBe(5);
      replies = { ...DEFAULT_REPLIES };
    });
  });

  // --- concurrency and cancellation -----------------------------------------------------------------------------------------------------

  describe("one active run, cancellation and stale selections", () => {
    it("allows exactly one run in progress and cancels it without late writes", async () => {
      replies = Object.fromEntries(Object.entries(DEFAULT_REPLIES).map(([k, v]) => [k, { ...(v as object), delayMs: 400 }]));
      const [a, b] = await Promise.all([startRun(1), startRun(1)]);
      const codes = [a.status, b.status].sort();
      expect(codes, `bodies: ${JSON.stringify([a.body, b.body]).slice(0, 600)}`).toEqual([202, 409]);
      const loser = a.status === 409 ? a : b;
      const winner = a.status === 202 ? a : b;
      expect(loser.body.error.code).toBe("RUN_IN_PROGRESS");
      expect(loser.body.runId).toBe(winner.body.runId);
      const cancel = await api.post(`/api/v1/discovery-runs/${winner.body.runId}/cancel`, {});
      expect([cancel.status, cancel.body.status]).toEqual([200, "CANCELLED"]);
      await new Promise((r) => setTimeout(r, 1500));
      const run = (await api.get(`/api/v1/discovery-runs/${winner.body.runId}`)).body;
      expect(run.status).toBe("CANCELLED");
      expect(run.boards.every((x: any) => ["OK", "SKIPPED", "FAILED"].includes(x.status))).toBe(true);
      expect((await api.post(`/api/v1/discovery-runs/${winner.body.runId}/cancel`, {})).body.error.code).toBe("RUN_NOT_ACTIVE");
      replies = { ...DEFAULT_REPLIES };
    });

    it("a selection edited after the page loaded is a conflict, and the new selection drives the next run", async () => {
      const saved = await saveSelection({ roleSlugs: ["incident-response-analyst", "soc-analyst"], targetFamilies: ["incident-response-dfir", "soc-blue-team"] }, 1);
      expect(saved.body.selection.revisionNo).toBe(2);
      const stale = await startRun(1);
      expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_SELECTION"]);
      const run = await wait((await startRun(2, { boardKeys: ["greenhouse:acmesec"] })).body.runId);
      expect(run.snapshot.roles.map((r: any) => r.roleSlug)).toEqual(["incident-response-analyst", "soc-analyst"]);
      expect(run.selectionRevisionNo).toBe(2);
      // "Incident Response Analyst, London, UK" matches a now-selected role but lies outside the selected places: counted, never stored
      expect(run.progress.locationExcluded).toBe(1);
      expect(await count("SELECT count(*) AS n FROM jobs WHERE title = 'Incident Response Analyst'")).toBe(0);
    });
  });

  // --- ownership -----------------------------------------------------------------------------------------------------------------------------

  describe("ownership", () => {
    it("another user sees none of these runs, jobs or failures", async () => {
      const other = await h.repo.ensureUser("someone-else");
      const repo = new JobsRepo(h.pool);
      const anyJob = (await h.pool.query("SELECT id FROM jobs LIMIT 1")).rows[0].id as string;
      const anyRun = (await h.pool.query("SELECT id FROM discovery_runs LIMIT 1")).rows[0].id as string;
      expect((await repo.listJobs(other.id)).total).toBe(0);
      expect(await repo.getJob(other.id, anyJob)).toBeNull();
      expect(await repo.getRun(other.id, anyRun)).toBeNull();
      expect(await repo.listRuns(other.id)).toEqual([]);
      await expect(repo.cancelRun(other.id, anyRun)).rejects.toBeInstanceOf(JobsRuleError);
    });
  });

  // --- crash recovery -----------------------------------------------------------------------------------------------------------------------------

  describe("restart recovery", () => {
    it("a run left active by a stopped API resumes its pending boards and ends truthful, without duplicate records", async () => {
      replies = { ...DEFAULT_REPLIES, globexcyber: { hang: true } };
      const started = await startRun(2, { boardKeys: ["greenhouse:acmesec", "greenhouse:globexcyber"] });
      const runId = started.body.runId as string;
      // acmesec finishes; globexcyber hangs. Aborting the runner (not the API cancel) leaves the run RUNNING, exactly like a crash.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const r = (await api.get(`/api/v1/discovery-runs/${runId}`)).body;
        if (r.boards.find((b: any) => b.boardKey === "greenhouse:acmesec").status === "OK" && r.boards.find((b: any) => b.boardKey === "greenhouse:globexcyber").status === "RUNNING") break;
        if (Date.now() > deadline) throw new Error("run did not reach the hanging board");
        await new Promise((r2) => setTimeout(r2, 100));
      }
      h.app.discoveryRunner.cancel(runId);
      await new Promise((r) => setTimeout(r, 300));
      expect((await api.get(`/api/v1/discovery-runs/${runId}`)).body.status).toBe("RUNNING");
      const jobsBefore = await count("SELECT count(*) AS n FROM jobs");

      replies = { ...DEFAULT_REPLIES };
      const restarted = await h.restart();
      owned.push(restarted);
      h = restarted;
      s = await login(h);
      expect(await h.app.discoveryRunner.recover()).toBe(1);
      const run = await wait(runId);
      expect(run.status).toBe("COMPLETED");
      expect(run.boards.map((b: any) => b.status)).toEqual(["OK", "OK"]);
      expect(await count("SELECT count(*) AS n FROM jobs")).toBe(jobsBefore); // nothing new: Globex's posting was already known from earlier runs
      expect(await count(`SELECT count(*) AS n FROM (SELECT run_id, job_id FROM job_observations WHERE run_id = '${runId}' GROUP BY 1,2 HAVING count(*) > 1) d`)).toBe(0);
    });
  });
});

// --- migration and rollback on a disposable database ------------------------------------------------------------------------------------------

suite("S3 migration 0003 and its rollback", { timeout: 60_000 }, () => {
  it("applies on top of S1+S2, rolls back without touching their data, and re-applies", async () => {
    const dbName = `jh_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const admin = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1, connectTimeoutMs: 30_000 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const pool = createPool(pgSettingsFromEnv(process.env, dbName), { max: 2, connectTimeoutMs: 30_000 });
    try {
      const first = await migrate(pool);
      expect(first.applied).toEqual(["0001_s1_candidate", "0002_s2_roles", "0003_s3_discovery", "0004_profile_boundary", "0005_s4b_matching", "0006_ml_engine", "0007_ml_pairs_registry", "0008_llm_labels", "0009_llm_reject_ledger", "0010_ml_evidence_integrity", "0011_ml_final_eval_claims"]);
      expect((await migrate(pool)).alreadyApplied).toHaveLength(11); // idempotent
      const tables = async () => (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).rows.map((r) => r.table_name as string);
      const s3Tables = ["discovery_failures", "discovery_run_boards", "discovery_runs", "job_observations", "job_revisions", "jobs"];
      expect(await tables()).toEqual(expect.arrayContaining(s3Tables));

      await pool.query("INSERT INTO users (handle) VALUES ('rollback-check')");
      const before = Number((await pool.query("SELECT count(*) AS n FROM users")).rows[0].n);

      // Rollback runs newest first: 0005 (match reports reference the job tables) goes before 0003.
      for (const file of ["0005_s4b_matching.down.sql", "0003_s3_discovery.down.sql"]) await pool.query(readFileSync(path.resolve("db", "migrations", "down", file), "utf8"));
      const after = await tables();
      for (const t of s3Tables) expect(after).not.toContain(t);
      expect(after).toEqual(expect.arrayContaining(["users", "candidate_facts", "role_catalog", "search_preferences"])); // S1/S2 intact
      expect(Number((await pool.query("SELECT count(*) AS n FROM users")).rows[0].n)).toBe(before);
      expect((await pool.query("SELECT version FROM schema_migrations ORDER BY 1")).rows.map((r) => r.version)).toEqual(["0001_s1_candidate", "0002_s2_roles", "0004_profile_boundary", "0006_ml_engine", "0007_ml_pairs_registry", "0008_llm_labels", "0009_llm_reject_ledger", "0010_ml_evidence_integrity", "0011_ml_final_eval_claims"]);

      expect((await migrate(pool)).applied).toEqual(["0003_s3_discovery", "0005_s4b_matching"]); // forward again (0005 depends on the job tables)
      expect(await tables()).toEqual(expect.arrayContaining(s3Tables));
    } finally {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});

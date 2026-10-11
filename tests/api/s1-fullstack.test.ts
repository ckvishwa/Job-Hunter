import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAiClient } from "../../src/ai/client.js";
import {
  AI_DIR, buildResumeFixtures, dbAvailable, getJson, login, postJson, pythonAvailable, startAiService, startHarness, upload,
  type AiService, type Harness, type Session,
} from "../helpers/s1-harness.js";

// FULL STACK, no fakes: real PDF/DOCX bytes -> real Fastify API -> real Python FastAPI service -> real PostgreSQL.
// The oracle is services/ai/tests/fixtures/resume_cases.json: expected facts hand-authored from the resume text, the same
// file the Python tests use. Skipped (and reported as skipped) if the S1 PostgreSQL container or the Python venv is missing.

const cases = JSON.parse(readFileSync(path.join(AI_DIR, "tests", "fixtures", "resume_cases.json"), "utf8")) as Array<{
  id: string; format: "pdf" | "docx"; expected: { facts?: Array<{ kind: string; value: string; attributes?: Record<string, unknown> }>; warningCodes?: string[]; error?: string };
}>;

const ready = (await dbAvailable()) && pythonAvailable();
const suite = ready ? describe : describe.skip;

/** Expected attributes use the Python vocabulary (`current: true`); the API stores that as an open-ended endDate: null. */
function expectedAttributes(attrs: Record<string, unknown> = {}): Record<string, unknown> {
  const { current, ...rest } = attrs;
  return current ? { ...rest, endDate: null } : rest;
}

suite("S1 full stack (real Python service)", () => {
  let service: AiService;
  let h: Harness;
  let s: Session;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = mkdtempSync(path.join(os.tmpdir(), "jh-s1-fixtures-"));
    buildResumeFixtures(fixtureDir);
    service = await startAiService();
    const ai = createAiClient({ baseUrl: `http://127.0.0.1:${service.port}`, serviceToken: service.token, timeoutMs: 60_000 });
    h = await startHarness(ai);
    s = await login(h);
  }, 120_000);

  afterAll(async () => {
    service?.stop();
    await h?.close().catch(() => undefined);
    await h?.dropDatabase().catch(() => undefined);
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  }, 60_000);

  it("has at least ten independently specified resumes in both formats", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((c) => c.format))).toEqual(new Set(["pdf", "docx"]));
    expect(readdirSync(fixtureDir).length).toBe(cases.length);
  });

  for (const c of cases) {
    it(`${c.id}: extraction matches the hand-authored oracle and persists only PENDING, source-backed facts`, async () => {
      const bytes = readFileSync(path.join(fixtureDir, `${c.id}.${c.format}`));
      const res = await upload(h, s, bytes, `${c.id}.${c.format}`);
      expect(res.statusCode).toBe(202);
      await h.queue.idle();
      const id = res.json().resumeId as string;
      const body = (await getJson(h, s, `/api/v1/resumes/${id}/facts`)).body;

      if (c.expected.error) {
        expect(body).toMatchObject({ state: "FAILED", errorCode: c.expected.error, facts: [] });
        return;
      }
      expect(body.state).toBe("PROPOSED");
      const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)])) : v);
      const key = (kind: string, value: string, attrs: unknown) => JSON.stringify([kind, value, canon(attrs)]);
      const got = body.facts.map((f: any) => key(f.kind, f.value, f.attributes)).sort();
      const want = c.expected.facts!.map((f) => key(f.kind, f.value, expectedAttributes(f.attributes))).sort();
      expect(got).toEqual(want);
      expect(body.warnings.map((w: { code: string }) => w.code).sort()).toEqual([...(c.expected.warningCodes ?? [])].sort());

      const text = (await getJson(h, s, `/api/v1/resumes/${id}/text`)).body.text as string;
      for (const f of body.facts) {
        expect(f.approvalStatus).toBe("pending");
        expect(f.verification.verifiedBy).toBeNull();
        expect(text.slice(f.span.start, f.span.end)).toBe(f.span.quote); // JS UTF-16 slice
        expect(["citizenship", "clearance", "work_authorization", "sponsorship_need"]).not.toContain(f.kind);
        if (["email", "phone", "legal_name"].includes(f.kind)) expect(f.sensitivity).toBe("sensitive");
        expect(f.attributes.employmentType === undefined || ["internship", "professional", "academic", "volunteer"].includes(f.attributes.employmentType)).toBe(true);
      }
    }, 60_000);
  }

  it("re-uploading every fixture changes nothing: same resume ids, same facts, no duplicates", async () => {
    const before = (await getJson(h, s, "/api/v1/resumes")).body.resumes as Array<{ resumeId: string; counts: Record<string, number> }>;
    expect(before.length).toBe(cases.length);
    for (const c of cases) {
      const res = await upload(h, s, readFileSync(path.join(fixtureDir, `${c.id}.${c.format}`)), `${c.id}.${c.format}`);
      expect(res.json()).toMatchObject({ duplicate: true, requeued: false });
    }
    await h.queue.idle();
    const after = (await getJson(h, s, "/api/v1/resumes")).body.resumes as typeof before;
    expect(after.map((r) => [r.resumeId, r.counts]).sort()).toEqual(before.map((r) => [r.resumeId, r.counts]).sort());
    const total = await h.pool.query("SELECT count(*)::int AS n FROM candidate_facts");
    const distinct = await h.pool.query("SELECT count(DISTINCT (resume_version_id, fact_key))::int AS n FROM candidate_facts");
    expect(total.rows[0].n).toBe(distinct.rows[0].n);
  }, 120_000);

  it("a resume that mentions citizenship, clearance, authorization and sponsorship yields no such fact; only an explicit attestation does", async () => {
    const row = await h.pool.query("SELECT count(*)::int AS n FROM candidate_facts WHERE kind IN ('citizenship','clearance','work_authorization','sponsorship_need')");
    expect(row.rows[0].n).toBe(0);
    const att = await postJson(h, s, "/api/v1/profile/attested-facts", { kind: "citizenship", value: "U.S. citizen", polarity: "has", confirm: true });
    expect(att.status).toBe(201);
    const after = await h.pool.query("SELECT proposed_by FROM candidate_facts WHERE kind = 'citizenship'");
    expect(after.rows).toEqual([{ proposed_by: "user" }]);
  });

  it("nothing becomes approved by processing: every machine-proposed fact is still pending", async () => {
    const r = await h.pool.query("SELECT count(*) FILTER (WHERE approval_status <> 'pending')::int AS non_pending FROM candidate_facts WHERE proposed_by IN ('rules','qwen')");
    expect(r.rows[0].non_pending).toBe(0);
  });

  it("an approval made through the API survives a full application restart against the same PostgreSQL", async () => {
    const list = (await getJson(h, s, "/api/v1/resumes")).body.resumes as Array<{ resumeId: string; state: string }>;
    const target = list.find((r) => r.state === "PROPOSED")!;
    const facts = (await getJson(h, s, `/api/v1/resumes/${target.resumeId}/facts`)).body.facts as any[];
    const skill = facts.find((f) => f.kind === "skill" || f.kind === "employment")!;
    const approved = await postJson(h, s, `/api/v1/resumes/${target.resumeId}/facts/review`, { factId: skill.factId, action: "approve", expectedDigest: skill.contentDigest });
    expect(approved.status).toBe(200);
    const restarted = await h.restart();
    h = restarted;
    s = await login(h);
    const again = (await getJson(h, s, `/api/v1/resumes/${target.resumeId}/facts`)).body.facts as any[];
    expect(again.find((f) => f.factId === skill.factId)).toMatchObject({ approvalStatus: "approved", verification: { verifiedBy: "local" } });
  }, 60_000);
});

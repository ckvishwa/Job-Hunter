import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiServiceError } from "../../src/ai/client.js";
import {
  FakeAi, HOST, ORIGIN, PDF_BYTES, SAMPLE_TEXT, authHeaders, dbAvailable, docxBytes, getJson, login, multipartBody, postJson, sampleResponse,
  startHarness, upload, type Harness, type Session,
} from "../helpers/s1-harness.js";

// Integration tests: real Fastify app + real PostgreSQL (a throwaway database per file in the dedicated S1 container) + real
// temp upload storage. Only the Python service is replaced by a scripted fake here; tests/api/s1-fullstack.test.ts covers the
// real Python service. Skipped (and reported as skipped) when the S1 PostgreSQL container is not running.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

suite("S1 API (PostgreSQL)", () => {
  const ai = new FakeAi();
  let h: Harness;
  let s: Session;
  const owned: Harness[] = [];

  beforeAll(async () => {
    h = await startHarness(ai);
    owned.push(h);
    s = await login(h);
  }, 60_000);

  afterAll(async () => {
    for (const x of owned) {
      await x.close().catch(() => undefined);
      await x.dropDatabase().catch(() => undefined);
    }
  }, 60_000);

  const uploadAndWait = async (marker: string, harness: Harness = h, session: Session = s) => {
    const res = await upload(harness, session, docxBytes(marker));
    await harness.queue.idle();
    return res;
  };

  // --- authentication, CSRF, origin ------------------------------------------------------------------------------------

  describe("authentication and request protection", () => {
    it("serves health without a session, but nothing else", async () => {
      expect((await h.app.inject({ method: "GET", url: "/api/v1/healthz", headers: { host: HOST } })).statusCode).toBe(200);
      for (const [method, url] of [["GET", "/api/v1/resumes"], ["GET", "/api/v1/profile/revisions"], ["GET", "/api/v1/profile/attested-facts"]] as const) {
        const res = await h.app.inject({ method, url, headers: { host: HOST } });
        expect(res.statusCode, url).toBe(401);
        expect(res.json()).toEqual({ error: { code: "UNAUTHENTICATED", message: expect.any(String) } });
      }
    });

    it("refuses requests whose Host is not loopback (DNS rebinding)", async () => {
      const res = await h.app.inject({ method: "GET", url: "/api/v1/healthz", headers: { host: "evil.example.com" } });
      expect(res.statusCode).toBe(403);
    });

    it("rejects a wrong access token and sets a hardened cookie on success", async () => {
      const bad = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { host: HOST, origin: ORIGIN }, payload: { accessToken: "x".repeat(40) } });
      expect(bad.statusCode).toBe(401);
      expect(bad.cookies).toEqual([]);
      const ok = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { host: HOST, origin: ORIGIN }, payload: { accessToken: "a".repeat(40) } });
      const setCookie = String(ok.headers["set-cookie"]);
      expect(setCookie).toMatch(/jh_session=/);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
    });

    it("login requires a trusted Origin", async () => {
      const res = await h.app.inject({ method: "POST", url: "/api/v1/session", headers: { host: HOST, origin: "https://evil.example.com" }, payload: { accessToken: "a".repeat(40) } });
      expect(res.statusCode).toBe(403);
    });

    it("every write needs a trusted Origin AND the CSRF token", async () => {
      const { payload, headers } = multipartBody("r.docx", docxBytes("csrf-case"));
      const base = { host: HOST, cookie: s.cookie, ...headers };
      const noOrigin = await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: { ...base, "x-csrf-token": s.csrf }, payload });
      const evilOrigin = await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: { ...base, origin: "https://evil.example.com", "x-csrf-token": s.csrf }, payload });
      const noCsrf = await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: { ...base, origin: ORIGIN }, payload });
      const wrongCsrf = await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: { ...base, origin: ORIGIN, "x-csrf-token": "0".repeat(64) }, payload });
      expect([noOrigin, evilOrigin].map((r) => [r.statusCode, r.json().error.code])).toEqual([[403, "BAD_ORIGIN"], [403, "BAD_ORIGIN"]]);
      expect([noCsrf, wrongCsrf].map((r) => [r.statusCode, r.json().error.code])).toEqual([[403, "BAD_CSRF"], [403, "BAD_CSRF"]]);
      const csrfDigest = createHash("sha256").update(docxBytes("csrf-case")).digest("hex");
      expect((await getJson(h, s, "/api/v1/resumes")).body.resumes.some((r: { sha256: string }) => r.sha256 === csrfDigest)).toBe(false); // nothing was stored
    });

    it("review and attestation writes are CSRF-protected too", async () => {
      const review = await h.app.inject({ method: "POST", url: "/api/v1/resumes/00000000-0000-4000-8000-000000000000/facts/review", headers: { host: HOST, origin: ORIGIN, cookie: s.cookie }, payload: {} });
      const attest = await h.app.inject({ method: "POST", url: "/api/v1/profile/attested-facts", headers: { host: HOST, origin: ORIGIN, cookie: s.cookie }, payload: {} });
      expect([review.statusCode, attest.statusCode]).toEqual([403, 403]);
    });

    it("a forged or expired cookie is not a session", async () => {
      const forged = { ...s, cookie: "jh_session=v1.9999999999.deadbeef.00" };
      expect((await getJson(h, forged, "/api/v1/resumes")).status).toBe(401);
    });

    it("limits repeated sign-in attempts", async () => {
      const limited = await startHarness(ai);
      owned.push(limited);
      const codes: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        codes.push((await limited.app.inject({ method: "POST", url: "/api/v1/session", headers: { host: HOST, origin: ORIGIN }, payload: { accessToken: "z".repeat(40) } })).statusCode);
      }
      expect(codes.slice(0, 8)).toEqual(Array(8).fill(401));
      expect(codes.slice(8)).toEqual([429, 429, 429]);
    }, 30_000);

    it("sets no-store and nosniff headers", async () => {
      const res = await h.app.inject({ method: "GET", url: "/api/v1/healthz", headers: { host: HOST } });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });

  // --- upload validation and idempotency ---------------------------------------------------------------------------------

  describe("upload", () => {
    it("rejects non-multipart bodies, empty files and unsupported content, whatever the file name says", async () => {
      const json = await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: authHeaders(s, { "content-type": "application/json" }), payload: { x: 1 } });
      expect(json.statusCode).toBe(415);
      const empty = multipartBody("r.pdf", Buffer.alloc(0));
      expect((await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: authHeaders(s, empty.headers), payload: empty.payload })).statusCode).toBe(400);
      const exe = multipartBody("resume.pdf", Buffer.from("MZ\x90\x00 not a resume"), "application/pdf");
      const res = await h.app.inject({ method: "POST", url: "/api/v1/resumes", headers: authHeaders(s, exe.headers), payload: exe.payload });
      expect([res.statusCode, res.json().error.code]).toEqual([415, "UNSUPPORTED_FILE_TYPE"]);
    });

    it("enforces the size limit", async () => {
      const small = await startHarness(ai, { env: { JH_MAX_UPLOAD_BYTES: "2048" } });
      owned.push(small);
      const session = await login(small);
      const res = await upload(small, session, Buffer.concat([docxBytes("big"), Buffer.alloc(4096, 1)]));
      expect([res.statusCode, res.json().error.code]).toEqual([413, "FILE_TOO_LARGE"]);
      expect((await getJson(small, session, "/api/v1/resumes")).body.resumes).toEqual([]);
    }, 30_000);

    it("stores the file by content hash and never by the user-supplied name", async () => {
      const bytes = docxBytes("name-case");
      const digest = createHash("sha256").update(bytes).digest("hex");
      const res = await upload(h, s, bytes, "../../etc/passwd");
      await h.queue.idle();
      expect(res.statusCode).toBe(202);
      const stored = readdirSync(h.uploadDir);
      expect(stored).toContain(`${digest}.docx`);
      expect(stored.some((name) => name.includes("passwd") || name.includes(".."))).toBe(false);
      expect(readFileSync(path.join(h.uploadDir, `${digest}.docx`)).equals(bytes)).toBe(true);
    });

    it("processes an upload to PROPOSED with only PENDING, source-backed facts", async () => {
      const res = await uploadAndWait("proposed-case");
      expect(res.statusCode).toBe(202);
      const id = res.json().resumeId as string;
      const detail = (await getJson(h, s, `/api/v1/resumes/${id}`)).body;
      expect(detail.version.state).toBe("PROPOSED");
      expect(detail).not.toHaveProperty("text");
      const text = (await getJson(h, s, `/api/v1/resumes/${id}/text`)).body.text as string;
      const { facts } = (await getJson(h, s, `/api/v1/resumes/${id}/facts`)).body;
      expect(facts).toHaveLength(5);
      for (const f of facts) {
        expect(f.approvalStatus).toBe("pending");
        expect(f.verification.verifiedBy).toBeNull();
        expect(text.slice(f.span.start, f.span.end)).toBe(f.span.quote);
        expect(["citizenship", "clearance", "work_authorization", "sponsorship_need"]).not.toContain(f.kind);
        if (["email", "legal_name", "phone"].includes(f.kind)) expect(f.sensitivity).toBe("sensitive");
      }
      expect(text).toBe(SAMPLE_TEXT);
    });

    it("is idempotent: the same bytes give the same resume, no new facts and no second extraction", async () => {
      const first = await uploadAndWait("idem-case");
      const calls = ai.calls;
      const again = await uploadAndWait("idem-case");
      expect(again.json()).toMatchObject({ resumeId: first.json().resumeId, versionId: first.json().versionId, duplicate: true, state: "PROPOSED" });
      expect(ai.calls).toBe(calls);
      const { facts } = (await getJson(h, s, `/api/v1/resumes/${first.json().resumeId}/facts`)).body;
      expect(facts).toHaveLength(5);
    });

    it("stays idempotent under concurrent identical uploads", async () => {
      const calls = ai.calls;
      const results = await Promise.all(Array.from({ length: 6 }, () => upload(h, s, docxBytes("concurrent-case"))));
      await h.queue.idle();
      expect(new Set(results.map((r) => r.json().resumeId)).size).toBe(1);
      expect(results.filter((r) => r.json().duplicate === false)).toHaveLength(1);
      expect(ai.calls - calls).toBe(1);
      const id = results[0]!.json().resumeId;
      expect((await getJson(h, s, `/api/v1/resumes/${id}/facts`)).body.facts).toHaveLength(5);
    });

    it("treats different bytes as a different resume with its own facts", async () => {
      const a = await uploadAndWait("distinct-a");
      const b = await uploadAndWait("distinct-b");
      expect(a.json().resumeId).not.toBe(b.json().resumeId);
      const fa = (await getJson(h, s, `/api/v1/resumes/${a.json().resumeId}/facts`)).body.facts.map((f: { factId: string }) => f.factId);
      const fb = (await getJson(h, s, `/api/v1/resumes/${b.json().resumeId}/facts`)).body.facts.map((f: { factId: string }) => f.factId);
      expect(fa.filter((id: string) => fb.includes(id))).toEqual([]);
    });

    it("returns 404 for an unknown or malformed resume id", async () => {
      expect((await getJson(h, s, "/api/v1/resumes/not-a-uuid")).status).toBe(404);
      expect((await getJson(h, s, "/api/v1/resumes/00000000-0000-4000-8000-000000000000/facts")).status).toBe(404);
    });
  });

  // --- extraction failures --------------------------------------------------------------------------------------------------

  describe("extraction outcomes", () => {
    it("records a typed, non-retryable failure and does not re-extract on re-upload (no-text-layer PDF)", async () => {
      ai.set(() => new AiServiceError("NO_TEXT_LAYER", "The file has no usable text layer."));
      const calls = ai.calls;
      const first = await upload(h, s, Buffer.concat([PDF_BYTES, Buffer.from("scan-1")]), "scan.pdf");
      await h.queue.idle();
      const facts = (await getJson(h, s, `/api/v1/resumes/${first.json().resumeId}/facts`)).body;
      expect(facts).toMatchObject({ state: "FAILED", errorCode: "NO_TEXT_LAYER", facts: [] });
      const again = await upload(h, s, Buffer.concat([PDF_BYTES, Buffer.from("scan-1")]), "scan.pdf");
      await h.queue.idle();
      expect(again.json()).toMatchObject({ duplicate: true, requeued: false, state: "FAILED" });
      expect(ai.calls - calls).toBe(1);
      ai.set(() => sampleResponse());
    });

    it("a transient AI failure is retried by re-uploading the same file, producing exactly one set of facts", async () => {
      ai.set(() => new AiServiceError("AI_UNAVAILABLE", "down"));
      const bytes = docxBytes("transient-case");
      const first = await upload(h, s, bytes);
      await h.queue.idle();
      expect((await getJson(h, s, `/api/v1/resumes/${first.json().resumeId}/facts`)).body).toMatchObject({ state: "FAILED", errorCode: "AI_UNAVAILABLE" });
      ai.set(() => sampleResponse());
      const retry = await upload(h, s, bytes);
      await h.queue.idle();
      expect(retry.json()).toMatchObject({ resumeId: first.json().resumeId, duplicate: true, requeued: true });
      const after = (await getJson(h, s, `/api/v1/resumes/${first.json().resumeId}/facts`)).body;
      expect(after.state).toBe("PROPOSED");
      expect(after.facts).toHaveLength(5);
      await upload(h, s, bytes);
      await h.queue.idle();
      expect((await getJson(h, s, `/api/v1/resumes/${first.json().resumeId}/facts`)).body.facts).toHaveLength(5);
    });

    it("fails closed when the service returns text that does not match its hash", async () => {
      ai.set(() => ({ ...sampleResponse(), textSha256: "0".repeat(64) }));
      const res = await upload(h, s, docxBytes("hash-case"));
      await h.queue.idle();
      expect((await getJson(h, s, `/api/v1/resumes/${res.json().resumeId}/facts`)).body).toMatchObject({ state: "FAILED", errorCode: "AI_SCHEMA_INVALID", facts: [] });
      ai.set(() => sampleResponse());
    });

    it("drops mismatched spans and forbidden kinds, keeps the valid facts, and reports why", async () => {
      const base = sampleResponse();
      ai.set(() => ({
        ...base,
        facts: [
          base.facts[2]!,
          { ...base.facts[3]!, span: { start: 0, end: 6, quote: "Splunk" } },
          { kind: "citizenship" as never, value: "U.S. citizen", attributes: {}, span: base.facts[2]!.span, proposedBy: "rules" },
        ],
      }));
      const res = await upload(h, s, docxBytes("drop-case"));
      await h.queue.idle();
      const body = (await getJson(h, s, `/api/v1/resumes/${res.json().resumeId}/facts`)).body;
      expect(body.state).toBe("PROPOSED");
      expect(body.facts.map((f: { value: string }) => f.value)).toEqual(["Python"]);
      expect(body.warnings.map((w: { code: string }) => w.code).sort()).toEqual(["PROPOSAL_FORBIDDEN_KIND", "PROPOSAL_SPAN_MISMATCH"]);
      ai.set(() => sampleResponse());
    });
  });

  // --- human review -----------------------------------------------------------------------------------------------------------

  describe("review, approval and revisions", () => {
    const setup = async (marker: string) => {
      const res = await uploadAndWait(marker);
      const id = res.json().resumeId as string;
      const facts = (await getJson(h, s, `/api/v1/resumes/${id}/facts`)).body.facts as Array<any>;
      return { id, facts, byValue: (v: string) => facts.find((f) => f.value === v)! };
    };
    const review = (id: string, body: unknown) => postJson(h, s, `/api/v1/resumes/${id}/facts/review`, body);

    it("approves a normal fact, binds its digest, and is idempotent", async () => {
      const { id, byValue } = await setup("review-approve");
      const python = byValue("Python");
      const ok = await review(id, { factId: python.factId, action: "approve", expectedDigest: python.contentDigest });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ changed: true, fact: { approvalStatus: "approved", verification: { verifiedBy: "local", verifiedAt: "2026-10-09", contentDigest: python.contentDigest } } });
      const again = await review(id, { factId: python.factId, action: "approve", expectedDigest: python.contentDigest });
      expect(again.body.changed).toBe(false);
      const revs = (await getJson(h, s, `/api/v1/facts/${python.factId}/revisions`)).body.revisions;
      expect(revs.map((r: { action: string }) => r.action)).toEqual(["PROPOSED", "APPROVE"]);
    });

    it("never approves a sensitive fact without explicit confirmation, and records the confirmation when given", async () => {
      const { id, byValue } = await setup("review-sensitive");
      const email = byValue("jordan@example.com");
      const refused = await review(id, { factId: email.factId, action: "approve", expectedDigest: email.contentDigest });
      expect([refused.status, refused.body.error.code]).toEqual([422, "CONFIRMATION_REQUIRED"]);
      const falsy = await review(id, { factId: email.factId, action: "approve", expectedDigest: email.contentDigest, confirmSensitive: false });
      expect(falsy.status).toBe(422);
      expect((await getJson(h, s, `/api/v1/resumes/${id}/facts`)).body.facts.find((f: { factId: string }) => f.factId === email.factId).approvalStatus).toBe("pending");
      const ok = await review(id, { factId: email.factId, action: "approve", expectedDigest: email.contentDigest, confirmSensitive: true });
      expect(ok.status).toBe(200);
      const revs = (await getJson(h, s, `/api/v1/facts/${email.factId}/revisions`)).body.revisions;
      expect(revs.at(-1)).toMatchObject({ action: "APPROVE", explicitConfirmation: true });
    });

    it("edits create a new immutable revision, return the fact to PENDING, and invalidate the old digest", async () => {
      const { id, byValue } = await setup("review-edit");
      const job = byValue("Northwind — SOC Analyst");
      const approved = await review(id, { factId: job.factId, action: "approve", expectedDigest: job.contentDigest });
      const edited = await review(id, {
        factId: job.factId, action: "edit", expectedDigest: approved.body.fact.contentDigest,
        edit: { value: "Northwind Traders — SOC Analyst I", attributes: { employer: "Northwind Traders", title: "SOC Analyst I", startDate: "2022-02", endDate: null, employmentType: "professional" } },
      });
      expect(edited.body.fact).toMatchObject({ value: "Northwind Traders — SOC Analyst I", approvalStatus: "pending", headRevision: 3, verification: { verifiedBy: null } });
      expect(edited.body.fact.attributes).toMatchObject({ startDate: "2022-02", employmentType: "professional" });
      expect(edited.body.fact.source).toEqual(job.source); // provenance survives the edit
      const stale = await review(id, { factId: job.factId, action: "approve", expectedDigest: approved.body.fact.contentDigest });
      expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_FACT"]);
      const revs = (await getJson(h, s, `/api/v1/facts/${job.factId}/revisions`)).body.revisions;
      expect(revs.map((r: { action: string }) => r.action)).toEqual(["PROPOSED", "APPROVE", "EDIT"]);
      expect(revs[0].snapshot.fact.value).toBe("Northwind — SOC Analyst"); // the original proposal is untouched
      expect(revs[1].snapshot.fact.approvalStatus).toBe("approved");
    });

    it("rejects invalid edits and unknown or foreign facts", async () => {
      const { id, byValue } = await setup("review-invalid");
      const job = byValue("Northwind — SOC Analyst");
      const noStart = await review(id, { factId: job.factId, action: "edit", expectedDigest: job.contentDigest, edit: { attributes: { employer: "X" } } });
      expect([noStart.status, noStart.body.error.code]).toEqual([422, "INVALID_EDIT"]);
      const unknown = await review(id, { factId: "f-skill-doesnotexist", action: "reject", expectedDigest: "0".repeat(64) });
      expect(unknown.status).toBe(404);
      const other = await uploadAndWait("review-other");
      const foreign = (await getJson(h, s, `/api/v1/resumes/${other.json().resumeId}/facts`)).body.facts[0];
      const crossed = await review(id, { factId: foreign.factId, action: "reject", expectedDigest: foreign.contentDigest });
      expect(crossed.status).toBe(404);
      const malformed = await review(id, { factId: job.factId, action: "delete", expectedDigest: job.contentDigest });
      expect(malformed.status).toBe(400);
    });

    it("rejects a fact without needing confirmation, and keeps its history", async () => {
      const { id, byValue } = await setup("review-reject");
      const email = byValue("jordan@example.com");
      const out = await review(id, { factId: email.factId, action: "reject", expectedDigest: email.contentDigest });
      expect(out.body.fact.approvalStatus).toBe("rejected");
      expect((await getJson(h, s, `/api/v1/facts/${email.factId}/revisions`)).body.revisions.map((r: { action: string }) => r.action)).toEqual(["PROPOSED", "REJECT"]);
    });

    it("records a profile revision for each effective change and none for a no-op", async () => {
      const { id, byValue } = await setup("review-profile");
      const before = (await getJson(h, s, "/api/v1/profile/revisions")).body.revisions;
      const splunk = byValue("Splunk");
      await review(id, { factId: splunk.factId, action: "approve", expectedDigest: splunk.contentDigest });
      await review(id, { factId: splunk.factId, action: "approve", expectedDigest: splunk.contentDigest });
      const after = (await getJson(h, s, "/api/v1/profile/revisions")).body.revisions;
      expect(after.length).toBe(before.length + 1);
      expect(after.at(-1).profileDigest).not.toBe(before.at(-1)?.profileDigest);
      expect(after.at(-1).approvedCount).toBeGreaterThan(before.at(-1)?.approvedCount ?? -1);
    });
  });

  // --- explicit attestation of sensitive facts -----------------------------------------------------------------------------------

  describe("attested sensitive facts", () => {
    it("requires explicit confirmation, is idempotent, and is the only source of citizenship/clearance facts", async () => {
      const body = { kind: "citizenship", value: "U.S. citizen", polarity: "lacks", confirm: true };
      const refused = await postJson(h, s, "/api/v1/profile/attested-facts", { ...body, confirm: false });
      expect([refused.status, refused.body.error.code]).toEqual([422, "CONFIRMATION_REQUIRED"]);
      const created = await postJson(h, s, "/api/v1/profile/attested-facts", body);
      expect(created.status).toBe(201);
      expect(created.body.fact).toMatchObject({ kind: "citizenship", polarity: "lacks", approvalStatus: "approved", proposedBy: "user", source: { kind: "user-statement" } });
      const repeat = await postJson(h, s, "/api/v1/profile/attested-facts", body);
      expect([repeat.status, repeat.body.created]).toEqual([200, false]);
      const revs = (await getJson(h, s, `/api/v1/facts/${created.body.fact.factId}/revisions`)).body.revisions;
      expect(revs).toEqual([expect.objectContaining({ action: "ATTEST", explicitConfirmation: true })]);
      const list = (await getJson(h, s, "/api/v1/profile/attested-facts")).body.facts;
      expect(list.map((f: { factId: string }) => f.factId)).toContain(created.body.fact.factId);
    });

    it("refuses a contradictory approved statement and non-sensitive kinds", async () => {
      const first = await postJson(h, s, "/api/v1/profile/attested-facts", { kind: "clearance", value: "TS/SCI", polarity: "has", confirm: true });
      expect(first.status).toBe(201);
      const contradiction = await postJson(h, s, "/api/v1/profile/attested-facts", { kind: "clearance", value: "ts/sci", polarity: "lacks", confirm: true });
      expect([contradiction.status, contradiction.body.error.code]).toEqual([409, "CONFLICTING_FACT"]);
      const skill = await postJson(h, s, "/api/v1/profile/attested-facts", { kind: "skill", value: "Python", polarity: "has", confirm: true });
      expect(skill.status).toBe(400);
    });

    it("keeps work authorization, citizenship and sponsorship as separate facts", async () => {
      const a = await postJson(h, s, "/api/v1/profile/attested-facts", { kind: "work_authorization", value: "Authorized to work in the United States", polarity: "has", confirm: true });
      const b = await postJson(h, s, "/api/v1/profile/attested-facts", { kind: "sponsorship_need", value: "Will require sponsorship", polarity: "has", confirm: true });
      expect(a.body.fact.kind).toBe("work_authorization");
      expect(b.body.fact.kind).toBe("sponsorship_need");
      expect(a.body.fact.factId).not.toBe(b.body.fact.factId);
    });
  });

  // --- database-level guarantees ----------------------------------------------------------------------------------------------------

  describe("database invariants", () => {
    it("fact_revisions and profile_revisions are append-only", async () => {
      await uploadAndWait("db-append-only");
      await expect(h.pool.query("UPDATE fact_revisions SET actor = 'tamper'")).rejects.toThrow(/append-only/);
      await expect(h.pool.query("DELETE FROM fact_revisions")).rejects.toThrow(/append-only/);
      await expect(h.pool.query("TRUNCATE fact_revisions")).rejects.toThrow(/append-only/);
      await expect(h.pool.query("UPDATE profile_revisions SET reason = 'tamper'")).rejects.toThrow(/append-only/);
      await expect(h.pool.query("DELETE FROM profile_revisions")).rejects.toThrow(/append-only/);
    });

    it("the schema itself refuses a machine-proposed citizenship fact and a machine-proposed approved fact", async () => {
      const { rows } = await h.pool.query("SELECT id FROM users LIMIT 1");
      const common = ["f-x", "citizenship", "U.S. citizen", "{}", JSON.stringify({ kind: "resume-import", reference: "r" }), "{}"];
      await expect(h.pool.query(
        `INSERT INTO candidate_facts (user_id, fact_id, kind, value, attributes, source, verification, proposed_by, approval_status, sensitivity, content_digest, head_revision)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'rules','pending','sensitive',$8,1)`, [rows[0].id, ...common, "0".repeat(64)])).rejects.toThrow(/check constraint/);
      await expect(h.pool.query(
        `INSERT INTO candidate_facts (user_id, fact_id, kind, value, attributes, source, verification, proposed_by, approval_status, sensitivity, content_digest, head_revision)
         VALUES ($1,'f-y','skill','Python','{}'::jsonb,'{}'::jsonb,$2::jsonb,'rules','approved','normal',$3,1)`, [rows[0].id, JSON.stringify({ verifiedBy: "x", verifiedAt: "2026-10-09" }), "0".repeat(64)])).rejects.toThrow(/check constraint/);
    });

    it("the schema refuses an approval revision of a sensitive fact that lacks recorded confirmation", async () => {
      const res = await uploadAndWait("db-sensitive-confirm");
      const { rows } = await h.pool.query(
        `SELECT f.id FROM candidate_facts f JOIN resume_versions v ON v.id=f.resume_version_id WHERE v.resume_id=$1 AND f.sensitivity='sensitive' LIMIT 1`, [res.json().resumeId]);
      await expect(h.pool.query(
        `INSERT INTO fact_revisions (fact_pk, revision, action, actor, explicit_confirmation, snapshot, content_digest)
         VALUES ($1, 9, 'APPROVE', 'user:local', false, $2::jsonb, $3)`, [rows[0].id, JSON.stringify({ fact: { sensitivity: "sensitive" } }), "0".repeat(64)])).rejects.toThrow(/check constraint/);
    });

    it("refuses to start if migrations are pending (guard used by the CLI)", async () => {
      const { migrationsCurrent } = await import("../../src/db/migrate.js");
      expect(await migrationsCurrent(h.pool)).toBe(true);
    });
  });

  // --- persistence and recovery ------------------------------------------------------------------------------------------------------

  describe("restart and recovery", () => {
    it("persists facts, approvals and revisions across an application restart", async () => {
      const local = await startHarness(ai);
      owned.push(local);
      const session = await login(local);
      const res = await upload(local, session, docxBytes("restart-case"));
      await local.queue.idle();
      const id = res.json().resumeId as string;
      const facts = (await getJson(local, session, `/api/v1/resumes/${id}/facts`)).body.facts as any[];
      const python = facts.find((f) => f.value === "Python");
      await postJson(local, session, `/api/v1/resumes/${id}/facts/review`, { factId: python.factId, action: "approve", expectedDigest: python.contentDigest });
      const beforeRevs = (await getJson(local, session, `/api/v1/facts/${python.factId}/revisions`)).body.revisions;
      const beforeProfile = (await getJson(local, session, "/api/v1/profile/revisions")).body.revisions;

      const restarted = await local.restart(); // new pool, new app, same database and upload directory
      owned.push(restarted);
      const again = await login(restarted);
      const after = (await getJson(restarted, again, `/api/v1/resumes/${id}/facts`)).body;
      expect(after.state).toBe("PROPOSED");
      expect(after.facts).toHaveLength(5);
      expect(after.facts.find((f: { factId: string }) => f.factId === python.factId).approvalStatus).toBe("approved");
      expect((await getJson(restarted, again, `/api/v1/facts/${python.factId}/revisions`)).body.revisions).toEqual(JSON.parse(JSON.stringify(beforeRevs)));
      expect((await getJson(restarted, again, "/api/v1/profile/revisions")).body.revisions).toEqual(JSON.parse(JSON.stringify(beforeProfile)));
      const dup = await upload(restarted, again, docxBytes("restart-case"));
      expect(dup.json()).toMatchObject({ resumeId: id, duplicate: true });
    }, 60_000);

    it("re-queues work that was interrupted by a crash (UPLOADED / EXTRACTING rows) and finishes it exactly once", async () => {
      const local = await startHarness(ai);
      owned.push(local);
      const user = await local.repo.ensureUser("local");
      const bytes = docxBytes("crash-case");
      // Simulate: the upload was accepted and stored, then the process died before extraction.
      const { createFileStore } = await import("../../src/api/file-store.js");
      const real = createHash("sha256").update(bytes).digest("hex");
      const ref = createFileStore(local.uploadDir).save(real, "docx", bytes);
      const reg = await local.repo.registerResume({ userId: user.id, sha256: real, fileType: "docx", byteSize: bytes.length, storageRef: ref, retryableErrorCodes: new Set() });
      await local.repo.beginExtraction(reg.version.id); // died mid-extraction
      const restarted = await local.restart();
      owned.push(restarted);
      expect(await restarted.queue.recover()).toBe(1);
      await restarted.queue.idle();
      const session = await login(restarted);
      const facts = (await getJson(restarted, session, `/api/v1/resumes/${reg.resume.id}/facts`)).body;
      expect(facts.state).toBe("PROPOSED");
      expect(facts.facts).toHaveLength(5);
      expect(await restarted.queue.recover()).toBe(0);
    }, 60_000);
  });
});

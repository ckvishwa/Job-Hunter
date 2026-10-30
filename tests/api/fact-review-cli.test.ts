import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlan, batchIdFor, planApply, type Plan } from "../../src/candidate/fact-review-apply.js";
import { buildReviewFile, reviewFileSchema, type ReviewFile } from "../../src/candidate/fact-review-file.js";
import type { CandidateRepo } from "../../src/db/candidate-repo.js";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import { FakeAi, authHeaders, dbAvailable, docxBytes, getJson, login, startHarness, upload, type Harness, type Session } from "../helpers/s1-harness.js";

// Fast fact review (JSON + CLI core) against a real PostgreSQL throwaway database. Synthetic résumé only; the extractor is scripted.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

const TEXT = [
  "Alex Morgan", "alex.morgan@example.com", "SKILLS", "Splunk, Python, event corre-", "lation, orchestration, splunk", "Wireshark, Nmap, Zeek",
  "EXPERIENCE", "Contoso | SOC Analyst | Jan 2022 - Present", "Led the triage rotation and wrote the escalation runbook for the overnight analyst team",
].join("\n");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const span = (quote: string, from = 0) => ({ start: TEXT.indexOf(quote, from), end: TEXT.indexOf(quote, from) + quote.length, quote });

function response(): ExtractResponse {
  return {
    schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text: TEXT, textSha256: sha(TEXT), warnings: [],
    facts: [
      { kind: "email", value: "alex.morgan@example.com", attributes: {}, span: span("alex.morgan@example.com"), proposedBy: "rules" },
      { kind: "skill", value: "Splunk", attributes: {}, span: span("Splunk"), proposedBy: "rules" },
      { kind: "skill", value: "Python", attributes: {}, span: span("Python"), proposedBy: "rules" },
      { kind: "skill", value: "event corre-", attributes: {}, span: span("event corre-"), proposedBy: "rules" },
      { kind: "skill", value: "lation", attributes: {}, span: span("lation"), proposedBy: "rules" },
      { kind: "skill", value: "orchestration", attributes: {}, span: span("orchestration"), proposedBy: "rules" },
      { kind: "skill", value: "splunk", attributes: {}, span: span("splunk", TEXT.indexOf("orchestration")), proposedBy: "rules" },
      ...["Wireshark", "Nmap", "Zeek"].map((v) => ({ kind: "skill" as const, value: v, attributes: {}, span: span(v), proposedBy: "rules" as const })),
      { kind: "employment", value: "Contoso — SOC Analyst", attributes: { employer: "Contoso", title: "SOC Analyst", startDate: "2022-01", current: true }, span: span("Contoso | SOC Analyst | Jan 2022 - Present"), proposedBy: "rules" },
    ],
    stats: { pageCount: 1, characterCount: TEXT.length, deterministicFacts: 11, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
  };
}

suite("fact review: export, decide, apply (PostgreSQL)", { timeout: 30_000 }, () => {
  let h: Harness;
  let s: Session;
  let resumeId: string;
  let userId: string;
  const owned: Harness[] = [];
  const opts = { actor: "local", today: "2026-10-09", confirmSensitive: false };

  beforeAll(async () => {
    h = await startHarness(new FakeAi(() => response()));
    owned.push(h);
    s = await login(h);
    resumeId = (await upload(h, s, docxBytes("fact-review"))).json().resumeId as string;
    await h.queue.idle();
    userId = (await h.repo.findUser("local"))!.id;
  }, 60_000);
  afterAll(async () => {
    for (const x of owned) {
      await x.close().catch(() => undefined);
      await x.dropDatabase().catch(() => undefined);
    }
  }, 60_000);

  const repo = (): CandidateRepo => h.repo;
  const exportFile = async (reveal = false): Promise<ReviewFile> => {
    const src = (await repo().getResumeSource(userId, resumeId))!;
    const facts = await repo().listFacts(userId, resumeId);
    return buildReviewFile({ userHandle: "local", resumeId, resumeVersionId: src.versionId, sourceTextSha256: src.textSha256, text: src.text, facts, reveal, now: new Date("2026-10-09T00:00:00Z") });
  };
  const decide = (file: ReviewFile, picks: Record<string, "approve" | "reject">, reason: string | null = null): ReviewFile => ({
    ...file, facts: file.facts.map((f) => (picks[f.value] ? { ...f, decision: picks[f.value]!, reason } : f)),
  });
  const status = async (value: string) => (await repo().listFacts(userId, resumeId)).find((f) => f.value === value)!;
  const count = async (sql: string) => Number((await h.pool.query(sql)).rows[0].n);
  const plan = (file: ReviewFile, o = opts): Promise<Plan> => planApply(repo(), userId, file, o);
  const apply = async (file: ReviewFile, o: Partial<typeof opts & { skipConflicts: boolean }> = {}) => {
    const p = await plan(file, { ...opts, ...o });
    return { p, r: await applyPlan(repo(), userId, "local", file, p, { ...opts, ...o, skipConflicts: o.skipConflicts ?? false }) };
  };
  const recs = async () => (await getJson(h, s, "/api/v1/roles/recommendations")).body;

  it("exports every fact with decision null, matching the database, with warnings and masked contact data", async () => {
    const file = await exportFile();
    expect(reviewFileSchema.safeParse(file).success).toBe(true);
    expect(file.facts).toHaveLength(11);
    expect(file.facts.every((f) => f.decision === null && f.status === "pending")).toBe(true);
    const db = await repo().listFacts(userId, resumeId);
    for (const f of file.facts) expect(db.find((d) => d.factId === f.factId)).toMatchObject({ contentDigest: f.contentDigest, headRevision: f.headRevision });
    const by = (v: string) => file.facts.find((f) => f.value === v)!;
    expect(by("event corre-").warnings.map((w) => w.code)).toContain("BROKEN_LINE");
    expect(by("lation").warnings.map((w) => w.code)).toContain("BROKEN_LINE");
    expect(by("orchestration").warnings.map((w) => w.code)).toContain("INSUFFICIENT_CONTEXT");
    expect(by("Splunk").warnings.map((w) => w.code)).toContain("POSSIBLE_DUPLICATE");
    expect(file.coverage.uncoveredLongLines).toBe(1); // the achievement sentence has no structured fact
    expect(JSON.stringify(file)).not.toContain("alex.morgan@example.com");
    expect(JSON.stringify(file)).not.toContain("Alex Morgan");
    expect((await exportFile(true)).facts.some((f) => f.value === "alex.morgan@example.com")).toBe(true);
    expect(await count("SELECT count(*) AS n FROM candidate_facts WHERE approval_status<>'pending'")).toBe(0); // export changes nothing
  });

  it("applies explicit approve/reject through the review lifecycle and leaves skipped facts untouched", async () => {
    const file = decide(await exportFile(), { Splunk: "approve", "Contoso — SOC Analyst": "approve", "event corre-": "reject", lation: "reject" }, "checked source");
    const revBefore = await count("SELECT count(*) AS n FROM fact_revisions");
    const profBefore = await count("SELECT count(*) AS n FROM profile_revisions");
    const { p, r } = await apply(file);
    expect(p.items.map((i) => i.status)).toEqual(["WILL_APPLY", "WILL_APPLY", "WILL_APPLY", "WILL_APPLY"].map(() => "WILL_APPLY"));
    expect(r).toMatchObject({ complete: true, aborted: false, failed: [], conflicts: [], skippedUndecided: 7 });
    expect(r.applied).toHaveLength(4);
    expect((await status("Splunk")).approvalStatus).toBe("approved");
    expect((await status("Contoso — SOC Analyst")).approvalStatus).toBe("approved");
    expect((await status("event corre-")).approvalStatus).toBe("rejected");
    for (const untouched of ["Python", "orchestration", "splunk"]) expect(await status(untouched)).toMatchObject({ approvalStatus: "pending", headRevision: 1 });
    expect(await count("SELECT count(*) AS n FROM fact_revisions")).toBe(revBefore + 4);
    expect(await count("SELECT count(*) AS n FROM profile_revisions")).toBe(profBefore + 4);
    const snap = (await h.pool.query(`SELECT fr.actor, fr.action, fr.snapshot FROM fact_revisions fr JOIN candidate_facts f ON f.id=fr.fact_pk WHERE f.value='Splunk' AND fr.action='APPROVE'`)).rows[0];
    expect(snap).toMatchObject({ actor: "user:local", action: "APPROVE" });
    expect(snap.snapshot.review).toEqual({ channel: "cli-json", reason: "checked source", batchId: batchIdFor(file) });
  });

  it("repeating the same file changes nothing and does not add history", async () => {
    const stale = decide(await exportFile(), {}); // sanity: a fresh export has no decisions and applies nothing
    expect((await apply(stale)).r).toMatchObject({ applied: [], complete: true });
    const first = decide(await exportFile(), { Python: "approve" });
    await apply(first);
    const revs = await count("SELECT count(*) AS n FROM fact_revisions");
    const again = await apply(first); // the same (now stale-revision) file applied twice
    expect(again.p.items.map((i) => i.status)).toEqual(["ALREADY_APPLIED"]);
    expect(again.r).toMatchObject({ applied: [], alreadyApplied: [expect.any(String)], complete: true });
    expect(await count("SELECT count(*) AS n FROM fact_revisions")).toBe(revs);
  });

  it("existing approved or rejected facts with no decision never change, even through a full apply", async () => {
    const before = await repo().listFacts(userId, resumeId);
    const { r } = await apply(await exportFile());
    expect(r).toMatchObject({ applied: [], skippedUndecided: 11 });
    expect(await repo().listFacts(userId, resumeId)).toEqual(before);
  });

  it("refuses a decision when the content or revision changed since export, and mutates nothing", async () => {
    const file = decide(await exportFile(), { "splunk": "approve", orchestration: "reject" });
    const target = await status("orchestration");
    // someone edits one fact in the browser path; another gets approved there
    await repo().applyReview(userId, "local", target.factId, { action: "edit", actor: "local", today: "2026-10-09", expectedDigest: target.contentDigest, edit: { value: "orchestration tooling" } });
    const dup = await status("splunk");
    await repo().applyReview(userId, "local", dup.factId, { action: "reject", actor: "local", today: "2026-10-09", expectedDigest: dup.contentDigest });
    const revs = await count("SELECT count(*) AS n FROM fact_revisions");
    const { p, r } = await apply(file);
    expect(p.items.map((i) => [i.factId === target.factId ? "edited" : "rejected-elsewhere", i.code])).toEqual(
      expect.arrayContaining([["edited", "STALE_CONTENT"], ["rejected-elsewhere", "STALE_REVISION"]]),
    );
    expect(r).toMatchObject({ aborted: true, complete: false, applied: [] });
    expect(r.conflicts).toHaveLength(2);
    expect(await count("SELECT count(*) AS n FROM fact_revisions")).toBe(revs);
  });

  it("--skip-conflicts applies only the clean decisions and still reports incomplete", async () => {
    const edited = await status("orchestration tooling");
    const clean = await status("Python");
    expect(clean.approvalStatus).toBe("approved"); // earlier test
    const file = decide(await exportFile(), { "orchestration tooling": "reject" });
    const stale = { ...file, facts: file.facts.map((f) => (f.factId === edited.factId ? f : f)) };
    const bad = { ...stale, facts: stale.facts.map((f) => (f.value === "lation" ? { ...f, decision: "approve" as const, headRevision: 1 } : f)) }; // lation is already rejected at revision 2
    const { r } = await apply(bad, { skipConflicts: true });
    expect(r.applied).toEqual([edited.factId]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.complete).toBe(false);
  });

  it("rejects a file for another user, an unknown fact, a wrong résumé id and a duplicate fact id", async () => {
    const other = await repo().ensureUser("someone-else");
    const file = decide(await exportFile(), { Python: "reject" });
    expect((await planApply(repo(), other.id, file, opts)).fileProblems[0]).toMatch(/does not exist for this user/);
    const p0 = await plan({ ...file, facts: [...file.facts, { ...file.facts[0]!, decision: "approve" }] });
    expect(p0.fileProblems.join()).toMatch(/more than once/);
    const unknown = await plan({ ...file, facts: [{ ...file.facts[0]!, factId: "f-skill-doesnotexist", decision: "approve" }] });
    expect(unknown.items[0]).toMatchObject({ status: "CONFLICT", code: "UNKNOWN_FACT" });
    const wrong = await plan({ ...file, facts: [{ ...file.facts[0]!, resumeId: "99999999-9999-4999-8999-999999999999", decision: "approve" }] });
    expect(wrong.items[0]).toMatchObject({ status: "CONFLICT", code: "WRONG_RESUME" });
    const tampered = await plan({ ...file, sourceTextSha256: "0".repeat(64) });
    expect(tampered.fileProblems.join()).toMatch(/source digest/);
    expect((await applyPlan(repo(), userId, "local", { ...file, sourceTextSha256: "0".repeat(64) }, tampered, { ...opts, skipConflicts: true })).aborted).toBe(true);
  });

  it("will not approve a sensitive fact without explicit confirmation, and records it when given", async () => {
    const email = (await repo().listFacts(userId, resumeId)).find((f) => f.kind === "email")!;
    const file = { ...(await exportFile()), facts: (await exportFile()).facts.map((f) => (f.kind === "email" ? { ...f, decision: "approve" as const } : f)) };
    const blocked = await apply(file);
    expect(blocked.p.items[0]).toMatchObject({ status: "CONFLICT", code: "CONFIRMATION_REQUIRED" });
    expect(blocked.r.aborted).toBe(true);
    expect((await repo().getFact(userId, email.factId))!.approvalStatus).toBe("pending");
    const ok = await apply(file, { confirmSensitive: true });
    expect(ok.r.complete).toBe(true);
    expect(await count("SELECT count(*) AS n FROM fact_revisions WHERE action='APPROVE' AND explicit_confirmation")).toBe(1);
  });

  it("recovers from an interrupted batch: failures are reported honestly and a re-run finishes only the rest", async () => {
    const file = await exportFile();
    const pending = file.facts.filter((f) => f.status === "pending" && f.kind === "skill").slice(0, 2);
    expect(pending).toHaveLength(2);
    const decided = { ...file, facts: file.facts.map((f) => (pending.some((p) => p.factId === f.factId) ? { ...f, decision: "reject" as const } : f)) };
    const flaky = Object.create(repo()) as CandidateRepo;
    flaky.applyReview = async (u, handle, factId, input) => {
      if (factId === pending[1]!.factId) throw new Error("connection lost");
      return repo().applyReview(u, handle, factId, input);
    };
    const p = await planApply(flaky, userId, decided, opts);
    const r1 = await applyPlan(flaky, userId, "local", decided, p, { ...opts, skipConflicts: false });
    expect(r1.applied).toEqual([pending[0]!.factId]);
    expect(r1.failed).toEqual([expect.objectContaining({ factId: pending[1]!.factId, message: "connection lost" })]);
    expect(r1.complete).toBe(false);
    const r2 = (await apply(decided)).r;
    expect(r2.alreadyApplied).toEqual([pending[0]!.factId]);
    expect(r2.applied).toEqual([pending[1]!.factId]);
    expect(r2.complete).toBe(true);
  });

  it("invalidates S2 recommendations: approved evidence moves the profile revision and the recommendation", async () => {
    const before = await recs();
    const profBefore = (await getJson(h, s, "/api/v1/profile/revisions")).body.revisions.length;
    const soc = (b: any) => b.recommendations.find((x: any) => x.roleSlug === "soc-analyst");
    const job = await status("Contoso — SOC Analyst");
    // The job was approved in an earlier test; withdraw it with an explicit reject through the same file path, then approve it again.
    const rejectFile = decide(await exportFile(), { "Contoso — SOC Analyst": "reject" });
    await apply(rejectFile);
    const mid = await recs();
    expect(soc(mid)?.support ?? "NONE").not.toBe("SUPPORTED");
    const back = decide(await exportFile(), { "Contoso — SOC Analyst": "approve" });
    await apply(back);
    const after = await recs();
    expect(soc(after)).toMatchObject({ support: "SUPPORTED" });
    expect(soc(after).id).not.toBe(soc(before)?.id);
    expect((await getJson(h, s, "/api/v1/profile/revisions")).body.revisions.length).toBe(profBefore + 2);
    expect(job.approvalStatus).toBe("approved");
  });

  it("keeps every decision after a database/API restart, and the browser review route still works", async () => {
    const snapshot = (await repo().listFacts(userId, resumeId)).map((f) => [f.factId, f.approvalStatus, f.headRevision]);
    h = await h.restart();
    owned.push(h);
    s = await login(h);
    expect((await repo().listFacts(userId, resumeId)).map((f) => [f.factId, f.approvalStatus, f.headRevision])).toEqual(snapshot);
    // the original browser endpoint, with its original digest-only protocol
    const list = (await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body.facts as any[];
    const pending = list.find((f) => f.approvalStatus === "pending")!;
    const res = await h.app.inject({
      method: "POST", url: `/api/v1/resumes/${resumeId}/facts/review`, headers: authHeaders(s, { "content-type": "application/json" }),
      payload: { factId: pending.factId, action: "reject", expectedDigest: pending.contentDigest },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fact.approvalStatus).toBe("rejected");
  });
});

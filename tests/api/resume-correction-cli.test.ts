import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import { FakeAi, dbAvailable, docxBytes, login, sha256, startHarness, upload, type Harness } from "../helpers/s1-harness.js";

// The real CLIs (facts:correct, facts:export/apply, resumes:diagnose) run as separate processes against a throwaway PostgreSQL database.
// Synthetic résumé only.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

const TEXT = [
  "Alex Morgan", "alex.morgan@example.com", "SKILLS", "Splunk, SPL, alert triage, event corre-", "lation, Python",
  "EXPERIENCE", "Security Operations Analyst Intern Globex Corp Jun 2022 – Dec 2022",
].join("\n");
const EMP = "Security Operations Analyst Intern Globex Corp Jun 2022 – Dec 2022";
const span = (quote: string) => ({ start: TEXT.indexOf(quote), end: TEXT.indexOf(quote) + quote.length, quote });
const response = (): ExtractResponse => ({
  schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text: TEXT, textSha256: sha256(TEXT), warnings: [],
  facts: [
    { kind: "email", value: "alex.morgan@example.com", attributes: {}, span: span("alex.morgan@example.com"), proposedBy: "rules" },
    ...["Splunk", "SPL", "alert triage", "event corre-", "Python"].map((v) => ({ kind: "skill" as const, value: v, attributes: {}, span: span(v), proposedBy: "rules" as const })),
    { kind: "employment", value: "Security Operations Analyst Intern Globex Corp", attributes: { startDate: "2022-06", endDate: "2022-12", employmentType: "internship" }, span: span(EMP), proposedBy: "rules" },
  ],
  stats: { pageCount: 1, characterCount: TEXT.length, deterministicFacts: 7, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
});

suite("CLI: facts:correct, A/R export-apply and resumes:diagnose (PostgreSQL, separate processes)", { timeout: 120_000 }, () => {
  let h: Harness;
  let resumeId: string;
  let userId: string;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jh-cli-"));

  beforeAll(async () => {
    h = await startHarness(new FakeAi(() => response()));
    resumeId = (await upload(h, await login(h), docxBytes("cli"))).json().resumeId as string;
    await h.queue.idle();
    userId = (await h.repo.findUser("local"))!.id;
  }, 90_000);
  afterAll(async () => {
    await h.close().catch(() => undefined);
    await h.dropDatabase().catch(() => undefined);
  }, 60_000);

  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", ...args], {
      cwd: process.cwd(), encoding: "utf8", input, timeout: 90_000, env: { ...process.env, JH_PG_DB: h.dbName, JH_USER_HANDLE: "local", FORCE_COLOR: "0", JH_UPLOAD_DIR: h.uploadDir, JH_FACT_REVIEW_DIR: path.join(h.uploadDir, "fact-review") },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const fact = async (value: string) => (await h.repo.listFacts(userId, resumeId)).find((f) => f.value === value)!;
  const correct = (factId: string, extra: string[]) => run(["src/candidate/fact-cli.ts", "correct", "--resume", resumeId, "--fact", factId, ...extra]);

  it("refuses without a reason, previews with --dry-run, and changes nothing until each field is confirmed", async () => {
    const emp = await fact("Security Operations Analyst Intern Globex Corp");
    const before = emp.headRevision;
    expect(correct(emp.factId, ["--employer", "Globex Corp", "--title", "Security Operations Analyst Intern"]).out).toMatch(/--reason is required/);

    const dry = correct(emp.factId, ["--dry-run", "--reason", "offer letter on file", "--employer", "Globex Corp", "--title", "Security Operations Analyst Intern"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/employer\s+\(unset\)\s+->\s+Globex Corp/);
    expect(dry.out).toMatch(/Dry run: nothing was changed/);

    const refused = correct(emp.factId, ["--reason", "offer letter on file", "--employer", "Globex Corp", "--title", "Security Operations Analyst Intern"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toMatch(/Refusing to change employer, title without explicit confirmation/);

    const partial = correct(emp.factId, ["--reason", "offer letter on file", "--employer", "Globex Corp", "--title", "Security Operations Analyst Intern", "--confirm-fields", "employer"]);
    expect(partial.code).not.toBe(0);
    expect(partial.out).toMatch(/Not confirmed: title/);
    expect((await fact("Security Operations Analyst Intern Globex Corp")).headRevision).toBe(before);
  });

  it("applies a confirmed correction, keeps the category, never approves, and reports the S2 recompute", async () => {
    const emp = await fact("Security Operations Analyst Intern Globex Corp");
    const ok = correct(emp.factId, ["--reason", "offer letter on file", "--employer", "Globex Corp", "--title", "Security Operations Analyst Intern", "--confirm-fields", "employer,title"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/is now PENDING at revision 2/);
    expect(ok.out).toMatch(/S2 recommendations recomputed/);
    expect(ok.out).toMatch(/Nothing was approved/);
    const after = (await h.repo.listFacts(userId, resumeId)).find((f) => f.factId === emp.factId)!;
    expect(after).toMatchObject({ value: "Globex Corp — Security Operations Analyst Intern", approvalStatus: "pending" });
    expect(after.attributes).toMatchObject({ employer: "Globex Corp", title: "Security Operations Analyst Intern", employmentType: "internship", startDate: "2022-06" });
    expect(after.span).toEqual(emp.span);
    const revs = await h.repo.listRevisions(userId, emp.factId);
    expect(revs.at(-1)).toMatchObject({ action: "EDIT", actor: "user:local" });
    expect(revs.at(-1)!.snapshot).toMatchObject({ review: { channel: "cli-correct", reason: "offer letter on file" } });
  });

  it("widens evidence for a split word with --quote, and refuses an approved fact without --allow-approved-edit", async () => {
    const frag = await fact("event corre-");
    const done = correct(frag.factId, ["--reason", "word split by a line wrap", "--value", "event correlation", "--quote", "event corre-\\nlation", "--confirm-fields", "evidence"]);
    expect(done.code).toBe(0);
    expect((await fact("event correlation")).span!.quote).toBe("event corre-\nlation");

    const py = await fact("Python");
    await h.repo.applyReview(userId, "local", py.factId, { action: "approve", actor: "local", today: "2026-10-10", expectedDigest: py.contentDigest });
    const blocked = correct(py.factId, ["--reason", "case fix", "--value", "PYTHON"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.out).toMatch(/--allow-approved-edit/);
    expect((await fact("Python")).approvalStatus).toBe("approved");
    const allowed = correct(py.factId, ["--reason", "case fix", "--value", "PYTHON", "--allow-approved-edit"]);
    expect(allowed.code).toBe(0);
    expect((await fact("PYTHON")).approvalStatus).toBe("pending");
  });

  it("the original export / dry-run / apply path (A and R) still works on corrected facts", async () => {
    const file = path.join(tmp, "review.json");
    const exp = run(["src/candidate/fact-cli.ts", "export", "--resume", resumeId, "--out", file, "--no-prior-profile"]);
    expect(exp.code).toBe(0);
    const data = JSON.parse(readFileSync(file, "utf8"));
    const corrected = data.facts.find((f: { value: string }) => f.value === "event correlation");
    expect(corrected.warnings.map((w: { code: string }) => w.code)).not.toContain("SOURCE_MISMATCH");
    const decided = { ...data, facts: data.facts.map((f: { value: string }) => (f.value === "event correlation" ? { ...f, decision: "approve" } : f.value === "SPL" ? { ...f, decision: "reject" } : f)) };
    await import("node:fs").then((fs) => fs.writeFileSync(file, JSON.stringify(decided)));
    const dry = run(["src/candidate/fact-cli.ts", "apply", "--file", file, "--dry-run", "--no-prior-profile"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/APPLY\s+APPROVE/);
    const applied = run(["src/candidate/fact-cli.ts", "apply", "--file", file, "--yes", "--no-prior-profile"]);
    expect(applied.code).toBe(0);
    expect((await fact("event correlation")).approvalStatus).toBe("approved");
    expect((await fact("SPL")).approvalStatus).toBe("rejected");
  });

  it("resumes:diagnose --json mirrors the database, masks sensitive values, and shows NOT_EVALUATED", async () => {
    const r = run(["src/candidate/diagnose-cli.ts", "--resume", resumeId, "--json", "--no-prior-profile"]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.out);
    const rows = await h.repo.listFacts(userId, resumeId);
    expect(d.extractionSummary.totalFacts).toBe(rows.length);
    expect(d.extractionSummary.byStatus).toEqual({
      approved: rows.filter((f) => f.approvalStatus === "approved").length, pending: rows.filter((f) => f.approvalStatus === "pending").length,
      rejected: rows.filter((f) => f.approvalStatus === "rejected").length,
    });
    expect(d.evaluationMetrics.accuracy).toMatchObject({ status: "NOT_EVALUATED", precision: "NOT_EVALUATED", f1: "NOT_EVALUATED" });
    expect(r.out).not.toContain("alex.morgan@example.com");
    const redacted = JSON.parse(run(["src/candidate/diagnose-cli.ts", "--resume", resumeId, "--json", "--redact-values", "--no-prior-profile"]).out);
    expect(JSON.stringify(redacted)).not.toMatch(/Globex|Splunk|Python/);
    expect(run(["src/candidate/diagnose-cli.ts", "--compare", "--no-prior-profile"]).out).toMatch(/collisions: 0/);
    expect(execFileSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" })).toBe("ok");
  });
});

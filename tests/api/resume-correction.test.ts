import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDiagnostic } from "../../src/candidate/diagnostics.js";
import { collectEmploymentConflicts } from "../../src/candidate/fact-context.js";
import { assertConfirmed, planCorrection, toEditInput } from "../../src/candidate/fact-correct.js";
import { FactRuleError } from "../../src/candidate/fact-lifecycle.js";
import { applyPlan, planApply } from "../../src/candidate/fact-review-apply.js";
import { buildReviewFile } from "../../src/candidate/fact-review-file.js";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import type { FactView } from "../../src/db/candidate-repo.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { FakeAi, dbAvailable, docxBytes, login, sha256, startHarness, upload, type Harness } from "../helpers/s1-harness.js";

// Correction of extracted facts, S2 invalidation, conflict gate and diagnostics against a real throwaway PostgreSQL database.
// Synthetic résumé only; the extractor is scripted to return what the OLD rules parser (resume-rules@1) produced.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const TODAY = "2026-10-09";

const TEXT = [
  "Alex Morgan", "alex.morgan@example.com", "SKILLS",
  "Detection: Splunk, SPL, alert triage, detection engineering, event corre-", "lation, threat hunting, Python, Wireshark",
  "EXPERIENCE", "Security Operations Vulnerability Analyst Intern Acme Systems Sep 2022 – May 2023", "Assessed applications and logged findings.",
  "CERTIFICATIONS", "CompTIA Security+ •Cisco Networking", "Basics",
].join("\n");
const span = (quote: string, from = 0) => ({ start: TEXT.indexOf(quote, from), end: TEXT.indexOf(quote, from) + quote.length, quote });
const EMP_LINE = "Security Operations Vulnerability Analyst Intern Acme Systems Sep 2022 – May 2023";

function response(): ExtractResponse {
  const skill = (v: string, from = 0) => ({ kind: "skill" as const, value: v, attributes: {}, span: span(v, from), proposedBy: "rules" as const });
  return {
    schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text: TEXT, textSha256: sha256(TEXT), warnings: [],
    facts: [
      { kind: "email", value: "alex.morgan@example.com", attributes: {}, span: span("alex.morgan@example.com"), proposedBy: "rules" },
      skill("Splunk"), skill("SPL"), skill("alert triage"), skill("detection engineering"), skill("event corre-"), skill("lation"), skill("threat hunting"), skill("Python"), skill("Wireshark"),
      { kind: "employment", value: "Security Operations Vulnerability Analyst Intern Acme Systems", attributes: { startDate: "2022-09", endDate: "2023-05", employmentType: "internship" }, span: span(EMP_LINE), proposedBy: "rules" },
      { kind: "certification", value: "CompTIA Security+", attributes: {}, span: span("CompTIA Security+"), proposedBy: "rules" },
      { kind: "certification", value: "Cisco Networking Basics", attributes: {}, span: span("Basics"), proposedBy: "rules" },
    ],
    stats: { pageCount: 1, characterCount: TEXT.length, deterministicFacts: 13, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
  };
}

suite("fact correction, S2 invalidation and diagnostics (PostgreSQL)", { timeout: 40_000 }, () => {
  let h: Harness;
  let resumeId: string;
  let userId: string;
  let roles: RolesRepo;

  beforeAll(async () => {
    h = await startHarness(new FakeAi(() => response()));
    await login(h);
    const s = await login(h);
    resumeId = (await upload(h, s, docxBytes("correction"))).json().resumeId as string;
    await h.queue.idle();
    userId = (await h.repo.findUser("local"))!.id;
    roles = new RolesRepo(h.pool);
    await roles.seedCatalog();
  }, 60_000);
  afterAll(async () => {
    await h.close().catch(() => undefined);
    await h.dropDatabase().catch(() => undefined);
  }, 60_000);

  const facts = (): Promise<FactView[]> => h.repo.listFacts(userId, resumeId);
  const byValue = async (value: string): Promise<FactView> => (await facts()).find((f) => f.value === value)!;
  const approve = async (value: string): Promise<void> => {
    const f = await byValue(value);
    await h.repo.applyReview(userId, "local", f.factId, { action: "approve", actor: "local", today: TODAY, expectedDigest: f.contentDigest });
  };
  const source = async () => (await h.repo.getResumeSource(userId, resumeId))!;

  it("plans an employer/title split and demands each changed field to be confirmed by name", async () => {
    const emp = await byValue("Security Operations Vulnerability Analyst Intern Acme Systems");
    const plan = planCorrection(emp, { employer: "Acme Systems", title: "Security Operations Vulnerability Analyst Intern" }, (await source()).text);
    expect(plan.after.value).toBe("Acme Systems — Security Operations Vulnerability Analyst Intern");
    expect(plan.needsConfirmation.sort()).toEqual(["employer", "title"]);
    expect(plan.after.attributes).toMatchObject({ employmentType: "internship", startDate: "2022-09", endDate: "2023-05" }); // untouched fields are kept as they were
    expect(() => assertConfirmed(plan, [], false)).toThrowError(/Not confirmed: employer, title/);
    expect(() => assertConfirmed(plan, ["employer"], false)).toThrowError(/title/);
    expect(() => assertConfirmed(plan, ["employer", "title"], false)).not.toThrow();
  });

  it("refuses unsafe or empty corrections", async () => {
    const emp = await byValue("Security Operations Vulnerability Analyst Intern Acme Systems");
    const skill = await byValue("Python");
    const text = (await source()).text;
    const email = await byValue("alex.morgan@example.com");
    expect(() => planCorrection(emp, { startDate: "2022-13" }, text)).toThrowError(/YYYY-MM/);
    expect(() => planCorrection(emp, { startDate: "2023-06" }, text)).toThrowError(/before the start/);
    expect(() => planCorrection(emp, { employmentType: "weekend-hero" }, text)).toThrowError(/Category must be/);
    expect(() => planCorrection(emp, { employmentType: "internship" }, text)).toThrowError(/changes nothing/);
    expect(() => planCorrection(skill, { employer: "X" }, text)).toThrowError(/only apply to an employment fact/);
    expect(() => planCorrection(email, { value: "other@example.com" }, text)).toThrowError(FactRuleError);
    // the display value cannot be rebuilt from half the information
    expect(() => planCorrection(emp, { employer: "Acme Systems" }, text)).toThrowError(/both --employer and --title/);
  });

  it("verifies a widened quotation against the stored text before it can be used", async () => {
    const frag = await byValue("event corre-");
    const text = (await source()).text;
    const good = planCorrection(frag, { value: "event correlation", quote: "event corre-\nlation" }, text);
    expect(good.evidence?.after).toMatchObject({ quote: "event corre-\nlation" });
    expect(good.needsConfirmation).toContain("evidence");
    expect(() => planCorrection(frag, { value: "event correlation", quote: "event corre-\nlatino" }, text)).toThrowError(/does not occur verbatim/);
    expect(() => planCorrection(frag, { value: "event correlation", quote: "alert triage" }, text)).toThrowError(/does not occur verbatim|exactly once/);
    expect(() => planCorrection(frag, { value: "threat hunting", quote: "event corre-\nlation" }, text)).toThrowError(/does not contain the value/);
  });

  it("corrects pending facts through the review lifecycle: evidence widened, provenance kept, nothing approved", async () => {
    const frag = await byValue("event corre-");
    const text = (await source()).text;
    const plan = planCorrection(frag, { value: "event correlation", quote: "event corre-\nlation" }, text);
    const out = await h.repo.applyReview(userId, "local", frag.factId, {
      action: "edit", actor: "local", today: TODAY, expectedDigest: frag.contentDigest, expectedHeadRevision: frag.headRevision, edit: toEditInput(plan), span: plan.evidence!.after,
      provenance: { channel: "cli-correct", reason: "synthetic test", batchId: "t1", changes: { fields: plan.changes } },
    });
    expect(out.changed).toBe(true);
    expect(out.fact).toMatchObject({ value: "event correlation", approvalStatus: "pending", headRevision: frag.headRevision + 1 });
    expect(out.fact.span).toEqual({ start: plan.evidence!.after.start, end: plan.evidence!.after.end, quote: "event corre-\nlation" });
    expect(out.fact.source.locator).toBe(`chars ${out.fact.span!.start}-${out.fact.span!.end}`);
    expect(text.slice(out.fact.span!.start, out.fact.span!.end)).toBe(out.fact.span!.quote);
    const revs = await h.repo.listRevisions(userId, frag.factId);
    expect(revs.map((r) => r.action)).toEqual(["PROPOSED", "EDIT"]);
    expect(revs[1]!.snapshot).toMatchObject({ previousSpan: { quote: "event corre-" }, review: { channel: "cli-correct", reason: "synthetic test" } });
    // the stray fragment is a separate fact that only a person can reject
    expect((await byValue("lation")).approvalStatus).toBe("pending");
    // the quality tool no longer reports a source mismatch for the corrected fact
    const file = buildReviewFile({ userHandle: "local", resumeId, resumeVersionId: (await source()).versionId, sourceTextSha256: (await source()).textSha256, text, facts: await facts(), reveal: false, now: new Date() });
    expect(file.facts.find((f) => f.factId === frag.factId)!.warnings.map((w) => w.code)).not.toContain("SOURCE_MISMATCH");
    expect(file.facts.find((f) => f.value === "Cisco Networking Basics")!.warnings.map((w) => w.code)).toContain("SOURCE_MISMATCH");
  });

  it("refuses a correction made against a stale digest or revision (revision lock)", async () => {
    const f = await byValue("Python");
    const base = { action: "edit" as const, actor: "local", today: TODAY, edit: { value: "Python 3" } };
    await expect(h.repo.applyReview(userId, "local", f.factId, { ...base, expectedDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "STALE_FACT" });
    await expect(h.repo.applyReview(userId, "local", f.factId, { ...base, expectedDigest: f.contentDigest, expectedHeadRevision: f.headRevision + 5 })).rejects.toMatchObject({ code: "STALE_FACT" });
    expect((await byValue("Python")).headRevision).toBe(f.headRevision);
    // evidence can only be adjusted by an edit, and only to text that is really there
    await expect(h.repo.applyReview(userId, "local", f.factId, { action: "approve", actor: "local", today: TODAY, expectedDigest: f.contentDigest, span: { start: 0, end: 4, quote: "Alex" } })).rejects.toMatchObject({ code: "INVALID_EDIT" });
    await expect(h.repo.applyReview(userId, "local", f.factId, { ...base, expectedDigest: f.contentDigest, span: { start: 0, end: 4, quote: "Alex" } })).rejects.toMatchObject({ code: "INVALID_EDIT" });
    expect((await byValue("Python")).span).toEqual(f.span);
  });

  it("editing an APPROVED fact needs an explicit flag, withdraws its approval and supersedes the S2 recommendations that rested on it", async () => {
    for (const v of ["Splunk", "SPL", "alert triage", "detection engineering", "threat hunting", "Python"]) await approve(v);
    await roles.refresh(userId, TODAY);
    const liveBefore = (await h.pool.query("SELECT id, role_slug, source_fact_ids FROM candidate_role_recommendations WHERE user_id=$1 AND superseded_at IS NULL", [userId])).rows;
    const splunk = await byValue("Splunk");
    const dependent = liveBefore.filter((r) => (r.source_fact_ids as string[]).includes(splunk.factId));
    expect(dependent.length).toBeGreaterThan(0);

    const plan = planCorrection(splunk, { value: "SPLUNK" }, (await source()).text);
    expect(plan.wasApproved).toBe(true);
    expect(() => assertConfirmed(plan, plan.needsConfirmation, false)).toThrowError(/--allow-approved-edit/);
    assertConfirmed(plan, plan.needsConfirmation, true);

    const profileBefore = (await h.repo.listProfileRevisions(userId)).length;
    await h.repo.applyReview(userId, "local", splunk.factId, {
      action: "edit", actor: "local", today: TODAY, expectedDigest: splunk.contentDigest, expectedHeadRevision: splunk.headRevision, edit: toEditInput(plan),
    });
    const refreshed = await roles.refresh(userId, TODAY);
    expect(refreshed.superseded).toBeGreaterThan(0);
    expect((await byValue("SPLUNK")).approvalStatus).toBe("pending");
    expect((await h.repo.listProfileRevisions(userId)).length).toBe(profileBefore + 1);
    const stillLive = (await h.pool.query("SELECT id FROM candidate_role_recommendations WHERE user_id=$1 AND superseded_at IS NULL", [userId])).rows.map((r) => r.id);
    for (const d of dependent) expect(stillLive).not.toContain(d.id);
    const reasons = (await h.pool.query("SELECT superseded_reason FROM candidate_role_recommendations WHERE id = ANY($1::uuid[])", [dependent.map((d) => d.id)])).rows;
    expect(reasons.every((r) => ["INPUTS_CHANGED", "NO_LONGER_SUPPORTED"].includes(r.superseded_reason))).toBe(true);
  });

  it("the original A/R path still works on a corrected fact", async () => {
    const f = await byValue("event correlation");
    const file = buildReviewFile({ userHandle: "local", resumeId, resumeVersionId: (await source()).versionId, sourceTextSha256: (await source()).textSha256, text: (await source()).text, facts: await facts(), reveal: false, now: new Date() });
    const decided = { ...file, facts: file.facts.map((x) => (x.factId === f.factId ? { ...x, decision: "approve" as const } : x.value === "lation" ? { ...x, decision: "reject" as const } : x)) };
    const options = { actor: "local", today: TODAY, confirmSensitive: false };
    const plan = await planApply(h.repo, userId, decided, options);
    const result = await applyPlan(h.repo, userId, "local", decided, plan, { ...options, skipConflicts: false });
    expect(result.complete).toBe(true);
    expect((await byValue("event correlation")).approvalStatus).toBe("approved");
    expect((await byValue("lation")).approvalStatus).toBe("rejected");
  });

  it("flags a disagreeing earlier record as an open conflict and blocks approving the disputed fact until it is explicitly accepted", async () => {
    const dir = await import("node:fs").then((fs) => fs.mkdtempSync(`${process.env.TEMP ?? "."}/jh-prior-`));
    const priorPath = `${dir}/prior-synthetic-profile.json`;
    const prior = {
      schemaVersion: 1, candidateId: "prior", profileVersion: "p9", updatedAt: "2026-10-07", preferences: {}, employmentHistoryComplete: null,
      facts: [{
        factId: "f-prior-acme", kind: "employment", value: "Acme Systems — Programmer Analyst", polarity: "has", sensitivity: "normal", approvalStatus: "approved",
        attributes: { employer: "Acme Systems", title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07" },
        source: { kind: "user-statement", reference: "owner" }, verification: { verifiedBy: "owner", verifiedAt: "2026-10-07", validUntil: null },
      }],
    };
    await import("node:fs").then((fs) => fs.writeFileSync(priorPath, JSON.stringify(prior)));
    const ctx = await collectEmploymentConflicts(h.repo, userId, priorPath);
    expect(ctx.conflicts).toHaveLength(1);
    expect(ctx.conflicts[0]!.differences.map((d) => d.field).sort()).toEqual(["endDate", "startDate", "title"]);
    expect(ctx.conflicts[0]!.required).toMatch(/Neither version is selected/);
    expect((await collectEmploymentConflicts(h.repo, userId, null)).conflicts).toHaveLength(0);

    const emp = await byValue("Security Operations Vulnerability Analyst Intern Acme Systems");
    const file = buildReviewFile({ userHandle: "local", resumeId, resumeVersionId: (await source()).versionId, sourceTextSha256: (await source()).textSha256, text: (await source()).text, facts: await facts(), reveal: false, now: new Date(), conflicts: ctx.conflicts });
    expect(file.facts.find((f) => f.factId === emp.factId)!.warnings.map((w) => w.code)).toContain("EMPLOYMENT_CONFLICT");
    const decided = { ...file, facts: file.facts.map((f) => (f.factId === emp.factId ? { ...f, decision: "approve" as const } : f)) };
    const ids = new Set(ctx.conflicts.flatMap((c) => c.records.map((r) => r.ref)));
    const gated = await planApply(h.repo, userId, decided, { actor: "local", today: TODAY, confirmSensitive: false, employmentConflictFactIds: ids });
    expect(gated.items[0]).toMatchObject({ status: "CONFLICT", code: "EMPLOYMENT_CONFLICT_OPEN" });
    const accepted = await planApply(h.repo, userId, decided, { actor: "local", today: TODAY, confirmSensitive: false, employmentConflictFactIds: ids, acceptEmploymentConflicts: true });
    expect(accepted.items[0]!.status).toBe("WILL_APPLY");
    // rejecting a disputed record never needs the flag
    const rejecting = { ...decided, facts: decided.facts.map((f) => (f.factId === emp.factId ? { ...f, decision: "reject" as const } : f)) };
    expect((await planApply(h.repo, userId, rejecting, { actor: "local", today: TODAY, confirmSensitive: false, employmentConflictFactIds: ids })).items[0]!.status).toBe("WILL_APPLY");
    // the pending record was not touched by any of this
    expect((await byValue("Security Operations Vulnerability Analyst Intern Acme Systems")).approvalStatus).toBe("pending");
  });

  it("diagnostics mirror the real database state, redact sensitive values, and show NOT_EVALUATED without an independent reference", async () => {
    const detail = (await h.repo.getResumeDetail(userId, resumeId))!;
    const row = (await h.repo.listResumes(userId)).find((r) => r.resumeId === resumeId)!;
    const all = await facts();
    const userFacts = all.map((f) => ({ factId: f.factId, kind: f.kind, value: f.value, polarity: f.polarity, attributes: f.attributes, source: f.source, verification: f.verification, approvalStatus: f.approvalStatus, sensitivity: f.sensitivity })) as never[];
    const build = async (options: { reveal: boolean; hideValues: boolean; showText: boolean }, reference = null as never) =>
      buildDiagnostic({
        asOf: TODAY, facts: all, userFacts, revisions: await h.repo.listRevisionActions(userId, resumeId), conflicts: await collectEmploymentConflicts(h.repo, userId, null),
        preview: await roles.previewAssessment(userId, TODAY), reference, latestRulesRevision: "resume-rules@2", options,
        resume: {
          resumeId, fileType: detail.fileType, sha256: detail.sha256, byteSize: detail.byteSize, createdAt: detail.createdAt, versionId: detail.version.id, state: detail.version.state,
          parserRevision: detail.version.parserRevision, contractRevision: detail.version.contractRevision, warnings: detail.version.warnings, stats: detail.version.stats,
          text: detail.text, textSha256: (await source()).textSha256,
        },
      });
    const d = await build({ reveal: false, hideValues: false, showText: false });
    expect(Object.keys(d)).toEqual(expect.arrayContaining(["resume", "parser", "extractionSummary", "factsByCategory", "qualityWarnings", "possibleOmissions", "approvedExperience", "roleRecommendations", "evaluationMetrics", "nextActions"]));
    expect(d.resume.resumeId).toBe(resumeId);
    expect(d.parser.parserRevision).toBe("resume-rules@1");
    expect(d.parser.aiModelUsedForThisExtraction).toBe("no: rules only");
    expect(d.extractionSummary.totalFacts).toBe(all.length);
    expect(d.extractionSummary.byStatus).toEqual({
      approved: row.counts.approved, pending: row.counts.pending, rejected: row.counts.rejected,
    });
    expect(d.extractionSummary.edited).toBeGreaterThanOrEqual(2); // the corrected fragment and the corrected approved skill
    expect(d.evaluationMetrics.accuracy).toMatchObject({ status: "NOT_EVALUATED", precision: "NOT_EVALUATED", recall: "NOT_EVALUATED", f1: "NOT_EVALUATED" });
    expect(d.evaluationMetrics.noOverallScore).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/"(?:score|overall|atsScore|hiringProbability|confidence)"/i);
    expect(d.factsByCategory.email!.facts[0]!.value).not.toContain("alex.morgan");
    expect(d.possibleOmissions.sections.find((s) => s.section === "experience")).toBeTruthy();
    expect(d.qualityWarnings.byCode.SOURCE_MISMATCH).toBeGreaterThanOrEqual(1);
    expect(d.approvedExperience.thisResumeApprovedFactsOnly.buckets.internship!.factIds).toEqual([]); // the internship is still pending: nothing counted
    const hidden = await build({ reveal: false, hideValues: true, showText: false });
    expect(JSON.stringify(hidden)).not.toMatch(/Splunk|alex\.morgan|Acme Systems/);
    const revealed = await build({ reveal: true, hideValues: false, showText: false });
    expect(revealed.factsByCategory.email!.facts[0]!.value).toBe("alex.morgan@example.com");
    // an independent reference switches metrics on; a copy of the parser's own output is not accepted as one
    const evaluated = await build({ reveal: false, hideValues: false, showText: false }, {
      schema: "orbital-extraction-reference/1", independent: true, labeledBy: "test author", labeledAt: "2026-10-09",
      facts: [{ kind: "skill", value: "Python" }, { kind: "skill", value: "Kubernetes" }],
    } as never);
    expect(evaluated.evaluationMetrics.accuracy).toMatchObject({ status: "EVALUATED", truePositives: 1, falseNegatives: 1 });
  });
});

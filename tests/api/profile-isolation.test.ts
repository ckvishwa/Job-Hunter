import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import { collectEmploymentConflicts } from "../../src/candidate/fact-context.js";
import { planApply, applyPlan } from "../../src/candidate/fact-review-apply.js";
import { buildReviewFile } from "../../src/candidate/fact-review-file.js";
import { suggestProvenance } from "../../src/candidate/provenance.js";
import { ProfileRepo, ProfileRuleError } from "../../src/db/profile-repo.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { buildPlan } from "../../src/jobs/planner.js";
import { FakeAi, dbAvailable, docxBytes, login, sha256, startHarness, upload, type Harness } from "../helpers/s1-harness.js";

// P0: candidate-profile isolation against a real throwaway PostgreSQL database. Demo mode is OFF here, so uploads start UNVERIFIED exactly as in
// production. Every résumé is synthetic; "real" below only means "the résumé this test treats as the personal candidate's".

const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const TODAY = "2026-10-11";

type Proposal = { kind: "skill" | "employment" | "certification" | "project"; value: string; quote: string; attributes?: Record<string, unknown> };

function resumeResponse(text: string, facts: Proposal[]): ExtractResponse {
  return {
    schemaRevision: 1, parserRevision: "resume-rules@2", fileType: "docx", text, textSha256: sha256(text), warnings: [],
    facts: facts.map((f) => {
      const start = text.indexOf(f.quote);
      if (start < 0) throw new Error(`fixture quote not found: ${f.quote}`);
      return { kind: f.kind, value: f.value, attributes: (f.attributes ?? {}) as never, span: { start, end: start + f.quote.length, quote: f.quote }, proposedBy: "rules" as const };
    }),
    stats: { pageCount: 1, characterCount: text.length, deterministicFacts: facts.length, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
  };
}

const REAL_TEXT = ["Casey Real", "SKILLS", "Wireshark, Splunk, Python", "EXPERIENCE", "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions Sep 2022 – May 2023",
  "PROJECTS", "MalTrace — Detection Platform 2026", "CERTIFICATIONS", "CompTIA Security+ •Cisco Networking", "Basics"].join("\n");
const INTERN_LINE = "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions Sep 2022 – May 2023";
const FIX_TEXT = ["Jordan Fixture", "SKILLS", "Wireshark, Splunk, Python, Docker", "EXPERIENCE", "Wingtip Corp | IAM Analyst | Nov 2022 – Present", "Wingtip Corp | Service Desk Associate | May 2021 – Oct 2022",
  "CERTIFICATIONS", "Microsoft SC-300"].join("\n");
const CORRECTED_TEXT = ["Casey Real", "EXPERIENCE", "Cognizant Technology Solutions | Programmer Analyst | Jan 2022 – Jul 2023", "Quality engineering and test automation."].join("\n");
const CORRECTED_LINE = "Cognizant Technology Solutions | Programmer Analyst | Jan 2022 – Jul 2023";

const BYTES: Record<string, ExtractResponse> = {
  real: resumeResponse(REAL_TEXT, [
    { kind: "skill", value: "Wireshark", quote: "Wireshark" }, { kind: "skill", value: "Splunk", quote: "Splunk" }, { kind: "skill", value: "Python", quote: "Python" },
    { kind: "employment", value: "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions", quote: INTERN_LINE, attributes: { startDate: "2022-09", endDate: "2023-05", employmentType: "internship" } },
    { kind: "project", value: "MalTrace", quote: "MalTrace" },
    { kind: "certification", value: "Cisco Networking Basics", quote: "Basics" }, // weakly sourced: the quote does not back the value
  ]),
  fix1: resumeResponse(FIX_TEXT, [
    { kind: "skill", value: "Wireshark", quote: "Wireshark" }, { kind: "skill", value: "Splunk", quote: "Splunk" }, { kind: "skill", value: "Docker", quote: "Docker" },
    { kind: "employment", value: "Wingtip Corp — IAM Analyst", quote: "Wingtip Corp | IAM Analyst | Nov 2022 – Present", attributes: { employer: "Wingtip Corp", title: "IAM Analyst", startDate: "2022-11", current: true, employmentType: "professional" } },
    { kind: "employment", value: "Wingtip Corp — Service Desk Associate", quote: "Wingtip Corp | Service Desk Associate | May 2021 – Oct 2022", attributes: { employer: "Wingtip Corp", title: "Service Desk Associate", startDate: "2021-05", endDate: "2022-10", employmentType: "professional" } },
    { kind: "certification", value: "Microsoft SC-300", quote: "Microsoft SC-300" },
  ]),
  alt1: resumeResponse(CORRECTED_TEXT, [{ kind: "employment", value: "Cognizant Technology Solutions — Programmer Analyst", quote: CORRECTED_LINE, attributes: { employer: "Cognizant Technology Solutions", title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional" } }]),
};
// a second synthetic fixture and a second corrected version share the same content but are different uploads
BYTES.fix2 = { ...BYTES.fix1! };
BYTES.alt2 = { ...BYTES.alt1! };
// the parser re-proposing the rejected internship on a fresh upload of the old text
BYTES.reintro = { ...BYTES.real! };

suite("P0 candidate-profile isolation (PostgreSQL)", { timeout: 60_000 }, () => {
  let h: Harness;
  let userId: string;
  let roles: RolesRepo;
  let profiles: ProfileRepo;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    h = await startHarness(new FakeAi((bytes) => {
      const marker = Object.keys(BYTES).find((k) => Buffer.from(bytes).toString("latin1").includes(`#${k}#`));
      return BYTES[marker ?? "real"]!;
    }), { env: { JH_DEMO_PROFILE: "0" } });
    const s = await login(h);
    for (const key of ["real", "fix1", "fix2", "alt1", "alt2", "reintro"]) {
      ids[key] = (await upload(h, s, docxBytes(`#${key}#`), `${key}.docx`)).json().resumeId as string;
      await h.queue.idle();
    }
    userId = (await h.repo.findUser("local"))!.id;
    roles = new RolesRepo(h.pool);
    profiles = new ProfileRepo(h.pool);
    await roles.seedCatalog();
  }, 120_000);
  afterAll(async () => {
    await h.close().catch(() => undefined);
    await h.dropDatabase().catch(() => undefined);
  }, 60_000);

  const facts = (key: string) => h.repo.listFacts(userId, ids[key]!);
  const fact = async (key: string, value: string) => (await facts(key)).find((f) => f.value === value)!;
  const review = async (key: string, value: string, action: "approve" | "reject") => {
    const f = await fact(key, value);
    return h.repo.applyReview(userId, "local", f.factId, { action, actor: "local", today: TODAY, expectedDigest: f.contentDigest });
  };
  const s2 = () => roles.getRecommendations(userId, TODAY);
  const months = (v: Awaited<ReturnType<RolesRepo["getRecommendations"]>>, bucket: "professional" | "internship") => [v.experience.buckets[bucket].monthsLower, v.experience.buckets[bucket].monthsUpper];
  const cites = (v: Awaited<ReturnType<RolesRepo["getRecommendations"]>>) => new Set(v.recommendations.flatMap((r) => r.sourceFacts.map((x) => x.resumeId)));

  it("with no active profile every résumé is unverified: approved employment, skills and certificates count for nothing", async () => {
    for (const v of ["Wireshark", "Splunk"]) await review("fix1", v, "approve");
    await review("fix1", "Wingtip Corp — IAM Analyst", "approve");
    await review("real", "Wireshark", "approve");
    const v = await s2();
    expect(v.evidenceScope.profile).toBeNull();
    expect(v.recommendations).toEqual([]);
    expect(months(v, "professional")).toEqual([0, 0]);
    expect(v.evidenceScope.excludedApproved.every((e) => e.code === "NO_ACTIVE_PROFILE")).toBe(true);
  });

  it("an unclassified résumé stays unverified and out of scoring even once a personal profile exists", async () => {
    await profiles.ensureActive(userId, "personal", "Casey");
    const v = await s2();
    expect(v.recommendations).toEqual([]);
    expect(months(v, "professional")).toEqual([0, 0]);
    expect(v.evidenceScope.excludedApproved.every((e) => e.code === "SOURCE_NOT_AUTHORIZED" && e.detail.includes("unverified (unclassified)"))).toBe(true);
  });

  it("rejects impossible classifications: unverified cannot be authorized, a personal profile cannot authorize a fixture", async () => {
    await expect(profiles.classify(userId, { resumeId: ids.fix1!, provenance: "unverified", authorized: true, basis: "no way", actor: "t" })).rejects.toMatchObject({ code: "INVALID_CLASSIFICATION" });
    await expect(profiles.classify(userId, { resumeId: ids.fix1!, provenance: "fixture", authorized: true, basis: "fixture in a personal profile", actor: "t" })).rejects.toMatchObject({ code: "PROFILE_KIND_MISMATCH" });
    await expect(profiles.classify(userId, { resumeId: ids.fix1!, provenance: "fixture", authorized: false, basis: "", actor: "t" })).rejects.toBeInstanceOf(ProfileRuleError);
  });

  it("two synthetic résumés cannot raise the real candidate's experience, and a real candidate with no approved employment gets no professional years", async () => {
    for (const key of ["fix1", "fix2"]) await profiles.classify(userId, { resumeId: ids[key]!, provenance: "fixture", authorized: false, basis: `identical to fixture case (${key})`, actor: "t" });
    await profiles.classify(userId, { resumeId: ids.real!, provenance: "personal", authorized: true, basis: "owner statement; email matches the account email", actor: "t" });
    await review("fix2", "Wingtip Corp — IAM Analyst", "approve");
    await review("fix2", "Wingtip Corp — Service Desk Associate", "approve");
    await review("fix1", "Microsoft SC-300", "approve");
    await review("real", "Splunk", "approve");
    const v = await s2();
    expect(v.evidenceScope.profile).toMatchObject({ kind: "personal" });
    expect(months(v, "professional")).toEqual([0, 0]); // 64-66 months before the boundary
    expect(v.experience.entries.filter((e) => e.counted)).toEqual([]);
    expect(v.experience.status).not.toBe("OK");
    const cited = cites(v);
    expect(cited.has(ids.fix1!) || cited.has(ids.fix2!)).toBe(false);
    for (const r of v.recommendations) for (const f of r.sourceFacts) expect(f.resumeId).toBe(ids.real);
    expect(v.recommendations.flatMap((r) => r.sourceFactIds).some((id) => id.includes("sc-300"))).toBe(false);
    const kept = v.evidenceScope.excludedApproved.filter((e) => e.resumeId === ids.fix1 || e.resumeId === ids.fix2);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((e) => e.code === "SOURCE_NOT_AUTHORIZED")).toBe(true);
  });

  it("every recommendation names the contributing résumé id and fact id", async () => {
    await review("real", "Python", "approve");
    const v = await s2();
    expect(v.recommendations.length).toBeGreaterThan(0);
    for (const r of v.recommendations) {
      expect(r.sourceFacts.map((x) => x.factId)).toEqual(r.sourceFactIds);
      expect(r.sourceFacts.every((x) => x.resumeId === ids.real)).toBe(true);
    }
  });

  it("a weakly sourced certificate cannot support a SUPPORTED role; it is kept out until the fact is corrected", async () => {
    await review("real", "Wireshark", "approve").catch(() => undefined); // already approved earlier
    const cert = await fact("real", "Cisco Networking Basics");
    await h.repo.applyReview(userId, "local", cert.factId, { action: "approve", actor: "local", today: TODAY, expectedDigest: cert.contentDigest });
    const slug = "network-engineer-associate";
    let v = await s2();
    const rec = v.recommendations.find((r) => r.roleSlug === slug);
    expect(rec?.support ?? "NONE").not.toBe("SUPPORTED");
    expect(v.evidenceScope.excludedApproved).toContainEqual(expect.objectContaining({ factId: cert.factId, code: "SOURCE_EVIDENCE_BROKEN", resumeId: ids.real }));
    expect(v.recommendations.flatMap((r) => r.sourceFactIds)).not.toContain(cert.factId);

    // correct the evidence (widen the quotation to the exact text), then approve the corrected fact: now it may support the role
    const text = (await h.repo.getResumeSource(userId, ids.real!))!.text;
    const quote = "Cisco Networking\nBasics";
    const at = text.indexOf(quote);
    const fresh = await fact("real", "Cisco Networking Basics");
    await h.repo.applyReview(userId, "local", fresh.factId, { action: "edit", actor: "local", today: TODAY, expectedDigest: fresh.contentDigest, edit: { value: "Cisco Networking Basics" , attributes: fresh.attributes }, span: { start: at, end: at + quote.length, quote } }).catch(async () => {
      // the edit above is a no-op on the value; change the wording case so the digest differs and the edit is recorded
      await h.repo.applyReview(userId, "local", fresh.factId, { action: "edit", actor: "local", today: TODAY, expectedDigest: fresh.contentDigest, edit: { value: "Cisco networking basics" }, span: { start: at, end: at + quote.length, quote } });
    });
    const corrected = (await facts("real")).find((f) => f.factId === cert.factId)!;
    expect(corrected.approvalStatus).toBe("pending");
    expect(corrected.span?.quote).toBe(quote);
    await h.repo.applyReview(userId, "local", corrected.factId, { action: "approve", actor: "local", today: TODAY, expectedDigest: corrected.contentDigest });
    v = await s2();
    expect(v.recommendations.find((r) => r.roleSlug === slug)?.support).toBe("SUPPORTED");
    expect(v.recommendations.find((r) => r.roleSlug === slug)!.sourceFacts).toContainEqual({ factId: cert.factId, resumeId: ids.real });
    expect(v.evidenceScope.excludedApproved.map((e) => e.factId)).not.toContain(cert.factId);
  });

  it("rejected facts cannot contribute evidence", async () => {
    await review("real", "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions", "approve");
    let v = await s2();
    expect(months(v, "internship")[0]).toBeGreaterThan(0);
    await review("real", "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions", "reject");
    await review("real", "Splunk", "reject");
    v = await s2();
    expect(months(v, "internship")).toEqual([0, 0]);
    expect(v.recommendations.flatMap((r) => r.sourceFactIds)).not.toContain((await fact("real", "Splunk")).factId);
    expect(v.experience.entries.filter((e) => e.counted)).toEqual([]);
  });

  it("parser @2 re-proposing the rejected internship on a new upload yields a PENDING fact that is flagged, gated, and still excluded if forced through", async () => {
    await profiles.classify(userId, { resumeId: ids.reintro!, provenance: "personal", authorized: true, basis: "owner re-upload of the old résumé", actor: "t" });
    await profiles.confirmEmployment(userId, {
      employer: "Cognizant Technology Solutions", title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional",
      detail: "Quality Engineering / QA Automation", statement: "stated by the candidate; the security internship was a tailored rewrite", actor: "t",
    });
    const line = "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions";
    const re = await fact("reintro", line);
    expect(re.approvalStatus).toBe("pending"); // proposals are never approved by a parser
    const ctx = await collectEmploymentConflicts(h.repo, userId, null);
    expect(ctx.conflicts.some((c) => c.records.some((r) => r.ref === re.factId) && c.records.some((r) => r.origin === "confirmed-statement"))).toBe(true);
    const src = (await h.repo.getResumeSource(userId, ids.reintro!))!;
    const file = buildReviewFile({ userHandle: "local", resumeId: ids.reintro!, resumeVersionId: src.versionId, sourceTextSha256: src.textSha256, text: src.text, facts: await facts("reintro"), reveal: false, now: new Date(), conflicts: ctx.conflicts });
    expect(file.facts.find((f) => f.factId === re.factId)!.warnings.map((w) => w.code)).toContain("EMPLOYMENT_CONFLICT");
    const decided = { ...file, facts: file.facts.map((f) => (f.factId === re.factId ? { ...f, decision: "approve" as const } : f)) };
    const conflictIds = new Set(ctx.conflicts.flatMap((c) => c.records.map((r) => r.ref)));
    const gated = await planApply(h.repo, userId, decided, { actor: "local", today: TODAY, confirmSensitive: false, employmentConflictFactIds: conflictIds });
    expect(gated.items[0]).toMatchObject({ status: "CONFLICT", code: "EMPLOYMENT_CONFLICT_OPEN" });

    // even if a person forces the approval through, the contradiction with the confirmed employment keeps it out of scoring
    const forced = { actor: "local", today: TODAY, confirmSensitive: false, employmentConflictFactIds: conflictIds, acceptEmploymentConflicts: true };
    const plan = await planApply(h.repo, userId, decided, forced);
    await applyPlan(h.repo, userId, "local", decided, plan, { ...forced, skipConflicts: false });
    expect((await fact("reintro", line)).approvalStatus).toBe("approved");
    const v = await s2();
    expect(months(v, "internship")).toEqual([0, 0]);
    expect(months(v, "professional")).toEqual([0, 0]);
    expect(v.evidenceScope.excludedApproved).toContainEqual(expect.objectContaining({ factId: re.factId, code: "CONFLICTS_WITH_CONFIRMED_EMPLOYMENT" }));
    // the confirmation is a reference only: still zero counted experience
    expect(v.experience.entries.filter((e) => e.counted)).toEqual([]);
  });

  it("identical approved employment on alternate authorized résumé versions is counted once, with no overlap warning", async () => {
    for (const key of ["alt1", "alt2"]) await profiles.classify(userId, { resumeId: ids[key]!, provenance: "personal", authorized: true, basis: "corrected résumé versions of the owner", actor: "t" });
    await review("alt1", "Cognizant Technology Solutions — Programmer Analyst", "approve");
    const one = months(await s2(), "professional");
    expect(one).toEqual([18, 19]); // 2022-01 .. 2023-07, month precision
    await review("alt2", "Cognizant Technology Solutions — Programmer Analyst", "approve");
    const v = await s2();
    expect(months(v, "professional")).toEqual(one);
    expect(v.evidenceScope.duplicatesCountedOnce).toHaveLength(1);
    expect(v.experience.issues.map((i) => i.code)).not.toContain("OVERLAP_SAME_EMPLOYER");
    const kept = v.experience.entries.filter((e) => e.counted).map((e) => e.factId);
    expect(kept).toHaveLength(1);
    // matches the confirmed statement, so it is not blocked; the earliest upload is the one counted
    expect(v.evidenceScope.duplicatesCountedOnce[0]!.keptResumeId).toBe(ids.alt1);
    expect(v.evidenceScope.excludedApproved.map((e) => e.code)).toContain("DUPLICATE_EMPLOYMENT");
  });

  it("S2 follows changes to the selected evidence sources, supersedes stale decisions, and records history", async () => {
    let v = await s2();
    const rec = v.recommendations.find((r) => r.sourceFacts.some((f) => f.resumeId === ids.real));
    expect(rec).toBeTruthy();
    await roles.decide(userId, "local", { recommendationId: rec!.id, decision: "approve", expectedInputDigest: rec!.inputDigest }, TODAY);
    await profiles.classify(userId, { resumeId: ids.real!, provenance: "personal", authorized: false, basis: "owner pulled this résumé from the profile", actor: "t" });
    const out = await roles.refresh(userId, TODAY);
    expect(out.superseded).toBeGreaterThan(0);
    v = await s2();
    expect(cites(v).has(ids.real!)).toBe(false);
    expect(v.staleDecisions.map((d) => d.roleSlug)).toContain(rec!.roleSlug);
    await profiles.classify(userId, { resumeId: ids.real!, provenance: "personal", authorized: true, basis: "owner re-authorized this résumé", actor: "t" });
    v = await s2();
    expect(v.recommendations.some((r) => r.sourceFacts.some((f) => f.resumeId === ids.real))).toBe(true);
    const events = (await h.pool.query("SELECT authorized FROM profile_source_events WHERE resume_id=$1 ORDER BY id", [ids.real])).rows.map((r) => r.authorized);
    expect(events).toEqual([true, false, true]);
    await expect(h.pool.query("UPDATE profile_source_events SET basis='x'")).rejects.toThrow();
  });

  it("no record or review history was deleted or changed by any of this", async () => {
    const before = Number((await h.pool.query("SELECT count(*) AS n FROM candidate_facts")).rows[0].n);
    await profiles.classify(userId, { resumeId: ids.fix1!, provenance: "unverified", authorized: false, basis: "reclassified for the test", actor: "t" });
    expect(Number((await h.pool.query("SELECT count(*) AS n FROM candidate_facts")).rows[0].n)).toBe(before);
    const f = await fact("fix1", "Microsoft SC-300");
    expect(f.approvalStatus).toBe("approved");
    expect((await h.repo.listRevisions(userId, f.factId)).map((r) => r.action)).toEqual(["PROPOSED", "APPROVE"]);
  });

  it("S3 discovery planning is unaffected by profile membership changes", async () => {
    const catalog = await roles.getCatalog();
    const slugs = catalog.roles.filter((r) => r.active).slice(0, 2).map((r) => r.roleSlug);
    const fam = [...new Set(catalog.roles.filter((r) => slugs.includes(r.roleSlug)).map((r) => r.familySlug))];
    await roles.saveSelection(userId, "t", {
      expectedRevision: 0, expectedCatalogVersion: catalog.catalogVersion, targetFamilies: fam, roleSlugs: slugs, locations: [{ kind: "country", value: "United States" }],
      workModes: ["remote"], seniorityLevels: ["entry"], searchBand: { minYears: 0, maxYears: 3 },
    });
    const planOf = async () => buildPlan({ selection: await roles.getSelection(userId), catalogRoles: catalog.roles, catalogVersion: catalog.catalogVersion });
    const before = await planOf();
    const revision = (await roles.getSelection(userId))!.revisionNo;
    await profiles.classify(userId, { resumeId: ids.real!, provenance: "personal", authorized: false, basis: "membership change for the S3 check", actor: "t" });
    await roles.refresh(userId, TODAY);
    await profiles.classify(userId, { resumeId: ids.real!, provenance: "personal", authorized: true, basis: "membership change back", actor: "t" });
    await roles.refresh(userId, TODAY);
    expect(await planOf()).toEqual(before);
    expect((await roles.getSelection(userId))!.revisionNo).toBe(revision);
  });

  it("suggests provenance only from positive evidence: exact fixture match = fixture, owner email = personal (never authorized), otherwise unverified", () => {
    const fixtures = [{ id: "c01", file: "fixtures.json", lines: ["Jordan Rivers", "Northwind Traders | SOC Analyst I | Jan 2022", "Contoso Labs | IT Support Technician | Jun 2020"] }];
    const same = suggestProvenance({ text: fixtures[0]!.lines.join("\n"), fixtures });
    expect(same).toMatchObject({ provenance: "fixture", needsExplicitAuthorization: false });
    expect(same.basis).toMatch(/identical to fixture case c01/);
    const mine = suggestProvenance({ text: "Casey Real\ncasey@home.test\nNorthwind Traders | SOC Analyst I | Jan 2022", fixtures, ownerEmail: "casey@home.test" });
    expect(mine).toMatchObject({ provenance: "personal", needsExplicitAuthorization: true });
    const unknown = suggestProvenance({ text: "Somebody Else\nA long line about experience that matches nothing known", fixtures });
    expect(unknown.provenance).toBe("unverified"); // NOT assumed synthetic
    expect(suggestProvenance({ text: null, fixtures }).provenance).toBe("unverified");
    // a real résumé that merely shares a line with a fixture is not a fixture
    const mixed = suggestProvenance({ text: `${fixtures[0]!.lines.join("\n")}\nA different second page of real experience\nmore real detail here and here`, fixtures });
    expect(mixed.provenance).toBe("unverified");
  });
});

// Static half of the S4 gate: candidate facts reach scoring only through loadScopedEvidence (profile-repo). No other module may read the fact
// table for scoring, so a future S4 matcher cannot silently bypass the profile boundary.
describe("S4 isolation gate (static)", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  it("only the repositories read candidate_facts; scoring modules never do", () => {
    const hits = walk("src").filter((f) => f.endsWith(".ts") && readFileSync(f, "utf8").includes("candidate_facts")).map((f) => f.split(path.sep).join("/")).sort();
    expect(hits).toEqual(["src/db/candidate-repo.ts", "src/db/profile-repo.ts", "src/db/roles-repo.ts"]);
    const roles = readFileSync("src/db/roles-repo.ts", "utf8");
    expect(roles.match(/candidate_facts/g)).toHaveLength(1); // the display index of already-scoped fact ids, not a scoring read
    expect(roles).toContain("loadScopedEvidence");
    for (const f of walk("src/roles").concat(walk("src/jobs"), walk("src/match"))) expect(readFileSync(f, "utf8")).not.toContain("candidate_facts");
    expect(readFileSync("src/match/evidence.ts", "utf8")).toContain("loadScopedEvidence"); // S4A reads candidate evidence only through the profile boundary
  });
});

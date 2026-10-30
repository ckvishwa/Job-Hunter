import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RolesRepo } from "../../src/db/roles-repo.js";
import { RoleRuleError } from "../../src/roles/errors.js";
import { SEED_CATALOG } from "../../src/roles/seed.js";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import {
  FakeAi, HOST, ORIGIN, authHeaders, dbAvailable, docxBytes, getJson, login, postJson, putJson, startHarness, upload, type Harness, type Session,
} from "../helpers/s1-harness.js";

// S2 integration: real Fastify app + real PostgreSQL (throwaway database) + temp storage. Only the Python extractor is scripted.
// Every resume and person here is synthetic. Expected values were worked out by hand from the seed role definitions.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;

const TEXT = [
  "Alex Morgan",
  "SKILLS",
  "Splunk, Python",
  "EXPERIENCE",
  "Contoso | SOC Analyst | Jan 2022 - Present",
  "Fabrikam | Help Desk Intern | Jun 2021 - Aug 2021",
  "EDUCATION",
  "M.S. Cybersecurity | 2022 - 2024",
].join("\n");
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const span = (quote: string) => ({ start: TEXT.indexOf(quote), end: TEXT.indexOf(quote) + quote.length, quote });

function resumeResponse(): ExtractResponse {
  return {
    schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text: TEXT, textSha256: sha(TEXT), warnings: [],
    facts: [
      { kind: "skill", value: "Splunk", attributes: {}, span: span("Splunk"), proposedBy: "rules" },
      { kind: "skill", value: "Python", attributes: {}, span: span("Python"), proposedBy: "rules" },
      { kind: "employment", value: "Contoso — SOC Analyst", attributes: { employer: "Contoso", title: "SOC Analyst", startDate: "2022-01", current: true }, span: span("Contoso | SOC Analyst | Jan 2022 - Present"), proposedBy: "rules" },
      { kind: "employment", value: "Fabrikam — Help Desk Intern", attributes: { employer: "Fabrikam", title: "Help Desk Intern", startDate: "2021-06", endDate: "2021-08", employmentType: "internship" }, span: span("Fabrikam | Help Desk Intern | Jun 2021 - Aug 2021"), proposedBy: "rules" },
      { kind: "education", value: "M.S. Cybersecurity", attributes: {}, span: span("M.S. Cybersecurity"), proposedBy: "rules" },
    ],
    stats: { pageCount: 1, characterCount: TEXT.length, deterministicFacts: 5, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
  };
}

// These tests are ordered and depend on each other, and every step makes several loopback database round trips. The environment's
// intermittent loopback connect stalls (docs/KNOWN_FLAKES.md, seventh entry) can exceed vitest's 5 s default and then cascade through
// the later steps, so THIS file (not the global config) allows 30 s per test. Assertions are unchanged.
suite("S2 roles API (PostgreSQL)", { timeout: 30_000 }, () => {
  const ai = new FakeAi(() => resumeResponse());
  let h: Harness;
  let s: Session;
  let resumeId: string;
  const owned: Harness[] = [];

  beforeAll(async () => {
    h = await startHarness(ai);
    owned.push(h);
    s = await login(h);
    const up = await upload(h, s, docxBytes("s2-fixture"));
    resumeId = up.json().resumeId as string;
    await h.queue.idle();
  }, 60_000);

  afterAll(async () => {
    for (const x of owned) {
      await x.close().catch(() => undefined);
      await x.dropDatabase().catch(() => undefined);
    }
  }, 60_000);

  const facts = async () => (await getJson(h, s, `/api/v1/resumes/${resumeId}/facts`)).body.facts as Array<any>;
  const fact = async (value: string) => (await facts()).find((f) => f.value === value)!;
  const review = (body: unknown) => postJson(h, s, `/api/v1/resumes/${resumeId}/facts/review`, body);
  const approve = async (value: string) => {
    const f = await fact(value);
    return (await review({ factId: f.factId, action: "approve", expectedDigest: f.contentDigest })).body.fact;
  };
  const recs = async () => (await getJson(h, s, "/api/v1/roles/recommendations")).body;
  const count = async (sql: string) => Number((await h.pool.query(sql)).rows[0].n);
  const rec = (body: any, slug: string) => body.recommendations.find((r: any) => r.roleSlug === slug);

  // --- protection ------------------------------------------------------------------------------------------------------

  describe("authentication and request protection", () => {
    it("every roles route needs a session", async () => {
      for (const [method, url] of [["GET", "/api/v1/roles/catalog"], ["GET", "/api/v1/roles/recommendations"], ["GET", "/api/v1/roles/selections"], ["POST", "/api/v1/roles/selections"], ["POST", "/api/v1/roles/recommendations/decisions"], ["PUT", "/api/v1/roles/catalog/soc-analyst"]] as const) {
        const res = await h.app.inject({ method, url, headers: { host: HOST, origin: ORIGIN }, payload: method === "GET" ? undefined : {} });
        expect([res.statusCode, url], url).toEqual([401, url]);
      }
    });

    it("every roles write needs a trusted Origin and the CSRF token", async () => {
      const base = { host: HOST, cookie: s.cookie, "content-type": "application/json" };
      for (const [method, url] of [["POST", "/api/v1/roles/selections"], ["POST", "/api/v1/roles/recommendations/decisions"], ["PUT", "/api/v1/roles/catalog/soc-analyst"]] as const) {
        const noCsrf = await h.app.inject({ method, url, headers: { ...base, origin: ORIGIN }, payload: {} });
        const evil = await h.app.inject({ method, url, headers: { ...base, origin: "https://evil.example.com", "x-csrf-token": s.csrf }, payload: {} });
        const noOrigin = await h.app.inject({ method, url, headers: { ...base, "x-csrf-token": s.csrf }, payload: {} });
        expect([noCsrf.json().error.code, evil.json().error.code, noOrigin.json().error.code], url).toEqual(["BAD_CSRF", "BAD_ORIGIN", "BAD_ORIGIN"]);
      }
    });
  });

  // --- catalog ---------------------------------------------------------------------------------------------------------

  describe("role catalog", () => {
    it("is seeded on start with cybersecurity families first, titles and aliases stored as data", async () => {
      const cat = (await getJson(h, s, "/api/v1/roles/catalog")).body;
      expect(cat.catalogVersion).toBe(1);
      expect(cat.families.filter((f: any) => f.tier === "primary").map((f: any) => f.familySlug)).toEqual(["soc-blue-team", "incident-response-dfir", "vulnerability-security-ops", "identity-access", "grc-compliance"]);
      expect(cat.families.filter((f: any) => f.tier === "secondary").map((f: any) => f.familySlug)).toEqual(["qa-sdet", "cloud", "network-noc"]);
      expect(cat.roles).toHaveLength(12);
      const soc = cat.roles.find((r: any) => r.roleSlug === "soc-analyst");
      expect(soc.aliases).toEqual(expect.arrayContaining(["SOC Analyst", "Tier 1 SOC Analyst"]));
      expect(soc).toMatchObject({ revision: 1, origin: "seed", familyTier: "primary" });
      expect(await count("SELECT count(*) AS n FROM role_aliases")).toBeGreaterThan(40);
    });

    it("re-seeding creates no duplicates and no new catalog version", async () => {
      const repo = new RolesRepo(h.pool);
      const before = [await count("SELECT count(*) AS n FROM role_catalog"), await count("SELECT count(*) AS n FROM role_aliases"), await count("SELECT count(*) AS n FROM role_catalog_revisions"), await count("SELECT count(*) AS n FROM role_catalog_versions")];
      const again = await repo.seedCatalog();
      expect(again).toMatchObject({ created: 0, updated: 0, catalogVersion: 1 });
      const after = [await count("SELECT count(*) AS n FROM role_catalog"), await count("SELECT count(*) AS n FROM role_aliases"), await count("SELECT count(*) AS n FROM role_catalog_revisions"), await count("SELECT count(*) AS n FROM role_catalog_versions")];
      expect(after).toEqual(before);
      expect(before[0]).toBe(12);
    });

    it("concurrent seeds that add a new role create it exactly once and bump the version once", async () => {
      const fresh = await startHarness(ai);
      owned.push(fresh);
      const repo = new RolesRepo(fresh.pool);
      const extra = { ...SEED_CATALOG.roles[0]!, roleSlug: "temp-extra-role", title: "Temp Extra Role", aliases: ["Temp Extra Role"] };
      const seed = { families: SEED_CATALOG.families, roles: [...SEED_CATALOG.roles, extra] };
      const results = await Promise.all([repo.seedCatalog(seed), repo.seedCatalog(seed), repo.seedCatalog(seed)]);
      expect(results.map((r) => r.created).sort()).toEqual([0, 0, 1]);
      expect((await fresh.pool.query("SELECT count(*)::int AS n FROM role_catalog")).rows[0].n).toBe(13);
      expect((await fresh.pool.query("SELECT count(*)::int AS n FROM role_catalog_versions")).rows[0].n).toBe(2);
      expect((await fresh.pool.query("SELECT count(*)::int AS n FROM role_aliases WHERE role_slug='temp-extra-role'")).rows[0].n).toBe(1);
    });
  });

  // --- before approval -------------------------------------------------------------------------------------------------

  describe("nothing approved yet", () => {
    it("proposes nothing, counts nothing, and explains what is pending", async () => {
      const body = await recs();
      expect(body.recommendations).toEqual([]);
      expect(body.experience).toMatchObject({ status: "NO_DATA", asOf: "2026-10-09" });
      expect(body.suggestedSearchBand).toMatchObject({ readiness: "UNKNOWN", minYears: 0, maxYears: 5 });
      expect(body.noMatch.length).toBe(12);
      const soc = body.noMatch.find((r: any) => r.roleSlug === "soc-analyst");
      expect(soc.pendingHints.length).toBeGreaterThan(0); // pending facts are hinted, never counted
      expect(body.disclaimer).toMatch(/not a hiring chance/);
      expect(body.selection).toBeNull();
      expect(await count("SELECT count(*) AS n FROM candidate_role_recommendations")).toBe(0);
    });
  });

  // --- approved facts -> recommendations --------------------------------------------------------------------------------

  describe("recommendations from approved facts", () => {
    it("an unclassified approved job is not counted and the experience needs review", async () => {
      await approve("Splunk");
      await approve("Contoso — SOC Analyst");
      const body = await recs();
      expect(body.experience.status).toBe("REVIEW");
      expect(body.experience.issues.map((i: any) => i.code)).toContain("UNCLASSIFIED_EMPLOYMENT");
      expect(body.experience.buckets.professional.monthsUpper).toBe(0);
      // Title evidence still works (alert triage via the approved title), SIEM via the skill mention.
      expect(rec(body, "soc-analyst")).toMatchObject({ support: "SUPPORTED", status: "PROPOSED" });
    });

    it("classifying the job, then re-approving it, yields exact month counts and keeps study and internships separate", async () => {
      const job = await fact("Contoso — SOC Analyst");
      const edited = await review({
        factId: job.factId, action: "edit", expectedDigest: job.contentDigest,
        edit: { attributes: { employer: "Contoso", title: "SOC Analyst", startDate: "2022-01", endDate: null, employmentType: "professional" } },
      });
      expect(edited.body.fact.approvalStatus).toBe("pending");
      await approve("Contoso — SOC Analyst");
      await approve("Fabrikam — Help Desk Intern");
      await approve("M.S. Cybersecurity");
      const body = await recs();
      const x = body.experience;
      expect(x.status).toBe("OK");
      // Jan 2022 .. asOf Oct 2026 (month index 57 months later): lower 57, upper 58.
      expect([x.buckets.professional.monthsLower, x.buckets.professional.monthsUpper]).toEqual([57, 58]);
      expect([x.buckets.internship.monthsLower, x.buckets.internship.monthsUpper]).toEqual([2, 3]); // Jun..Aug 2021
      expect(x.counts).toMatchObject({ skillMentions: 1, education: 1 });
      expect(body.suggestedSearchBand).toMatchObject({ readiness: "ESTABLISHED", minYears: 0, maxYears: 5 });
      expect(x.buckets.professional.factIds).toEqual([job.factId]); // evidence link
    });

    it("SOC Analyst is SUPPORTED with evidence links to approved facts only; Python (pending) is never cited", async () => {
      const body = await recs();
      const soc = rec(body, "soc-analyst");
      const python = await fact("Python");
      expect(python.approvalStatus).toBe("pending");
      expect(soc).toMatchObject({ support: "SUPPORTED", familySlug: "soc-blue-team", familyTier: "primary" });
      const approvedIds = new Set((await facts()).filter((f) => f.approvalStatus === "approved").map((f) => f.factId));
      expect(soc.sourceFactIds.length).toBeGreaterThanOrEqual(2);
      for (const id of soc.sourceFactIds) expect(approvedIds.has(id)).toBe(true);
      expect(soc.sourceFactIds).not.toContain(python.factId);
      expect(soc.evidence.requirements.find((r: any) => r.id === "siem").matches[0]).toMatchObject({ via: "skill_mention", demonstrated: false });
      expect(soc.evidence.requirements.find((r: any) => r.id === "alert-triage").matches[0]).toMatchObject({ via: "employment", demonstrated: true });
      expect(soc.gaps.map((g: any) => g.code)).toContain("UNMET_CORE"); // endpoint/network tooling is not evidenced
      // Unsupported roles are not invented: cloud, QA and network stay out of the proposals.
      expect(body.recommendations.map((r: any) => [r.roleSlug, r.support]).sort()).toEqual([["incident-response-analyst", "PARTIAL"], ["soc-analyst", "SUPPORTED"]]);
      expect(body.noMatch.map((r: any) => r.roleSlug)).toEqual(expect.arrayContaining(["sdet", "cloud-engineer-associate", "noc-technician", "iam-analyst"]));
      expect(JSON.stringify(body).toLowerCase()).not.toMatch(/citizen|sponsor|clearance|work authorization/);
    });

    it("is idempotent: reading again changes nothing", async () => {
      const first = await recs();
      const rows = await count("SELECT count(*) AS n FROM candidate_role_recommendations");
      const second = await recs();
      expect(await count("SELECT count(*) AS n FROM candidate_role_recommendations")).toBe(rows);
      expect(second.recommendations.map((r: any) => [r.id, r.inputDigest])).toEqual(first.recommendations.map((r: any) => [r.id, r.inputDigest]));
    });

    it("parallel reads never create duplicate current recommendations", async () => {
      await Promise.all(Array.from({ length: 6 }, () => getJson(h, s, "/api/v1/roles/recommendations")));
      expect(await count("SELECT count(*) AS n FROM (SELECT role_slug FROM candidate_role_recommendations WHERE superseded_at IS NULL GROUP BY role_slug HAVING count(*) > 1) d")).toBe(0);
    });
  });

  // --- human decisions -------------------------------------------------------------------------------------------------

  describe("approve, dismiss and reset", () => {
    it("records the decision, survives a restart, and the history is append-only", async () => {
      const before = await recs();
      const soc = rec(before, "soc-analyst");
      const ir = rec(before, "incident-response-analyst");
      const ok = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: soc.id, decision: "approve", expectedInputDigest: soc.inputDigest });
      expect([ok.status, ok.body.changed, ok.body.recommendation.status]).toEqual([200, true, "APPROVED"]);
      const dismissed = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: ir.id, decision: "dismiss", expectedInputDigest: ir.inputDigest });
      expect(dismissed.body.recommendation.status).toBe("DISMISSED");
      const again = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: soc.id, decision: "approve", expectedInputDigest: soc.inputDigest });
      expect(again.body.changed).toBe(false);

      h = await h.restart();
      owned.push(h);
      s = await login(h);
      const after = await recs();
      expect(rec(after, "soc-analyst")).toMatchObject({ id: soc.id, status: "APPROVED", decidedBy: "local" });
      expect(rec(after, "incident-response-analyst")).toMatchObject({ id: ir.id, status: "DISMISSED" });
      expect(await count("SELECT count(*) AS n FROM role_catalog")).toBe(12); // restart re-seeds nothing
      expect(await count("SELECT count(*) AS n FROM candidate_role_decisions")).toBe(2);
      await expect(h.pool.query("UPDATE candidate_role_decisions SET status='PROPOSED'")).rejects.toThrow(/append-only/);
      await expect(h.pool.query("DELETE FROM candidate_role_decisions")).rejects.toThrow(/append-only/);

      const reset = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: ir.id, decision: "reset", expectedInputDigest: ir.inputDigest });
      expect(reset.body.recommendation.status).toBe("PROPOSED");
      expect(rec(await recs(), "incident-response-analyst")).toMatchObject({ status: "PROPOSED", decidedAt: null });
    });

    it("refuses stale, unknown and malformed decisions without changing anything", async () => {
      const soc = rec(await recs(), "soc-analyst");
      const decisions = await count("SELECT count(*) AS n FROM candidate_role_decisions");
      const stale = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: soc.id, decision: "dismiss", expectedInputDigest: "0".repeat(64) });
      expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_RECOMMENDATION"]);
      const unknown = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: "00000000-0000-4000-8000-000000000000", decision: "approve", expectedInputDigest: soc.inputDigest });
      expect([unknown.status, unknown.body.error.code]).toEqual([404, "UNKNOWN_RECOMMENDATION"]);
      for (const bad of [{}, { recommendationId: "nope", decision: "approve", expectedInputDigest: soc.inputDigest }, { recommendationId: soc.id, decision: "delete", expectedInputDigest: soc.inputDigest }, { recommendationId: soc.id, decision: "approve", expectedInputDigest: soc.inputDigest, extra: 1 }]) {
        const res = await postJson(h, s, "/api/v1/roles/recommendations/decisions", bad);
        expect([res.status, res.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
      }
      expect(await count("SELECT count(*) AS n FROM candidate_role_decisions")).toBe(decisions);
      expect(rec(await recs(), "soc-analyst").status).toBe("APPROVED");
    });

    it("another user can neither see nor decide this user's recommendations", async () => {
      const repo = new RolesRepo(h.pool);
      const other = await new (await import("../../src/db/candidate-repo.js")).CandidateRepo(h.pool).ensureUser("someone-else");
      const soc = rec(await recs(), "soc-analyst");
      const theirs = await repo.getRecommendations(other.id, "2026-10-09");
      expect(theirs.recommendations).toEqual([]);
      expect(theirs.experience.status).toBe("NO_DATA");
      await expect(repo.decide(other.id, "someone-else", { recommendationId: soc.id, decision: "dismiss", expectedInputDigest: soc.inputDigest }, "2026-10-09")).rejects.toMatchObject({ code: "UNKNOWN_RECOMMENDATION" });
      expect(rec(await recs(), "soc-analyst").status).toBe("APPROVED");
    });
  });

  // --- evidence change invalidates -------------------------------------------------------------------------------------

  describe("changed evidence invalidates stale proposals and decisions", () => {
    it("editing an approved fact withdraws it, supersedes the approved recommendation and marks the decision stale", async () => {
      const before = rec(await recs(), "soc-analyst");
      expect(before.status).toBe("APPROVED");
      const job = await fact("Contoso — SOC Analyst");
      const profileBefore = (await getJson(h, s, "/api/v1/profile/revisions")).body.revisions.length;
      await review({ factId: job.factId, action: "edit", expectedDigest: job.contentDigest, edit: { value: "Contoso Ltd — SOC Analyst", attributes: { ...job.attributes, employer: "Contoso Ltd" } } });
      expect((await getJson(h, s, "/api/v1/profile/revisions")).body.revisions.length).toBe(profileBefore + 1); // profile revision advanced

      const after = await recs();
      const now = rec(after, "soc-analyst");
      expect(now.id).not.toBe(before.id);
      expect(now.status).toBe("PROPOSED"); // never carried forward as approved
      expect(now.support).toBe("PARTIAL"); // the approved job is gone; only the Splunk skill mention remains
      expect(now.profileRevisionNo).toBeGreaterThan(before.profileRevisionNo);
      expect(after.staleDecisions).toEqual([expect.objectContaining({ roleSlug: "soc-analyst", previousStatus: "APPROVED", reason: "INPUTS_CHANGED" })]);
      expect(after.experience.buckets.professional.monthsUpper).toBe(0); // the pending job no longer counts

      const old = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: before.id, decision: "approve", expectedInputDigest: before.inputDigest });
      expect([old.status, old.body.error.code]).toEqual([409, "STALE_RECOMMENDATION"]);
      expect(await count("SELECT count(*) AS n FROM candidate_role_recommendations WHERE role_slug='soc-analyst' AND superseded_at IS NOT NULL AND status='APPROVED'")).toBe(1); // history kept
    });

    it("re-approving the corrected fact produces a fresh PROPOSED recommendation, not the old approval", async () => {
      await approve("Contoso Ltd — SOC Analyst");
      const body = await recs();
      const soc = rec(body, "soc-analyst");
      expect(soc).toMatchObject({ support: "SUPPORTED", status: "PROPOSED" });
      expect(body.staleDecisions.map((d: any) => d.roleSlug)).toContain("soc-analyst");
      const decided = await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: soc.id, decision: "approve", expectedInputDigest: soc.inputDigest });
      expect(decided.body.recommendation.status).toBe("APPROVED");
      expect((await recs()).staleDecisions.map((d: any) => d.roleSlug)).not.toContain("soc-analyst");
    });

    it("sensitive attestations never create or change recommendations", async () => {
      const before = await recs();
      for (const [kind, value] of [["citizenship", "U.S. citizen"], ["clearance", "Active secret clearance"], ["sponsorship_need", "Requires sponsorship"], ["work_authorization", "Authorized to work"]] as const) {
        const res = await postJson(h, s, "/api/v1/profile/attested-facts", { kind, value, polarity: "has", confirm: true });
        expect(res.status).toBe(201);
      }
      const after = await recs();
      expect(before.recommendations.length).toBeGreaterThan(0);
      expect(after.recommendations.map((r: any) => [r.id, r.inputDigest, r.status])).toEqual(before.recommendations.map((r: any) => [r.id, r.inputDigest, r.status]));
      expect(JSON.stringify(after.noMatch)).toBe(JSON.stringify(before.noMatch));
      expect(JSON.stringify(after.recommendations).toLowerCase()).not.toMatch(/citizen|clearance|sponsor|authorized/);
    });

    it("rejecting the only supporting facts removes the proposal (it becomes a no-match with gaps)", async () => {
      const job = await fact("Contoso Ltd — SOC Analyst");
      const splunk = await fact("Splunk");
      await review({ factId: job.factId, action: "reject", expectedDigest: job.contentDigest });
      await review({ factId: splunk.factId, action: "reject", expectedDigest: splunk.contentDigest });
      const body = await recs();
      expect(rec(body, "soc-analyst")).toBeUndefined();
      expect(body.noMatch.find((r: any) => r.roleSlug === "soc-analyst").gaps.map((g: any) => g.code)).toContain("UNMET_CORE");
      expect(body.staleDecisions.find((d: any) => d.roleSlug === "soc-analyst")).toMatchObject({ previousStatus: "APPROVED", reason: "NO_LONGER_SUPPORTED" });
      expect(await count("SELECT count(*) AS n FROM candidate_role_recommendations WHERE superseded_at IS NULL")).toBe(0);
    });
  });

  // --- selection --------------------------------------------------------------------------------------------------------

  describe("explicit role selection and search preferences", () => {
    const payload = (o: Record<string, unknown> = {}) => ({
      expectedRevision: 0, expectedCatalogVersion: 1, targetFamilies: ["soc-blue-team", "qa-sdet"], roleSlugs: ["soc-analyst", "sdet"],
      locations: [{ kind: "country", value: "United States" }, { kind: "remote", value: "Remote" }], workModes: ["remote", "hybrid"],
      seniorityLevels: ["entry", "junior"], searchBand: { minYears: 0, maxYears: 5 }, ...o,
    });

    it("saves a revision, persists it, is idempotent for identical input, and keeps a role with no supporting evidence if the user chose it", async () => {
      const ok = await postJson(h, s, "/api/v1/roles/selections", payload());
      expect([ok.status, ok.body.changed, ok.body.selection.revisionNo]).toEqual([200, true, 1]);
      expect(ok.body.selection).toMatchObject({ roleSlugs: ["sdet", "soc-analyst"], targetFamilies: ["qa-sdet", "soc-blue-team"], searchBand: { minYears: 0, maxYears: 5 }, catalogVersion: 1 });
      const same = await postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 1, roleSlugs: ["sdet", "soc-analyst", "sdet"] }));
      expect([same.body.changed, same.body.selection.revisionNo]).toEqual([false, 1]);
      expect(await count("SELECT count(*) AS n FROM search_preferences")).toBe(1);
      h = await h.restart();
      owned.push(h);
      s = await login(h);
      expect((await getJson(h, s, "/api/v1/roles/selections")).body.selection).toMatchObject({ revisionNo: 1, roleSlugs: ["sdet", "soc-analyst"] });
      // Recomputing recommendations (sdet has no evidence) never touches the human selection.
      expect((await recs()).selection).toMatchObject({ revisionNo: 1, roleSlugs: ["sdet", "soc-analyst"] });
    });

    it("a stale revision is a 409 and does not overwrite", async () => {
      const stale = await postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 0, roleSlugs: ["noc-technician"] }));
      expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_SELECTION"]);
      const ok = await postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 1, roleSlugs: ["noc-technician"], targetFamilies: ["network-noc"] }));
      expect(ok.body.selection.revisionNo).toBe(2);
      expect(await count("SELECT count(*) AS n FROM search_preferences")).toBe(2);
    });

    it("two simultaneous saves from the same revision: exactly one wins", async () => {
      const results = await Promise.all([
        postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 2, roleSlugs: ["iam-analyst"], targetFamilies: ["identity-access"] })),
        postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 2, roleSlugs: ["sdet"], targetFamilies: ["qa-sdet"] })),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await count("SELECT count(*) AS n FROM search_preferences")).toBe(3);
    });

    it("rejects unknown roles/families and malformed input (400) and writes nothing", async () => {
      const rows = await count("SELECT count(*) AS n FROM search_preferences");
      const unknownRole = await postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 3, roleSlugs: ["ceo"] }));
      expect([unknownRole.status, unknownRole.body.error.code]).toEqual([400, "INVALID_SELECTION"]);
      const unknownFamily = await postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 3, targetFamilies: ["astronaut"] }));
      expect([unknownFamily.status, unknownFamily.body.error.code]).toEqual([400, "INVALID_SELECTION"]);
      for (const bad of [{ searchBand: { minYears: 6, maxYears: 2 } }, { workModes: ["underwater"] }, { seniorityLevels: ["god"] }, { locations: [{ kind: "planet", value: "Mars" }] }, { extra: true }, { roleSlugs: "soc-analyst" }]) {
        const res = await postJson(h, s, "/api/v1/roles/selections", payload({ expectedRevision: 3, ...bad }));
        expect([res.status, res.body.error.code], JSON.stringify(bad)).toEqual([400, "INVALID_REQUEST"]);
      }
      expect(await count("SELECT count(*) AS n FROM search_preferences")).toBe(rows);
    });

    it("selection revisions are append-only", async () => {
      await expect(h.pool.query("UPDATE search_preferences SET role_slugs = '{}'")).rejects.toThrow(/append-only/);
      await expect(h.pool.query("DELETE FROM search_preferences")).rejects.toThrow(/append-only/);
    });
  });

  // --- catalog administration -------------------------------------------------------------------------------------------

  describe("catalog edits are revisioned, validated and never overwritten by the seed", () => {
    const socEdit = (changes: unknown, expectedRevision = 1) => putJson(h, s, "/api/v1/roles/catalog/soc-analyst", { expectedRevision, changes });

    it("edits aliases and evidence, bumps role revision and catalog version, and keeps history", async () => {
      const soc = (await getJson(h, s, "/api/v1/roles/catalog")).body.roles.find((r: any) => r.roleSlug === "soc-analyst");
      const ok = await socEdit({ aliases: [...soc.aliases, "Blue Team Analyst"], description: "Edited by the candidate." });
      expect([ok.status, ok.body.changed, ok.body.role.revision, ok.body.role.origin]).toEqual([200, true, 2, "user"]);
      expect(ok.body.role.aliases).toContain("Blue Team Analyst");
      expect(ok.body.catalogVersion).toBe(2);
      expect(await count("SELECT count(*) AS n FROM role_catalog_revisions WHERE role_slug='soc-analyst'")).toBe(2);
      await expect(h.pool.query("UPDATE role_catalog_revisions SET actor='x'")).rejects.toThrow(/append-only/);
      const noop = await socEdit({ description: "Edited by the candidate." }, 2);
      expect([noop.body.changed, noop.body.catalogVersion]).toEqual([false, 2]);
    });

    it("refuses stale revisions (409), invalid definitions (400), identity edits, unknown roles (404)", async () => {
      const stale = await socEdit({ description: "x" }, 1);
      expect([stale.status, stale.body.error.code]).toEqual([409, "STALE_ROLE"]);
      const invalid = await socEdit({ evidence: { requirements: [{ id: "a", label: "A", importance: "supporting", terms: ["alpha"] }], minCoreMatches: 1, advisoryProfessionalMonths: 0 } }, 2);
      expect(invalid.status).toBe(400);
      const identity = await socEdit({ roleSlug: "other" }, 2);
      expect([identity.status, identity.body.error.code]).toEqual([400, "INVALID_REQUEST"]);
      const unknown = await putJson(h, s, "/api/v1/roles/catalog/no-such-role", { expectedRevision: 1, changes: { description: "x" } });
      expect([unknown.status, unknown.body.error.code]).toEqual([404, "UNKNOWN_ROLE"]);
      expect(await count("SELECT head_revision AS n FROM role_catalog WHERE role_slug='soc-analyst'")).toBe(2);
    });

    it("a seed run never overwrites the edited role", async () => {
      const again = await new RolesRepo(h.pool).seedCatalog();
      expect(again).toMatchObject({ created: 0, updated: 0, skippedUserEdited: 1 });
      expect(((await getJson(h, s, "/api/v1/roles/catalog")).body.roles.find((r: any) => r.roleSlug === "soc-analyst")).description).toBe("Edited by the candidate.");
    });

    it("a selection made against the old catalog version is rejected as STALE_CATALOG", async () => {
      const res = await postJson(h, s, "/api/v1/roles/selections", { expectedRevision: 3, expectedCatalogVersion: 1, targetFamilies: [], roleSlugs: ["sdet"], locations: [], workModes: [], seniorityLevels: [], searchBand: { minYears: 0, maxYears: 5 } });
      expect([res.status, res.body.error.code]).toEqual([409, "STALE_CATALOG"]);
    });

    it("a taxonomy change recomputes affected proposals and invalidates a decision on them", async () => {
      // Re-establish SOC support (the previous test rejected the supporting facts), then decide, then edit the role.
      // Approve a fresh fact set through the review API.
      const up = await upload(h, s, docxBytes("s2-second-resume"));
      const second = up.json().resumeId as string;
      await h.queue.idle();
      const list = (await getJson(h, s, `/api/v1/resumes/${second}/facts`)).body.facts as Array<any>;
      for (const value of ["Splunk", "Contoso — SOC Analyst"]) {
        const f = list.find((x) => x.value === value)!;
        let digest = f.contentDigest;
        if (value.startsWith("Contoso")) {
          const e = await postJson(h, s, `/api/v1/resumes/${second}/facts/review`, { factId: f.factId, action: "edit", expectedDigest: digest, edit: { attributes: { employer: "Contoso", title: "SOC Analyst", startDate: "2022-01", endDate: null, employmentType: "professional" } } });
          digest = e.body.fact.contentDigest;
        }
        await postJson(h, s, `/api/v1/resumes/${second}/facts/review`, { factId: f.factId, action: "approve", expectedDigest: digest });
      }
      const before = rec(await recs(), "soc-analyst");
      expect(before.support).toBe("SUPPORTED");
      await postJson(h, s, "/api/v1/roles/recommendations/decisions", { recommendationId: before.id, decision: "approve", expectedInputDigest: before.inputDigest });
      const cat = (await getJson(h, s, "/api/v1/roles/catalog")).body;
      const soc = cat.roles.find((r: any) => r.roleSlug === "soc-analyst");
      const requirements = soc.evidence.requirements.map((r: any) => (r.id === "alert-triage" ? { ...r, terms: [...r.terms, "incident queue handling"] } : r));
      const edited = await socEdit({ evidence: { ...soc.evidence, requirements } }, soc.revision);
      expect(edited.body.changed).toBe(true);
      const after = await recs();
      const now = rec(after, "soc-analyst");
      expect(now.id).not.toBe(before.id);
      expect(now.status).toBe("PROPOSED");
      expect(now.roleRevision).toBe(soc.revision + 1);
      expect(now.catalogVersion).toBe(cat.catalogVersion + 1);
      expect(after.staleDecisions.find((d: any) => d.roleSlug === "soc-analyst")).toMatchObject({ previousStatus: "APPROVED", reason: "INPUTS_CHANGED" });
    });
  });

  // --- transactions and errors -----------------------------------------------------------------------------------------

  describe("transaction behaviour", () => {
    it("a refused selection leaves no partial row, and unrelated roles are untouched", async () => {
      const rows = await count("SELECT count(*) AS n FROM search_preferences");
      const cat = (await getJson(h, s, "/api/v1/roles/catalog")).body;
      const res = await postJson(h, s, "/api/v1/roles/selections", { expectedRevision: 3, expectedCatalogVersion: cat.catalogVersion, targetFamilies: ["soc-blue-team"], roleSlugs: ["soc-analyst", "does-not-exist"], locations: [], workModes: [], seniorityLevels: [], searchBand: { minYears: 0, maxYears: 5 } });
      expect(res.status).toBe(400);
      expect(await count("SELECT count(*) AS n FROM search_preferences")).toBe(rows);
    });

    it("the repository surfaces typed rule errors", async () => {
      const repo = new RolesRepo(h.pool);
      await expect(repo.editRole("sdet", 99, { description: "x" }, "local")).rejects.toBeInstanceOf(RoleRuleError);
    });

    it("session headers are still applied to roles responses", async () => {
      const res = await h.app.inject({ method: "GET", url: "/api/v1/roles/catalog", headers: authHeaders(s) });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });
  });
});

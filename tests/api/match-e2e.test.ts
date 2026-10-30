import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractResponse } from "../../src/ai/contracts.js";
import { buildEvidenceCorpus } from "../../src/match/evidence.js";
import { loadPgJob } from "../../src/match/jd-source.js";
import { renderMatchMarkdown, runMatch, type MatchReport } from "../../src/match/pipeline.js";
import { RulesJobSemanticProvider } from "../../src/match/rules-provider.js";
import { ProfileRepo } from "../../src/db/profile-repo.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import type { JobSemanticProvider } from "../../src/semantic/provider.js";
import { FakeAi, dbAvailable, docxBytes, login, sha256, startHarness, upload, type Harness } from "../helpers/s1-harness.js";
import { SYNTHETIC_JD, makeJob } from "../match/helpers.js";

// First end-to-end S4A slice against a real throwaway PostgreSQL database: official JD -> structured requirements -> authorized candidate facts
// -> retrieval -> requirement decisions -> report. Synthetic résumés and a synthetic JD only. No employer is contacted.

const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const TODAY = "2026-10-11";

type P = { kind: "skill" | "employment" | "certification" | "project" | "email"; value: string; quote: string; attributes?: Record<string, unknown> };
const response = (text: string, facts: P[]): ExtractResponse => ({
  schemaRevision: 1, parserRevision: "resume-rules@2", fileType: "docx", text, textSha256: sha256(text), warnings: [],
  facts: facts.map((f) => { const start = text.indexOf(f.quote); if (start < 0) throw new Error(`quote not found: ${f.quote}`); return { kind: f.kind, value: f.value, attributes: (f.attributes ?? {}) as never, span: { start, end: start + f.quote.length, quote: f.quote }, proposedBy: "rules" as const }; }),
  stats: { pageCount: 1, characterCount: text.length, deterministicFacts: facts.length, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
});

const REAL = ["Casey Real", "casey@real.test", "SKILLS", "Splunk, Python, Wireshark", "EXPERIENCE",
  "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions Sep 2022 – May 2023", "◦ Detected 14 threats across 8,000+ events.",
  "PROJECTS", "MalTrace — Detection Platform 2026", "◦ Built a Splunk detection pipeline mapped to 19 ATT&CK techniques.", "CERTIFICATIONS", "CompTIA Security+ •Cisco Networking", "Basics"].join("\n");
const INTERN = "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions Sep 2022 – May 2023";
const FIXT = ["Jordan Fixture", "SKILLS", "Kubernetes, Docker, Splunk", "EXPERIENCE", "Wingtip Corp | Security Analyst | Jan 2015 – Present", "CERTIFICATIONS", "CISSP"].join("\n");

const RESPONSES: Record<string, ExtractResponse> = {
  real: response(REAL, [
    { kind: "email", value: "casey@real.test", quote: "casey@real.test" },
    { kind: "skill", value: "Splunk", quote: "Splunk" }, { kind: "skill", value: "Python", quote: "Python" }, { kind: "skill", value: "Wireshark", quote: "Wireshark" },
    { kind: "employment", value: "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions", quote: INTERN, attributes: { startDate: "2022-09", endDate: "2023-05", employmentType: "internship" } },
    { kind: "project", value: "MalTrace", quote: "MalTrace", attributes: { technologies: ["Splunk", "Sysmon"] } },
    { kind: "certification", value: "CompTIA Security+", quote: "Basics" }, // weakly sourced: the quote does not back the value
  ]),
  fix: response(FIXT, [
    { kind: "skill", value: "Kubernetes", quote: "Kubernetes" }, { kind: "skill", value: "Docker", quote: "Docker" },
    { kind: "employment", value: "Wingtip Corp — Security Analyst", quote: "Wingtip Corp | Security Analyst | Jan 2015 – Present", attributes: { employer: "Wingtip Corp", title: "Security Analyst", startDate: "2015-01", current: true, employmentType: "professional", roleTags: ["security operations"] } },
    { kind: "certification", value: "CISSP", quote: "CISSP" },
  ]),
};

const fakeEncoder = { embed: async (t: string) => { const v = new Array(8).fill(0); for (let i = 0; i < t.length; i += 1) v[t.charCodeAt(i) % 8] += 1; return { vector: v } as never; } };

suite("S4A end to end (PostgreSQL)", { timeout: 60_000 }, () => {
  let h: Harness;
  let userId: string;
  let ids: { real: string; fix: string };
  let profiles: ProfileRepo;
  const corpus = () => buildEvidenceCorpus({ pool: h.pool, candidates: h.repo, userId, asOf: TODAY });
  const match = async (provider: JobSemanticProvider = new RulesJobSemanticProvider(), encoder: typeof fakeEncoder | null = fakeEncoder) =>
    runMatch({ job: makeJob(SYNTHETIC_JD), provider, corpus: await corpus(), encoder: encoder as never, encoderLabel: encoder ? "fake-8d" : null, asOf: TODAY });
  const complete = (r: MatchReport) => { if (r.status !== "COMPLETE") throw new Error(`not complete: ${JSON.stringify(r)}`); return r; };
  const fact = async (resume: "real" | "fix", value: string) => (await h.repo.listFacts(userId, ids[resume])).find((f) => f.value === value)!;
  const approve = async (resume: "real" | "fix", value: string, action: "approve" | "reject" = "approve") => {
    const f = await fact(resume, value);
    await h.repo.applyReview(userId, "local", f.factId, { action, actor: "local", today: TODAY, expectedDigest: f.contentDigest, confirmSensitive: true });
  };
  const snapshot = async () => (await h.pool.query("SELECT fact_id, approval_status, content_digest, head_revision FROM candidate_facts ORDER BY fact_id")).rows;

  beforeAll(async () => {
    h = await startHarness(new FakeAi((bytes) => RESPONSES[Object.keys(RESPONSES).find((k) => Buffer.from(bytes).toString("latin1").includes(`#${k}#`)) ?? "real"]!), { env: { JH_DEMO_PROFILE: "0" } });
    const s = await login(h);
    ids = {
      real: (await upload(h, s, docxBytes("#real#"), "real.docx")).json().resumeId as string,
      fix: (await upload(h, s, docxBytes("#fix#"), "fix.docx")).json().resumeId as string,
    };
    await h.queue.idle();
    userId = (await h.repo.findUser("local"))!.id;
    profiles = new ProfileRepo(h.pool);
    await new RolesRepo(h.pool).seedCatalog();
    await profiles.ensureActive(userId, "personal", "Casey");
    await profiles.classify(userId, { resumeId: ids.real, provenance: "personal", authorized: true, basis: "owner's own résumé (test)", actor: "t" });
    await profiles.classify(userId, { resumeId: ids.fix, provenance: "fixture", authorized: false, basis: "synthetic fixture (test)", actor: "t" });
    for (const v of ["Splunk", "Python"]) await approve("real", v);
    await approve("real", "MalTrace");
    await approve("real", "casey@real.test");
    await approve("real", "CompTIA Security+"); // approved but weakly sourced
    await approve("real", "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions");
    await approve("real", "Security Operations Vulnerability Analyst Intern Cognizant Technology Solutions", "reject"); // the inaccurate internship is rejected
    // Wireshark stays PENDING. Everything on the fixture résumé is approved but its source is not authorized.
    for (const v of ["Kubernetes", "Docker", "CISSP", "Wingtip Corp — Security Analyst"]) await approve("fix", v);
  }, 90_000);
  afterAll(async () => {
    await h.close().catch(() => undefined);
    await h.dropDatabase().catch(() => undefined);
  }, 60_000);

  it("retrieves only approved, authorized, source-backed, non-sensitive evidence and keeps provenance", async () => {
    const c = await corpus();
    const byValue = (v: string) => c.units.find((u) => u.value === v);
    expect(c.units.map((u) => u.value).sort()).toEqual(expect.arrayContaining(["Splunk", "Python", "MalTrace"]));
    expect(byValue("Splunk")).toMatchObject({ resumeId: ids.real, category: "skill", sourceReference: expect.stringContaining("resume-"), verification: { status: "approved", verifiedBy: "local" } });
    expect(byValue("Splunk")!.quote).toBe("Splunk");
    // pending, fixture, weak-source, contact, rejected employment: all absent
    for (const v of ["Wireshark", "Kubernetes", "Docker", "CISSP", "CompTIA Security+", "casey@real.test", "Wingtip Corp — Security Analyst"]) expect(byValue(v), v).toBeUndefined();
    expect(c.units.some((u) => /Cognizant/.test(u.value))).toBe(false);
    expect(c.units.some((u) => u.resumeId === ids.fix)).toBe(false);
    expect(c.boundaryExclusions.map((e) => e.code)).toEqual(expect.arrayContaining(["SOURCE_NOT_AUTHORIZED", "SOURCE_EVIDENCE_BROKEN"]));
    // accomplishment text of the REJECTED employment is gone; text of the approved project is kept and points at its owner
    expect(c.units.some((u) => u.category === "statement" && /Detected 14 threats/.test(u.value))).toBe(false);
    const stmt = c.units.find((u) => u.category === "statement")!;
    expect(stmt.value).toMatch(/Splunk detection pipeline/);
    expect(stmt.factId).toBe(byValue("MalTrace")!.factId);
    expect(c.employment).toEqual([]);
  });

  it("produces an explainable report from the current profile, with missing employment shown as missing evidence", async () => {
    const before = await snapshot();
    const report = complete(await match());
    const by = (v: string) => report.requirements.find((r) => r.value === v)!;
    expect(by("Splunk")).toMatchObject({ status: "PARTIAL" }); // 3+ years of Splunk: tool evidenced, duration is not
    expect(by("Splunk").support[0]).toMatchObject({ resumeId: ids.real, strength: "mention" });
    expect(by("security operations experience")).toMatchObject({ status: "UNSUPPORTED" });
    expect(by("security operations experience").missingEvidence.join(" ")).toMatch(/professional employment/);
    expect(by("Python").status).toBe("PARTIAL"); // "Experience with Python or PowerShell": Python is only a skills-list mention, and the wording asks for use
    expect(report.alternativeGroups.find((g) => g.memberIds.includes(by("Python").requirementId))).toMatchObject({ status: "PARTIAL" });
    expect(by("CISSP").status).toBe("UNSUPPORTED"); // the only CISSP fact is on an unauthorized fixture résumé
    expect(by("Security+").status).toBe("UNSUPPORTED"); // the Security+ fact is weakly sourced
    expect(by("Bachelor's degree").status).toBe("UNSUPPORTED");
    expect(by("Kubernetes")).toMatchObject({ applicable: false });
    // "Awareness of the MITRE ATT&CK framework": an approved project's own accomplishment text mentions ATT&CK, which is enough for awareness wording
    expect(by("MITRE ATT&CK")).toMatchObject({ status: "SUPPORTED", effectiveLevel: "preferred" });
    expect(by("MITRE ATT&CK").support[0]).toMatchObject({ category: "statement", resumeId: ids.real, strength: "demonstrated" });
    expect(report.conditions.map((c) => [c.type, c.result])).toEqual([["citizenship", "UNKNOWN"], ["clearance", "NOT_APPLICABLE"], ["work_authorization", "UNKNOWN"], ["sponsorship", "UNKNOWN"]]);
    expect(report.summary.criticalBlockers).toEqual([]);
    expect(report.versions).toMatchObject({ policy: "match-policy@1", profile: { profileKind: "personal", authorizedResumeIds: [ids.real] }, jd: { extractor: expect.stringMatching(/^rules-jd-extractor@3/), jdSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(report.scoring).toMatch(/^NONE/);
    expect(JSON.stringify(report)).not.toMatch(/"(?:matchScore|score|fit|probability|percent)"/i);
    const md = renderMatchMarkdown(report);
    expect(md).toContain("no match score");
    expect(md).toContain("missing evidence");
    // read-only: not one fact, status or revision changed, and no employment was created or approved
    expect(await snapshot()).toEqual(before);
    expect((await h.pool.query("SELECT count(*) AS n FROM candidate_facts WHERE kind='employment' AND approval_status='approved' AND fact_id NOT IN (SELECT fact_id FROM candidate_facts WHERE resume_version_id IN (SELECT id FROM resume_versions WHERE resume_id=$1))", [ids.fix])).rows[0].n).toBe("0");
  });

  it("a confirmed-but-not-ingested employment statement never fills the gap", async () => {
    await profiles.confirmEmployment(userId, { employer: "Cognizant Technology Solutions", title: "Programmer Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional", statement: "stated by the candidate (test)", actor: "t" });
    const report = complete(await match());
    expect(report.requirements.find((r) => r.value === "security operations experience")!.status).toBe("UNSUPPORTED");
    expect(report.evidence.unitsSearched).toBe((await corpus()).units.length);
    expect((await corpus()).employment).toEqual([]);
  });

  it("changing the authorized sources changes the result, and an unauthorized profile yields no evidence at all", async () => {
    await profiles.classify(userId, { resumeId: ids.real, provenance: "personal", authorized: false, basis: "owner pulled the résumé (test)", actor: "t" });
    const none = complete(await match());
    expect(none.evidence.unitsSearched).toBe(0);
    expect(none.requirements.every((r) => r.status !== "SUPPORTED")).toBe(true);
    await profiles.classify(userId, { resumeId: ids.real, provenance: "personal", authorized: true, basis: "owner restored the résumé (test)", actor: "t" });
    expect(complete(await match()).requirements.find((r) => r.value === "Python")!.status).toBe("PARTIAL");
  });

  it("works with AI off: no encoder means the deterministic baseline still decides", async () => {
    const off = complete(await match(new RulesJobSemanticProvider(), null));
    expect(off.retrieval.semantic).toBe("NOT_CONFIGURED");
    expect(off.requirements.find((r) => r.value === "Python")!.status).toBe("PARTIAL");
    expect(off.requirements.every((r) => r.retrievalLeads.every((l) => l.semanticRank === null))).toBe(true);
  });

  it("fails closed: a throwing provider or a proposal with an invented quotation produces no decisions", async () => {
    const throwing: JobSemanticProvider = { revision: "test:throws", extractJob: async () => { throw new Error("model exploded"); } };
    const r1 = await match(throwing);
    expect(r1.status).toBe("EXTRACTION_FAILED");
    expect(JSON.stringify(r1)).not.toContain("model exploded");
    const invented: JobSemanticProvider = {
      revision: "test:invents",
      extractJob: async ({ rawJd }) => ({ requirements: [{ id: "x1", type: "skill", value: "Ghidra", level: "required", minimumYears: null, scope: { kind: "unspecified", value: null }, groupId: null, evidence: [{ quote: "Expert in Ghidra reverse engineering", start: 0, end: 36 }] }], rawJdLength: rawJd.length }),
    };
    const r2 = await match(invented);
    expect(r2).toMatchObject({ status: "EXTRACTION_FAILED" });
    expect("requirements" in r2).toBe(false);
    // a valid-looking proposal that quotes text which is not in the JD is rejected as a whole
    const fabricated: JobSemanticProvider = {
      revision: "test:fabricates",
      extractJob: async () => ({ requirements: [{ id: "x1", type: "skill", value: "Ghidra", level: "required", minimumYears: null, scope: { kind: "unspecified", value: null }, groupId: null, evidence: [{ quote: "Expert in Ghidra", start: 0, end: 16 }] }] }),
    };
    expect((await match(fabricated)).status).toBe("EXTRACTION_FAILED");
  });

  it("reads a stored S3 job revision from PostgreSQL and runs the same pipeline", async () => {
    const jd = makeJob(SYNTHETIC_JD);
    const job = await h.pool.query(
      "INSERT INTO jobs (ats_identity, company, ats, board, requisition_id, title, location, canonical_url) VALUES ('greenhouse:examplecorp:42','Examplecorp','greenhouse','examplecorp','42','Security Analyst I','Remote','https://boards.example.test/42') RETURNING id");
    const rev = await h.pool.query("INSERT INTO job_revisions (job_id, jd_sha256, title, location, description_text) VALUES ($1,$2,'Security Analyst I','Remote',$3) RETURNING id", [job.rows[0].id, jd.jdContentHash, SYNTHETIC_JD]);
    await h.pool.query("UPDATE jobs SET current_revision_id=$1 WHERE id=$2", [rev.rows[0].id, job.rows[0].id]);
    const loaded = await loadPgJob(h.pool, "greenhouse:examplecorp:42");
    expect(loaded.jdContentHash).toBe(jd.jdContentHash);
    const report = complete(await runMatch({ job: loaded, provider: new RulesJobSemanticProvider(), corpus: await corpus(), asOf: TODAY }));
    expect(report.job.jdSha256).toBe(jd.jdContentHash);
    expect(report.requirements.length).toBeGreaterThan(8);
  });

  it("with an approved, classified, tagged professional employment fact the years requirements are computed, not inferred", async () => {
    // a corrected résumé version is uploaded, authorized and its employment approved by a person
    const text = ["Casey Real", "EXPERIENCE", "Examplecorp | SOC Analyst | Jan 2022 – Jul 2023"].join("\n");
    RESPONSES.corrected = response(text, [{ kind: "employment", value: "Examplecorp — SOC Analyst", quote: "Examplecorp | SOC Analyst | Jan 2022 – Jul 2023", attributes: { employer: "Examplecorp", title: "SOC Analyst", startDate: "2022-01", endDate: "2023-07", employmentType: "professional", roleTags: ["security operations"] } }]);
    const s = await login(h);
    const id = (await upload(h, s, docxBytes("#corrected#"), "corrected.docx")).json().resumeId as string;
    await h.queue.idle();
    await profiles.classify(userId, { resumeId: id, provenance: "personal", authorized: true, basis: "corrected résumé of the owner (test)", actor: "t" });
    // role tags are a human step (the parser cannot propose them): the owner edits the fact, then approves the edited content
    let f = (await h.repo.listFacts(userId, id))[0]!;
    await h.repo.applyReview(userId, "local", f.factId, { action: "edit", actor: "local", today: TODAY, expectedDigest: f.contentDigest, edit: { attributes: { ...f.attributes, roleTags: ["security operations"] } } });
    f = (await h.repo.listFacts(userId, id))[0]!;
    await h.repo.applyReview(userId, "local", f.factId, { action: "approve", actor: "local", today: TODAY, expectedDigest: f.contentDigest });
    const report = complete(await match());
    const years = report.requirements.find((r) => r.value === "security operations experience")!;
    expect(years).toMatchObject({ status: "PARTIAL" }); // 18 months of tagged security-operations employment against 2+ years
    expect(years.explanation).toMatch(/1\.5 years/);
    expect(years.support[0]).toMatchObject({ factId: f.factId, resumeId: id, basis: "computed-months" });
    // projects still add nothing: the Splunk tool-years requirement has no employment linked to Splunk
    expect(report.requirements.find((r) => r.value === "Splunk")!.status).toBe("PARTIAL");
  });
});

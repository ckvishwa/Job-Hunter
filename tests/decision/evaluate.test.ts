import { describe, expect, it } from "vitest";
import { decisionKey, decisionStaleness, evaluateJob, normalizeTerm, POLICY_V1, type Decision, type ExtractionReview } from "../../src/decision/evaluate.js";
import { profileDigest } from "../../src/domain/candidate-profile.js";
import { AS_OF, ATTESTED, JD_HASH, fact, job, profile, review, stated } from "../helpers/decision-fixtures.js";

// Expected outcomes are reasoned by hand from the policy in src/decision/evaluate.ts (PASS needs an approved
// current fact; FAIL needs a demonstrated shortfall or an explicit "lacks"; otherwise UNKNOWN; any mandatory
// FAIL -> REJECT, else any mandatory UNKNOWN or unattested coverage -> REVIEW, else ELIGIBLE). Months are
// counted end minus start. Boundary: pure functions over synthetic data.

const run = (j: ReturnType<typeof job>, p: ReturnType<typeof profile>, r: ExtractionReview | null = review()): Decision => evaluateJob({ structured: j, profile: p, review: r, asOf: AS_OF, evaluatedAt: "2026-10-07T12:00:00.000Z" });
const rule = (d: Decision, id: string) => d.rules.find((r) => r.ruleId === id)!;

const python = fact({ factId: "f-python", kind: "skill", value: "Python" });
const reqPython = { type: "language" as const, value: "Python" };

describe("approved vs pending, rejected, expired and unverified facts", () => {
  it("an approved current fact passes and the result carries the JD evidence and the fact id", () => {
    const d = run(job({ requirements: [reqPython] }), profile([python]));
    const r = rule(d, "req:r1");
    expect(r.status).toBe("PASS");
    expect(r.factIds).toEqual(["f-python"]);
    expect(r.evidence).toEqual([{ quote: "evidence text", start: 100, end: 113 }]);
    expect(r.mandatory).toBe(true);
  });

  it("a PENDING fact cannot satisfy a requirement and the explanation says why", () => {
    const d = run(job({ requirements: [reqPython] }), profile([fact({ factId: "f-python", kind: "skill", value: "Python", pending: true })]));
    expect(rule(d, "req:r1").status).toBe("UNKNOWN");
    expect(rule(d, "req:r1").explanation).toContain("pending approval");
    expect(d.outcome).toBe("REVIEW");
  });

  it("a REJECTED fact and an EXPIRED fact do not satisfy a requirement either", () => {
    const rejected = fact({ factId: "f-py-r", kind: "skill", value: "Python", approvalStatus: "rejected" });
    expect(rule(run(job({ requirements: [reqPython] }), profile([rejected])), "req:r1").status).toBe("UNKNOWN");
    const expired = fact({ factId: "f-py-e", kind: "skill", value: "Python", verification: { validUntil: "2026-01-01" } });
    const d = run(job({ requirements: [reqPython] }), profile([expired]));
    expect(rule(d, "req:r1").status).toBe("UNKNOWN");
    expect(rule(d, "req:r1").explanation).toContain("expired on 2026-01-01");
  });

  it("a fact that expires later is still current", () => {
    const later = fact({ factId: "f-py-l", kind: "skill", value: "Python", verification: { validUntil: "2027-01-01" } });
    expect(rule(run(job({ requirements: [reqPython] }), profile([later])), "req:r1").status).toBe("PASS");
  });

  it("matches by normalized exact term or a reviewed synonym, never by resemblance", () => {
    expect(normalizeTerm("TS")).toBe("typescript");
    expect(normalizeTerm("  Node.js ")).toBe("node.js");
    const ts = fact({ factId: "f-ts", kind: "skill", value: "TypeScript" });
    expect(rule(run(job({ requirements: [{ type: "language", value: "TS" }] }), profile([ts])), "req:r1").status).toBe("PASS");
    const playwright = fact({ factId: "f-pw", kind: "skill", value: "Playwright" });
    expect(rule(run(job({ requirements: [{ type: "tool", value: "Selenium" }] }), profile([playwright])), "req:r1").status).toBe("UNKNOWN");
    const java = fact({ factId: "f-java", kind: "skill", value: "Java" });
    expect(rule(run(job({ requirements: [{ type: "language", value: "JavaScript" }] }), profile([java])), "req:r1").status).toBe("UNKNOWN");
  });

  it("an approved skill fact can carry its own matchTerms", () => {
    const k8s = fact({ factId: "f-k", kind: "skill", value: "Container orchestration", attributes: { matchTerms: ["Kubernetes"] } });
    expect(rule(run(job({ requirements: [{ type: "tool", value: "Kubernetes" }] }), profile([k8s])), "req:r1").status).toBe("PASS");
  });

  it("conflicting approved facts (has + lacks) are UNKNOWN, not resolved by guesswork", () => {
    const lacks = fact({ factId: "f-py-lacks", kind: "skill", value: "Python", polarity: "lacks" });
    expect(rule(run(job({ requirements: [reqPython] }), profile([python, lacks])), "req:r1").status).toBe("UNKNOWN");
  });
});

describe("required vs preferred", () => {
  it("a missing mandatory skill is UNKNOWN and sends the job to REVIEW (absence is not a demonstrated lack)", () => {
    const d = run(job({ requirements: [reqPython] }), profile([]));
    expect(rule(d, "req:r1").status).toBe("UNKNOWN");
    expect(d.outcome).toBe("REVIEW");
    expect(d.unresolvedQuestions.join("\n")).toContain("Python");
  });

  it("an explicit 'lacks' on a mandatory skill is a demonstrated failure: REJECT", () => {
    const lacks = fact({ factId: "f-py-lacks", kind: "skill", value: "Python", polarity: "lacks" });
    const d = run(job({ requirements: [reqPython] }), profile([lacks]));
    expect(rule(d, "req:r1").status).toBe("FAIL");
    expect(d.outcome).toBe("REJECT");
    expect(d.reasons[0]).toContain("Mandatory criterion not met");
  });

  it("preferred gaps never become mandatory failures: a failed or unknown preferred criterion still leaves ELIGIBLE", () => {
    const lacksK8s = fact({ factId: "f-k8s-lacks", kind: "skill", value: "Kubernetes", polarity: "lacks" });
    const j = job({ requirements: [reqPython, { type: "tool", value: "Kubernetes", level: "preferred" }, { type: "tool", value: "Terraform", level: "preferred" }] });
    const d = run(j, profile([python, lacksK8s]));
    expect(rule(d, "req:r2")).toMatchObject({ status: "FAIL", mandatory: false });
    expect(rule(d, "req:r3")).toMatchObject({ status: "UNKNOWN", mandatory: false });
    expect(d.counts).toEqual({ mandatory: { pass: 2, fail: 0, unknown: 0 }, preferred: { pass: 0, fail: 1, unknown: 1 } });
    expect(d.outcome).toBe("ELIGIBLE");
  });

  it("a requirement whose level the JD left unclear is not treated as mandatory", () => {
    const d = run(job({ requirements: [reqPython, { type: "tool", value: "Terraform", level: "unknown" }] }), profile([python]));
    expect(rule(d, "req:r2").mandatory).toBe(false);
    expect(d.outcome).toBe("ELIGIBLE");
  });
});

describe("OR alternatives and mixed AND/OR", () => {
  const selenium = { type: "tool" as const, value: "Selenium", groupId: "g1" };
  const playwright = { type: "tool" as const, value: "Playwright", groupId: "g1" };

  it("one satisfied alternative satisfies the whole group, and only that fact is cited", () => {
    const d = run(job({ requirements: [selenium, playwright], groups: ["g1"] }), profile([fact({ factId: "f-pw", kind: "skill", value: "Playwright" })]));
    expect(rule(d, "group:g1")).toMatchObject({ status: "PASS", factIds: ["f-pw"], mandatory: true });
    expect(rule(d, "group:g1").explanation).toContain("Selenium -> UNKNOWN");
    expect(d.outcome).toBe("ELIGIBLE");
  });

  it("no satisfied alternative and some undecidable -> UNKNOWN; every alternative explicitly lacked -> FAIL", () => {
    const j = job({ requirements: [selenium, playwright], groups: ["g1"] });
    expect(rule(run(j, profile([])), "group:g1").status).toBe("UNKNOWN");
    const lacks = [fact({ factId: "f-1", kind: "skill", value: "Selenium", polarity: "lacks" }), fact({ factId: "f-2", kind: "skill", value: "Playwright", polarity: "lacks" })];
    const d = run(j, profile(lacks));
    expect(rule(d, "group:g1").status).toBe("FAIL");
    expect(d.outcome).toBe("REJECT");
  });

  it("(Java OR Python) AND Kubernetes: the OR group passes but the unmet AND requirement keeps the job in REVIEW", () => {
    const j = job({
      requirements: [{ type: "language", value: "Java", groupId: "g1" }, { type: "language", value: "Python", groupId: "g1" }, { type: "tool", value: "Kubernetes" }],
      groups: ["g1"],
    });
    const d = run(j, profile([python]));
    expect(rule(d, "group:g1").status).toBe("PASS");
    expect(rule(d, "req:r3").status).toBe("UNKNOWN");
    expect(d.outcome).toBe("REVIEW");
  });
});

describe("scoped experience and overlapping dates", () => {
  const roleReq = { type: "role_experience" as const, value: "Security Engineering", minimumYears: 5, scope: { kind: "role" as const, value: "Security Engineering" } };
  const emp = (id: string, start: string, end: string | null, tags: string[] | undefined) =>
    fact({ factId: id, kind: "employment", value: `Employer ${id}`, attributes: { employer: `Employer ${id}`, title: "Engineer", startDate: start, endDate: end, ...(tags ? { roleTags: tags } : {}) } });

  it("overlapping jobs are counted once: 30 + 30 overlapping months is 42, below 5 years", () => {
    // A: 2018-01..2020-07 = 30 months. B: 2019-01..2021-07 = 30 months. Union 2018-01..2021-07 = 42 months (3.5 y).
    // A naive sum would be 60 months = exactly 5 years and would wrongly pass.
    const facts = [emp("a", "2018-01", "2020-07", ["Security Engineering"]), emp("b", "2019-01", "2021-07", ["Security Engineering"])];
    const unattested = rule(run(job({ requirements: [roleReq] }), profile(facts)), "req:r1");
    expect(unattested.status).toBe("UNKNOWN");
    expect(unattested.explanation).toContain("3.5 years");
    expect(unattested.factIds).toEqual(["a", "b"]);
    const attested = run(job({ requirements: [roleReq] }), profile(facts, { employmentHistoryComplete: ATTESTED }));
    expect(rule(attested, "req:r1").status).toBe("FAIL");
    expect(attested.outcome).toBe("REJECT");
  });

  it("non-overlapping tagged jobs add up, and a current job runs to the as-of date", () => {
    // 2016-01..2019-01 = 36 months; 2020-10..current(2026-10) = 72 months; total 108 months = 9 years.
    const facts = [emp("a", "2016-01", "2019-01", ["Security Engineering"]), emp("b", "2020-10", null, ["security engineering"])];
    const r = rule(run(job({ requirements: [roleReq] }), profile(facts)), "req:r1");
    expect(r.status).toBe("PASS");
    expect(r.explanation).toContain("9.0 years");
  });

  it("role experience is never inferred from a job title: an untagged 'Security Engineer' job proves nothing", () => {
    const untagged = fact({ factId: "a", kind: "employment", value: "Co — Security Engineer", attributes: { employer: "Co", title: "Security Engineer", startDate: "2010-01", endDate: "2024-01" } });
    const r = rule(run(job({ requirements: [roleReq] }), profile([untagged], { employmentHistoryComplete: ATTESTED })), "req:r1");
    expect(r.status).toBe("UNKNOWN");
    expect(r.explanation).toContain("never inferred from a job title");
  });

  it("role-years and tool-years are separate: Python years come only from employment the Python fact links to", () => {
    const pyReq = { type: "language" as const, value: "Python", minimumYears: 3, scope: { kind: "tool" as const, value: "Python" } };
    const jobA = emp("a", "2020-01", "2021-07", undefined); // 18 months
    const jobB = emp("b", "2015-01", "2019-01", undefined); // 48 months, NOT linked to Python
    const linked = fact({ factId: "f-py", kind: "skill", value: "Python", attributes: { experienceIds: ["a"] } });
    const shortfall = rule(run(job({ requirements: [pyReq] }), profile([jobA, jobB, linked])), "req:r1");
    expect(shortfall.status).toBe("UNKNOWN");
    expect(shortfall.explanation).toContain("1.5 years");
    expect(shortfall.factIds).toEqual(["f-py", "a"]);
    const both = fact({ factId: "f-py", kind: "skill", value: "Python", attributes: { experienceIds: ["a", "b"] } });
    expect(rule(run(job({ requirements: [pyReq] }), profile([jobA, jobB, both])), "req:r1").status).toBe("PASS"); // 66 months = 5.5 y
  });

  it("a skill mention alone, or a project, never creates professional years", () => {
    const pyReq = { type: "language" as const, value: "Python", minimumYears: 3, scope: { kind: "tool" as const, value: "Python" } };
    const noLink = rule(run(job({ requirements: [pyReq] }), profile([python, emp("a", "2010-01", "2024-01", undefined)])), "req:r1");
    expect(noLink.status).toBe("UNKNOWN");
    expect(noLink.explanation).toContain("links to no approved employment");
    const project = fact({ factId: "p1", kind: "project", value: "Big Project", attributes: { technologies: ["Python"], startDate: "2015-01", endDate: "2024-01" } });
    expect(rule(run(job({ requirements: [pyReq] }), profile([project])), "req:r1").status).toBe("UNKNOWN");
  });

  it("unusable (pending) employment is excluded from years", () => {
    const pending = fact({ factId: "a", kind: "employment", value: "Co", pending: true, attributes: { employer: "Co", title: "E", startDate: "2000-01", endDate: "2020-01", roleTags: ["Security Engineering"] } });
    const r = rule(run(job({ requirements: [roleReq] }), profile([pending])), "req:r1");
    expect(r.status).toBe("UNKNOWN");
    expect(r.explanation).toContain("pending approval");
  });

  it("general 'N+ years of experience' uses the overlap-safe union of all approved employment", () => {
    const generic = { type: "role_experience" as const, value: "professional experience", minimumYears: 3, scope: { kind: "unspecified" as const, value: null } };
    // 2020-01..2021-07 (18) + 2021-01..2022-07 overlapping: union 2020-01..2022-07 = 30 months = 2.5 y < 3
    const facts = [emp("a", "2020-01", "2021-07", undefined), emp("b", "2021-01", "2022-07", undefined)];
    const unattested = rule(run(job({ requirements: [generic] }), profile(facts)), "req:r1");
    expect(unattested.status).toBe("UNKNOWN");
    expect(unattested.explanation).toContain("2.5 years");
    expect(unattested.factIds).toEqual(["a", "b"]);
    expect(rule(run(job({ requirements: [generic] }), profile(facts, { employmentHistoryComplete: ATTESTED })), "req:r1").status).toBe("FAIL");
    // Adding a later job brings the union to 2020-01..2023-07 = 42 months = 3.5 years.
    const more = [...facts, emp("c", "2022-01", "2023-07", undefined)];
    expect(rule(run(job({ requirements: [generic] }), profile(more)), "req:r1").status).toBe("PASS");
  });
});

describe("constraints: sensitive facts are explicit, sponsorship is record-only, location needs a configured preference", () => {
  const sponsorStmt = stated("We are unable to sponsor visas.", 40);

  it("sponsorship statements are recorded and never reject, even when the candidate states they need sponsorship", () => {
    const needs = fact({ factId: "f-sp", kind: "sponsorship_need", value: "Will require sponsorship" });
    const j = job({ requirements: [reqPython], constraints: [{ type: "sponsorship", status: "not_offered", value: "visa sponsorship", evidence: [sponsorStmt] }] });
    const d = run(j, profile([python, needs]));
    expect(d.outcome).toBe("ELIGIBLE");
    expect(d.rules.some((r) => r.subject.id === "c1")).toBe(false);
    expect(d.recordedStatements).toEqual([expect.objectContaining({ type: "sponsorship", status: "not_offered", value: "visa sponsorship", evidence: [sponsorStmt], handling: expect.stringContaining("disabled by policy") })]);
    expect(POLICY_V1.sponsorship).toBe("record_only");
  });

  it("a JD that says nothing about clearance or sponsorship adds no restriction", () => {
    const j = job({ requirements: [reqPython], constraints: ["clearance", "sponsorship", "citizenship", "work_authorization"].map((type) => ({ type: type as never, status: "unknown" as const })) });
    const d = run(j, profile([python]));
    expect(d.rules.filter((r) => r.subject.kind === "constraint")).toEqual([]);
    expect(d.outcome).toBe("ELIGIBLE");
  });

  it("a stated clearance requirement without an explicit approved fact is UNKNOWN (never inferred) -> REVIEW", () => {
    const j = job({ requirements: [reqPython], constraints: [{ type: "clearance", status: "required", value: "TS/SCI", evidence: [stated("Active TS/SCI clearance required.", 200)] }] });
    const d = run(j, profile([python]));
    expect(rule(d, "constraint:c1").status).toBe("UNKNOWN");
    expect(rule(d, "constraint:c1").explanation).toContain("never inferred");
    expect(d.outcome).toBe("REVIEW");
  });

  it("explicit approved clearance facts decide it: held -> PASS, explicitly not held -> FAIL", () => {
    const c = { type: "clearance" as const, status: "required" as const, value: "TS/SCI", evidence: [stated("Active TS/SCI clearance required.", 200)] };
    const held = fact({ factId: "f-cl", kind: "clearance", value: "TS/SCI" });
    expect(rule(run(job({ requirements: [reqPython], constraints: [c] }), profile([python, held])), "constraint:c1")).toMatchObject({ status: "PASS", factIds: ["f-cl"] });
    const none = fact({ factId: "f-cl-no", kind: "clearance", value: "TS/SCI", polarity: "lacks" });
    const d = run(job({ requirements: [reqPython], constraints: [c] }), profile([python, none]));
    expect(rule(d, "constraint:c1").status).toBe("FAIL");
    expect(d.outcome).toBe("REJECT");
  });

  it("work authorization comes only from an explicit approved fact; education or employment never imply it", () => {
    const c = { type: "work_authorization" as const, status: "required" as const, value: "authorized to work in the United States", evidence: [stated("You must be authorized to work in the United States.", 300)] };
    const history = fact({ factId: "e", kind: "employment", value: "US Corp", attributes: { startDate: "2010-01", endDate: "2020-01" } });
    expect(rule(run(job({ requirements: [reqPython], constraints: [c] }), profile([python, history])), "constraint:c1").status).toBe("UNKNOWN");
    const auth = fact({ factId: "f-auth", kind: "work_authorization", value: "authorized to work in the United States" });
    expect(rule(run(job({ requirements: [reqPython], constraints: [c] }), profile([python, auth])), "constraint:c1").status).toBe("PASS");
  });

  it("location: with no configured preference the JD statement is recorded only; a configured mandatory preference decides", () => {
    const loc = { type: "location" as const, status: "required" as const, value: "US hubs or remotely in the United States", evidence: [stated("remotely in the United States", 400)] };
    const j = job({ requirements: [reqPython], constraints: [loc] });
    const none = run(j, profile([python]));
    expect(none.rules.some((r) => r.subject.kind === "preference")).toBe(false);
    expect(none.recordedStatements[0]!.handling).toContain("no location/work-mode preference");
    const pref = (terms: string[], strength: "mandatory" | "preferred") => ({ locationWorkMode: { terms, strength, approvedBy: "synthetic-reviewer", approvedAt: "2026-09-01" } });
    expect(rule(run(j, profile([python], { preferences: pref(["united states"], "mandatory") })), "constraint:c1").status).toBe("PASS");
    const miss = run(j, profile([python], { preferences: pref(["germany"], "mandatory") }));
    expect(rule(miss, "constraint:c1").status).toBe("FAIL");
    expect(miss.outcome).toBe("REJECT");
    const soft = run(j, profile([python], { preferences: pref(["germany"], "preferred") }));
    expect(soft.outcome).toBe("ELIGIBLE");
    expect(soft.recordedStatements[0]!.handling).toContain("not mandatory");
  });
});

describe("extraction coverage and the outcome", () => {
  const passing = () => job({ requirements: [reqPython] });

  it("complete passing evidence with an attested-complete review is ELIGIBLE", () => {
    const d = run(passing(), profile([python]));
    expect(d.outcome).toBe("ELIGIBLE");
    expect(rule(d, "coverage:extraction").status).toBe("PASS");
    expect(d.extraction).toMatchObject({ coverage: "complete", reviewedBy: "reviewer-a", provenance: "MANUAL_ANNOTATION" });
    expect(d.unresolvedQuestions).toEqual([]);
  });

  it.each([
    ["partial coverage", review({ coverage: "partial", omissions: ["responsibilities", "compensation"] }), "partial"],
    ["no review record", null, "No extraction review record"],
    ["review for a different JD revision", review({ jdHash: "b".repeat(64) }), "different JD revision"],
    ["complete but nobody named as reviewer", review({ reviewedBy: null }), "no reviewer name"],
    ["complete but no review date", review({ reviewedAt: null }), "no reviewer name"],
  ])("never ELIGIBLE on %s, even when every extracted requirement passes", (_name, r, text) => {
    const d = run(passing(), profile([python]), r);
    expect(d.outcome).toBe("REVIEW");
    expect(rule(d, "coverage:extraction").status).toBe("UNKNOWN");
    expect(rule(d, "coverage:extraction").explanation).toContain(text);
    expect(rule(d, "req:r1").status).toBe("PASS");
    expect(d.unresolvedQuestions.join("\n")).toContain("Who reviewed the extraction");
  });

  it("partial coverage records the known omissions in the decision", () => {
    const d = run(passing(), profile([python]), review({ coverage: "partial", omissions: ["responsibilities not annotated"] }));
    expect(d.extraction.omissions).toEqual(["responsibilities not annotated"]);
    expect(rule(d, "coverage:extraction").explanation).toContain("responsibilities not annotated");
  });

  it("a demonstrated failure still REJECTs under partial coverage, and says the rejection rests on what was extracted", () => {
    const lacks = fact({ factId: "f-l", kind: "skill", value: "Python", polarity: "lacks" });
    const d = run(passing(), profile([lacks]), review({ coverage: "partial" }));
    expect(d.outcome).toBe("REJECT");
    expect(d.reasons.join(" ")).toContain("not attested complete");
  });

  it("an extraction with no mandatory criteria cannot be ELIGIBLE", () => {
    const d = run(job({ requirements: [{ type: "tool", value: "Terraform", level: "preferred" }] }), profile([]));
    expect(d.outcome).toBe("REVIEW");
    expect(d.reasons.join(" ")).toContain("no mandatory criteria");
  });

  it("REJECT takes precedence over unknowns", () => {
    const lacks = fact({ factId: "f-l", kind: "skill", value: "Python", polarity: "lacks" });
    const d = run(job({ requirements: [reqPython, { type: "tool", value: "Terraform" }] }), profile([lacks]));
    // Python lacked (1 fail), Terraform undecidable (1 unknown), coverage attested (1 pass).
    expect(d.counts.mandatory).toEqual({ pass: 1, fail: 1, unknown: 1 });
    expect(d.outcome).toBe("REJECT");
  });
});

describe("decision identity and staleness", () => {
  const base = () => run(job({ requirements: [reqPython] }), profile([python]));

  it("records job, JD hash, profile version and digest, policy version and extraction provenance", () => {
    const d = base();
    expect(d).toMatchObject({ schemaVersion: 1, jobId: "job-1", jdHash: JD_HASH, structuredId: "job-1::s", candidateId: "synthetic-candidate", profileVersion: "test.1", policyVersion: "decision-policy@1", asOf: AS_OF });
    expect(d.profileDigest).toBe(profileDigest(profile([python])));
    expect(d.id).toBe(decisionKey({ jobId: "job-1", jdHash: JD_HASH, structuredId: "job-1::s", profileDigest: d.profileDigest, policyVersion: "decision-policy@1" }));
    expect(d.extraction.providerRevision).toBe("fixture:MANUAL_ANNOTATION:test");
  });

  it("is deterministic for identical inputs", () => {
    expect(base()).toEqual(base());
  });

  it("a changed JD, extraction, profile content (even with the same profileVersion) or policy makes the decision stale", () => {
    const d = base();
    const current = { jdHash: d.jdHash, structuredId: d.structuredId, profileDigest: d.profileDigest, policyVersion: d.policyVersion };
    expect(decisionStaleness(d, current)).toEqual([]);
    expect(decisionStaleness(d, { ...current, jdHash: "c".repeat(64) })).toEqual(["the job description changed"]);
    expect(decisionStaleness(d, { ...current, structuredId: "other" })).toEqual(["the structured extraction changed"]);
    expect(decisionStaleness(d, { ...current, policyVersion: "decision-policy@2" })).toEqual(["the decision policy changed"]);
    const edited = profile([fact({ factId: "f-python", kind: "skill", value: "Python", notes: "edited after approval" })]);
    expect(edited.profileVersion).toBe("test.1");
    expect(decisionStaleness(d, { ...current, profileDigest: profileDigest(edited) })).toEqual(["the candidate profile changed"]);
  });

  it("the profile digest ignores key order but not content", () => {
    const a = profile([python]);
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
    const reordered = reverseKeys(a) as typeof a;
    expect(profileDigest(reordered)).toBe(profileDigest(a));
    expect(profileDigest(profile([python, fact({ factId: "f-x", kind: "skill", value: "Go" })]))).not.toBe(profileDigest(a));
  });
});

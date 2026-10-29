import { describe, expect, it } from "vitest";
import { analyzeJd } from "../../src/match/analyze.js";
import { decideConditions, decideRequirements, rollupItems } from "../../src/match/decide.js";
import type { EligibilityFact, EvidenceCorpus, EvidenceUnit } from "../../src/match/evidence.js";
import { Lexicon } from "../../src/match/lexicon.js";
import { RulesJobSemanticProvider } from "../../src/match/rules-provider.js";
import { runMatch } from "../../src/match/pipeline.js";
import { decideMatch } from "../../src/match/intelligence.js";
import { EvidenceIndex, queryFor, rrf, type RetrievalResult } from "../../src/match/retrieval.js";
import { parseCanonicalJob } from "../../src/semantic/parse-job.js";
import type { CandidateFact } from "../../src/domain/candidate-profile.js";
import { SYNTHETIC_JD, makeJob } from "./helpers.js";

const lex = Lexicon.load();

async function analyze(text: string, over: Record<string, unknown> = {}) {
  const job = makeJob(text, over);
  const res = await parseCanonicalJob(job, new RulesJobSemanticProvider());
  if (!res.ok) throw new Error(`extraction failed: ${JSON.stringify(res.failure.issues)}`);
  return { job, structured: res.structured, analysis: analyzeJd(job, res.structured) };
}

describe("deterministic JD extraction (AI off baseline)", () => {
  it("preserves unqualified Qualifications items as unknown rather than silently dropping them or making them mandatory", async () => {
    const { analysis } = await analyze("About the role\nSupport production networks.\n\nQualifications:\nPython.\nWireshark.\n\nBenefits:\nHealth coverage.");
    expect(analysis.requirements.find((r) => r.value === "Python")).toMatchObject({ level: "unknown", effectiveLevel: "unknown" });
    expect(analysis.requirements.find((r) => r.value === "Wireshark")).toMatchObject({ level: "unknown" });
  });
  it("passes the unchanged production validator: every quote is an exact slice of the JD, ids unique, groups well-formed", async () => {
    const { job, structured } = await analyze(SYNTHETIC_JD);
    for (const r of structured.requirements) for (const e of r.evidence) expect(job.descriptionText.slice(e.start, e.end)).toBe(e.quote);
    expect(new Set(structured.requirements.map((r) => r.id)).size).toBe(structured.requirements.length);
    expect(structured.parserVersion).toBe("structured-job-validator@1");
    expect(structured.providerRevision).toMatch(/^rules-jd-extractor@3/);
  });

  it("an oversized source item still validates, and its quote is an exact slice no longer than 2000 characters", async () => {
    const blob = ["Required Qualifications", "- " + `${"Experience with Splunk and daily alert triage. ".repeat(80)}`].join("\n");
    const { job, structured } = await analyze(blob);
    expect(blob.length).toBeGreaterThan(2000);
    expect(structured.requirements.some((r) => r.value === "Splunk")).toBe(true);
    for (const r of structured.requirements) for (const e of r.evidence) {
      expect(e.quote.length).toBeLessThanOrEqual(2000);
      expect(job.descriptionText.slice(e.start, e.end)).toBe(e.quote);
    }
  });

  it("takes required vs preferred from the section the item sits in", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    const by = (v: string) => analysis.requirements.find((r) => r.value === v)!;
    expect(by("Splunk").level).toBe("required");
    expect(by("CrowdStrike").level).toBe("preferred");
    expect(by("MITRE ATT&CK").level).toBe("preferred");
  });

  it("separates professional, domain, tool and role years, and keeps the lower bound of a range", async () => {
    const { analysis } = await analyze([
      "Minimum Qualifications", "- 2+ years of experience in security operations.", "- 3+ years of experience with Splunk.", "- 5+ years of experience.",
      "- 4 years of experience as a Detection Engineer.", "- 1-2 years of IT or security experience is preferred.",
    ].join("\n"));
    const years = analysis.requirements.filter((r) => r.minimumYears !== null).map((r) => [r.minimumYears, r.yearsKind, r.scopeValue]);
    expect(years).toEqual([[2, "domain", "security operations"], [3, "tool", "Splunk"], [5, "professional", null], [4, "role", "Detection Engineer"], [1, "domain", "IT or security"]]);
  });

  it("derives alternatives only from an explicit OR; a plain list is not an alternative", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    const group = (v: string) => analysis.requirements.find((r) => r.value === v)!.groupId;
    expect(group("Python")).not.toBeNull();
    expect(group("Python")).toBe(group("PowerShell"));
    expect(group("CISSP")).toBe(group("Security+"));
    expect(group("Python")).not.toBe(group("CISSP"));
    const plain = await analyze(["Minimum Qualifications", "- Experience with Windows, macOS, and Linux systems."].join("\n"));
    expect(plain.analysis.requirements.every((r) => r.groupId === null)).toBe(true);
    expect(plain.analysis.requirements.map((r) => r.termRole)).toEqual(["listed", "listed", "listed"]);
  });

  it("marks example terms and negated conditions without dropping the quotation", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    expect(analysis.requirements.find((r) => r.value === "CrowdStrike")!.termRole).toBe("example");
    const k8s = analysis.requirements.find((r) => r.value === "Kubernetes")!;
    expect(k8s).toMatchObject({ negated: true, effectiveLevel: "not_required" });
    expect(k8s.quote.quote).toContain("is not required");
  });

  it("keeps citizenship, clearance, present work authorization and future sponsorship as four separate conditions", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    expect(analysis.conditions.citizenship).toMatchObject({ status: "required", value: "U.S. citizenship" });
    expect(analysis.conditions.work_authorization).toMatchObject({ status: "required", value: "United States" });
    expect(analysis.conditions.sponsorship).toMatchObject({ status: "not_offered" });
    expect(analysis.conditions.clearance.status).toBe("unknown"); // silent: unknown, never "not required"
    expect(analysis.conditions.citizenship.quote!.quote).not.toBe(analysis.conditions.work_authorization.quote!.quote);
    expect(analysis.arrangement).toMatchObject({ mode: "remote", source: "jd-text" });
  });

  it("a clearance requirement is read as clearance only, and silence on sponsorship stays unknown", async () => {
    const { analysis } = await analyze(["Minimum Qualifications", "- Python.", "", "Additional notes", "Candidates must be able to obtain and maintain a Public Trust clearance."].join("\n"));
    expect(analysis.conditions.clearance.status).toBe("required");
    expect(analysis.conditions.sponsorship.status).toBe("unknown");
    expect(analysis.conditions.citizenship.status).toBe("unknown");
    expect(analysis.conditions.work_authorization.status).toBe("unknown");
  });

  it("reads \"the legal right to work in the country where the position is based\" as work authorization, apart from sponsorship", async () => {
    const { analysis } = await analyze(["Minimum Qualifications", "- Python.", "", "Additional notes", "Applicants must have the legal right to work in the country where the position is based, without the need for visa sponsorship. This role does not offer visa sponsorship."].join("\n"));
    expect(analysis.conditions.work_authorization).toMatchObject({ status: "required", value: "the country where the position is based" });
    expect(analysis.conditions.sponsorship.status).toBe("not_offered");
    expect(analysis.conditions.citizenship.status).toBe("unknown");
  });

  it("recognizes \"Must Haves\" and \"What Skills and Knowledge Will You Bring?\" sections, and keeps \"Nice to Have\" preferred", async () => {
    const must = await analyze(["About the Role", "Join us.", "Must Haves", "- 3+ years of experience with Splunk.", "- Experience with Python.", "Nice to Have", "- Experience with Terraform."].join("\n"));
    expect(must.analysis.requirements.find((r) => r.value === "Splunk")).toMatchObject({ level: "required" });
    expect(must.analysis.requirements.find((r) => r.value === "Terraform")).toMatchObject({ level: "preferred" });
    const bring = await analyze(["Our Purpose", "We protect people.", "What Skills and Knowledge Will You Bring?", "Ideal candidates will have:", "- Experience with Splunk.", "Why SentinelOne?", "Great benefits."].join("\n"));
    expect(bring.analysis.requirements.find((r) => r.value === "Splunk")).toMatchObject({ level: "required" });
  });

  it("falls back to posting metadata for the work arrangement and says so", async () => {
    const { analysis } = await analyze(["Minimum Qualifications", "- Python."].join("\n"), { location: "Hybrid - New York", remoteType: null });
    expect(analysis.arrangement).toMatchObject({ mode: "hybrid", source: "posting-metadata" });
  });

  it("an extraction with nothing to extract fails closed (NO_REQUIREMENTS) instead of reporting an empty requirement list", async () => {
    const job = makeJob("We are a friendly company with a nice office and free snacks for everyone.");
    const res = await parseCanonicalJob(job, new RulesJobSemanticProvider());
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------

const fact = (over: Partial<CandidateFact> & { factId: string; kind: CandidateFact["kind"]; value: string }): CandidateFact => ({
  polarity: "has", attributes: {}, source: { kind: "resume-import", reference: "r.pdf" }, verification: { verifiedBy: "owner", verifiedAt: "2026-10-01", validUntil: null }, approvalStatus: "approved", sensitivity: "normal", ...over,
}) as CandidateFact;

function unit(f: CandidateFact, over: Partial<EvidenceUnit> = {}): EvidenceUnit {
  return {
    unitId: `fact:${f.factId}`, factId: f.factId, resumeId: "res-1", category: f.kind as EvidenceUnit["category"], kind: f.kind, value: f.value, text: [f.value, ...(f.attributes.technologies ?? [])].join(". "),
    quote: f.value, span: { start: 0, end: f.value.length }, verification: { verifiedBy: "owner", verifiedAt: "2026-10-01", contentDigest: "d".repeat(64), status: "approved" },
    sourceReference: "r.pdf", attributes: f.attributes, polarity: f.polarity, ...over,
  };
}

function corpusOf(facts: CandidateFact[], eligibility: EligibilityFact[] = [], employment: CandidateFact[] = []): EvidenceCorpus {
  return {
    units: facts.map((f) => unit(f)), eligibility, employment, excluded: [], boundaryExclusions: [],
    version: { profileId: "p", profileKind: "personal", profileRevisionNo: 1, profileDigest: "x", evidenceDigest: "y", factCount: facts.length, authorizedResumeIds: ["res-1"], confirmedEmploymentReferences: 0 },
  };
}

describe("unmodeled eligibility warnings", () => {
  it("keeps an explicit residency restriction in review even when the technical skill is supported", async () => {
    const jd = "About the role\nJoin our SOC team.\n\nMinimum Qualifications\n- Familiarity with Splunk.\n\nAdditional notes\nWe can only accept applications from persons with UK residency (at least five years).";
    const report = await runMatch({ job: makeJob(jd), provider: new RulesJobSemanticProvider(), corpus: corpusOf([fact({ factId: "f-splunk", kind: "skill", value: "Splunk" })]), asOf: "2026-10-21" });
    expect(report.status).toBe("COMPLETE");
    if (report.status !== "COMPLETE") return;
    expect(report.extraction.analysisWarnings).toContain("OTHER_ELIGIBILITY_UNCLASSIFIED:RESIDENCY");
    expect(decideMatch(report).outcome).toBe("REVIEW_REQUIRED");
  });
});

async function decide(jd: string, corpus: EvidenceCorpus, asOf = "2026-10-11") {
  const { analysis } = await analyze(jd);
  const retrieval = new Map<string, RetrievalResult>();
  const index = new EvidenceIndex(corpus.units, null);
  for (const r of analysis.requirements) retrieval.set(r.id, await index.retrieve(queryFor({ id: r.id, value: r.value, type: r.type })));
  return { analysis, ...decideRequirements({ analysis, corpus, retrieval, asOf }) };
}
const status = (res: Awaited<ReturnType<typeof decide>>, value: string) => res.decisions.find((d) => d.value === value)!;

describe("requirement decisions", () => {
  const QUAL = (lines: string[]) => ["Minimum Qualifications", ...lines.map((l) => `- ${l}`)].join("\n");

  it("a category requirement is supported by a member tool, and a familiarity wording accepts a skills-list mention", async () => {
    const res = await decide(QUAL(["Familiarity with detection tools like SIEM, EDR."]), corpusOf([fact({ factId: "f-splunk", kind: "skill", value: "Splunk" })]));
    expect(status(res, "SIEM")).toMatchObject({ status: "SUPPORTED", matchedFactIds: ["f-splunk"] });
    expect(status(res, "SIEM").support[0]).toMatchObject({ basis: "category-member", strength: "mention", quote: "Splunk", resumeId: "res-1" });
    expect(status(res, "EDR").status).toBe("UNSUPPORTED");
    expect(res.decisions.every((d) => d.explanation.length > 0)).toBe(true);
  });

  it("a generic infrastructure mention such as DNS stays PARTIAL until use is shown", async () => {
    const jd = QUAL(["Familiarity with DNS."]);
    const mention = await decide(jd, corpusOf([fact({ factId: "f-dns", kind: "skill", value: "DNS" })]));
    expect(status(mention, "DNS")).toMatchObject({ status: "PARTIAL" });
    const shown = await decide(jd, corpusOf([
      fact({ factId: "f-dns", kind: "skill", value: "DNS" }),
      fact({ factId: "f-p", kind: "project", value: "Resolver", attributes: { technologies: ["DNS"] } }),
    ]));
    expect(status(shown, "DNS")).toMatchObject({ status: "SUPPORTED" });
  });

  it("hands-on wording is only PARTIAL on a skills-list mention, and SUPPORTED once a project demonstrates it", async () => {
    const jd = QUAL(["Experience with Splunk for detection work."]);
    const mention = await decide(jd, corpusOf([fact({ factId: "f-s", kind: "skill", value: "Splunk" })]));
    expect(status(mention, "Splunk")).toMatchObject({ status: "PARTIAL" });
    expect(status(mention, "Splunk").missingEvidence[0]).toMatch(/project, employment or certification/);
    const proj = await decide(jd, corpusOf([fact({ factId: "f-s", kind: "skill", value: "Splunk" }), fact({ factId: "f-p", kind: "project", value: "DetectLab", attributes: { technologies: ["Splunk", "Sysmon"] } })]));
    expect(status(proj, "Splunk")).toMatchObject({ status: "SUPPORTED" });
    expect(status(proj, "Splunk").support.map((s) => s.factId)).toContain("f-p");
  });

  it("projects never become professional years, and a skill mention never becomes a duration", async () => {
    const corpus = corpusOf([fact({ factId: "f-s", kind: "skill", value: "Splunk" }), fact({ factId: "f-p", kind: "project", value: "SOC lab", attributes: { technologies: ["Splunk"] } })]);
    const res = await decide(QUAL(["2+ years of experience in security operations.", "3+ years of experience with Splunk.", "5+ years of experience."]), corpus);
    expect(status(res, "security operations experience")).toMatchObject({ status: "UNSUPPORTED" });
    expect(status(res, "security operations experience").notCounted.map((n) => n.factId)).toContain("f-p");
    expect(status(res, "security operations experience").missingEvidence.join(" ")).toMatch(/professional employment/);
    expect(status(res, "Splunk")).toMatchObject({ status: "PARTIAL" }); // the tool is evidenced, its duration is not
    expect(status(res, "Splunk").explanation).toMatch(/never inferred/);
    expect(status(res, "professional experience")).toMatchObject({ status: "UNSUPPORTED" });
  });

  it("professional years come only from approved professional employment, overlap-safe, and compare to the minimum", async () => {
    const job = (id: string, start: string, end: string | null, over: Record<string, unknown> = {}) => fact({ factId: id, kind: "employment", value: id, attributes: { employer: id, title: "Analyst", startDate: start, ...(end ? { endDate: end } : { endDate: null }), employmentType: "professional", ...over } as never });
    const employment = [job("e1", "2022-01", "2023-07")];
    const corpus = corpusOf(employment, [], employment);
    const enough = await decide(QUAL(["1+ years of experience."]), corpus);
    expect(status(enough, "professional experience")).toMatchObject({ status: "SUPPORTED", matchedFactIds: ["e1"] });
    expect(status(enough, "professional experience").support[0]!.basis).toBe("computed-months");
    const short = await decide(QUAL(["5+ years of experience."]), corpus);
    expect(status(short, "professional experience").status).toBe("PARTIAL");
    // an internship is not professional experience
    const intern = [job("i1", "2022-09", "2023-05", { employmentType: "internship" })];
    expect(status(await decide(QUAL(["1+ years of experience."]), corpusOf(intern, [], intern)), "professional experience").status).toBe("UNSUPPORTED");
  });

  it("a domain-scoped duration needs employment tagged for that field; titles and skills are never enough", async () => {
    const e = fact({ factId: "e1", kind: "employment", value: "QA Analyst", attributes: { employer: "Acme", title: "QA Analyst", startDate: "2021-01", endDate: "2023-01", employmentType: "professional" } });
    const untagged = await decide(QUAL(["2+ years of experience in security operations."]), corpusOf([e], [], [e]));
    expect(status(untagged, "security operations experience").status).toBe("UNKNOWN");
    const tagged = fact({ factId: "e2", kind: "employment", value: "SOC Analyst", attributes: { employer: "Acme", title: "SOC Analyst", startDate: "2021-01", endDate: "2023-06", employmentType: "professional", roleTags: ["security operations"] } });
    expect(status(await decide(QUAL(["2+ years of experience in security operations."]), corpusOf([tagged], [], [tagged])), "security operations experience").status).toBe("SUPPORTED");
  });

  it("alternatives: one satisfied branch satisfies the group", async () => {
    const res = await decide(QUAL(["CISSP or Security+ certification."]), corpusOf([fact({ factId: "f-c", kind: "certification", value: "CompTIA Security+" })]));
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ status: "SUPPORTED", satisfiedBy: expect.any(Array) });
    expect(status(res, "CISSP").status).toBe("UNSUPPORTED");
    expect(status(res, "Security+").status).toBe("SUPPORTED");
  });

  it("a certification requirement is met by a certification fact, not by a skill that shares its name", async () => {
    const res = await decide(QUAL(["CISSP certification."]), corpusOf([fact({ factId: "f-s", kind: "skill", value: "CISSP" })]));
    expect(status(res, "CISSP").status).toBe("UNSUPPORTED");
  });

  it("an explicit 'lacks' fact is the only thing that sets explicitLack", async () => {
    const res = await decide(QUAL(["Experience with Kubernetes and Docker."]), corpusOf([fact({ factId: "f-l", kind: "skill", value: "Kubernetes", polarity: "lacks" })]));
    expect(status(res, "Kubernetes")).toMatchObject({ status: "UNSUPPORTED", explicitLack: true });
    expect(status(res, "Docker")).toMatchObject({ status: "UNSUPPORTED", explicitLack: false });
  });

  it("degree level is compared, a higher degree meets a lower requirement, and an unmatched field is only PARTIAL", async () => {
    const ms = fact({ factId: "f-ms", kind: "education", value: "M.S. Computer Science, University" });
    const ok = await decide(QUAL(["Bachelor's degree in computer science or a related field."]), corpusOf([ms]));
    expect(status(ok, "Bachelor's degree").status).toBe("SUPPORTED");
    // a degree at the right level whose field was not shown to match is only partial; the field is never assumed related
    const cyber = fact({ factId: "f-cy", kind: "education", value: "M.S. Cybersecurity & Networks, University" });
    expect(status(await decide(QUAL(["Bachelor's degree in computer science or a related field."]), corpusOf([cyber])), "Bachelor's degree").status).toBe("PARTIAL");
    const wrongField = fact({ factId: "f-ba", kind: "education", value: "B.A. History, State College" });
    expect(status(await decide(QUAL(["Bachelor's degree in computer science or a related field."]), corpusOf([wrongField])), "Bachelor's degree").status).toBe("PARTIAL");
    expect(status(await decide(QUAL(["Bachelor's degree in computer science."]), corpusOf([])), "Bachelor's degree").status).toBe("UNSUPPORTED");
  });

  it("soft skills and unmappable wording are UNKNOWN, a negated requirement is not applicable", async () => {
    const res = await decide(["Minimum Qualifications", "- Strong written communication.", "- Experience with Kubernetes is not required."].join("\n"), corpusOf([]));
    expect(status(res, "Strong written communication.").status).toBe("UNKNOWN");
    expect(status(res, "Kubernetes")).toMatchObject({ applicable: false, status: "UNKNOWN", effectiveLevel: "not_required" });
  });

  it("source-item rollup reports how many listed terms are supported", async () => {
    const res = await decide(QUAL(["Familiarity with detection tools like SIEM, EDR, IDS/IPS."]), corpusOf([fact({ factId: "f-s", kind: "skill", value: "Splunk" })]));
    const roll = rollupItems(res.decisions);
    expect(roll).toHaveLength(1);
    expect(roll[0]).toMatchObject({ status: "PARTIAL", note: "1 of 3 listed terms supported" });
  });
});

describe("eligibility conditions", () => {
  it("never infers a sensitive answer: no attested fact means UNKNOWN, each condition stays separate", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    const out = decideConditions(analysis, []);
    const by = (t: string) => out.find((c) => c.type === t)!;
    expect(by("citizenship")).toMatchObject({ result: "UNKNOWN", severity: "needs-candidate-answer" });
    expect(by("work_authorization")).toMatchObject({ result: "UNKNOWN" });
    expect(by("sponsorship")).toMatchObject({ result: "UNKNOWN" });
    expect(by("clearance")).toMatchObject({ result: "NOT_APPLICABLE" });
    expect(out.every((c) => c.candidateFactIds.length === 0)).toBe(true);
  });

  it("work authorization does not satisfy citizenship, and sponsorship need never filters automatically", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    const facts: EligibilityFact[] = [{ factId: "wa", kind: "work_authorization", value: "Authorized to work in the United States", polarity: "has" }, { factId: "sp", kind: "sponsorship_need", value: "Requires visa sponsorship in future", polarity: "has" }];
    const by = (t: string) => decideConditions(analysis, facts).find((c) => c.type === t)!;
    expect(by("work_authorization")).toMatchObject({ result: "SATISFIED", candidateFactIds: ["wa"] });
    expect(by("citizenship")).toMatchObject({ result: "UNKNOWN", candidateFactIds: [] });
    expect(by("sponsorship")).toMatchObject({ result: "ATTENTION", severity: "needs-candidate-answer" });
  });

  it("a demonstrated lack is a blocker only for the condition it concerns", async () => {
    const { analysis } = await analyze(SYNTHETIC_JD);
    const out = decideConditions(analysis, [{ factId: "c", kind: "citizenship", value: "U.S. citizen", polarity: "lacks" }]);
    expect(out.find((c) => c.type === "citizenship")).toMatchObject({ result: "BLOCKER", severity: "blocker" });
    expect(out.filter((c) => c.severity === "blocker")).toHaveLength(1);
  });

  it("does not turn a lack of a different clearance level into a hard rejection", async () => {
    const { analysis } = await analyze("Minimum Qualifications\n- Python.\n\nAdditional notes\nCandidates must hold an active Secret clearance.");
    expect(analysis.conditions.clearance.value).toBe("Secret");
    const other = decideConditions(analysis, [{ factId: "public-trust", kind: "clearance", value: "Public Trust", polarity: "lacks" }]);
    expect(other.find((c) => c.type === "clearance")).toMatchObject({ result: "UNKNOWN", severity: "needs-candidate-answer" });
    const exact = decideConditions(analysis, [{ factId: "secret", kind: "clearance", value: "Secret", polarity: "lacks" }]);
    expect(exact.find((c) => c.type === "clearance")).toMatchObject({ result: "BLOCKER", candidateFactIds: ["secret"] });
  });
});

describe("retrieval", () => {
  const units = [
    unit(fact({ factId: "a", kind: "skill", value: "Splunk" })), unit(fact({ factId: "b", kind: "skill", value: "Wireshark" })), unit(fact({ factId: "c", kind: "skill", value: "Python scripting" })),
  ];
  it("lexical, BM25 and reciprocal-rank fusion rank a matching unit first", async () => {
    const idx = new EvidenceIndex(units, null);
    const r = await idx.retrieve({ requirementId: "r", text: "Splunk", phrases: ["Splunk", "SPL"] });
    expect(r.lexical[0]!.unitId).toBe("fact:a");
    expect(r.bm25[0]!.unitId).toBe("fact:a");
    expect(r.semantic).toBeNull();
    expect(r.hybrid[0]!.unitId).toBe("fact:a");
    const fused = rrf([[{ unitId: "x", rank: 1, score: 1 }, { unitId: "y", rank: 2, score: 1 }], [{ unitId: "y", rank: 1, score: 1 }]]);
    expect(fused[0]!.unitId).toBe("y");
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("a semantic ranker is advisory: an encoder failure disables it and everything else keeps working", async () => {
    const broken = { embed: async () => { throw new Error("encoder down"); } };
    const idx = new EvidenceIndex(units, broken as never);
    await idx.prepare();
    expect(idx.semanticStatus).toBe("FAILED");
    const r = await idx.retrieve({ requirementId: "r", text: "Splunk", phrases: ["Splunk"] });
    expect(r.semantic).toBeNull();
    expect(r.hybrid[0]!.unitId).toBe("fact:a");
  });

  it("a high similarity score never changes a decision", async () => {
    const encoder = { embed: async (t: string) => ({ vector: /kubernetes/i.test(t) || /container/i.test(t) ? [1, 0] : [0, 1] }) };
    const corpus = corpusOf([fact({ factId: "f-doc", kind: "skill", value: "Docker containers" })]);
    const { analysis } = await analyze(["Minimum Qualifications", "- Experience with Kubernetes."].join("\n"));
    const idx = new EvidenceIndex(corpus.units, encoder as never);
    await idx.prepare();
    const retrieval = new Map<string, RetrievalResult>();
    for (const r of analysis.requirements) retrieval.set(r.id, await idx.retrieve(queryFor({ id: r.id, value: r.value, type: r.type })));
    const d = decideRequirements({ analysis, corpus, retrieval, asOf: "2026-10-11" }).decisions.find((x) => x.value === "Kubernetes")!;
    expect(d.retrievalLeads[0]).toMatchObject({ factId: "f-doc", semanticRank: 1 });
    expect(d.status).toBe("UNSUPPORTED"); // semantically close, but Docker is not Kubernetes
    expect(d.matchedFactIds).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { roleDefinitionSchema, roleEditSchema, canonicalAliases, roleDefinitionDigest } from "../../src/roles/catalog.js";
import { SEED_CATALOG } from "../../src/roles/seed.js";
import { assessRoles, experienceNote, normalizeForMatch, suggestSearchBand } from "../../src/roles/recommend.js";
import { summarizeExperience } from "../../src/roles/experience.js";
import { emp, makeFact, type FactSpec } from "./helpers.js";

interface Case {
  caseId: string;
  description: string;
  facts: Array<FactSpec & { id: string }>;
  expected: {
    supported: string[];
    partial: string[];
    gapCodes?: Record<string, string[]>;
    noMatchGapCodes?: Record<string, string[]>;
    pendingHintRoles?: string[];
    titleSignals?: Record<string, string[]>;
  };
}
const cases = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "role_cases.json"), "utf8")).cases as Case[];
const ASOF = "2026-10-09";
const run = (facts: Case["facts"]) => assessRoles({ roles: SEED_CATALOG.roles, facts: facts.map(makeFact), asOf: ASOF });

describe("role catalog seed content", () => {
  it("every seed role and family parses, slugs are unique, primary families are cybersecurity", () => {
    const slugs = SEED_CATALOG.roles.map((r) => r.roleSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const families = new Map(SEED_CATALOG.families.map((f) => [f.familySlug, f]));
    for (const r of SEED_CATALOG.roles) expect(families.has(r.familySlug), r.roleSlug).toBe(true);
    const primary = SEED_CATALOG.families.filter((f) => f.tier === "primary").map((f) => f.familySlug).sort();
    expect(primary).toEqual(["grc-compliance", "identity-access", "incident-response-dfir", "soc-blue-team", "vulnerability-security-ops"]);
    const secondary = SEED_CATALOG.families.filter((f) => f.tier === "secondary").map((f) => f.familySlug).sort();
    expect(secondary).toEqual(["cloud", "network-noc", "qa-sdet"]);
    for (const r of SEED_CATALOG.roles) expect(roleDefinitionSchema.safeParse(r).success, r.roleSlug).toBe(true);
  });

  it("role definitions reject malformed evidence", () => {
    const base = SEED_CATALOG.roles[0]!;
    const bad = (evidence: unknown) => roleDefinitionSchema.safeParse({ ...base, evidence }).success;
    expect(bad({ ...base.evidence, minCoreMatches: 9 })).toBe(false); // more than the core requirements available
    expect(bad({ ...base.evidence, requirements: [] })).toBe(false);
    expect(bad({ ...base.evidence, requirements: base.evidence.requirements.map((r) => ({ ...r, importance: "supporting" })) })).toBe(false); // no core
    expect(bad({ ...base.evidence, requirements: [base.evidence.requirements[0], base.evidence.requirements[0]] })).toBe(false); // duplicate id
    expect(roleDefinitionSchema.safeParse({ ...base, roleSlug: "Bad Slug" }).success).toBe(false);
    expect(roleEditSchema.safeParse({}).success).toBe(false);
    expect(roleEditSchema.safeParse({ roleSlug: "x" }).success).toBe(false); // identity is not editable
  });

  it("aliases are deduplicated case-insensitively and the digest ignores alias order and case", () => {
    expect(canonicalAliases(["SOC Analyst", "soc  analyst", "Tier 1"])).toEqual(["SOC Analyst", "Tier 1"]);
    const base = SEED_CATALOG.roles[0]!;
    expect(roleDefinitionDigest({ ...base, aliases: [...base.aliases].reverse().map((a) => a.toUpperCase()) })).toBe(roleDefinitionDigest(base));
    expect(roleDefinitionDigest({ ...base, aliases: [...base.aliases, "Brand New Alias"] })).not.toBe(roleDefinitionDigest(base));
  });
});

describe("assessRoles against the hand-authored oracle (14 synthetic cases)", () => {
  for (const c of cases) {
    it(`${c.caseId}: ${c.description}`, () => {
      const out = run(c.facts);
      const supported = out.assessments.filter((a) => a.support === "SUPPORTED").map((a) => a.roleSlug).sort();
      const partial = out.assessments.filter((a) => a.support === "PARTIAL").map((a) => a.roleSlug).sort();
      expect(supported).toEqual([...c.expected.supported].sort());
      expect(partial).toEqual([...c.expected.partial].sort());
      for (const [slug, codes] of Object.entries(c.expected.gapCodes ?? {})) {
        expect(out.assessments.find((a) => a.roleSlug === slug)!.gaps.map((g) => g.code)).toEqual(expect.arrayContaining(codes));
      }
      for (const [slug, codes] of Object.entries(c.expected.noMatchGapCodes ?? {})) {
        const a = out.assessments.find((x) => x.roleSlug === slug)!;
        expect(a.support).toBe("NO_MATCH");
        expect(a.gaps.map((g) => g.code)).toEqual(expect.arrayContaining(codes));
      }
      for (const slug of c.expected.pendingHintRoles ?? []) expect(Object.keys(out.pendingHints[slug] ?? {}).length, slug).toBeGreaterThan(0);
      for (const [slug, ids] of Object.entries(c.expected.titleSignals ?? {})) {
        expect(out.assessments.find((a) => a.roleSlug === slug)!.titleSignals.map((t) => t.factId)).toEqual(ids);
      }
    });
  }

  it("every proposed role cites only approved facts that exist, and every NO_MATCH cites none", () => {
    for (const c of cases) {
      const approved = new Set(c.facts.filter((f) => (f.status ?? "approved") === "approved").map((f) => f.id));
      for (const a of run(c.facts).assessments) {
        if (a.support === "NO_MATCH") expect(a.sourceFactIds, `${c.caseId}/${a.roleSlug}`).toEqual([]);
        else {
          expect(a.sourceFactIds.length, `${c.caseId}/${a.roleSlug}`).toBeGreaterThan(0);
          for (const id of a.sourceFactIds) expect(approved.has(id), `${c.caseId}/${a.roleSlug}/${id}`).toBe(true);
        }
      }
    }
  });

  it("an empty profile yields no support anywhere and explains every missing core requirement", () => {
    const out = assessRoles({ roles: SEED_CATALOG.roles, facts: [], asOf: ASOF });
    expect(out.assessments.every((a) => a.support === "NO_MATCH")).toBe(true);
    for (const a of out.assessments) expect(a.gaps.filter((g) => g.code === "UNMET_CORE").length).toBe(a.coreTotal);
  });
});

describe("assessRoles: authority and safety", () => {
  const soc = { id: "e1", kind: "employment" as const, value: "Contoso — SOC Analyst", attributes: { employer: "Contoso", title: "SOC Analyst", startDate: "2023-01", endDate: null, employmentType: "professional", detail: "Triaged alerts in Splunk SIEM with CrowdStrike EDR." } };
  const supportOf = (facts: FactSpec[], role = "soc-analyst") => assessRoles({ roles: SEED_CATALOG.roles, facts: facts.map(makeFact), asOf: ASOF }).assessments.find((a) => a.roleSlug === role)!;

  it("rejected or pending facts cannot support a role, and un-approving an approved one removes the support", () => {
    expect(supportOf([soc]).support).toBe("SUPPORTED");
    expect(supportOf([{ ...soc, status: "pending" }]).support).toBe("NO_MATCH");
    expect(supportOf([{ ...soc, status: "rejected" }]).support).toBe("NO_MATCH");
  });

  it("an expired approval does not support a role", () => {
    expect(supportOf([{ ...soc, validUntil: "2026-01-01" }]).support).toBe("NO_MATCH");
  });

  it("sensitive facts never contribute, even if their text matches", () => {
    const sensitive = makeFact({ id: "x", kind: "work_authorization", value: "Splunk SIEM triaged alerts CrowdStrike EDR", sensitivity: "sensitive" });
    const out = assessRoles({ roles: SEED_CATALOG.roles, facts: [sensitive], asOf: ASOF });
    expect(out.assessments.every((a) => a.support === "NO_MATCH")).toBe(true);
  });

  it("citizenship, clearance and sponsorship are never inferred: nothing in the output mentions them", () => {
    const out = assessRoles({ roles: SEED_CATALOG.roles, facts: [makeFact(soc)], asOf: ASOF });
    expect(JSON.stringify(out).toLowerCase()).not.toMatch(/citizen|clearance|sponsor|work authorization/);
  });

  it("changing an approved fact's content changes the input digest of every role that cites it; unrelated approvals do not", () => {
    const before = supportOf([soc]);
    const edited = supportOf([{ ...soc, attributes: { ...soc.attributes, detail: "Triaged alerts in Splunk SIEM with CrowdStrike EDR and Sentinel." } }]);
    expect(edited.support).toBe(before.support);
    expect(edited.inputDigest).not.toBe(before.inputDigest);
    const withUnrelated = supportOf([soc, { id: "u", kind: "skill", value: "Microsoft Excel" }]);
    expect(withUnrelated.inputDigest).toBe(before.inputDigest);
  });

  it("identical inputs give identical output regardless of fact order (reproducible)", () => {
    const facts: FactSpec[] = [soc, { id: "s1", kind: "skill", value: "Python" }, { id: "s2", kind: "skill", value: "Wireshark" }];
    const a = assessRoles({ roles: SEED_CATALOG.roles, facts: facts.map(makeFact), asOf: ASOF });
    const b = assessRoles({ roles: [...SEED_CATALOG.roles].reverse(), facts: [...facts].reverse().map(makeFact), asOf: ASOF });
    const bySlug = (o: typeof a) => Object.fromEntries(o.assessments.map((x) => [x.roleSlug, x]));
    expect(bySlug(b)).toEqual(bySlug(a));
  });

  it("an inactive role is not assessed", () => {
    const roles = SEED_CATALOG.roles.map((r) => (r.roleSlug === "soc-analyst" ? { ...r, active: false } : r));
    expect(assessRoles({ roles, facts: [makeFact(soc)], asOf: ASOF }).assessments.some((a) => a.roleSlug === "soc-analyst")).toBe(false);
  });

  it("matches whole words only: 'sso' inside another word, or 'soc' in 'social', never matches", () => {
    expect(normalizeForMatch("MITRE ATT&CK, Node.js and SC-200")).toBe(" mitre att ck node js and sc 200 ");
    const lookalike = supportOf([{ id: "w", kind: "skill", value: "Social media, assorted tools, SOC 2 reports" }]);
    expect(lookalike.support).toBe("NO_MATCH");
  });
});

describe("experience notes and search-band advice", () => {
  const role = SEED_CATALOG.roles.find((r) => r.roleSlug === "incident-response-analyst")!; // advisory 12 months

  it("is advice only and reflects review / no-data / below / uncertain states", () => {
    const none = summarizeExperience([], ASOF);
    expect(experienceNote(role, none)?.code).toBe("NO_EXPERIENCE_DATA");
    expect(experienceNote(role, summarizeExperience([emp("a", "2020-01", "2022-01", undefined)], ASOF))?.code).toBe("EXPERIENCE_NEEDS_REVIEW");
    expect(experienceNote(role, summarizeExperience([emp("a", "2026-05", "2026-08", "professional")], ASOF))?.code).toBe("EXPERIENCE_BELOW_ADVISORY"); // upper 4 < 12
    expect(experienceNote(role, summarizeExperience([emp("a", "2025-02", "2026-01", "professional")], ASOF))?.code).toBe("EXPERIENCE_UNCERTAIN"); // lower 11, upper 12 vs 12 wanted
  });

  it("a role with no advisory months has no note", () => {
    const soc = SEED_CATALOG.roles.find((r) => r.roleSlug === "soc-analyst")!;
    expect(experienceNote(soc, summarizeExperience([], ASOF))).toBeNull();
  });

  it("the suggested band is bounded 0-5, unknown when experience is unknown, and never claims five years", () => {
    expect(suggestSearchBand(summarizeExperience([], ASOF))).toMatchObject({ readiness: "UNKNOWN", minYears: 0, maxYears: 5 });
    expect(suggestSearchBand(summarizeExperience([emp("a", "2026-01", null, "professional")], ASOF))).toMatchObject({ readiness: "ENTRY", maxYears: 3 });
    expect(suggestSearchBand(summarizeExperience([emp("a", "2018-01", null, "professional")], ASOF))).toMatchObject({ readiness: "ESTABLISHED", maxYears: 5 });
    const entry = suggestSearchBand(summarizeExperience([emp("a", "2026-01", null, "professional")], ASOF));
    expect(entry.basis).toMatch(/not a claim/i);
  });
});

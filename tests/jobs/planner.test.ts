import { describe, expect, it } from "vitest";
import {
  PlanError, bandStatus, buildPlan, excludedBySeniority, matchLocation, matchRoles, senioritySignal, statedYears, type CatalogRoleLike, type SelectionLike,
} from "../../src/jobs/planner.js";

const catalog: CatalogRoleLike[] = [
  { roleSlug: "soc-analyst", title: "SOC Analyst", aliases: ["Security Operations Center Analyst", "Cybersecurity Analyst", "Tier 1 SOC Analyst"], active: true },
  { roleSlug: "incident-response-analyst", title: "Incident Response Analyst", aliases: ["Incident Responder"], active: true },
  { roleSlug: "sdet", title: "SDET", aliases: ["Test Automation Engineer"], active: true },
  { roleSlug: "retired-role", title: "Retired Role", aliases: [], active: false },
];

const selection = (over: Partial<SelectionLike> = {}): SelectionLike => ({
  revisionNo: 3, roleSlugs: ["soc-analyst"], targetFamilies: ["soc-blue-team"], locations: [{ kind: "country", value: "United States" }, { kind: "remote", value: "Remote" }],
  workModes: ["remote"], seniorityLevels: ["entry", "junior"], searchBand: { minYears: 0, maxYears: 5 }, catalogVersion: 2, ...over,
});
const plan = (over: Partial<SelectionLike> = {}) => buildPlan({ selection: selection(over), catalogRoles: catalog, catalogVersion: 2, expectedRevision: 3 });

describe("S3 planner: selection -> discovery plan", () => {
  it("plans only from the persisted human selection, using the role title and catalog aliases", () => {
    const p = plan();
    expect(p.roles).toHaveLength(1);
    expect(p.roles[0]).toMatchObject({ roleSlug: "soc-analyst" });
    expect(p.roles[0]!.phrases).toEqual(["cybersecurity analyst", "security operations center analyst", "soc analyst", "tier 1 soc analyst"]);
    expect(p.selectionRevisionNo).toBe(3);
  });

  it("an unselected role contributes no phrase and can never match", () => {
    const p = plan();
    expect(matchRoles("Incident Response Analyst", p).roleSlugs).toEqual([]);
    expect(matchRoles("SDET", p).roleSlugs).toEqual([]);
    expect(matchRoles("Security Operations Center Analyst - Night Shift", p).roleSlugs).toEqual(["soc-analyst"]);
    const both = plan({ roleSlugs: ["incident-response-analyst", "soc-analyst"] });
    expect(matchRoles("Incident Responder", both).roleSlugs).toEqual(["incident-response-analyst"]);
  });

  it("matches whole phrases only, case-insensitively", () => {
    const p = plan();
    expect(matchRoles("soc analyst ii", p).phrases).toEqual(["soc analyst"]);
    expect(matchRoles("Associate Social Analyst", p).roleSlugs).toEqual([]); // 'soc' inside a longer word is not a phrase match
    expect(matchRoles("Account Executive, Cybersecurity Sales", p).roleSlugs).toEqual([]);
  });

  it("refuses to plan without a usable, current selection", () => {
    const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { return e instanceof PlanError ? e.code : "other"; } };
    expect(code(() => buildPlan({ selection: null, catalogRoles: catalog, catalogVersion: 2 }))).toBe("NO_SELECTION");
    expect(code(() => plan({ roleSlugs: [] }))).toBe("EMPTY_SELECTION");
    expect(code(() => plan({ roleSlugs: ["retired-role"] }))).toBe("INACTIVE_ROLE");
    expect(code(() => plan({ roleSlugs: ["not-a-role"] }))).toBe("INACTIVE_ROLE");
    expect(code(() => buildPlan({ selection: selection(), catalogRoles: catalog, catalogVersion: 2, expectedRevision: 2 }))).toBe("STALE_SELECTION");
    expect(code(() => buildPlan({ selection: selection({ catalogVersion: 1 }), catalogRoles: catalog, catalogVersion: 2 }))).toBe("STALE_CATALOG");
  });
});

describe("S3 planner: location, seniority and band are filters for what to LOOK AT, never eligibility", () => {
  const p = plan();

  it("keeps unknown locations visible and flags them; excludes only clear mismatches", () => {
    expect(matchLocation("Austin, TX", p)).toBe("MATCH"); // United States selected
    expect(matchLocation("Remote - US", p)).toBe("MATCH");
    expect(matchLocation("Remote", p)).toBe("MATCH"); // the person accepts remote
    expect(matchLocation(null, p)).toBe("UNKNOWN");
    expect(matchLocation("", p)).toBe("UNKNOWN");
    expect(matchLocation("Hybrid", p)).toBe("UNKNOWN");
    expect(matchLocation("London, UK", p)).toBe("NO_MATCH");
    expect(matchLocation("Bengaluru, India", p)).toBe("NO_MATCH");
  });

  it("no location preference means nothing is filtered", () => {
    const open = plan({ locations: [] });
    expect(matchLocation("London, UK", open)).toBe("UNSPECIFIED");
    expect(matchLocation(null, open)).toBe("UNSPECIFIED");
  });

  it("matches a selected city or region by whole word", () => {
    const austin = plan({ locations: [{ kind: "city", value: "Austin" }] });
    expect(matchLocation("Austin, TX", austin)).toBe("MATCH");
    expect(matchLocation("Boston, MA", austin)).toBe("NO_MATCH");
    expect(matchLocation("East Austinville, OH", austin)).not.toBe("MATCH");
  });

  it("a senior title is dropped only when the person did not select senior; an entry title is a label, not proof", () => {
    expect(senioritySignal("Senior SOC Analyst")).toBe("SENIOR");
    expect(senioritySignal("Lead Detection Engineer")).toBe("SENIOR");
    expect(senioritySignal("Junior SOC Analyst")).toBe("ENTRY");
    expect(senioritySignal("SOC Analyst")).toBe("UNSPECIFIED");
    expect(excludedBySeniority("SENIOR", p)).toBe(true);
    expect(excludedBySeniority("UNSPECIFIED", p)).toBe(false);
    expect(excludedBySeniority("SENIOR", plan({ seniorityLevels: ["entry", "senior"] }))).toBe(false);
    expect(excludedBySeniority("SENIOR", plan({ seniorityLevels: [] }))).toBe(false); // no level chosen: no filter
  });

  it("the 0-5 year band flags what a posting states; absence is UNSTATED, never zero", () => {
    expect(bandStatus(null, p.searchBand)).toBe("UNSTATED");
    expect(bandStatus(2, p.searchBand)).toBe("WITHIN");
    expect(bandStatus(5, p.searchBand)).toBe("WITHIN");
    expect(bandStatus(7, p.searchBand)).toBe("OUTSIDE");
    expect(statedYears("We want 3+ years of experience in security operations.").years).toBe(3);
    expect(statedYears("A friendly team that likes tea.")).toEqual({ years: null, quote: null });
  });
});

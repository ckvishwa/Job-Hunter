import { titleMatches } from "../pipeline/discovery/board-discoverer.js";
import { classifyLocation } from "../pipeline/discovery/location.js";
import { analyzeJd } from "../pipeline/discovery/jd-flags.js";

// S3 planner: a PURE function of the persisted human selection and the role catalog. Nothing here reads the network, a database or a
// model. Role suggestions that the person did not select never reach this module, so they can never trigger a search.
//
// What the plan can and cannot say:
//  - a title phrase match means "worth fetching and showing", never "eligible" or "qualified" (that is S4);
//  - the years band is a discovery heuristic for which postings to look at, not a statement about the candidate's experience;
//  - an unknown location or unstated years is kept and flagged, never silently dropped.

export type PlanErrorCode = "NO_SELECTION" | "EMPTY_SELECTION" | "STALE_SELECTION" | "STALE_CATALOG" | "INACTIVE_ROLE";

export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode, message: string) {
    super(message);
    this.name = "PlanError";
  }
}

export interface SelectionLike {
  revisionNo: number;
  roleSlugs: string[];
  targetFamilies: string[];
  locations: Array<{ kind: "country" | "region" | "city" | "remote"; value: string }>;
  workModes: string[];
  seniorityLevels: string[];
  searchBand: { minYears: number; maxYears: number };
  catalogVersion: number;
}

export interface RoleEvidenceRequirement {
  id: string;
  importance: "core" | "supporting";
  terms: string[];
}

export interface CatalogRoleLike {
  roleSlug: string;
  title: string;
  aliases: string[];
  active: boolean;
  /** Present on catalog rows. Omitted in older callers; description matching stays off until it is supplied. */
  evidence?: { minCoreMatches: number; requirements: RoleEvidenceRequirement[] };
}

export interface PlanRole {
  roleSlug: string;
  title: string;
  /** Title and aliases, de-duplicated, lower-case. Matched as whole phrases against posting titles. */
  phrases: string[];
  /** How many distinct core evidence groups a description must hit before a non-matching title can be admitted. */
  minCoreMatches: number;
  evidence: RoleEvidenceRequirement[];
}

export interface DiscoveryPlan {
  selectionRevisionNo: number;
  catalogVersion: number;
  roles: PlanRole[];
  locations: SelectionLike["locations"];
  workModes: string[];
  seniorityLevels: string[];
  searchBand: SelectionLike["searchBand"];
}

export function buildPlan(input: {
  selection: SelectionLike | null;
  catalogRoles: CatalogRoleLike[];
  catalogVersion: number;
  /** The selection revision the person was looking at when they pressed Start. A different current revision is a conflict. */
  expectedRevision?: number;
}): DiscoveryPlan {
  const { selection } = input;
  if (!selection) throw new PlanError("NO_SELECTION", "Save a role selection before starting discovery.");
  if (input.expectedRevision !== undefined && input.expectedRevision !== selection.revisionNo) {
    throw new PlanError("STALE_SELECTION", "Your selection changed in another window. Reload and review it before starting discovery.");
  }
  if (selection.catalogVersion !== input.catalogVersion) {
    throw new PlanError("STALE_CATALOG", "The role catalog changed after you saved this selection. Review and save your selection again.");
  }
  if (selection.roleSlugs.length === 0) throw new PlanError("EMPTY_SELECTION", "Your selection has no roles. Choose at least one role.");
  const bySlug = new Map(input.catalogRoles.map((r) => [r.roleSlug, r]));
  const roles: PlanRole[] = selection.roleSlugs.map((slug) => {
    const role = bySlug.get(slug);
    if (!role || !role.active) throw new PlanError("INACTIVE_ROLE", `Selected role "${slug}" is no longer an active catalog role. Review your selection.`);
    const phrases = [...new Set([role.title, ...role.aliases].map((p) => p.toLowerCase().replace(/\s+/g, " ").trim()).filter((p) => p.length >= 2))].sort();
    const evidence = role.evidence?.requirements ?? [];
    const minCoreMatches = role.evidence?.minCoreMatches ?? 0;
    return { roleSlug: slug, title: role.title, phrases, minCoreMatches, evidence };
  });
  return {
    selectionRevisionNo: selection.revisionNo, catalogVersion: selection.catalogVersion, roles,
    locations: selection.locations, workModes: selection.workModes, seniorityLevels: selection.seniorityLevels, searchBand: selection.searchBand,
  };
}

export interface RoleMatch {
  roleSlugs: string[];
  phrases: string[];
}

/** Whole-phrase, case-insensitive match of a posting title against the SELECTED roles' phrases only. */
export function matchRoles(title: string, plan: DiscoveryPlan): RoleMatch {
  const roleSlugs: string[] = [];
  const phrases = new Set<string>();
  for (const role of plan.roles) {
    const hit = titleMatches(title, role.phrases);
    if (hit.length > 0) {
      roleSlugs.push(role.roleSlug);
      hit.forEach((p) => phrases.add(p));
    }
  }
  return { roleSlugs, phrases: [...phrases].sort() };
}

export type LocationMatch = "MATCH" | "UNKNOWN" | "UNSPECIFIED" | "NO_MATCH";

const US_COUNTRY = /^(united states( of america)?|usa|u\.s\.a?\.?|us)$/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (text: string, term: string) => new RegExp(`(?<![a-z0-9])${esc(term.toLowerCase())}(?![a-z0-9])`).test(text.toLowerCase());

/**
 * UNSPECIFIED: the person gave no location, so nothing is filtered. UNKNOWN: the posting's location is empty or ambiguous, so the
 * posting is kept and flagged. NO_MATCH: the posting names a location that matches none of the selected places (counted, not stored).
 */
export function matchLocation(jobLocation: string | null | undefined, plan: Pick<DiscoveryPlan, "locations">): LocationMatch {
  if (plan.locations.length === 0) return "UNSPECIFIED";
  const text = (jobLocation ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "UNKNOWN";
  const verdict = classifyLocation(text);
  for (const place of plan.locations) {
    if (place.kind === "remote") {
      if (/(?<![a-z0-9])remote(?![a-z0-9])/i.test(text)) return "MATCH";
    } else if (place.kind === "country" && US_COUNTRY.test(place.value.trim())) {
      if (verdict === "US") return "MATCH";
    } else if (hasWord(text, place.value)) {
      return "MATCH";
    }
  }
  return verdict === "UNKNOWN" ? "UNKNOWN" : "NO_MATCH";
}

export type SenioritySignal = "ENTRY" | "SENIOR" | "UNSPECIFIED";

const SENIOR_WORDS = ["senior", "sr", "staff", "principal", "lead", "director", "manager", "head of", "vp", "vice president", "architect"];
const ENTRY_WORDS = ["junior", "jr", "associate", "entry level", "entry-level", "intern", "internship", "new grad", "graduate", "apprentice", "trainee"];

/** Reads the TITLE only, as a label. A title never proves the actual experience a posting requires. */
export function senioritySignal(title: string): SenioritySignal {
  if (titleMatches(title, SENIOR_WORDS).length > 0) return "SENIOR";
  if (titleMatches(title, ENTRY_WORDS).length > 0) return "ENTRY";
  return "UNSPECIFIED";
}

/** True when the title is explicitly senior-level and the person did not select the senior level. */
export function excludedBySeniority(signal: SenioritySignal, plan: Pick<DiscoveryPlan, "seniorityLevels">): boolean {
  return signal === "SENIOR" && plan.seniorityLevels.length > 0 && !plan.seniorityLevels.includes("senior");
}

export type BandStatus = "WITHIN" | "OUTSIDE" | "UNSTATED";

export interface StatedYears {
  years: number | null;
  quote: string | null;
}

/** The highest minimum years the JD states (with its verbatim quote), via the existing JD flag reader. Absence is UNSTATED, not zero. */
export function statedYears(descriptionText: string): StatedYears {
  const flag = analyzeJd(descriptionText).yearsRequired;
  return flag ? { years: flag.years, quote: flag.quote } : { years: null, quote: null };
}

export function bandStatus(years: number | null, band: DiscoveryPlan["searchBand"]): BandStatus {
  if (years === null) return "UNSTATED";
  return years >= band.minYears && years <= band.maxYears ? "WITHIN" : "OUTSIDE";
}

/**
 * Titles that must not be admitted from description keywords alone. A selected-role phrase in the title still uses the title path.
 * These are job functions, not seniority; seniority is a separate gate.
 */
const DESCRIPTION_TITLE_BLOCK = ["recruiter", "talent acquisition", "account executive", "sales development", "product manager", "product marketing", "customer success", "account manager"];

/**
 * Terms that show up in many unrelated postings. They may be recorded, but a core group counts toward
 * description admission only when a more specific term in that group also matches. Exact title matches ignore this list.
 */
const GENERIC_DESCRIPTION_TERMS = new Set(["sso", "oauth", "saml", "ldap", "mfa", "rbac", "access management", "single sign on", "least privilege", "dns"]);
const CUE_STOP = new Set(["analyst", "engineer", "security", "specialist", "associate", "junior", "senior", "access", "support", "developer", "software", "platform", "system", "administrator", "owner", "technical", "staff", "manager"]);
const SHORT_CUES = new Set(["iam", "soc", "sdet", "dfir", "grc"]);

export interface ScreenInput {
  title: string;
  description?: string | null;
  location?: string | null;
  excludeTitleKeywords?: string[];
  plan: DiscoveryPlan;
}

export type Screen =
  | { gate: "EXCLUDED_KEYWORD"; terms: string[] }
  | { gate: "NO_ROLE" }
  | { gate: "SENIORITY"; basis: "title" | "description" }
  | { gate: "LOCATION"; basis: "title" | "description" }
  | { gate: "ADMIT"; basis: "title" | "description"; roleSlugs: string[]; phrases: string[]; evidenceGroups: string[]; location: Exclude<LocationMatch, "NO_MATCH"> };

function titleCues(role: PlanRole): string[] {
  const tokens = new Set<string>();
  for (const phrase of role.phrases) {
    for (const word of phrase.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!word || CUE_STOP.has(word)) continue;
      if (word.length >= 4 || SHORT_CUES.has(word)) tokens.add(word);
    }
  }
  return [...tokens];
}

/** Core groups that matched a role-specific term. Generic protocol words alone do not count. */
function descriptionEvidence(description: string, role: PlanRole): { groups: string[]; terms: string[] } | null {
  const cores = role.evidence.filter((group) => group.importance === "core" && group.terms.length > 0);
  if (cores.length === 0 || role.minCoreMatches < 1) return null;
  const groups: string[] = [];
  const terms: string[] = [];
  for (const group of cores) {
    const hit = titleMatches(description, group.terms);
    const specific = hit.filter((term) => !GENERIC_DESCRIPTION_TERMS.has(term.toLowerCase()));
    if (specific.length === 0) continue;
    groups.push(group.id);
    terms.push(...hit);
  }
  if (groups.length === 0) return null;
  return { groups, terms: [...new Set(terms)].sort() };
}

/**
 * One posting against the saved selection. Order: board exclude list, then selected-role title phrase, then description evidence
 * for that same role only, then seniority, then location. An unselected family's keywords never admit a posting.
 * A senior title is not admitted from description keywords when senior was not selected.
 */
export function screenPosting(input: ScreenInput): Screen {
  const excluded = titleMatches(input.title, input.excludeTitleKeywords ?? []);
  if (excluded.length > 0) return { gate: "EXCLUDED_KEYWORD", terms: excluded };
  const title = matchRoles(input.title, input.plan);
  const described: Array<{ roleSlug: string; groups: string[]; terms: string[] }> = [];
  if (title.roleSlugs.length === 0 && titleMatches(input.title, DESCRIPTION_TITLE_BLOCK).length === 0) {
    const description = input.description ?? "";
    for (const role of input.plan.roles) {
      const hit = descriptionEvidence(description, role);
      if (!hit) continue;
      const titled = titleMatches(input.title, titleCues(role)).length > 0;
      if (hit.groups.length >= role.minCoreMatches || (titled && hit.groups.length >= 1)) {
        described.push({ roleSlug: role.roleSlug, groups: hit.groups, terms: hit.terms });
      }
    }
  }
  const basis: "title" | "description" | null = title.roleSlugs.length > 0 ? "title" : described.length > 0 ? "description" : null;
  if (!basis) return { gate: "NO_ROLE" };
  if (excludedBySeniority(senioritySignal(input.title), input.plan)) return { gate: "SENIORITY", basis };
  const location = matchLocation(input.location, input.plan);
  if (location === "NO_MATCH") return { gate: "LOCATION", basis };
  const kept = location as Exclude<LocationMatch, "NO_MATCH">;
  if (basis === "title") return { gate: "ADMIT", basis, roleSlugs: title.roleSlugs, phrases: title.phrases, evidenceGroups: [], location: kept };
  return {
    gate: "ADMIT",
    basis,
    roleSlugs: described.map((hit) => hit.roleSlug),
    phrases: [...new Set(described.flatMap((hit) => hit.terms.map((term) => `jd:${term}`)))].sort(),
    evidenceGroups: [...new Set(described.flatMap((hit) => hit.groups))].sort(),
    location: kept,
  };
}

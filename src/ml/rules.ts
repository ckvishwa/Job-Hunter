import type { CatalogView } from "../db/roles-repo.js";
import { buildPlan, screenPosting, type DiscoveryPlan } from "../jobs/planner.js";

// The deterministic baseline the learned model must beat: the production S3 role screen (title phrase, then specific description evidence)
// run over EVERY active catalog role, with no location, seniority or keyword gates. It answers only "does this posting name or evidence a
// catalog role?". It is a baseline, never a label.

export const RULES_REVISION = "s3-screen-all-roles@1";

export function allRolesPlan(catalog: CatalogView): DiscoveryPlan {
  const active = catalog.roles.filter((r) => r.active);
  return buildPlan({
    selection: {
      revisionNo: 0, roleSlugs: active.map((r) => r.roleSlug), targetFamilies: [...new Set(active.map((r) => r.familySlug))],
      locations: [], workModes: [], seniorityLevels: ["entry", "junior", "mid", "senior"], searchBand: { minYears: 0, maxYears: 99 }, catalogVersion: catalog.catalogVersion,
    },
    catalogRoles: catalog.roles,
    catalogVersion: catalog.catalogVersion,
  });
}

export interface RuleDecision {
  relevant: boolean;
  basis: "title" | "description" | null;
  roleSlugs: string[];
  families: string[];
}

export function ruleDecision(posting: { title: string; description: string }, plan: DiscoveryPlan, familyOf: ReadonlyMap<string, string>): RuleDecision {
  const screen = screenPosting({ title: posting.title, description: posting.description, plan });
  if (screen.gate !== "ADMIT") return { relevant: false, basis: null, roleSlugs: [], families: [] };
  const families = [...new Set(screen.roleSlugs.map((s) => familyOf.get(s)).filter((f): f is string => !!f))].sort();
  return { relevant: true, basis: screen.basis, roleSlugs: [...screen.roleSlugs].sort(), families };
}

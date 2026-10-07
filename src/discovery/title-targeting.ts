import type { RoleConfig } from "../types.js";
import { evaluateRelevance } from "./relevance.js";

// Title-based targeting of search results, BEFORE any posting is opened.
//
// This is NOT candidate eligibility and NOT a hiring probability. It answers one narrow question:
// "does this result's title (and, for REVIEW only, its team label) match a role profile this repository
// already defines?" It reuses evaluateRelevance and config/roles.yml; it adds no preferences of its own
// (no seniority, sponsorship or location filtering).
//
//   MATCH     the TITLE matches a configured role keyword (config/roles.yml) or one of relevance.ts's
//             documented domain qualifiers paired with a role word.
//   REVIEW    the title does not match, but the result's team label names a configured profile domain
//             (e.g. team "Security"). A person decides; it is never opened unless selection.openReview is on.
//   NO_MATCH  neither. A result the site returned for a query is NOT thereby relevant.

export type TitleClass = "MATCH" | "REVIEW" | "NO_MATCH";

export interface TitleDecision {
  classification: TitleClass;
  profile: string | null;
  // Where the rule lives, precisely enough to find and edit it.
  rule: string;
  reason: string;
  matchedKeywords: string[];
}

export interface TitleTargetingOptions {
  /** Treat a title-less match on the team label as REVIEW. Default true. */
  reviewByTeam?: boolean;
}

function describeRule(keywords: string[], profile: string, roles: RoleConfig[]): string {
  const parts = keywords.map((kw) => {
    const role = roles.find((r) => r.profile === profile && r.keywords.some((k) => k.toLowerCase() === kw.toLowerCase()));
    return role
      ? `config/roles.yml role "${role.id}" keyword "${kw}"`
      : `domain qualifier "${kw}" (src/discovery/relevance.ts, profile "${profile}"; a title needs a paired role word)`;
  });
  return [...new Set(parts.map((p) => p.toLowerCase()))].map((lower) => parts.find((p) => p.toLowerCase() === lower)!).join("; ");
}

/** Keywords/qualifiers that matched for ONE profile (evaluateRelevance spans all profiles at once). */
function keywordsFor(profile: string, fields: { title: string; department?: string }, roles: RoleConfig[]): string[] {
  return evaluateRelevance(fields, roles.filter((r) => r.profile === profile)).matchedKeywords;
}

export function classifyResultTitle(
  input: { title: string; team?: string | null },
  roles: RoleConfig[],
  options: TitleTargetingOptions = {},
): TitleDecision {
  const byTitle = evaluateRelevance({ title: input.title }, roles);
  if (byTitle.matched) {
    const profile = byTitle.matchedProfiles[0]!;
    const keywords = keywordsFor(profile, { title: input.title }, roles);
    return {
      classification: "MATCH",
      profile,
      rule: describeRule(keywords, profile, roles),
      reason: byTitle.relevanceReason,
      matchedKeywords: keywords,
    };
  }

  const team = input.team?.trim();
  if (options.reviewByTeam !== false && team) {
    const byTeam = evaluateRelevance({ title: "", department: team }, roles);
    if (byTeam.matched) {
      const profile = byTeam.matchedProfiles[0]!;
      const keywords = keywordsFor(profile, { title: "", department: team }, roles);
      return {
        classification: "REVIEW",
        profile,
        rule: `team label "${team}" matches ${describeRule(keywords, profile, roles)}; the title matches no configured role`,
        reason: `Title "${input.title}" has no configured role match, but its team "${team}" is in the "${profile}" domain. Needs a human decision.`,
        matchedKeywords: keywords,
      };
    }
  }

  return {
    classification: "NO_MATCH",
    profile: null,
    rule: "no config/roles.yml keyword or documented domain qualifier matches the title" + (team ? ` or the team label "${team}"` : ""),
    reason: `Title "${input.title}" does not match any configured role profile.`,
    matchedKeywords: [],
  };
}

import type { RoleConfig, ProfileKind } from "../types.js";

// Deterministic, no LLM. Two independent ways a (profile, field) pair can match:
//  1. The field's text contains one of that profile's config/roles.yml keyword phrases
//     verbatim (case-insensitive substring) -- the strongest evidence, since it's a phrase a
//     human already curated as meaning "this profile." Checked against every field, including
//     descriptionSnippet -- a random company boilerplate paragraph coincidentally containing
//     an exact multi-word phrase like "Software Development Engineer in Test" is vanishingly
//     unlikely, so this is safe even against free text.
//  2. The field's text contains one of a small, curated set of profile-specific DOMAIN_QUALIFIER
//     words as a whole token. Every word in every list below is inherently profile-specific
//     (an acronym like "sdet"/"soc"/"noc"/"iam", or a domain noun like "automation"/
//     "incident"/"cybersecurity") -- generic job-title words that say nothing about domain
//     (engineer, analyst, specialist, administrator, manager, director, associate,
//     coordinator, lead, architect, consultant, staff, senior, technician) are deliberately
//     excluded from every list, so a title/snippet containing ONLY a generic role word can
//     never match on its own, satisfying the "never treat 'engineer' or 'analyst' as
//     sufficient" requirement structurally rather than by a separate exclusion check.
//     Restricted to TITLE and DEPARTMENT only -- NOT descriptionSnippet or location. Found
//     live: a single-word qualifier like "automation" or "cloud" routinely appears in a
//     company's generic "About Us" boilerplate that opens every one of its job descriptions
//     regardless of role (confirmed against a real AHEAD posting: "AI Sales Specialist"
//     false-matched sdet+cloud purely because AHEAD's boilerplate mentions "cloud
//     infrastructure, automation and analytics"). Title/department are short, curated,
//     human-authored classification fields where a stray buzzword match is far less likely.
const DOMAIN_QUALIFIERS: Record<ProfileKind, string[]> = {
  sdet: ["sdet", "qa", "quality", "automation", "test", "testing"],
  security: [
    "security",
    "soc",
    "incident",
    "cyber",
    "cybersecurity",
    "vulnerability",
    "penetration",
    "pentest",
    "infosec",
    "threat",
  ],
  cloud: ["iam", "identity", "cloud"],
  network: ["network", "networking", "noc"],
};

export interface RelevanceInput {
  title: string;
  department?: string | null;
  location?: string | null;
  descriptionSnippet?: string | null;
}

export interface RelevanceEvaluation {
  matched: boolean;
  // Ordered: index 0 is the primary profile. Primary is the first profile (in
  // config/roles.yml's own array order) that has at least one hit -- simple, deterministic,
  // no separate "which is strongest" scoring needed.
  matchedProfiles: string[];
  matchedKeywords: string[];
  matchedFields: string[];
  relevanceReason: string;
}

function tokenize(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []) as string[]);
}

function fieldsToCheck(input: RelevanceInput): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  if (input.title) out.push({ field: "title", text: input.title });
  if (input.department) out.push({ field: "department", text: input.department });
  if (input.location) out.push({ field: "location", text: input.location });
  if (input.descriptionSnippet) out.push({ field: "descriptionSnippet", text: input.descriptionSnippet });
  return out;
}

interface ProfileHit {
  keywords: Set<string>;
  fields: Set<string>;
}

export function evaluateRelevance(input: RelevanceInput, roles: RoleConfig[]): RelevanceEvaluation {
  const fields = fieldsToCheck(input);
  const hitsByProfile = new Map<string, ProfileHit>();

  const recordHit = (profile: string, keyword: string, field: string) => {
    let hit = hitsByProfile.get(profile);
    if (!hit) {
      hit = { keywords: new Set(), fields: new Set() };
      hitsByProfile.set(profile, hit);
    }
    hit.keywords.add(keyword);
    hit.fields.add(field);
  };

  const DOMAIN_QUALIFIER_FIELDS = new Set(["title", "department"]);

  for (const role of roles) {
    for (const { field, text } of fields) {
      const lower = text.toLowerCase();
      for (const kw of role.keywords) {
        if (kw && lower.includes(kw.toLowerCase())) {
          recordHit(role.profile, kw, field);
        }
      }
      if (!DOMAIN_QUALIFIER_FIELDS.has(field)) continue;
      const tokens = tokenize(text);
      for (const qualifier of DOMAIN_QUALIFIERS[role.profile] ?? []) {
        if (tokens.has(qualifier)) {
          recordHit(role.profile, qualifier, field);
        }
      }
    }
  }

  const matchedProfiles = [...hitsByProfile.keys()];
  const matchedKeywords = [...new Set([...hitsByProfile.values()].flatMap((h) => [...h.keywords]))];
  const matchedFields = [...new Set([...hitsByProfile.values()].flatMap((h) => [...h.fields]))];

  if (matchedProfiles.length === 0) {
    return {
      matched: false,
      matchedProfiles: [],
      matchedKeywords: [],
      matchedFields: [],
      relevanceReason: "No configured keyword or domain term matched title/department/location/description snippet.",
    };
  }

  const primary = matchedProfiles[0]!;
  const primaryHit = hitsByProfile.get(primary)!;
  const primaryKeywords = [...primaryHit.keywords].join('", "');
  const extra = matchedProfiles.slice(1);
  const relevanceReason =
    `Matched profile "${primary}" via "${primaryKeywords}" in ${[...primaryHit.fields].join("/")}` +
    (extra.length ? ` (also matches: ${extra.join(", ")})` : "");

  return { matched: true, matchedProfiles, matchedKeywords, matchedFields, relevanceReason };
}

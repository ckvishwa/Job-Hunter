import type { RoleConfig, ProfileKind } from "../types.js";

// Deterministic, no LLM. Two independent ways a (profile, field) pair can match:
//  1. The field's text contains one of that profile's config/roles.yml keyword phrases
//     verbatim (case-insensitive substring) -- the strongest evidence, since it's a phrase a
//     human already curated as meaning "this profile." Checked against every field, including
//     descriptionSnippet -- a random company boilerplate paragraph coincidentally containing
//     an exact multi-word phrase like "Software Development Engineer in Test" is vanishingly
//     unlikely, so this is safe even against free text.
//  2. The field's text contains a profile-specific DOMAIN_QUALIFIER word, restricted to TITLE
//     and DEPARTMENT only -- NOT descriptionSnippet or location. Found live: a single-word
//     qualifier like "automation" or "cloud" routinely appears in a company's generic
//     "About Us" boilerplate that opens every one of its job descriptions regardless of role
//     (confirmed against a real AHEAD posting: "AI Sales Specialist" false-matched sdet+cloud
//     purely because AHEAD's boilerplate mentions "cloud infrastructure, automation and
//     analytics"). Title/department are short, curated, human-authored classification fields
//     where a stray buzzword match is far less likely -- but even there, a WEAK qualifier
//     (below) is common enough in non-technical English that it can still false-positive in a
//     TITLE alone: confirmed live via independent review reproducing "Account Executive,
//     Cloud Platform Sales" (matches "cloud"), "Corporate Security Guard" (matches
//     "security"), and "Network Marketing Representative" (matches "network") -- the exact
//     same class of false positive relevance.ts exists to prevent, just via a domain word
//     instead of a generic role word. Fixed by splitting qualifiers into two tiers:
//       - STRONG: acronyms/compounds that are essentially never used non-technically (sdet,
//         soc, noc, iam, cybersecurity, infosec, pentest) -- sufficient alone in title OR
//         department, same as before.
//       - WEAK: common English words that ARE genuinely used outside tech (quality, test,
//         automation, security, cloud, network, incident, ...) -- in TITLE, only count if
//         paired with a real tech/professional role word (engineer, developer, architect,
//         administrator, technician, analyst, specialist, consultant, scientist, programmer).
//         Deliberately excludes broad-across-every-business-function words (manager, director,
//         lead, coordinator, associate, executive) from that role-word set -- "Director of
//         Cloud Sales" must not pair. In DEPARTMENT, a WEAK qualifier still counts alone
//         (unpaired) -- a department value is a curated organizational category (e.g.
//         "Quality Assurance", "Security", "Network Operations"), not free English prose, so
//         the false-positive risk that motivates the title-pairing rule doesn't apply there.
//     Generic role words (engineer, analyst, specialist, administrator, manager, director,
//     associate, coordinator, lead, architect, consultant, staff, senior, technician) are
//     never themselves qualifiers, in either tier -- a title containing ONLY a generic role
//     word can never match on its own, satisfying "never treat 'engineer' or 'analyst' as
//     sufficient" structurally.
const STRONG_QUALIFIERS: Record<ProfileKind, string[]> = {
  sdet: ["sdet"],
  security: ["soc", "cybersecurity", "infosec", "pentest"],
  cloud: ["iam"],
  network: ["noc"],
};

const WEAK_QUALIFIERS: Record<ProfileKind, string[]> = {
  sdet: ["qa", "quality", "automation", "test", "testing"],
  security: ["security", "incident", "cyber", "vulnerability", "penetration", "threat"],
  cloud: ["identity", "cloud"],
  network: ["network", "networking"],
};

const TECH_ROLE_WORDS = new Set([
  "engineer",
  "developer",
  "architect",
  "administrator",
  "technician",
  "analyst",
  "specialist",
  "consultant",
  "scientist",
  "programmer",
]);

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
        // ponytail: unanchored substring match, no word-boundary check -- safe today only
        // because every config/roles.yml keyword is multi-word (verified: no bare short
        // keyword like "QA" or "IAM" exists there). A future short keyword added to roles.yml
        // would substring-match inside unrelated words in free-text fields (descriptionSnippet
        // especially). Add a word-boundary regex check here if that ever changes.
        if (kw && lower.includes(kw.toLowerCase())) {
          recordHit(role.profile, kw, field);
        }
      }
      if (!DOMAIN_QUALIFIER_FIELDS.has(field)) continue;

      const tokens = tokenize(text);
      for (const qualifier of STRONG_QUALIFIERS[role.profile] ?? []) {
        if (tokens.has(qualifier)) recordHit(role.profile, qualifier, field);
      }
      for (const qualifier of WEAK_QUALIFIERS[role.profile] ?? []) {
        if (!tokens.has(qualifier)) continue;
        // Department is a curated category value, not free prose -- a weak qualifier counts
        // there unpaired. Title is free-authored English and needs a real tech role word
        // alongside it (see the file-level comment for the reproduced false positives this
        // prevents).
        if (field === "department" || [...tokens].some((t) => TECH_ROLE_WORDS.has(t))) {
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

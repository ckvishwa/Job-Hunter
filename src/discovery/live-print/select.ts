import { titleMatches } from "../../pipeline/discovery/board-discoverer.js";
import { classifyLocation } from "../../pipeline/discovery/location.js";

const HARDWARE = /\b(propulsion|mechanical|hardware|avionics|battery|vehicle|asic|silicon|photonics)\b/i;
const EARLY = /\b(junior|associate|entry|new grad|early career|intern)\b/i;
const LATER = /\b(senior|staff|principal|director|\blead\b|manager|sr\.?)\b/i;

export interface LivePosting {
  provider: "greenhouse" | "lever" | "ashby" | "workday";
  company: string;
  title: string;
  location: string | null;
  url: string;
  requisitionId: string;
  descriptionText: string | null;
}

export interface SelectedJob extends LivePosting {
  profiles: string[];
  phrases: string[];
  locationVerdict: "US" | "NON_US" | "UNKNOWN";
  careerRank: number;
}

/** Title phrases for the four profiles in config/roles.yml, plus the command's named titles for those same profiles. */
export function phrasesForProfiles(roles: { profile: string; keywords: string[] }[], extras: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const role of roles) out[role.profile] = [...role.keywords];
  for (const [profile, phrases] of Object.entries(extras)) out[profile] = [...(out[profile] ?? []), ...phrases];
  return out;
}

export function careerRank(title: string): number {
  if (LATER.test(title)) return 2;
  if (EARLY.test(title)) return 0;
  return 1;
}

export function selectLiveJobs(postings: readonly LivePosting[], phrasesByProfile: Record<string, string[]>): SelectedJob[] {
  const seen = new Set<string>();
  const selected: SelectedJob[] = [];
  for (const posting of postings) {
    const key = `${posting.provider}::${posting.requisitionId || posting.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (HARDWARE.test(posting.title)) continue;
    const phrases: string[] = [];
    const profiles: string[] = [];
    for (const [profile, phrasesForProfile] of Object.entries(phrasesByProfile)) {
      const hit = titleMatches(posting.title, phrasesForProfile);
      if (hit.length === 0) continue;
      profiles.push(profile);
      phrases.push(...hit);
    }
    if (profiles.length === 0) continue;
    selected.push({
      ...posting,
      profiles,
      phrases: [...new Set(phrases)],
      locationVerdict: classifyLocation(posting.location),
      careerRank: careerRank(posting.title),
    });
  }
  return selected.sort((a, b) => a.careerRank - b.careerRank || a.title.localeCompare(b.title));
}

import type { RoleSearch } from "./types.js";

export function matchProfiles(text: string, searches: RoleSearch[]): string[] {
  const lower = text.toLowerCase();
  const profiles = new Set<string>();
  for (const search of searches) {
    if (search.keyword && lower.includes(search.keyword.toLowerCase())) {
      for (const profileId of search.profileIds) profiles.add(profileId);
    }
  }
  return [...profiles];
}

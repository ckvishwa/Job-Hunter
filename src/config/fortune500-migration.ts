import type { CompanyRegistryEntry } from "./schema.js";

export interface Fortune500NewIdentity {
  rank: number;
  company: string;
}

export interface RetainedEntry {
  oldRank: number | null;
  newRank: number;
  oldCompany: string;
  newCompany: string;
  corporateDomain: string | null;
}
export interface AddedEntry {
  newRank: number;
  newCompany: string;
  note?: string;
}
export interface RemovedEntry {
  oldRank: number | null;
  company: string;
  corporateDomain: string | null;
}
export interface RenamedEntry {
  oldRank: number | null;
  newRank: number;
  oldCompany: string;
  newCompany: string;
}
export interface RankChangeEntry {
  company: string;
  oldRank: number | null;
  newRank: number;
  delta: number;
}
export interface UnresolvedMatch {
  newRank: number;
  newCompany: string;
  reason: string;
  candidates: string[];
}

export interface Fortune500MigrationReport {
  totalRetained: number;
  totalAdded: number;
  totalRemoved: number;
  totalRenamed: number;
  totalRankChanges: number;
  totalUnresolved: number;
  retained: RetainedEntry[];
  added: AddedEntry[];
  removed: RemovedEntry[];
  renamed: RenamedEntry[];
  rankChanges: RankChangeEntry[];
  unresolvedIdentityMatches: UnresolvedMatch[];
}

// Legal-entity-suffix words stripped for matching purposes only (never used to alter a stored
// display name -- normalize() exists purely to compare identities, not to rewrite them).
const SUFFIX_RE = /\b(incorporated|inc|corporation|corp|company|co|group|holdings|holding|international|worldwide|companies|plc|ltd|llc|the|com)\b/g;

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizeCompanyIdentity(name: string): string {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/\.com\b/g, "") // strip BEFORE punctuation removal, or \bcom\b in SUFFIX_RE can never match "amazoncom"
    .replace(/[.,'’]/g, "")
    .replace(SUFFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tightNormalize(name: string): string {
  return normalizeCompanyIdentity(name).replace(/\s+/g, "");
}

// Matches purely by normalized company identity -- NEVER by rank number (rank order differs
// across dataset editions/years; matching by rank silently corrupted the wrong row the first
// time this was tried, caught before it reached the registry). Ambiguous matches (more than one
// old-registry candidate for a single new identity) are reported, never guessed.
export function migrateFortune500Identity(
  oldEntries: CompanyRegistryEntry[],
  newIdentity: Fortune500NewIdentity[],
): Fortune500MigrationReport {
  const oldByLoose = new Map<string, CompanyRegistryEntry[]>();
  const oldByTight = new Map<string, CompanyRegistryEntry[]>();
  for (const e of oldEntries) {
    const loose = normalizeCompanyIdentity(e.company);
    const tight = tightNormalize(e.company);
    (oldByLoose.get(loose) ?? oldByLoose.set(loose, []).get(loose)!).push(e);
    (oldByTight.get(tight) ?? oldByTight.set(tight, []).get(tight)!).push(e);
  }

  const retained: RetainedEntry[] = [];
  const added: AddedEntry[] = [];
  const renamed: RenamedEntry[] = [];
  const rankChanges: RankChangeEntry[] = [];
  const unresolved: UnresolvedMatch[] = [];
  const matchedOldCompanies = new Set<string>();

  for (const n of newIdentity) {
    const loose = normalizeCompanyIdentity(n.company);
    const tight = tightNormalize(n.company);
    let candidates = oldByLoose.get(loose) ?? [];
    if (candidates.length === 0) candidates = oldByTight.get(tight) ?? [];

    if (candidates.length === 1) {
      const old = candidates[0]!;
      matchedOldCompanies.add(old.company);
      retained.push({
        oldRank: old.fortuneRank,
        newRank: n.rank,
        oldCompany: old.company,
        newCompany: n.company,
        corporateDomain: old.corporateDomain,
      });
      if (old.company !== n.company) {
        renamed.push({ oldRank: old.fortuneRank, newRank: n.rank, oldCompany: old.company, newCompany: n.company });
      }
      if (old.fortuneRank !== n.rank) {
        rankChanges.push({ company: n.company, oldRank: old.fortuneRank, newRank: n.rank, delta: (old.fortuneRank ?? 0) - n.rank });
      }
    } else if (candidates.length > 1) {
      unresolved.push({
        newRank: n.rank,
        newCompany: n.company,
        reason: `${candidates.length} ambiguous old-registry matches`,
        candidates: candidates.map((c) => c.company),
      });
      added.push({ newRank: n.rank, newCompany: n.company, note: "ambiguous match, treated as added -- see unresolvedIdentityMatches" });
    } else {
      added.push({ newRank: n.rank, newCompany: n.company });
    }
  }

  const removed: RemovedEntry[] = oldEntries
    .filter((e) => !matchedOldCompanies.has(e.company))
    .map((e) => ({ oldRank: e.fortuneRank, company: e.company, corporateDomain: e.corporateDomain }));

  return {
    totalRetained: retained.length,
    totalAdded: added.length,
    totalRemoved: removed.length,
    totalRenamed: renamed.length,
    totalRankChanges: rankChanges.length,
    totalUnresolved: unresolved.length,
    retained,
    added,
    removed,
    renamed,
    rankChanges,
    unresolvedIdentityMatches: unresolved,
  };
}

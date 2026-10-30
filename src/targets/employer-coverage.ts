import type { TargetRecord } from "./crosswalk.js";

export const COVERAGE_STATUSES = [
  "NOT_STARTED",
  "VERIFIED_SOURCE",
  "FETCHED",
  "PARTIAL",
  "UNSUPPORTED_ATS",
  "BLOCKED",
  "FAILED",
] as const;

export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export interface RegistryEmployer {
  company: string;
  careersUrl: string | null;
  atsType: string | null;
  atsTenantOrBoardId: string | null;
  atsWorkdaySite: string | null;
  atsWorkdayHostname: string | null;
  verificationStatus: string | null;
}

export interface EmployerCoverage {
  canonicalId: string;
  displayName: string;
  status: CoverageStatus;
  reason: string;
  verifiedAt: string | null;
  brands: string[];
  aliases: string[];
  parentCompany: string | null;
  officialCareersUrl: string | null;
  careersUrlVerified: boolean;
  atsIdentity: string | null;
  uniqueJobs: number;
  rawObservations: number;
  newPostings: number;
  durationMs: number | null;
  error: string | null;
  sponsorshipEligibilityInferred: false;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchRegistry(target: TargetRecord, registry: readonly RegistryEmployer[]): RegistryEmployer | null {
  const names = [target.displayName, ...(target.aliases ?? [])].map(norm).filter(Boolean);
  const registryName = target.existingFortune500RegistryMatch ? norm(target.existingFortune500RegistryMatch) : "";
  return registry.find((row) => {
    const company = norm(row.company);
    return names.includes(company) || (registryName.length > 0 && company === registryName);
  }) ?? null;
}

/** Classifies a target from stored registry fields only. It does not invent a board id. */
export function classifyStoredSource(target: TargetRecord, registry: readonly RegistryEmployer[], verifiedAt: string | null): EmployerCoverage {
  const row = matchRegistry(target, registry);
  const base: EmployerCoverage = {
    canonicalId: target.id,
    displayName: target.displayName,
    status: "NOT_STARTED",
    reason: "No verified Greenhouse or Lever board id is stored. A board id was not guessed.",
    verifiedAt,
    brands: target.aliases ?? [],
    aliases: target.aliases ?? [],
    parentCompany: target.parentCompany,
    officialCareersUrl: row?.careersUrl ?? null,
    careersUrlVerified: false,
    atsIdentity: null,
    uniqueJobs: 0,
    rawObservations: 0,
    newPostings: 0,
    durationMs: null,
    error: null,
    sponsorshipEligibilityInferred: false,
  };
  if (!row) return base;
  if (row.atsType === "workday") {
    const host = row.atsWorkdayHostname?.trim() || null;
    const site = row.atsWorkdaySite?.trim() || null;
    if (!host || !site || row.verificationStatus !== "verified") {
      return {
        ...base,
        status: "UNSUPPORTED_ATS",
        reason: "Registry marks Workday but does not store a verified hostname and site. The host was not guessed.",
        atsIdentity: row.atsTenantOrBoardId,
      };
    }
    return {
      ...base,
      status: "VERIFIED_SOURCE",
      reason: "Verified Workday host is stored. This record does not by itself mean a catalog was fetched.",
      atsIdentity: `${host}/${site}`,
      careersUrlVerified: true,
      officialCareersUrl: row.careersUrl,
    };
  }
  if ((row.atsType === "greenhouse" || row.atsType === "lever") && row.atsTenantOrBoardId && row.verificationStatus === "verified") {
    return {
      ...base,
      status: "VERIFIED_SOURCE",
      reason: `Stored ${row.atsType} board id is marked verified. Live name check is still required before any job is kept.`,
      atsIdentity: `${row.atsType}:${row.atsTenantOrBoardId}`,
      officialCareersUrl: row.careersUrl,
    };
  }
  if (row.careersUrl) {
    return {
      ...base,
      reason: "A careers URL candidate exists and the ATS identity is not verified. The URL was not treated as an official board.",
    };
  }
  return base;
}

export function coverageLedger(targets: readonly TargetRecord[], registry: readonly RegistryEmployer[], verifiedAt: string | null): EmployerCoverage[] {
  return targets.map((target) => classifyStoredSource(target, registry, verifiedAt));
}

export function unresolvedEmployers(records: readonly EmployerCoverage[]): EmployerCoverage[] {
  return records.filter((record) => record.status !== "FETCHED");
}

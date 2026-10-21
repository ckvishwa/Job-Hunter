export const UPSTREAM_COMMIT = "dff9703a092e2872245aef09b096edcee054ac69";

export const ATS_RESOLUTION_STATUSES = [
  "VERIFIED",
  "NOT_FOUND",
  "UNSUPPORTED",
  "ACCESS_RESTRICTED",
  "TRANSIENT_FAILURE",
  "IDENTITY_MISMATCH",
] as const;

export type AtsResolutionStatus = (typeof ATS_RESOLUTION_STATUSES)[number];

export interface EmployerResolution {
  canonicalId: string;
  displayName: string;
  status: AtsResolutionStatus;
  atsType: string | null;
  method: string;
  careersUrl: string | null;
  reason: string;
  observedPostings: number;
  uniqueUsPostings: number | null;
  resolvedJds: number;
  verifiedAt: string | null;
}

export interface PriorityEmployer {
  id: string;
  displayName: string;
  aliases?: string[];
  parentCompany?: string | null;
}

export function unresolvedEmployer(employer: PriorityEmployer): EmployerResolution {
  return {
    canonicalId: employer.id,
    displayName: employer.displayName,
    status: "NOT_FOUND",
    atsType: null,
    method: "none",
    careersUrl: null,
    reason: "No verified ATS tenant, instance, site, or board token is stored. A directory slug was not guessed.",
    observedPostings: 0,
    uniqueUsPostings: null,
    resolvedJds: 0,
    verifiedAt: null,
  };
}

export function workdayFromUrl(value: string): { tenant: string; instance: string; site: string; hostname: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = url.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  const site = url.pathname.split("/").filter(Boolean).pop();
  if (!match || !site) return null;
  return { tenant: match[1]!, instance: match[2]!, site, hostname: url.hostname };
}

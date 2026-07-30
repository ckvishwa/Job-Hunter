import { companyRegistrySchema, type CompanyRegistryEntry } from "./schema.js";

export const EXPECTED_TOTAL = 500;
// The edition this audit reports against. Not derived from the data (no per-entry "edition"
// field exists -- edition is a property of the whole registry snapshot, recorded in each
// entry's sourceProvenance strings instead) -- stated once, here, and bumped by whichever task
// next refreshes the registry to a newer edition.
export const CURRENT_EDITION = "Fortune 500, 2026";
// Minimum scan-ready (verified career URL) entries for the registry to be considered
// operationally complete, not just structurally valid. Matches the task's own acceptance bar.
export const OPERATIONAL_READINESS_TARGET = 475;

const ATS_TYPES = ["greenhouse", "lever", "ashby", "workday", "icims", "generic", "unknown"] as const;
const VERIFICATION_STATUSES = ["verified", "no-parent-careers-page", "unreachable", "verification-required", "not-found", "pending"] as const;

export interface Fortune500AuditIssue {
  index: number;
  fortuneRank: number | null;
  company: string | null;
  path: string;
  message: string;
}

export interface Fortune500AuditResult {
  totalEntries: number;
  missingRanks: number[];
  duplicateRanks: number[];
  duplicateCompanies: string[];
  careerUrlsPresent: number;
  careerUrlsMissing: number;
  atsIdentified: number;
  atsUnknown: number;
  atsCounts: Record<(typeof ATS_TYPES)[number], number>;
  verificationStatusCounts: Record<(typeof VERIFICATION_STATUSES)[number], number>;
  unsafeUrlCount: number;
  schemaErrors: Fortune500AuditIssue[];
  ok: boolean;
  failReasons: string[];

  // -- Operational-readiness reporting (distinct from `ok`/structural validity above; a
  // registry can be `ok: true` -- 500 structurally valid rows -- while still being nowhere
  // near operationally complete). --
  edition: string;
  currentEditionIdentities: number;
  domainsVerified: number;
  domainsMissing: number;
  careerUrlsVerified: number;
  careerUrlsUnreachable: number;
  verificationRequiredCount: number;
  // "no-parent-careers-page" -- a documented, evidence-backed exception (e.g. a holding company
  // with no centralized careers page). Mutually exclusive from careerUrlsVerified: an exception
  // is never counted as a verified career URL, no matter how well-justified.
  documentedExceptions: number;
  notFoundCount: number;
  // totalEntries minus pending -- every entry that has been looked at, regardless of outcome.
  attemptedCount: number;
  scanReadyEntries: number;
  // Entries whose sourceProvenance carries more than the bare edition-membership string --
  // i.e. something (a domain, a career URL, a verification attempt) was actually sourced for
  // them, not just "this company is in the 2026 list."
  provenanceBeyondEdition: number;
  operationallyComplete: boolean;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Reads raw, not-yet-validated entries defensively (a malformed entry may not even have a
// string `company`/number `fortuneRank`) -- never throws on odd shapes, only reports them.
function rawField<T>(raw: unknown, field: string): T | null {
  if (raw && typeof raw === "object" && field in raw) {
    const value = (raw as Record<string, unknown>)[field];
    return (value ?? null) as T | null;
  }
  return null;
}

// Pure, deterministic, read-only over its input -- never touches the filesystem, never mutates
// `rawEntries`. The CLI wrapper (fortune500-audit-cli.ts) owns all file I/O, and only ever
// writes to output/, never back to the registry file itself -- a failed audit can never
// truncate or otherwise modify config/fortune500-registry.json.
export function auditFortune500Registry(rawEntries: unknown[]): Fortune500AuditResult {
  const totalEntries = rawEntries.length;

  const atsCounts = Object.fromEntries(ATS_TYPES.map((t) => [t, 0])) as Fortune500AuditResult["atsCounts"];
  const verificationStatusCounts = Object.fromEntries(
    VERIFICATION_STATUSES.map((s) => [s, 0]),
  ) as Fortune500AuditResult["verificationStatusCounts"];

  let careerUrlsPresent = 0;
  let unsafeUrlCount = 0;
  let domainsVerified = 0;
  let scanReadyEntries = 0;
  let provenanceBeyondEdition = 0;
  const rankCounts = new Map<number, number>();

  rawEntries.forEach((raw) => {
    const rank = rawField<number>(raw, "fortuneRank");
    if (typeof rank === "number") {
      rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);
    }

    const careersUrl = rawField<string>(raw, "careersUrl");
    if (careersUrl) {
      careerUrlsPresent += 1;
      if (!isHttpUrl(careersUrl)) unsafeUrlCount += 1;
    }

    if (rawField<string>(raw, "corporateDomain") !== null) domainsVerified += 1;

    const atsType = rawField<string>(raw, "atsType");
    if (atsType && (ATS_TYPES as readonly string[]).includes(atsType)) {
      atsCounts[atsType as (typeof ATS_TYPES)[number]] += 1;
    }

    const status = rawField<string>(raw, "verificationStatus");
    if (status && (VERIFICATION_STATUSES as readonly string[]).includes(status)) {
      verificationStatusCounts[status as (typeof VERIFICATION_STATUSES)[number]] += 1;
    }
    if (status === "verified" && careersUrl) scanReadyEntries += 1;

    const provenance = rawField<string[]>(raw, "sourceProvenance");
    if (Array.isArray(provenance) && provenance.length > 1) provenanceBeyondEdition += 1;
  });

  const missingRanks: number[] = [];
  for (let r = 1; r <= EXPECTED_TOTAL; r++) {
    if (!rankCounts.has(r)) missingRanks.push(r);
  }
  const duplicateRanks = [...rankCounts.entries()].filter(([, count]) => count > 1).map(([rank]) => rank).sort((a, b) => a - b);

  const domainSeen = new Map<string, number>();
  const duplicateCompanies: string[] = [];
  rawEntries.forEach((raw) => {
    const company = rawField<string>(raw, "company");
    const domain = rawField<string>(raw, "corporateDomain");
    if (!company || !domain) return;
    const key = `${company.toLowerCase()}::${domain.toLowerCase()}`;
    const count = (domainSeen.get(key) ?? 0) + 1;
    domainSeen.set(key, count);
    if (count === 2) duplicateCompanies.push(key);
  });

  const schemaResult = companyRegistrySchema.safeParse(rawEntries);
  const schemaErrors: Fortune500AuditIssue[] = schemaResult.success
    ? []
    : schemaResult.error.issues.map((issue) => {
        const index = typeof issue.path[0] === "number" ? issue.path[0] : -1;
        const raw = index >= 0 ? rawEntries[index] : undefined;
        return {
          index,
          fortuneRank: rawField<number>(raw, "fortuneRank"),
          company: rawField<string>(raw, "company"),
          path: issue.path.slice(1).join("."),
          message: issue.message,
        };
      });

  const failReasons: string[] = [];
  if (totalEntries !== EXPECTED_TOTAL) {
    failReasons.push(`Total entries is ${totalEntries}, expected exactly ${EXPECTED_TOTAL}`);
  }
  if (missingRanks.length > 0) {
    failReasons.push(`Missing rank(s): ${missingRanks.join(", ")}`);
  }
  if (duplicateRanks.length > 0) {
    failReasons.push(`Duplicate rank(s): ${duplicateRanks.join(", ")}`);
  }
  if (schemaErrors.length > 0) {
    failReasons.push(`Schema validation failed on ${schemaErrors.length} issue(s)`);
  }
  if (unsafeUrlCount > 0) {
    failReasons.push(`${unsafeUrlCount} unsafe URL(s) found`);
  }

  return {
    totalEntries,
    missingRanks,
    duplicateRanks,
    duplicateCompanies,
    careerUrlsPresent,
    careerUrlsMissing: totalEntries - careerUrlsPresent,
    atsIdentified: totalEntries - atsCounts.unknown,
    atsUnknown: atsCounts.unknown,
    atsCounts,
    verificationStatusCounts,
    unsafeUrlCount,
    schemaErrors,
    ok: failReasons.length === 0,
    failReasons,

    edition: CURRENT_EDITION,
    currentEditionIdentities: totalEntries,
    domainsVerified,
    domainsMissing: totalEntries - domainsVerified,
    careerUrlsVerified: scanReadyEntries,
    careerUrlsUnreachable: verificationStatusCounts.unreachable,
    verificationRequiredCount: verificationStatusCounts["verification-required"],
    documentedExceptions: verificationStatusCounts["no-parent-careers-page"],
    notFoundCount: verificationStatusCounts["not-found"],
    attemptedCount: totalEntries - verificationStatusCounts.pending,
    scanReadyEntries,
    provenanceBeyondEdition,
    // Structural validity (`ok`) is necessary but never sufficient -- a registry of 500
    // honestly-unknown rows is `ok: true` and `operationallyComplete: false` at the same time.
    operationallyComplete: failReasons.length === 0 && scanReadyEntries >= OPERATIONAL_READINESS_TARGET,
  };
}

export type { CompanyRegistryEntry };

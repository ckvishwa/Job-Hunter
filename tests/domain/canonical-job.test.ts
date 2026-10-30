import { describe, expect, it } from "vitest";
import {
  CANONICAL_SCHEMA_VERSION,
  assessJobDescription,
  buildJobFailure,
  computeJdContentHash,
  evaluatePersistable,
  jobIdFromAtsIdentity,
  parseAtsPostingUrl,
  stampResolution,
  verifyOfficialPosting,
} from "../../src/domain/canonical-job.js";
import { companyRegistrySchema } from "../../src/config/schema.js";
import type { JobPosting } from "../../src/adapters/types.js";
import { ACME, FULL_JD_HTML, registryEntry } from "../helpers/canonical-fixtures.js";
import { stripHtml } from "../../src/extraction/jd-cleaner.js";

const entry = companyRegistrySchema.parse([registryEntry()])[0]!;
const OFFICIAL = `https://boards.greenhouse.io/${ACME.board}/jobs/101?gh_jid=101`;

function posting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "0000000000000000",
    source: "company-careers::acme",
    sourceType: "company-careers",
    company: "Acme",
    title: "SDET II",
    location: "Remote - US",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "101",
    postingDate: null,
    discoveredAt: "2026-10-07T12:00:00.000Z",
    lastSeenAt: "2026-10-07T12:00:00.000Z",
    canonicalUrl: OFFICIAL,
    applyUrl: OFFICIAL,
    descriptionText: stripHtml(FULL_JD_HTML),
    descriptionHtml: FULL_JD_HTML,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["company-careers"],
    rawMetadata: {},
    ...overrides,
  };
}

function stamp(p: JobPosting, overrides: Record<string, unknown> = {}) {
  return stampResolution(p, {
    sourceKind: "company-careers",
    observedUrl: OFFICIAL,
    observedAt: "2026-10-07T12:00:00.000Z",
    finalUrl: OFFICIAL,
    extractionMethod: "ats-api",
    discoveredCompany: "Acme",
    registryEntry: entry,
    apiJobId: "101",
    now: "2026-10-07T12:05:00.000Z",
    ...overrides,
  } as Parameters<typeof stampResolution>[1]);
}

describe("assessJobDescription", () => {
  it("accepts a complete JD", () => {
    expect(assessJobDescription(stripHtml(FULL_JD_HTML))).toBeNull();
  });
  it("rejects empty text", () => {
    expect(assessJobDescription("   \n ")?.code).toBe("EMPTY_DESCRIPTION");
  });
  it("rejects the resolver placeholder, with and without its prefix", () => {
    expect(assessJobDescription("Job posting found on indeed. Full description not extracted. Reason: timeout")?.code).toBe(
      "PLACEHOLDER_DESCRIPTION",
    );
    expect(assessJobDescription("Full description not extracted.")?.code).toBe("PLACEHOLDER_DESCRIPTION");
  });
  it("rejects a one-line stub as too short", () => {
    expect(assessJobDescription("We are looking for QA Automation")?.code).toBe("DESCRIPTION_TOO_SHORT");
  });
});

describe("verifyOfficialPosting", () => {
  const base = { discoveredCompany: "Acme", registryEntry: entry };

  it("accepts the registry's hosted board and derives a stable ATS identity", () => {
    const v = verifyOfficialPosting({ ...base, finalUrl: OFFICIAL, apiJobId: "101" });
    expect(v).toMatchObject({ ok: true, atsIdentity: "greenhouse:acme:101", hostKind: "ats-board" });
  });

  it("derives the same identity from the redirected job-boards host with different tracking", () => {
    const v = verifyOfficialPosting({
      ...base,
      finalUrl: `https://job-boards.greenhouse.io/ACME/jobs/101?utm_source=x&gh_jid=101`,
    });
    expect(v.atsIdentity).toBe("greenhouse:acme:101");
  });

  it("accepts a company-hosted page that carries gh_jid", () => {
    const v = verifyOfficialPosting({ ...base, finalUrl: `https://careers.${ACME.domain}/jobs/search?gh_jid=101` });
    expect(v).toMatchObject({ ok: true, atsIdentity: "greenhouse:acme:101", hostKind: "company-domain" });
  });

  it("rejects a different employer's board even when the listing claims Acme", () => {
    const v = verifyOfficialPosting({ ...base, finalUrl: "https://boards.greenhouse.io/otherco/jobs/101" });
    expect(v.failure?.code).toBe("BOARD_MISMATCH");
  });

  it("rejects a listing whose claimed employer differs from the registry employer", () => {
    const v = verifyOfficialPosting({ ...base, discoveredCompany: "Globex", finalUrl: OFFICIAL });
    expect(v.failure?.code).toBe("EMPLOYER_MISMATCH");
  });

  it("rejects a URL that merely contains the company domain", () => {
    const lookalikes = [
      `https://evil.example/path/${ACME.domain}/jobs?gh_jid=101`,
      `https://${ACME.domain}.evil.example/jobs?gh_jid=101`,
      `https://evil.example/redirect?to=https://${ACME.domain}/jobs&gh_jid=101`,
      `https://not${ACME.domain}/jobs?gh_jid=101`,
    ];
    for (const finalUrl of lookalikes) {
      expect(verifyOfficialPosting({ ...base, finalUrl }).failure?.code).toBe("UNOFFICIAL_HOST");
    }
  });

  it("rejects an unmatched employer, a board page without a job id, and an id disagreeing with the ATS", () => {
    expect(verifyOfficialPosting({ ...base, registryEntry: null, finalUrl: OFFICIAL }).failure?.code).toBe("UNVERIFIED_EMPLOYER");
    expect(verifyOfficialPosting({ ...base, finalUrl: `https://job-boards.greenhouse.io/${ACME.board}?error=true` }).failure?.code).toBe(
      "JOB_ID_MISSING",
    );
    expect(verifyOfficialPosting({ ...base, finalUrl: OFFICIAL, apiJobId: "999" }).failure?.code).toBe("JOB_ID_MISMATCH");
    expect(verifyOfficialPosting({ ...base, finalUrl: "ftp://boards.greenhouse.io/acme/jobs/1" }).failure?.code).toBe("INVALID_URL");
  });

  it("parses lever boards by exact host", () => {
    expect(parseAtsPostingUrl("https://jobs.lever.co/acme/2d1e-uuid/apply")).toMatchObject({ ats: "lever", board: "acme", jobId: "2d1e-uuid" });
    expect(parseAtsPostingUrl("https://jobs.lever.co.evil.example/acme/2d1e")).toBeNull();
  });
});

describe("stampResolution + evaluatePersistable", () => {
  it("stamps a valid posting with every canonical field and lets it persist", () => {
    const stamped = stamp(posting());
    expect(stamped).toMatchObject({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      resolutionStatus: "resolved",
      atsIdentity: "greenhouse:acme:101",
      extractedAt: "2026-10-07T12:05:00.000Z",
      id: jobIdFromAtsIdentity("greenhouse:acme:101"),
    });
    expect(stamped.jdContentHash).toBe(computeJdContentHash(posting().descriptionText));
    expect(stamped.sourceObservations).toEqual([
      {
        sourceKind: "company-careers",
        observedUrl: OFFICIAL,
        finalUrl: OFFICIAL,
        observedAt: "2026-10-07T12:00:00.000Z",
        extractionMethod: "ats-api",
      },
    ]);
    expect(evaluatePersistable(stamped).ok).toBe(true);
  });

  it("marks a placeholder description unresolved and refuses to persist it", () => {
    const stamped = stamp(posting({ descriptionText: "Job posting found on company-careers. Full description not extracted." }));
    expect(stamped.resolutionStatus).toBe("unresolved");
    const gate = evaluatePersistable(stamped);
    expect(gate.ok).toBe(false);
    expect(!gate.ok && gate.failure.code).toBe("PLACEHOLDER_DESCRIPTION");
  });

  it("reports identity failure ahead of description quality", () => {
    const stamped = stamp(posting(), { discoveredCompany: "Globex" });
    expect(stamped.resolutionFailure?.code).toBe("EMPLOYER_MISMATCH");
  });

  it("refuses an unstamped posting (fail closed)", () => {
    const gate = evaluatePersistable(posting());
    expect(!gate.ok && gate.failure.code).toBe("UNSTAMPED_POSTING");
  });

  it("refuses a resolved-looking posting that fails the runtime schema", () => {
    const stamped = { ...stamp(posting()), jdContentHash: "not-a-hash" };
    const gate = evaluatePersistable(stamped);
    expect(!gate.ok && gate.failure.code).toBe("SCHEMA_INVALID");
  });

  it("strips the transient resolutionFailure field from persisted records", () => {
    const stamped = { ...stamp(posting()), resolutionFailure: { code: "X", detail: "y" } };
    const gate = evaluatePersistable(stamped);
    expect(gate.ok && "resolutionFailure" in gate.posting).toBe(false);
  });
});

describe("buildJobFailure", () => {
  it("categorizes, marks retryability, and keeps diagnostics short and credential-free", () => {
    const f = buildJobFailure({
      code: "EMPTY_DESCRIPTION",
      stage: "resolution",
      runId: "run-1",
      targetUrl: "https://user:secret@boards.greenhouse.io/acme/jobs/1",
      company: "Acme",
      title: "SDET",
      sourceJobId: "1",
      detail: "x".repeat(1000),
    });
    expect(f.category).toBe("JD_EXTRACTION_FAILED");
    expect(f.retryable).toBe(false);
    expect(f.targetUrl).not.toContain("secret");
    expect(f.detail.length).toBeLessThanOrEqual(300);
    expect(buildJobFailure({ ...f, code: "RESOLUTION_TIMEOUT", stage: "resolution" }).retryable).toBe(true);
  });
});

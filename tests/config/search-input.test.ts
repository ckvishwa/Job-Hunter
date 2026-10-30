import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConfigValidationError } from "../../src/config/loader.js";
import { loadSearchInput, resolveSearchTarget, searchInputFileSchema, searchTargetSchema } from "../../src/config/search-input.js";
import { companyRegistrySchema } from "../../src/config/schema.js";
import { parseSearchArgs } from "../../src/discovery/search-cli.js";
import { verifyOfficialPosting } from "../../src/domain/canonical-job.js";

const base = { company: "Stripe", careersUrl: "https://stripe.com/careers/search", queries: ["SDET"], maxJobs: 1, registry: "config/fortune500-registry.validation.json" };

describe("search input schema", () => {
  it("loads the shipped example and resolves it against the verified registry entry", () => {
    const input = loadSearchInput(path.resolve("config/job-search-inputs.example.json"));
    expect(input.searches).toHaveLength(1);
    const resolved = resolveSearchTarget(input.searches[0]!);
    expect(resolved.entry).toMatchObject({ company: "Stripe", corporateDomain: "stripe.com", atsType: "greenhouse", atsTenantOrBoardId: "stripe", verificationStatus: "verified" });
    expect(resolved.target.queries).toEqual(["SDET", "QA", "security engineer"]);
    expect(resolved.target.maxJobs).toBe(1);
  });

  it.each([
    ["http (not https) careers URL", { careersUrl: "http://stripe.com/careers/search" }],
    ["no queries", { queries: [] }],
    ["blank query", { queries: ["   "] }],
    ["maxJobs zero", { maxJobs: 0 }],
    ["maxJobs too large", { maxJobs: 500 }],
    ["fractional maxJobs", { maxJobs: 1.5 }],
    ["unknown field (no candidate data allowed here)", { candidateAnswers: { sponsorship: "no" } }],
    ["unknown selector field", { selectors: { script: "alert(1)" } }],
  ])("rejects %s", (_name, patch) => {
    expect(searchTargetSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });

  it("fills selector defaults", () => {
    const t = searchTargetSchema.parse(base);
    expect(t.selectors.descriptionContainer).toContain("main");
    expect(t.selectors.resultLink.length).toBeGreaterThan(0);
  });

  it("rejects a file with no searches, and reports a readable error for bad JSON", () => {
    expect(searchInputFileSchema.safeParse({ searches: [] }).success).toBe(false);
    const dir = mkdtempSync(path.join(tmpdir(), "jh-search-input-"));
    const file = path.join(dir, "in.json");
    writeFileSync(file, "{ nope");
    expect(() => loadSearchInput(file)).toThrow(ConfigValidationError);
  });
});

describe("resolveSearchTarget ties the careers URL to the registry employer before any browser opens", () => {
  it("rejects a company that is not in the registry", () => {
    expect(() => resolveSearchTarget(searchTargetSchema.parse({ ...base, company: "Nobody Inc" }))).toThrow(/not in the registry/);
  });

  it("rejects a careers URL on a host that is not the employer's domain or registered board", () => {
    expect(() => resolveSearchTarget(searchTargetSchema.parse({ ...base, careersUrl: "https://stripe.com.evil.example/careers/search" }))).toThrow(/neither/);
    expect(() => resolveSearchTarget(searchTargetSchema.parse({ ...base, careersUrl: "https://jobs.example.com/stripe" }))).toThrow(/neither/);
  });

  it("accepts the employer's registered Greenhouse board URL", () => {
    expect(() => resolveSearchTarget(searchTargetSchema.parse({ ...base, careersUrl: "https://job-boards.greenhouse.io/stripe" }))).not.toThrow();
    expect(() => resolveSearchTarget(searchTargetSchema.parse({ ...base, careersUrl: "https://job-boards.greenhouse.io/otherco" }))).toThrow(/neither/);
  });
});

describe("company-hosted listings: a bare number in a URL is never an ATS identity", () => {
  const entry = companyRegistrySchema.parse([
    { company: "Acme", fortuneRank: null, corporateDomain: "acme-corp.com", careersUrl: "https://acme-corp.com/careers", atsType: "greenhouse", atsTenantOrBoardId: "acme", atsWorkdaySite: null, atsWorkdayHostname: null, enabled: true, verificationStatus: "verified", verificationNote: null, sourceProvenance: ["t"], lastVerifiedAt: "2026-10-07" },
  ])[0]!;
  const verify = (finalUrl: string, extra: Record<string, unknown> = {}, registryEntry = entry) =>
    verifyOfficialPosting({ finalUrl, discoveredCompany: "Acme", registryEntry, ...extra });

  it("gives no identity to a numeric URL suffix on its own", () => {
    for (const url of ["https://acme-corp.com/careers/listing/some-role/8172503", "https://acme-corp.com/blog/post/8172503", "https://acme-corp.com/careers/2024001"]) {
      const v = verify(url);
      expect(v.ok).toBe(false);
      expect(v.atsIdentity).toBeNull();
      expect(v.failure?.code).toBe("JOB_ID_MISSING");
    }
  });

  it("accepts the identity only when the caller supplies an id it confirmed on the registered board", () => {
    expect(verify("https://acme-corp.com/careers/listing/some-role/8172503", { confirmedGreenhouseJobId: "8172503" })).toMatchObject({ ok: true, atsIdentity: "greenhouse:acme:8172503", hostKind: "company-domain" });
  });

  it("still accepts gh_jid on a company page without any confirmation", () => {
    expect(verify("https://acme-corp.com/jobs/search?gh_jid=8172503")).toMatchObject({ ok: true, atsIdentity: "greenhouse:acme:8172503" });
  });

  it("a confirmed id never invents an identity for a non-Greenhouse employer or a look-alike host", () => {
    const lever = { ...entry, atsType: "lever" as const };
    expect(verify("https://acme-corp.com/careers/listing/some-role/8172503", { confirmedGreenhouseJobId: "8172503" }, lever).atsIdentity).toBeNull();
    const bad = verify("https://acme-corp.com.evil.example/careers/listing/some-role/8172503", { confirmedGreenhouseJobId: "8172503" });
    expect(bad.failure?.code).toBe("UNOFFICIAL_HOST");
    expect(bad.atsIdentity).toBeNull();
  });
});

describe("listingIdPattern and selection settings", () => {
  it("requires a valid regular expression with exactly one capture group", () => {
    const withPattern = (listingIdPattern: string) => searchTargetSchema.safeParse({ ...base, selectors: { listingIdPattern } }).success;
    expect(withPattern("^/careers/listing/[^/]+/(\\d{6,})/?$")).toBe(true);
    expect(withPattern("^/careers/listing/[^/]+/\\d{6,}$")).toBe(false); // no group
    expect(withPattern("^/(a)/(b)$")).toBe(false); // two groups
    expect(withPattern("([unclosed")).toBe(false); // invalid regex
  });

  it("defaults to not opening REVIEW results and to team-based review", () => {
    expect(searchTargetSchema.parse(base).selection).toEqual({ openReview: false, reviewByTeam: true });
    expect(searchTargetSchema.safeParse({ ...base, selection: { openReview: true, stealth: true } }).success).toBe(false);
  });

  it("the shipped example declares its URL shape explicitly", () => {
    const t = loadSearchInput(path.resolve("config/job-search-inputs.example.json")).searches[0]!;
    expect(new RegExp(t.selectors.listingIdPattern!).exec("/careers/listing/arg-engineering-manager/8113337")?.[1]).toBe("8113337");
    expect(new RegExp(t.selectors.listingIdPattern!).exec("/careers/2024001")).toBeNull();
  });
});

describe("search CLI arguments", () => {
  it("parses options and keeps safe defaults", () => {
    expect(parseSearchArgs([])).toMatchObject({ typingDelayMs: 90, holdMs: 1500, dataDir: "data" });
    expect(parseSearchArgs(["--input", "x.json", "--company", "Stripe", "--max-jobs", "2", "--typing-delay-ms", "0", "--hold-ms", "0", "--data-dir", "d", "--evidence-dir", "e"])).toEqual({
      input: "x.json", company: "Stripe", maxJobs: 2, typingDelayMs: 0, holdMs: 0, dataDir: "d", evidenceDir: "e",
    });
  });

  it("ignores invalid numbers instead of producing NaN", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const parsed = parseSearchArgs(["--max-jobs", "abc", "--typing-delay-ms", "-5"]);
    expect(parsed.maxJobs).toBeUndefined();
    expect(parsed.typingDelayMs).toBe(90);
    spy.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { PostingResolver, matchCompany } from "../../src/resolver/posting-resolver.js";
import { evaluatePersistable } from "../../src/domain/canonical-job.js";
import { companyRegistrySchema } from "../../src/config/schema.js";
import {
  ACME,
  FULL_JD_HTML,
  discoveredJob,
  fakeContextWith,
  fakePage,
  greenhousePayload,
  installFetch,
  registryEntry,
  writeRegistry,
} from "../helpers/canonical-fixtures.js";

// Boundaries substituted here: global fetch (URL-routed) and the Playwright context/page.
// Proves resolver -> stamp wiring offline; says nothing about live ATS behaviour.

const OFFICIAL = (id: string) => `https://boards.greenhouse.io/${ACME.board}/jobs/${id}?gh_jid=${id}`;

function resolverWith(entries?: Record<string, unknown>[]) {
  return new PostingResolver(writeRegistry(entries));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostingResolver canonical stamping", () => {
  it("valid complete JD: resolved via the ATS API with a full source observation", async () => {
    installFetch({ greenhouse: { "101": greenhousePayload(101) } });
    const page = fakePage("", OFFICIAL("101"));
    const resolved = await resolverWith().resolve(discoveredJob("101"), fakeContextWith(page) as never);

    expect(resolved).not.toBeNull();
    expect(resolved!.resolutionStatus).toBe("resolved");
    expect(resolved!.atsIdentity).toBe("greenhouse:acme:101");
    expect(resolved!.sourceObservations).toHaveLength(1);
    expect(resolved!.sourceObservations![0]).toMatchObject({ sourceKind: "company-careers", extractionMethod: "ats-api" });
    expect(resolved!.requisitionId).toBe("101");
    expect(resolved!.descriptionText).toContain("Software Development Engineer in Test");
    expect(evaluatePersistable(resolved!).ok).toBe(true);
    // The browser was not needed for a successful API extraction.
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it("tracking redirect to the correct posting keeps both URLs in the observation", async () => {
    const tracker = "https://click.jobs-tracker.example/r?u=abc123";
    installFetch({
      redirects: { [tracker]: `https://job-boards.greenhouse.io/${ACME.board}/jobs/101?gh_jid=101&utm_source=tracker` },
      greenhouse: { "101": greenhousePayload(101) },
    });
    const resolved = await resolverWith().resolve(
      discoveredJob("101", { resultUrl: tracker }),
      fakeContextWith(fakePage("", tracker)) as never,
    );

    expect(resolved!.resolutionStatus).toBe("resolved");
    expect(resolved!.atsIdentity).toBe("greenhouse:acme:101");
    expect(resolved!.sourceObservations![0]!.observedUrl).toBe(tracker);
    expect(resolved!.sourceObservations![0]!.finalUrl).toContain("job-boards.greenhouse.io/acme/jobs/101");
    expect(resolved!.discoveredUrl).toBe(tracker);
  });

  it("unresolved placeholder (no browser context, nothing extractable) is stamped unresolved", async () => {
    installFetch();
    const resolved = await resolverWith().resolve(discoveredJob("101"));
    expect(resolved).not.toBeNull();
    expect(resolved!.resolutionStatus).toBe("unresolved");
    const gate = evaluatePersistable(resolved!);
    expect(!gate.ok && gate.failure.code).toBe("PLACEHOLDER_DESCRIPTION");
  });

  it("ATS API 404 falls through to headed-browser extraction and records the method", async () => {
    installFetch({ greenhouse: {} });
    const page = fakePage(FULL_JD_HTML, OFFICIAL("101"));
    const resolved = await resolverWith().resolve(discoveredJob("101"), fakeContextWith(page) as never);

    expect(page.evaluate).toHaveBeenCalled();
    expect(resolved!.resolutionStatus).toBe("resolved");
    expect(resolved!.sourceObservations![0]!.extractionMethod).toBe("browser-dom");
  });

  it("empty/incomplete extraction: API gone and no description container -> JD_EXTRACTION_FAILED, never an empty record", async () => {
    installFetch({ greenhouse: {} });
    const page = fakePage("", OFFICIAL("101"));
    const resolved = await resolverWith().resolve(discoveredJob("101"), fakeContextWith(page) as never);

    expect(resolved!.resolutionStatus).toBe("unresolved");
    const gate = evaluatePersistable(resolved!);
    expect(!gate.ok && gate.failure.code).toBe("EMPTY_DESCRIPTION");
  });

  it("incomplete extraction: a JD that is only a few words is rejected as too short", async () => {
    installFetch({ greenhouse: { "101": greenhousePayload(101, { content: "<p>See careers page.</p>" }) } });
    const resolved = await resolverWith().resolve(discoveredJob("101"), fakeContextWith(fakePage("", OFFICIAL("101"))) as never);
    const gate = evaluatePersistable(resolved!);
    expect(!gate.ok && gate.failure.code).toBe("DESCRIPTION_TOO_SHORT");
  });

  it("wrong board: a listing claiming Acme that resolves onto another registered employer's board is rejected", async () => {
    const other = registryEntry({ company: "Globex", corporateDomain: "globex-corp.com", careersUrl: null, atsTenantOrBoardId: "globex" });
    installFetch({ greenhouse: { "101": greenhousePayload(101) } });
    const resolved = await resolverWith([registryEntry(), other]).resolve(
      discoveredJob("101", { resultUrl: "https://boards.greenhouse.io/globex/jobs/101?gh_jid=101" }),
      fakeContextWith(fakePage("", "https://boards.greenhouse.io/globex/jobs/101?gh_jid=101")) as never,
    );
    expect(resolved!.resolutionStatus).toBe("unresolved");
    expect(resolved!.resolutionFailure?.code).toBe("EMPLOYER_MISMATCH");
  });

  it("unregistered board: a plausible-looking ATS URL for an employer outside the registry is unverified", async () => {
    installFetch({ greenhouse: { "101": greenhousePayload(101) } });
    const resolved = await resolverWith().resolve(
      discoveredJob("101", { resultUrl: "https://boards.greenhouse.io/stranger/jobs/101?gh_jid=101" }),
      fakeContextWith(fakePage("", "https://boards.greenhouse.io/stranger/jobs/101?gh_jid=101")) as never,
    );
    expect(resolved!.resolutionFailure?.code).toBe("UNVERIFIED_EMPLOYER");
  });

  it("ATS reporting a different job id than the URL is rejected", async () => {
    installFetch({ greenhouse: { "101": greenhousePayload(202) } });
    const resolved = await resolverWith().resolve(discoveredJob("101"), fakeContextWith(fakePage("", OFFICIAL("101"))) as never);
    expect(resolved!.resolutionFailure?.code).toBe("JOB_ID_MISMATCH");
  });

  it("browser fallback never fabricates a location", async () => {
    installFetch({ greenhouse: {} });
    const resolved = await resolverWith().resolve(
      discoveredJob("101", { location: "Austin, TX" }),
      fakeContextWith(fakePage(FULL_JD_HTML, OFFICIAL("101"))) as never,
    );
    expect(resolved!.location).toBe("Austin, TX");
  });
});

describe("matchCompany (parsed URL parts only)", () => {
  const registry = companyRegistrySchema.parse([registryEntry()]);

  it("matches the registry board, the corporate domain and its subdomains", () => {
    expect(matchCompany(OFFICIAL("1"), registry)?.company).toBe("Acme");
    expect(matchCompany(`https://careers.${ACME.domain}/jobs/1`, registry)?.company).toBe("Acme");
  });

  it("does not match a company domain that only appears in a path or query", () => {
    expect(matchCompany(`https://aggregator.example/job?src=${ACME.domain}`, registry)).toBeNull();
    expect(matchCompany(`https://aggregator.example/${ACME.domain}/careers/1`, registry)).toBeNull();
    expect(matchCompany(`https://${ACME.domain}.evil.example/x`, registry)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  classifyCareersUrlVerification,
  outcomeToRegistryStatus,
  verifyBatch,
  type CareersUrlFetchResult,
} from "../../src/config/careers-url-verifier.js";

function fetchResult(overrides: Partial<CareersUrlFetchResult> = {}): CareersUrlFetchResult {
  return {
    statusCode: 200,
    finalUrl: "https://careers.acme.com/",
    finalHost: "careers.acme.com",
    title: "Careers | Acme",
    bodySnippet: "Join our team. Acme careers: explore open jobs.",
    redirectCount: 0,
    chain: ["https://careers.acme.com/"],
    ...overrides,
  };
}

describe("classifyCareersUrlVerification", () => {
  it("verifies an official domain career page with matching identity and careers content", () => {
    const result = classifyCareersUrlVerification("Acme", fetchResult());
    expect(result.outcome).toBe("verified");
  });

  it("verifies an official ATS destination that carries correct company branding", () => {
    // Host is a third-party ATS domain (Workday), not acme.com -- but the page content itself
    // confirms company identity and careers content, which is exactly evidence category 4
    // (official page redirecting to a confirmed ATS board / ATS page with unambiguous identity).
    const result = classifyCareersUrlVerification(
      "Acme",
      fetchResult({
        finalUrl: "https://acme.wd5.myworkdayjobs.com/Acme_Careers",
        finalHost: "acme.wd5.myworkdayjobs.com",
        title: "Acme Careers",
        bodySnippet: "Search open jobs at Acme. Join the Acme team today.",
      }),
    );
    expect(result.outcome).toBe("verified");
  });

  it("does NOT verify a redirect that lands on an unrelated company's page", () => {
    const result = classifyCareersUrlVerification(
      "Acme",
      fetchResult({
        finalUrl: "https://careers.widgetco.com/",
        finalHost: "careers.widgetco.com",
        title: "Careers | Widget Co",
        bodySnippet: "Join Widget Co. Explore open jobs at Widget Co today.",
      }),
    );
    expect(result.outcome).toBe("wrong-company");
  });

  it("does NOT verify an HTTP success whose content is unrelated to careers", () => {
    const result = classifyCareersUrlVerification(
      "Acme",
      fetchResult({
        finalUrl: "https://acme.com/investor-relations",
        finalHost: "acme.com",
        title: "Investor Relations | Acme",
        bodySnippet: "Acme quarterly earnings report and shareholder information.",
      }),
    );
    expect(result.outcome).toBe("not-a-careers-page");
  });

  it("classifies a bot-protection challenge page as verification-required, never bypassed", () => {
    const result = classifyCareersUrlVerification(
      "Acme",
      fetchResult({
        statusCode: 403,
        title: "Just a moment...",
        bodySnippet: "Checking your browser before accessing acme.com. This process is automatic. cf-ray: 123abc",
      }),
    );
    expect(result.outcome).toBe("verification-required");
  });

  it("fails safely (unreachable) on a redirect loop / excessive redirect count, without throwing", () => {
    const result = classifyCareersUrlVerification(
      "Acme",
      fetchResult({ redirectCount: 9, chain: Array.from({ length: 10 }, (_, i) => `https://acme.com/r${i}`) }),
    );
    expect(result.outcome).toBe("unreachable");
    expect(result.detail).toMatch(/redirect/i);
  });

  it("treats a network/fetch error as unreachable, not a crash", () => {
    const result = classifyCareersUrlVerification("Acme", fetchResult({ statusCode: null, error: "getaddrinfo ENOTFOUND careers.acme.com" }));
    expect(result.outcome).toBe("unreachable");
  });

  // Reproduces a real false-negative found while applying this classifier to the 49 live
  // candidates: a company whose site brands itself only by acronym/initials, with no full
  // legal-name word anywhere in the captured title/host/body, must still verify.
  it("verifies a multi-word company branded only by its acronym (IBM)", () => {
    const result = classifyCareersUrlVerification(
      "International Business Machines",
      fetchResult({ finalUrl: "https://www.ibm.com/careers", finalHost: "www.ibm.com", title: "Define your career with IBM", bodySnippet: "Search jobs at IBM." }),
    );
    expect(result.outcome).toBe("verified");
  });

  it("verifies another acronym-branded company (Archer Daniels Midland -> ADM)", () => {
    const result = classifyCareersUrlVerification(
      "Archer Daniels Midland",
      fetchResult({ finalUrl: "https://www.adm.com/en-us/culture-and-careers/", finalHost: "www.adm.com", title: "ADM Careers and Culture | ADM", bodySnippet: "Careers at ADM." }),
    );
    expect(result.outcome).toBe("verified");
  });

  // Reproduces a second false-negative: a company branded by a truncated form of its legal
  // name on its own domain (Citigroup -> "citi").
  it("verifies a company branded by a truncated form of its legal name (Citigroup -> citi)", () => {
    const result = classifyCareersUrlVerification(
      "Citigroup",
      fetchResult({ finalUrl: "https://jobs.citi.com/", finalHost: "jobs.citi.com", title: "Citi Careers | Find Your Next Opportunity", bodySnippet: "Careers at Citi." }),
    );
    expect(result.outcome).toBe("verified");
  });

  // Reproduces a third false-negative: the naive tokenizer turned "AT&T" into two useless
  // 1-2 character tokens ("at", "t") by replacing "&" with a space instead of removing it.
  it("verifies a company name containing '&' (AT&T)", () => {
    const result = classifyCareersUrlVerification(
      "AT&T",
      fetchResult({ finalUrl: "https://www.att.jobs/", finalHost: "www.att.jobs", title: "AT&T Careers: Shape the future of connectivity", bodySnippet: "Careers at AT&T." }),
    );
    expect(result.outcome).toBe("verified");
  });

  it("does not verify off a short acronym-like substring appearing incidentally, without a standalone word/host-label match", () => {
    // "Acme Media" -> acronym "am" -- must not match just because "am" appears inside
    // unrelated words like "team"/"amazing" in the body.
    const result = classifyCareersUrlVerification(
      "Acme Media",
      fetchResult({
        finalUrl: "https://careers.widgetco.com/",
        finalHost: "careers.widgetco.com",
        title: "Careers | Widget Co",
        bodySnippet: "Join our amazing team at Widget Co. Explore open jobs today.",
      }),
    );
    expect(result.outcome).toBe("wrong-company");
  });
});

describe("outcomeToRegistryStatus", () => {
  it("maps wrong-company and not-a-careers-page onto the existing 'not-found' status (no schema growth needed)", () => {
    expect(outcomeToRegistryStatus("wrong-company")).toBe("not-found");
    expect(outcomeToRegistryStatus("not-a-careers-page")).toBe("not-found");
  });

  it("maps verified/unreachable/verification-required/pending onto themselves", () => {
    expect(outcomeToRegistryStatus("verified")).toBe("verified");
    expect(outcomeToRegistryStatus("unreachable")).toBe("unreachable");
    expect(outcomeToRegistryStatus("verification-required")).toBe("verification-required");
    expect(outcomeToRegistryStatus("pending")).toBe("pending");
  });
});

describe("verifyBatch", () => {
  it("does not let one URL's failure stop the rest of the batch", async () => {
    const candidates = [
      { item: "https://acme.com/careers", company: "Acme" },
      { item: "https://boom.com/careers", company: "Boom" },
      { item: "https://widget.com/careers", company: "Widget" },
    ];
    const results = await verifyBatch(candidates, async (url) => {
      if (url.includes("boom")) throw new Error("connection reset");
      return fetchResult({ finalUrl: url, finalHost: new URL(url).hostname, title: `Careers | ${new URL(url).hostname}`, bodySnippet: "careers jobs " + new URL(url).hostname });
    });
    expect(results).toHaveLength(3);
    expect(results[1]?.outcome).toBe("error");
    expect(results[0]?.outcome).not.toBe("error");
    expect(results[2]?.outcome).not.toBe("error");
  });
});

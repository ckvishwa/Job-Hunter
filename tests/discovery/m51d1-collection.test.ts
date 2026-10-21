import { describe, expect, test } from "vitest";
import { extractAtsHints } from "../../src/discovery/collection/ats-hints.js";
import { collectEmployer, googleResultsUrl } from "../../src/discovery/collection/collect-employer.js";
import { toPersistItem } from "../../src/discovery/collection/postgres-items.js";
import { guardedGet } from "../../src/discovery/collection/guarded-get.js";
import { extractJsonLdJobs } from "../../src/discovery/collection/jsonld.js";
import {
  employersOutsideWatchlist,
  mergeCanonical,
  mergeObserved,
  renderAuditHtml,
  toReviewCsv,
  type ObservedRecord,
} from "../../src/discovery/collection/records.js";
import type { JobPosting } from "../../src/adapters/types.js";

const employer = { id: "stripe", displayName: "Stripe", careersUrl: "https://stripe.com/jobs", nameTokens: ["Stripe"] };

function observed(partial: Partial<ObservedRecord> & Pick<ObservedRecord, "sourceUrl">): ObservedRecord {
  return {
    employerId: "stripe",
    employerName: "Stripe",
    requisitionId: "1",
    title: "Engineer",
    location: "Remote",
    postedAt: null,
    postingDatePrecision: "unknown",
    descriptionText: null,
    recordClass: "live",
    resolutionStatus: "pending",
    atsType: "greenhouse",
    ...partial,
  };
}

describe("ATS hints", () => {
  test("reads a Greenhouse token and a Workday host from the page and ignores a private redirect", () => {
    const html = `
      <a href="https://boards.greenhouse.io/stripe">Jobs</a>
      <a href="https://walmart.wd5.myworkdayjobs.com/en-US/WalmartExternal">Walmart</a>
      <a href="http://10.1.1.1/latest">no</a>
    `;
    const hints = extractAtsHints(html, "https://stripe.com/jobs");
    expect(hints.map((hint) => hint.kind)).toEqual(["greenhouse", "workday"]);
    expect(hints[0]?.board).toBe("stripe");
    expect(hints[1]?.workday?.tenant).toBe("walmart");
  });
});

describe("collection guards", () => {
  test("refuses a redirect onto a loopback address before following it", async () => {
    const result = await guardedGet("https://careers.example/jobs", {
      fetchImpl: async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    });
    expect(result.status).toBe(0);
    expect(result.error).toMatch(/HTTPS|Blocked/);
    expect(result.body).toBe("");
  });

  test("does not request the disallowed Google page parameter", () => {
    expect(new URL(googleResultsUrl()).searchParams.has("page")).toBe(false);
  });
});

describe("record merge", () => {
  test("a failed refresh does not erase a stored description", () => {
    const kept = mergeObserved(
      [observed({ sourceUrl: "https://boards.greenhouse.io/stripe/jobs/1", descriptionText: "A real description that is long enough to matter for the audit trail.", resolutionStatus: "resolved" })],
      [observed({ sourceUrl: "https://boards.greenhouse.io/stripe/jobs/1", descriptionText: null, resolutionStatus: "rejected" })],
    );
    expect(kept[0]?.descriptionText).toContain("real description");
  });

  test("distinct requisitions stay distinct", () => {
    const rows = mergeObserved([], [
      observed({ sourceUrl: "https://boards.greenhouse.io/stripe/jobs/1", requisitionId: "1", title: "Engineer" }),
      observed({ sourceUrl: "https://boards.greenhouse.io/stripe/jobs/2", requisitionId: "2", title: "Engineer" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  test("an outside employer is not treated as one of the watchlist", () => {
    expect(employersOutsideWatchlist(["Stripe", "Initech"], [{ displayName: "Stripe", aliases: ["Stripe, Inc."] }])).toEqual(["Initech"]);
  });
});

describe("audit export", () => {
  test("keeps the source URL and escapes markup", () => {
    const html = renderAuditHtml({
      generatedAt: "2026-10-21T00:00:00.000Z",
      employers: [],
      jobs: [observed({ sourceUrl: "https://boards.greenhouse.io/stripe/jobs/1", title: "<script>" })],
    });
    expect(html).toContain("https://boards.greenhouse.io/stripe/jobs/1");
    expect(html).not.toContain("<script>");
    expect(toReviewCsv([observed({ sourceUrl: "https://boards.greenhouse.io/stripe/jobs/1" })])).toContain("https://boards.greenhouse.io/stripe/jobs/1");
  });
});

describe("employer collection", () => {
  test("records an identified careers page with no board as unsupported", async () => {
    const result = await collectEmployer(employer, {
      get: async () => ({ status: 200, finalUrl: "https://stripe.com/jobs", body: "<html>Stripe careers</html>", hops: [] }),
    });
    expect(result.counters.status).toBe("UNSUPPORTED");
    expect(result.counters.careerSiteReachable).toBe(true);
    expect(result.counters.atsIdentityVerified).toBe(false);
    expect(result.observed).toHaveLength(0);
    expect(result.counters.reason).toMatch(/not an empty job board/i);
  });

  test("persists a Greenhouse listing whose token was on the careers page", async () => {
    const description = `${"Design and test payment systems. ".repeat(20)}Requirements include collaboration with product and engineering.`;
    const result = await collectEmployer(employer, {
      get: async () => ({
        status: 200,
        finalUrl: "https://stripe.com/jobs",
        body: `<a href="https://boards.greenhouse.io/stripe">open roles</a> Stripe`,
        hops: [],
      }),
      loadBoard: async () => [{
        externalId: "99",
        title: "Software Engineer",
        url: "https://boards.greenhouse.io/stripe/jobs/99",
        applyUrl: "https://boards.greenhouse.io/stripe/jobs/99",
        location: "South San Francisco",
        department: "Engineering",
        employmentType: null,
        postingDate: "2026-10-01",
        descriptionText: description,
        descriptionHtml: null,
      }],
    });
    expect(result.counters.atsIdentityVerified).toBe(true);
    expect(result.counters.atsType).toBe("greenhouse");
    expect(result.observed[0]?.sourceUrl).toBe("https://boards.greenhouse.io/stripe/jobs/99");
    expect(result.observed[0]?.postingDatePrecision).toBe("exact");
    expect(result.canonical).toHaveLength(1);
    expect(result.canonical[0]?.atsIdentity).toBe("greenhouse:stripe:99");
    expect(toPersistItem(result.canonical[0]!, "2026-10-21T00:00:00.000Z")?.ats).toBe("greenhouse");
    expect(toPersistItem({ ...result.canonical[0]!, atsIdentity: undefined }, "2026-10-21T00:00:00.000Z")).toBeNull();
    expect(result.canonical[0]?.descriptionText).toContain("payment systems");
  });

  test("does not replace a resolved canonical job with an empty description", () => {
    const prior = { id: "abc", descriptionText: "x".repeat(400), resolutionStatus: "resolved" } as JobPosting;
    const incoming = { id: "abc", descriptionText: "", resolutionStatus: "unresolved" } as JobPosting;
    expect(mergeCanonical([prior], [incoming])[0]?.descriptionText).toHaveLength(400);
  });
});

describe("JSON-LD", () => {
  test("reads a job posting and skips a broken block", () => {
    const html = `<script type="application/ld+json">{</script><script type="application/ld+json">{"@type":"JobPosting","title":"SDET","description":"${"Verify releases. ".repeat(30)}","url":"https://example.com/jobs/1","datePosted":"2026-10-02","identifier":{"value":"R1"}}</script>`;
    const jobs = extractJsonLdJobs(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("SDET");
    expect(jobs[0]?.datePosted).toBe("2026-10-02");
  });
});

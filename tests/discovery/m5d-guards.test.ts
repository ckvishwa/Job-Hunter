import { describe, expect, test } from "vitest";
import { assertFetchableUrl, isBlockedIp } from "../../src/discovery/security/url-guard.js";
import { postingDatePrecision } from "../../src/discovery/posting-date.js";
import { openCheckpoint, sealCheckpoint } from "../../src/discovery/ats/checkpoint.js";
import { ingestOffers } from "../../src/sources/careerops/ingest.js";
import { unresolvedEmployer, workdayFromUrl } from "../../src/discovery/ats/employer-resolution.js";

describe("untrusted URL guard", () => {
  test("blocks loopback, metadata, and credentialed URLs", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("10.1.1.1")).toBe(true);
    expect(() => assertFetchableUrl("http://169.254.169.254/latest")).toThrow(/HTTPS|Blocked/);
    expect(() => assertFetchableUrl("https://user:pass@example.com/job")).toThrow(/credentials/);
    expect(assertFetchableUrl("https://www.amazon.jobs/en/search.json").hostname).toBe("www.amazon.jobs");
  });
});

describe("posting dates and checkpoints", () => {
  test("relative dates stay approximate and discovery time is not a posting date", () => {
    expect(postingDatePrecision("Posted 3 days ago").precision).toBe("approximate");
    expect(postingDatePrecision(null)).toEqual({ postedAt: null, precision: "unknown" });
    expect(postingDatePrecision("2026-03-01").precision).toBe("exact");
    expect(postingDatePrecision("October 21, 2026").precision).toBe("exact");
  });

  test("a corrupted checkpoint is refused", () => {
    const sealed = sealCheckpoint("run-1", ["google"]);
    expect(openCheckpoint(sealed).completedEmployerIds).toEqual(["google"]);
    expect(() => openCheckpoint({ ...sealed, completedEmployerIds: ["amazon-aws"] })).toThrow(/hash/);
  });
});

describe("careerops ingestion", () => {
  test("keeps an irrelevant offer instead of dropping it before storage", () => {
    const ingested = ingestOffers([{
      company: "Acme",
      title: "Account Executive",
      url: "https://boards.greenhouse.io/acme/jobs/1",
      location: "Remote",
      postedAt: "Posted today",
      source: "greenhouse-full",
    }], "dff9703a");
    expect(ingested.listings).toHaveLength(1);
    expect(ingested.listings[0]?.description).toBeNull();
    expect(ingested.listings[0]?.postingDatePrecision).toBe("approximate");
    expect(ingested.listings[0]?.resolutionStatus).toBe("pending");
  });

  test("does not treat a missing Workday host as verified", () => {
    expect(unresolvedEmployer({ id: "walmart-associates", displayName: "Walmart Associates" }).status).toBe("NOT_FOUND");
    expect(workdayFromUrl("https://walmart.wd5.myworkdayjobs.com/WalmartExternal")).toEqual({
      tenant: "walmart",
      instance: "wd5",
      site: "WalmartExternal",
      hostname: "walmart.wd5.myworkdayjobs.com",
    });
    expect(workdayFromUrl("https://careers.walmart.com")).toBeNull();
  });
});

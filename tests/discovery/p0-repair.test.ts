import { describe, expect, test, vi } from "vitest";
import { classifyTransportFailure } from "../../src/discovery/repair/classify-error.js";
import { contentHash, mergeObservations, type RawObservation } from "../../src/discovery/repair/observations.js";
import { fetchWorkdayBoard, validateWorkdayDirectoryLine } from "../../src/discovery/repair/workday-directory.js";

describe("Workday directory validation", () => {
  test("rejects instance ids used as tenants before any request", async () => {
    const fetchImpl = vi.fn();
    for (const tenant of ["wd1", "wd3", "wd5", "wd103", "wd501"]) {
      const result = await fetchWorkdayBoard(`${tenant}|wd1|external`, fetchImpl);
      expect(result.requested).toBe(false);
      expect(result.result.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("accepts a tenant, shard, and site", () => {
    const result = validateWorkdayDirectoryLine("2020companies|wd1|external_careers");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.board.jobsUrl).toBe("https://2020companies.wd1.myworkdayjobs.com/wday/cxs/2020companies/external_careers/jobs");
    }
  });

  test("does not invent a missing site", () => {
    expect(validateWorkdayDirectoryLine("acme|wd5").ok).toBe(false);
  });
});

describe("source error classification", () => {
  test("keeps HTTP statuses distinct and does not treat a challenge as a method bug", () => {
    expect(classifyTransportFailure({ status: 404, message: "missing" }).outcome).toBe("NOT_FOUND");
    expect(classifyTransportFailure({ status: 403, message: "forbidden" }).outcome).toBe("ACCESS_DENIED");
    expect(classifyTransportFailure({ status: 405, message: "method" }).outcome).toBe("METHOD_NOT_ALLOWED");
    expect(classifyTransportFailure({ status: 405, body: "<title>Human Verification</title>" }).outcome).toBe("ACCESS_DENIED");
    expect(classifyTransportFailure({ status: 422, body: "maintenance" }).outcome).toBe("UNPROCESSABLE_RESPONSE");
    expect(classifyTransportFailure({ status: 429, message: "slow down" })).toMatchObject({ outcome: "RATE_LIMITED", transient: true });
    expect(classifyTransportFailure({ message: "The operation was aborted" }).outcome).toBe("ABORTED");
    expect(classifyTransportFailure({ code: "ENOTFOUND", message: "getaddrinfo" }).outcome).toBe("DNS_ERROR");
    expect(classifyTransportFailure({ code: "TIMEOUT", message: "timed out" }).outcome).toBe("TIMEOUT");
  });
});

describe("raw observations", () => {
  test("a repeat without a description does not erase the stored one", () => {
    const first: RawObservation = {
      provider: "greenhouse",
      employer: "Stripe",
      title: "Engineer",
      sourceUrl: "https://boards.greenhouse.io/stripe/jobs/1",
      sourcePostingId: "1",
      requisitionId: "1",
      location: "Remote",
      postedAt: null,
      postingDatePrecision: "unknown",
      discoveredAt: "2026-10-21T00:00:00.000Z",
      descriptionText: "Design and operate payment systems with care. ".repeat(12),
      descriptionStatus: "retrieved",
      outcome: "SUCCESS",
      contentHash: null,
    };
    first.contentHash = contentHash(first.descriptionText);
    const second = mergeObservations([first], [{ ...first, descriptionText: null, descriptionStatus: "missing", discoveredAt: "2026-10-21T01:00:00.000Z" }]);
    expect(second).toHaveLength(1);
    expect(second[0]?.descriptionText).toContain("payment systems");
    expect(second[0]?.discoveredAt).toBe("2026-10-21T01:00:00.000Z");
  });
});

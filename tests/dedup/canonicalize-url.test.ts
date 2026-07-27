import { describe, expect, it } from "vitest";
import { canonicalizeUrl, computeJobId } from "../../src/dedup/canonicalize-url.js";

describe("canonicalizeUrl", () => {
  it("lowercases the host, strips fragment and trailing slash", () => {
    expect(canonicalizeUrl("https://Example.COM/jobs/123/#apply")).toBe(
      "https://example.com/jobs/123",
    );
  });

  it("strips known tracking params but keeps meaningful ones", () => {
    const result = canonicalizeUrl(
      "https://boards.greenhouse.io/acme/jobs/123?gh_jid=123&gh_src=abc&utm_source=x&utm_campaign=y",
    );
    expect(result).toBe("https://boards.greenhouse.io/acme/jobs/123?gh_jid=123");
  });

  it("is stable regardless of query param order", () => {
    const a = canonicalizeUrl("https://acme.com/jobs/1?gh_jid=1&utm_source=x");
    const b = canonicalizeUrl("https://acme.com/jobs/1?utm_source=x&gh_jid=1");
    expect(a).toBe(b);
  });

  it("does not throw on a malformed URL and returns something usable instead", () => {
    expect(() => canonicalizeUrl("not a valid url")).not.toThrow();
    expect(canonicalizeUrl("not a valid url")).toBe("not a valid url");
  });
});

describe("computeJobId", () => {
  it("is deterministic for the same canonical url", () => {
    const id1 = computeJobId("https://acme.com/jobs/1");
    const id2 = computeJobId("https://acme.com/jobs/1");
    expect(id1).toBe(id2);
  });

  it("differs for different urls", () => {
    const id1 = computeJobId("https://acme.com/jobs/1");
    const id2 = computeJobId("https://acme.com/jobs/2");
    expect(id1).not.toBe(id2);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { mapCareerOpsOffer } from "../../../src/sources/careerops/careerops-mapper.js";
import { validateOffers, type CareerOpsOffer } from "../../../src/sources/careerops/careerops-schema.js";
import { computeJobId } from "../../../src/dedup/canonicalize-url.js";

const FIXTURE_PATH = new URL("../../fixtures/careerops/scan-ats-full.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
const { valid: validOffers } = validateOffers(fixture.offers);

function findOffer(title: string): CareerOpsOffer {
  const offer = validOffers.find((o) => o.title === title);
  if (!offer) throw new Error(`fixture missing offer titled "${title}"`);
  return offer;
}

describe("mapCareerOpsOffer - field mapping", () => {
  test("valid Greenhouse offer maps correctly", () => {
    const offer = findOffer("Cybersecurity Engineer");
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.title).toBe("Cybersecurity Engineer");
    expect(result.job.company).toBe("10alabs");
    expect(result.job.resultUrl).toBe("https://job-boards.greenhouse.io/10alabs/jobs/4330885009");
    expect(result.job.source).toBe("greenhouse-full");
  });

  test("valid Lever offer maps correctly", () => {
    const offer = findOffer("Assistant Chief Engineer");
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.company).toBe("ableserve");
    expect(result.job.location).toBe("Seattle, WA");
    expect(result.job.source).toBe("lever-full");
  });

  test("Workday source maps without fabricating ATS-specific path details", () => {
    const offer = findOffer("Cloud Security Engineer");
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.source).toBe("workday-full");
    // No workday tenant/site/hostname fields exist on DiscoveredJobLite -- nothing to fabricate.
    // The resolver (later, out of scope here) derives those from resultUrl if/when it needs to.
    expect(result.job.resultUrl).toBe(offer.url);
  });

  test("null location remains unknown (empty string, never a guess)", () => {
    const offer = findOffer("SDET II"); // fixture's location:null record
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.location).toBe("");
  });

  test("missing location remains unknown", () => {
    const offerWithoutLocation = { ...findOffer("Cybersecurity Engineer"), location: undefined as unknown as null };
    const result = mapCareerOpsOffer(offerWithoutLocation);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.location).toBe("");
  });

  test("null postedAt remains unknown (null, never today's date)", () => {
    const offer = { ...findOffer("Cybersecurity Engineer"), postedAt: null };
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.postingAgeOrDate).toBeNull();
  });

  test("valid postedAt maps verbatim into the existing postingAgeOrDate field", () => {
    const offer = findOffer("Cybersecurity Engineer"); // postedAt: "2026-07-28"
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.postingAgeOrDate).toBe("2026-07-28");
  });

  test("source provenance is the raw CareerOps source string, preserved verbatim", () => {
    const offer = findOffer("Cybersecurity Engineer");
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.source).toBe("greenhouse-full");
  });

  test("no description is fabricated -- descriptionSnippet is always null, never an empty string", () => {
    const offer = findOffer("Cybersecurity Engineer");
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.descriptionSnippet).toBeNull();
  });

  test("missing JD does not appear as a completed/resolved posting -- no resolution-status field is set to anything", () => {
    const offer = findOffer("Cybersecurity Engineer");
    const result = mapCareerOpsOffer(offer);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // DiscoveredJobLite carries no resolution-status field at all -- resolution hasn't run yet.
    // The absence of such a field IS the correct behavior; nothing here claims completeness.
    expect(result.job).not.toHaveProperty("resolved");
    expect(result.job).not.toHaveProperty("descriptionText");
  });
});

describe("mapCareerOpsOffer - no remote/profile inference", () => {
  test("no remote type inferred from null location", () => {
    const offer = findOffer("SDET II");
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    // DiscoveredJobLite has no remoteType field at all -- nothing to fabricate into.
    if (result.ok) expect(result.job).not.toHaveProperty("remoteType");
  });

  test("no remote type inferred from ordinary city text", () => {
    const offer = findOffer("Assistant Chief Engineer"); // location: "Seattle, WA"
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.location).toBe("Seattle, WA");
  });

  test("no remote type inferred from free text containing 'Remote'", () => {
    const offer = findOffer("Cybersecurity Engineer"); // location: "Remote · 10a Labs"
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.location).toBe("Remote · 10a Labs");
      expect(result.job).not.toHaveProperty("remoteType");
    }
  });

  test("no profile is falsely assigned -- matchedProfiles starts empty, filled later by the real classifier", () => {
    const offer = findOffer("Cybersecurity Engineer");
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.matchedProfiles).toEqual([]);
  });

  test('"Corporate Security Guard" is not classified here -- mapper stays relevance-neutral', () => {
    const offer = findOffer("Corporate Security Guard");
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.job.matchedProfiles).toEqual([]);
      expect(result.job.relevanceReason).toBe("");
    }
  });

  test('"Cloud Network Engineer" is not arbitrarily forced into one profile here', () => {
    const offer = findOffer("Cloud Network Engineer");
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.matchedProfiles).toEqual([]);
  });
});

describe("mapCareerOpsOffer - determinism and identity", () => {
  test("stable mapping: identical input produces identical identity-relevant fields", () => {
    const offer = findOffer("Cybersecurity Engineer");
    const a = mapCareerOpsOffer(offer);
    const b = mapCareerOpsOffer(offer);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.job.resultUrl).toBe(b.job.resultUrl);
      expect(a.job.company).toBe(b.job.company);
      expect(a.job.title).toBe(b.job.title);
      expect(a.job.location).toBe(b.job.location);
      expect(a.job.source).toBe(b.job.source);
    }
  });

  test("stable mapping under frozen time: full object identical across repeated calls", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T00:00:00.000Z"));
    try {
      const offer = findOffer("Cybersecurity Engineer");
      const a = mapCareerOpsOffer(offer);
      const b = mapCareerOpsOffer(offer);
      expect(a).toEqual(b);
    } finally {
      vi.useRealTimers();
    }
  });

  test("resultUrl -> computeJobId is stable and does not depend on array index or mapping order", () => {
    const offer = findOffer("Cybersecurity Engineer");
    // Map the same offer as if it were at different positions in a batch -- nothing about
    // position is ever read, so the resulting ID must be identical regardless.
    const first = mapCareerOpsOffer(offer);
    const others = [findOffer("Assistant Chief Engineer"), findOffer("Cloud Security Engineer")].map(mapCareerOpsOffer);
    const last = mapCareerOpsOffer(offer);

    expect(first.ok && last.ok).toBe(true);
    if (first.ok && last.ok) {
      expect(computeJobId(first.job.resultUrl)).toBe(computeJobId(last.job.resultUrl));
    }
    expect(others.every((o) => o.ok)).toBe(true);
  });

  test("cross-source duplicate fixture pair maps to identical company/title/location -- remains deduplicatable by the existing dedup layer", () => {
    const dup1 = validOffers.filter((o) => o.title === "Network Security Engineer");
    expect(dup1.length).toBe(2); // fixture's intentional cross-source duplicate pair

    const mapped = dup1.map(mapCareerOpsOffer);
    expect(mapped.every((m) => m.ok)).toBe(true);
    type MapOk = Extract<ReturnType<typeof mapCareerOpsOffer>, { ok: true }>;
    const jobs = mapped.filter((m): m is MapOk => m.ok).map((m) => m.job);

    // Different URLs (different ATS listings), but the company+title+location triple mergeJobs
    // already keys its fallback dedup match on must agree exactly -- the mapper must not
    // introduce any spurious difference (whitespace, casing) that would silently break that.
    expect(jobs[0]!.company).toBe(jobs[1]!.company);
    expect(jobs[0]!.title).toBe(jobs[1]!.title);
    expect(jobs[0]!.location).toBe(jobs[1]!.location);
    expect(jobs[0]!.resultUrl).not.toBe(jobs[1]!.resultUrl);
    expect(jobs[0]!.source).not.toBe(jobs[1]!.source);
  });

  test("unknown/future CareerOps source strings are preserved verbatim, never relabeled to a different ATS", () => {
    const offer = { ...findOffer("Cybersecurity Engineer"), source: "bamboohr-full" };
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job.source).toBe("bamboohr-full");
  });

  test("mapper does not mutate the raw offer object", () => {
    const offer = Object.freeze({ ...findOffer("Cybersecurity Engineer") });
    expect(() => mapCareerOpsOffer(offer)).not.toThrow();
  });
});

describe("mapCareerOpsOffer - defensive validation (called outside normal schema flow)", () => {
  test("an unsafe javascript: URL is rejected with a typed failure, never reaches resultUrl", () => {
    const offer = { ...findOffer("Cybersecurity Engineer"), url: "javascript:alert(1)" };
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSAFE_URL");
  });

  test("a syntactically invalid URL is rejected with a typed failure", () => {
    const offer = { ...findOffer("Cybersecurity Engineer"), url: "not a url" };
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSAFE_URL");
  });

  test("a missing/empty source is rejected with a typed failure -- an empty source would corrupt dedup's source::requisitionId key and per-source counters downstream", () => {
    const offer = { ...findOffer("Cybersecurity Engineer"), source: "" };
    expect(() => mapCareerOpsOffer(offer)).not.toThrow();
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_REQUIRED_FIELD");
  });

  test("a missing company is rejected with a typed failure, not thrown", () => {
    const offer = { ...findOffer("Cybersecurity Engineer"), company: "" };
    expect(() => mapCareerOpsOffer(offer)).not.toThrow();
    const result = mapCareerOpsOffer(offer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("MISSING_REQUIRED_FIELD");
  });
});

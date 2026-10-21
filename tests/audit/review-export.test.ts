import { describe, expect, it } from "vitest";
import { linkDuplicates, paginate, reviewHtml, reviewJobFromStored, safeHttpUrl } from "../../src/audit/review-export.js";

describe("job review export", () => {
  it("keeps a missing employer posting date unknown", () => {
    const job = reviewJobFromStored({
      id: "job-1",
      company: "Acme",
      title: "SDET",
      discoveredAt: "2026-10-01T00:00:00.000Z",
      url: "https://boards.greenhouse.io/acme/jobs/1",
    }, "data/jobs.jsonl", "cached_listing");
    expect(job.postedAt).toBeNull();
    expect(job.postedAtEvidence).toBeNull();
    expect(job.discoveredAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("drops unsafe urls and links distinct requisitions separately from duplicates", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    const first = reviewJobFromStored({ id: "same", company: "Acme", title: "One", url: "https://example.com/a" }, "store-a", "cached_listing");
    const second = reviewJobFromStored({ id: "same", company: "Acme", title: "One", url: "https://example.com/a" }, "store-b", "cached_listing");
    const other = reviewJobFromStored({ id: "other", company: "Acme", title: "One", url: "https://example.com/b" }, "store-c", "cached_listing");
    const linked = linkDuplicates([first, second, other]);
    expect(linked[1]?.duplicateOf).toBe("store-a");
    expect(linked[2]?.duplicateOf).toBeNull();
    expect(linked[2]?.recordClass).toBe("cached_listing");
  });

  it("paginates and escapes html urls", () => {
    const jobs = Array.from({ length: 30 }, (_, index) => reviewJobFromStored({
      id: `j${index}`,
      company: "Acme <script>",
      title: "Role",
      url: "https://example.com/jobs/" + index,
    }, "memory", "synthetic_fixture"));
    expect(paginate(jobs, 2, 25).items).toHaveLength(5);
    expect(reviewHtml(jobs)).toContain("Acme &lt;script&gt;");
    expect(reviewHtml(jobs)).not.toContain("Acme <script>");
    expect(reviewHtml(jobs)).toContain("https://example.com/jobs/0");
  });
});

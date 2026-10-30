import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditToCsv, auditToHtml, buildAudit, safeHref, writeAuditFiles } from "../../src/audit/job-audit.js";

function legacy(id: string, title: string, postingDate: string | null = null) {
  return {
    raw: {
      id,
      title,
      company: "Northwind",
      location: "Austin, TX",
      salaryText: null,
      source: "company-careers",
      sourceType: "greenhouse",
      canonicalUrl: `https://boards.example/${id}`,
      applyUrl: `javascript:alert(${id})`,
      postingDate,
      discoveredAt: "2026-01-02T00:00:00.000Z",
      lastSeenAt: "2026-01-03T00:00:00.000Z",
      descriptionText: `Description for ${title}`,
      matchedProfiles: ["sdet"],
    },
    storeLocation: "data/jobs.jsonl",
  };
}

describe("job audit export", () => {
  it("exports every job, keeps unknown dates unknown, and refuses unsafe links", () => {
    const jobs = Array.from({ length: 25 }, (_, index) => legacy(`job-${index}`, `Role ${index}`, index === 0 ? "3 days ago" : null));
    const bundle = buildAudit({ legacy: jobs, generatedAt: "2026-10-21T00:00:00.000Z" });
    expect(bundle.counts.exported).toBe(25);
    expect(bundle.jobs[0]).toMatchObject({ postingDate: null, postingDateStatus: "unknown", sourceDateText: "3 days ago", recordFirstDiscoveredAt: "2026-01-02T00:00:00.000Z" });
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://boards.example/job-0")).toBe("https://boards.example/job-0");
    const csv = auditToCsv(bundle.jobs);
    expect(csv.trim().split("\n")).toHaveLength(26);
    expect(csv).toContain("Description for Role 24");
    const html = auditToHtml(bundle);
    expect(html).not.toContain('href="javascript:');
    for (const job of bundle.jobs) expect(html).toContain(job.jobId);
    expect(html).toContain("const pageSize = 20");
    const again = buildAudit({ legacy: jobs });
    expect(again.jobs.map((job) => job.jobId)).toEqual(bundle.jobs.map((job) => job.jobId));
  });

  it("writes the json, csv, and html files without dropping rows", () => {
    const bundle = buildAudit({ legacy: [legacy("a", "One"), legacy("b", "Two")] });
    const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
    const files = writeAuditFiles(dir, bundle);
    const json = JSON.parse(readFileSync(files.jsonPath, "utf8"));
    expect(json.jobs).toHaveLength(2);
    expect(readFileSync(files.csvPath, "utf8").trim().split("\n")).toHaveLength(3);
    expect(readFileSync(files.htmlPath, "utf8")).toContain("One");
  });
});

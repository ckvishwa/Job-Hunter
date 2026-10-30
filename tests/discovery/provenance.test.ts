import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendProvenance, appendProvenanceQueued, listingProvenance, readProvenance } from "../../src/discovery/provenance.js";

function record(title: string) {
  return listingProvenance({
    capturedAt: "2026-10-21T00:00:00.000Z",
    searchRunId: "run-1",
    source: "greenhouse",
    keyword: "analyst",
    searchLocation: "United States",
    title,
    employer: "Acme",
    location: "Remote",
    salary: null,
    resultUrl: "https://example.invalid/job",
    officialUrl: null,
    applicationUrl: null,
    externalId: title,
    sourceDateText: "3 days ago",
    relevanceMatched: false,
    matchedProfiles: [],
    relevanceReason: "none",
    disposition: "filtered",
    filterReason: "not-a-selected-role",
    descriptionText: null,
    descriptionComplete: false,
  });
}

describe("listing provenance", () => {
  it("keeps a filtered listing and does not turn a relative source date into a posting date", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prov-"));
    const file = path.join(dir, "listing-provenance.jsonl");
    expect(appendProvenance(file, [record("Account Executive")])).toEqual({ written: 1, dropped: 0 });
    const read = readProvenance(file);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({ disposition: "filtered", postingDate: null, postingDateStatus: "unknown", sourceDateText: "3 days ago" });
  });

  it("records a gap when the file bound is reached and leaves earlier lines intact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prov-limit-"));
    const file = path.join(dir, "listing-provenance.jsonl");
    appendProvenance(file, [record("First")]);
    const limit = statSync(file).size;
    const second = appendProvenance(file, [record("Second")], limit);
    expect(second.dropped).toBe(1);
    const read = readProvenance(file);
    expect(read.records.map((row) => row.title)).toEqual(["First"]);
    expect(read.gaps).toHaveLength(1);
    expect(appendProvenance(file, [record("Third")], limit).written).toBe(0);
    expect(readProvenance(file).gaps).toHaveLength(1);
  });

  it("serializes concurrent appends and recovers a torn final line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prov-concurrent-"));
    const file = path.join(dir, "listing-provenance.jsonl");
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendProvenanceQueued(file, [record(`Job ${index}`)])));
    const read = readProvenance(file);
    expect(read.records).toHaveLength(20);
    expect(read.tornTail).toBe(false);
    writeFileSync(file, `${JSON.stringify(record("Whole"))}\n{"kind":"listing","title":`, "utf8");
    const recovered = readProvenance(file);
    expect(recovered.records.map((row) => row.title)).toEqual(["Whole"]);
    expect(recovered.tornTail).toBe(true);
  });
});

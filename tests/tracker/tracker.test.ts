import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { saveJobs } from "../../src/storage/job-store.js";
import { runTracker, writeTracker } from "../../src/tracker/cli.js";
import { buildTrackerRows, TRACKER_COLUMNS } from "../../src/tracker/rows.js";
import { buildXlsx } from "../../src/tracker/xlsx.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function job(over: Partial<JobPosting>): JobPosting {
  return {
    id: "job-1", source: "company-careers::acme", sourceType: "company-careers", company: "Acme", title: "QA Engineer", location: null,
    remoteType: null, employmentType: null, department: null, requisitionId: "1", postingDate: null, discoveredAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1", applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
    descriptionText: "x", descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: ["sdet"], discoveredFrom: ["company-careers"],
    schemaVersion: 1, jdContentHash: HASH_A, extractedAt: "2026-10-02T00:00:00.000Z", resolutionStatus: "resolved", atsIdentity: "greenhouse:acme:1", rawMetadata: {},
    ...over,
  } as JobPosting;
}

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-tracker-"));
  const out = path.join(dir, "output");
  mkdirSync(out);
  return { dir, out, jobsPath: path.join(dir, "jobs.jsonl") };
}

function writeRun(out: string, jobId: string, hash: string, files: Record<string, unknown>) {
  const dir = path.join(out, jobId, hash);
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(path.join(dir, name), JSON.stringify(value));
}

/** Independent minimal zip reader: central directory, inflate, CRC check. */
function readZip(bytes: Buffer): Map<string, string> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    expect(bytes.readUInt32LE(p)).toBe(0x02014b50);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const localAt = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const localNameLen = bytes.readUInt16LE(localAt + 26);
    const data = inflateRawSync(bytes.subarray(localAt + 30 + localNameLen, localAt + 30 + localNameLen + compressedSize));
    files.set(name, data.toString("utf8"));
    p += 46 + nameLen;
  }
  return files;
}

describe("tracker rows (projection of the ledger)", () => {
  it("projects company, ATS, URL, JD hash, decision, resume variant, state, last update and blocking reason", () => {
    const w = workspace();
    saveJobs(w.jobsPath, [job({ matchedProfiles: ["qa"] })]);
    writeRun(w.out, "job-1", HASH_A, {
      "application-1.json": { outcome: "WAITING_FOR_USER", reason: ["fact missing", "coverage partial"], createdAt: "2026-10-08T10:00:00.000Z", atsIdentity: "greenhouse:acme:1" },
      "resume-plan.json": { lane: "sdet", decisionOutcome: "REVIEW" },
    });
    const { rows, problems } = buildTrackerRows({ jobsPath: w.jobsPath, outputDir: w.out });
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      {
        company: "Acme", title: "QA Engineer", track: "QA", location: "", locationFlag: "LOCATION_UNKNOWN", ats: "greenhouse", officialUrl: "https://boards.greenhouse.io/acme/jobs/1", jdHash: HASH_A,
        decision: "REVIEW", resumeVariant: "sdet", state: "WAITING_FOR_USER", lastUpdate: "2026-10-08T10:00:00.000Z", blockingReason: "fact missing; coverage partial",
      },
    ]);
  });

  it("keeps a discovered job with no run output, and one row per JD revision", () => {
    const w = workspace();
    saveJobs(w.jobsPath, [job({}), job({ id: "job-2", title: "SDET", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/2", atsIdentity: "greenhouse:acme:2", jdContentHash: HASH_B, resolutionStatus: "unresolved" })]);
    writeRun(w.out, "job-1", "c".repeat(64), { "application-1.json": { outcome: "READY_TO_SUBMIT", createdAt: "2026-10-09T00:00:00.000Z" } });
    const { rows } = buildTrackerRows({ jobsPath: w.jobsPath, outputDir: w.out });
    expect(rows.map((r) => [r.title, r.state, r.jdHash.slice(0, 1)])).toEqual([
      ["QA Engineer", "RESOLVED", "a"], // current JD revision, no run yet
      ["QA Engineer", "READY_TO_SUBMIT", "c"], // older JD revision with a run (sorted by company, title, hash)
      ["SDET", "DISCOVERED", "b"],
    ]);
  });

  it("reports an unreadable record instead of dropping the row or inventing a state", () => {
    const w = workspace();
    saveJobs(w.jobsPath, [job({})]);
    const dir = path.join(w.out, "job-1", HASH_A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "application-1.json"), "{not json");
    const { rows, problems } = buildTrackerRows({ jobsPath: w.jobsPath, outputDir: w.out });
    expect(problems).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("RESOLVED");
  });
});

describe("tracker track column", () => {
  it("sorts SECURITY first, then QA, then untracked; a job matched to both is SECURITY", () => {
    const w = workspace();
    saveJobs(w.jobsPath, [
      job({ id: "a", company: "Zeta", title: "QA Engineer", atsIdentity: "greenhouse:zeta:1", canonicalUrl: "https://boards.greenhouse.io/zeta/jobs/1", matchedProfiles: ["qa"] }),
      job({ id: "b", company: "Beta", title: "Other", atsIdentity: "greenhouse:beta:2", canonicalUrl: "https://boards.greenhouse.io/beta/jobs/2", matchedProfiles: [] }),
      job({ id: "c", company: "Yank", title: "SOC Analyst", atsIdentity: "greenhouse:yank:3", canonicalUrl: "https://boards.greenhouse.io/yank/jobs/3", matchedProfiles: ["security"] }),
      job({ id: "d", company: "Alpha", title: "Security QA", atsIdentity: "greenhouse:alpha:4", canonicalUrl: "https://boards.greenhouse.io/alpha/jobs/4", matchedProfiles: ["qa", "security"] }),
      job({ id: "e", company: "Legacy", title: "SDET", atsIdentity: "greenhouse:legacy:5", canonicalUrl: "https://boards.greenhouse.io/legacy/jobs/5", matchedProfiles: ["sdet"] }),
    ]);
    const { rows } = buildTrackerRows({ jobsPath: w.jobsPath, outputDir: w.out });
    expect(rows.map((r) => [r.track, r.company])).toEqual([["SECURITY", "Alpha"], ["SECURITY", "Yank"], ["QA", "Legacy"], ["QA", "Zeta"], ["", "Beta"]]);
  });
});

describe("xlsx writer", () => {
  it("produces a well-formed zip with valid CRCs and the expected parts", () => {
    const bytes = buildXlsx([{ name: "T", header: ["A", "B"], rows: [["1", "x & <y>"]] }]);
    const parts = readZip(bytes);
    expect([...parts.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(parts.get("xl/worksheets/sheet1.xml")).toContain("x &amp; &lt;y&gt;");
  });

  it("stores formula-looking posting text as inline text and strips XML-invalid control characters", () => {
    const sheet = readZip(buildXlsx([{ name: "T", header: ["A"], rows: [["=HYPERLINK(\"http://evil\",\"x\")"], ["ok\u0000\u0008end"]] }])).get("xl/worksheets/sheet1.xml")!;
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('t="inlineStr"');
    expect(sheet).toContain("okend");
  });

  it("rejects invalid sheet names and ragged rows", () => {
    expect(() => buildXlsx([{ name: "bad/name", header: ["A"], rows: [] }])).toThrow(/sheet name/);
    expect(() => buildXlsx([{ name: "T", header: ["A", "B"], rows: [["only one"]] }])).toThrow(/Row width/);
  });
});

describe("tracker CLI", () => {
  it("rebuilds the same workbook content from the ledger and never trusts a previous file", async () => {
    const w = workspace();
    saveJobs(w.jobsPath, [job({})]);
    const outFile = path.join(w.dir, "tracker.xlsx");
    writeFileSync(outFile, "stale or hand-edited junk");
    const lines: string[] = [];
    expect(await runTracker({ dataDir: w.dir, outputDir: w.out, out: outFile }, (l) => lines.push(l))).toBe(0);
    const first = readZip(readFileSync(outFile));
    const sheet = first.get("xl/worksheets/sheet1.xml")!;
    for (const column of TRACKER_COLUMNS) expect(sheet).toContain(`>${column}<`);
    expect(sheet).toContain("greenhouse");
    // About sheet states the projection is not authoritative.
    expect(first.get("xl/worksheets/sheet2.xml")).toContain("not authoritative");
    expect(writeTracker({ jobsPath: w.jobsPath, outputDir: w.out, out: outFile, now: "2026-10-10T00:00:00.000Z" }).rows).toBe(1);
  });

  it("leaves the previous workbook untouched and exits non-zero when the target cannot be replaced", async () => {
    const w = workspace();
    saveJobs(w.jobsPath, [job({})]);
    const blocked = path.join(w.dir, "blocked.xlsx");
    mkdirSync(blocked); // a directory where the file should be: rename onto it fails like a locked workbook
    const lines: string[] = [];
    expect(await runTracker({ dataDir: w.dir, outputDir: w.out, out: blocked }, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("Tracker not written");
  });

  it("does not modify the ledger", async () => {
    const w = workspace();
    saveJobs(w.jobsPath, [job({})]);
    const before = readFileSync(w.jobsPath, "utf8");
    await runTracker({ dataDir: w.dir, outputDir: w.out, out: path.join(w.dir, "t.xlsx") }, () => {});
    expect(readFileSync(w.jobsPath, "utf8")).toBe(before);
  });
});

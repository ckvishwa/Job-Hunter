import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { buildDashboardSnapshot } from "../../src/dashboard/model.js";
import { createDashboardServer, listenLoopback } from "../../src/dashboard/server.js";
import { saveJobs } from "../../src/storage/job-store.js";

const HASH_A = "a".repeat(64);
const SECRET_FACT = "SECRET-CANDIDATE-FACT-9917";

function job(over: Partial<JobPosting>): JobPosting {
  return {
    id: "job-1", source: "company-careers::acme", sourceType: "company-careers", company: "Acme", title: "QA Engineer", location: "Remote, US",
    remoteType: null, employmentType: null, department: null, requisitionId: "1", postingDate: null, discoveredAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: "2026-10-01T00:00:00.000Z", canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1", applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
    descriptionText: "We do not provide visa sponsorship.", descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: ["sdet"], discoveredFrom: ["company-careers"],
    schemaVersion: 1, jdContentHash: HASH_A, extractedAt: "2026-10-02T00:00:00.000Z", resolutionStatus: "resolved", atsIdentity: "greenhouse:acme:1", rawMetadata: {},
    ...over,
  } as JobPosting;
}

// Fixture: 3 jobs. job-1 resolved only; job-2 has a WAITING_FOR_USER application plus checkpoint with a typed error; job-3 is a javascript: URL job.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-dash-"));
  const data = path.join(dir, "data");
  const out = path.join(dir, "output");
  mkdirSync(data);
  mkdirSync(out);
  saveJobs(path.join(data, "jobs.jsonl"), [
    job({ id: "job-1" }),
    job({ id: "job-2", company: "Beta Sec", title: "SOC Analyst", matchedProfiles: ["security"], jdContentHash: "b".repeat(64), canonicalUrl: "https://jobs.lever.co/beta/2", descriptionText: "Active clearance required." }),
    job({ id: "job-3", company: "Gamma", title: "Backend Dev", matchedProfiles: [], jdContentHash: "c".repeat(64), descriptionText: "Backend role.", resolutionStatus: "unresolved", canonicalUrl: "javascript:alert(1)" }),
  ]);
  const run = path.join(out, "job-2", "b".repeat(64));
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, "application-x.json"), JSON.stringify({ outcome: "WAITING_FOR_USER", reason: [SECRET_FACT], createdAt: "2026-10-08T10:00:00.000Z", application: { answers: [SECRET_FACT] } }));
  writeFileSync(path.join(run, "resume-plan.json"), JSON.stringify({ decisionOutcome: "REVIEW", lane: "security", facts: [SECRET_FACT] }));
  writeFileSync(path.join(run, "pipeline-checkpoint.json"), JSON.stringify({ outcome: "WAITING_FOR_USER", updatedAt: "2026-10-08T10:00:00.000Z", stages: { canonicalJob: { status: "DONE" }, extraction: { status: "BLOCKED", errorCode: "PROVIDER_UNAVAILABLE", note: SECRET_FACT } } }));
  // Run events: an older boards run that ended PARTIAL, then a pipeline run still open on extraction,
  // then a torn (partial) last line from a crash mid-append.
  const ev = (seq: number, at: string, runId: string, runType: string, kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, seq, at, runId, runType, kind, ...extra });
  const events = path.join(dir, "run-events.jsonl");
  writeFileSync(events, [
    ev(1, "2026-10-08T10:00:00.000Z", "boards-y", "boards", "run.start"),
    ev(2, "2026-10-08T10:00:01.000Z", "boards-y", "boards", "stage.start", { stage: "board", company: "Beta Sec" }),
    ev(3, "2026-10-08T10:00:02.000Z", "boards-y", "boards", "stage.end", { stage: "board", company: "Beta Sec", outcome: "ERROR", errorCode: "BOARD_NOT_FOUND", durationMs: 1000 }),
    ev(4, "2026-10-08T10:01:00.000Z", "boards-y", "boards", "run.end", { outcome: "PARTIAL", durationMs: 60000 }),
    ev(1, "2026-10-08T10:04:00.000Z", "pipeline-x", "pipeline", "run.start", { jobId: "job-2" }),
    ev(2, "2026-10-08T10:04:01.000Z", "pipeline-x", "pipeline", "stage.start", { stage: "lane", company: "Acme", jobId: "job-2" }),
    ev(3, "2026-10-08T10:04:02.000Z", "pipeline-x", "pipeline", "stage.end", { stage: "lane", company: "Acme", jobId: "job-2", outcome: "OK", durationMs: 1000 }),
    ev(4, "2026-10-08T10:04:03.000Z", "pipeline-x", "pipeline", "stage.start", { stage: "extraction", company: "Acme", jobId: "job-2" }),
  ].join("\n") + '\n{"v":1,"seq":5,"at":"2026-10-08T10:04:0');
  const boards = path.join(dir, "boards.json");
  writeFileSync(boards, JSON.stringify({ version: 1, titleKeywords: ["QA"], companies: [{ company: "Acme", ats: "greenhouse", board: "acme" }, { company: "Delta", ats: "lever", board: "delta" }] }));
  return { dir, data, out, boards, events };
}

function snapshotSources(f: ReturnType<typeof fixture>, now: string) {
  return { dataDir: f.data, outputDir: f.out, boardsPath: f.boards, eventsPath: f.events, now };
}

function digestTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p)).update(String(statSync(p).mtimeMs));
    }
  };
  walk(dir);
  return h.digest("hex");
}

function request(port: number, method: string, urlPath: string, host?: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: host ? { Host: host } : undefined }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

const open: http.Server[] = [];
afterEach(async () => {
  while (open.length) await new Promise((r) => open.pop()!.close(r));
});

async function start(f: ReturnType<typeof fixture>, now = "2026-10-08T10:05:00.000Z") {
  const server = createDashboardServer(snapshotSources(f, now));
  open.push(server);
  const addr = await listenLoopback(server, 0);
  return { server, addr };
}

describe("dashboard snapshot (independent expected values from the fixture)", () => {
  it("counts the funnel, flags, errors and tracks exactly", () => {
    const s = buildDashboardSnapshot(snapshotSources(fixture(), "2026-10-08T10:05:00.000Z"));
    const funnel = Object.fromEntries(s.funnel.map((f) => [f.stage, f.count]));
    expect(funnel).toMatchObject({ RESOLVED: 1, DISCOVERED: 1, WAITING_FOR_USER: 1, READY_TO_SUBMIT: 0 });
    expect(Object.fromEntries(s.flags.map((f) => [f.flag, f.count]))).toMatchObject({ NO_SPONSORSHIP: 1, CLEARANCE_REQUIRED: 1 });
    expect(s.activity.active).toBe(true);
    expect(s.activity.typedErrors).toEqual([
      { source: "checkpoint", company: "Beta Sec", title: "SOC Analyst", stage: "extraction", errorCode: "PROVIDER_UNAVAILABLE" },
      { source: "events", company: "Beta Sec", title: "", stage: "board", errorCode: "BOARD_NOT_FOUND" },
    ]);
    expect(s.activity.run).toMatchObject({ runId: "pipeline-x", runType: "pipeline", endedAt: "" });
    expect(s.activity.current).toMatchObject({ stage: "extraction", company: "Acme", jobId: "job-2" });
    if (s.activity.events.status !== "ok") throw new Error("expected events");
    expect(s.activity.events.items).toHaveLength(8);
    expect(s.activity.events.skippedLines).toBe(1); // the torn last line
    expect(s.queue.byTrack).toEqual({ SECURITY: 1, QA: 1 });
    expect(s.boards.companies).toEqual([{ company: "Acme", ats: "greenhouse", board: "acme", ledgerJobs: 1 }, { company: "Delta", ats: "lever", board: "delta", ledgerJobs: 0 }]);
  });

  it("reports no data instead of inventing numbers", () => {
    const f = fixture();
    // Two hours later the open pipeline run is stale: not active, and no stage is reported as current.
    const stale = buildDashboardSnapshot(snapshotSources(f, "2026-10-08T12:00:00.000Z"));
    expect(stale.activity.active).toBe(false);
    expect(stale.activity.current).toBeNull();
    // With no events file at all there is no feed to show.
    const s = buildDashboardSnapshot({ ...snapshotSources(f, "2026-10-08T12:00:00.000Z"), eventsPath: path.join(f.dir, "missing.jsonl") });
    expect(s.activity.active).toBe(false);
    expect(s.activity.events.status).toBe("no data");
    expect(s.queue.status).toBe("no data");
    expect(s.boards.verifyResults.status).toBe("no data");
    expect(s.stageEmitters.filter((e) => e.emitsRunEvents).length).toBe(3);
    expect(s.stageEmitters.find((e) => e.stage === "board verify")!.emitsRunEvents).toBe(false);
  });

  it("works with empty or missing stores", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-dash-empty-"));
    const s = buildDashboardSnapshot({ dataDir: dir, outputDir: path.join(dir, "none") });
    expect(s.jobs).toEqual([]);
    expect(s.boards.status).toBe("no data");
  });

  it("never emits candidate facts or non-https URLs", () => {
    const s = JSON.stringify(buildDashboardSnapshot(snapshotSources(fixture(), "2026-10-08T10:05:00.000Z")));
    expect(s).not.toContain(SECRET_FACT);
    expect(s).not.toContain("javascript:");
  });
});

describe("dashboard server", () => {
  it("binds to loopback only", async () => {
    const { server, addr } = await start(fixture());
    expect(addr.address).toBe("127.0.0.1");
    expect((server.address() as AddressInfo).family).toBe("IPv4");
  });

  it("serves GET endpoints and rejects every write method, bad hosts and unknown paths", async () => {
    const f = fixture();
    const { addr } = await start(f);
    const before = digestTree(f.dir);
    expect((await request(addr.port, "GET", "/")).status).toBe(200);
    const snap = await request(addr.port, "GET", "/api/snapshot");
    expect(snap.status).toBe(200);
    expect(JSON.parse(snap.body).funnel).toBeInstanceOf(Array);
    expect(snap.headers["cache-control"]).toBe("no-store");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect((await request(addr.port, method, "/api/snapshot")).status).toBe(405);
    expect((await request(addr.port, "GET", "/api/snapshot", "evil.example")).status).toBe(403);
    expect((await request(addr.port, "GET", "/nope")).status).toBe(404);
    expect(digestTree(f.dir)).toBe(before);
}, 20_000);
});

describe("dashboard page rendering (headless Chromium against the fixture server)", () => {
  it("renders funnel, no-data panels, escaped text and safe links from fixture data", async () => {
    const f = fixture();
    const { addr } = await start(f);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const external: string[] = [];
      page.on("request", (r) => { if (!r.url().startsWith(`http://127.0.0.1:${addr.port}/`)) external.push(r.url()); });
      await page.goto(`http://127.0.0.1:${addr.port}/`);
      await page.waitForSelector("#jobs tr");
      expect(await page.locator("#funnel .row").first().innerText()).toContain("MANUAL_WATCH");
      expect(await page.locator("#jobs tr").count()).toBe(3);
      const activity = await page.locator("#activity").innerText();
      expect(activity).toContain("RUN ACTIVE");
      expect(activity).toContain("stage: extraction / Acme / job-2");
      expect(activity).toContain("stage.end lane / Acme / job-2 -> OK");
      expect(activity).toContain("1 unreadable line(s) skipped");
      expect(activity).toContain("PROVIDER_UNAVAILABLE");
      expect(activity).toContain("BOARD_NOT_FOUND");
      expect(await page.locator("#queue").innerText()).toContain("no data");
      expect(await page.locator("#jobs a").count()).toBe(2);
      expect(await page.locator("#jobs a").first().getAttribute("rel")).toBe("noopener noreferrer");
      await page.fill("#q", "soc");
      expect(await page.locator("#jobs tr").count()).toBe(1);
      expect(await page.content()).not.toContain(SECRET_FACT);
      expect(external).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

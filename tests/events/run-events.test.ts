import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunEventLog, errorCodeOf, noopRunEventLog, parseEventLine, readRunEvents } from "../../src/events/run-events.js";
import { boardApiUrl, runBoardDiscovery } from "../../src/pipeline/discovery/board-discoverer.js";

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-events-"));
  return { dir, file: path.join(dir, "private-runtime", "run-events.jsonl") };
}

/** Deterministic clock: each call advances 10 ms, so durations are exact. */
function fakeClock() {
  let t = 0;
  return () => (t += 10);
}
function fakeNow() {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 9, 12, 0, n++)).toISOString();
}

const options = (file: string) => ({ filePath: file, now: fakeNow(), clock: fakeClock(), runId: "run-1" });

describe("run event order and shape", () => {
  it("writes run.start, nested stage events, run.end in order with exact durations", async () => {
    const { file } = tmp();
    const log = createRunEventLog("pipeline", options(file));
    log.runStart({ jobId: "job-1" });
    await log.stage("lane", { company: "Acme", jobId: "job-1" }, async () => "ok");
    const extraction = log.stageStart("extraction", { company: "Acme", jobId: "job-1" });
    extraction.end("VALIDATED");
    log.runEnd("WAITING_FOR_USER");

    const { events, skippedLines } = readRunEvents(file);
    expect(skippedLines).toBe(0);
    expect(events.map((e) => [e.seq, e.kind, e.stage ?? "", e.outcome ?? ""])).toEqual([
      [1, "run.start", "", ""],
      [2, "stage.start", "lane", ""],
      [3, "stage.end", "lane", "OK"],
      [4, "stage.start", "extraction", ""],
      [5, "stage.end", "extraction", "VALIDATED"],
      [6, "run.end", "", "WAITING_FOR_USER"],
    ]);
    // Clock ticks: runStart 10 | lane start 20, end 30 | extraction start 40, end 50 | runEnd 60.
    expect(events[2]!.durationMs).toBe(10);
    expect(events[4]!.durationMs).toBe(10);
    expect(events[5]!.durationMs).toBe(50);
    expect(events.every((e) => e.runId === "run-1" && e.runType === "pipeline" && e.v === 1)).toBe(true);
    expect(events[1]).toMatchObject({ company: "Acme", jobId: "job-1" });
  });

  it("records a throwing stage as ERROR with its typed code, then rethrows", async () => {
    const { file } = tmp();
    const log = createRunEventLog("pipeline", options(file));
    log.runStart();
    class ProviderError extends Error { code = "PROVIDER_UNAVAILABLE"; }
    await expect(log.stage("extraction", { company: "Acme" }, () => { throw new ProviderError("boom"); })).rejects.toThrow("boom");
    log.runEnd("ERROR", "PROVIDER_UNAVAILABLE");
    const { events } = readRunEvents(file);
    expect(events[2]).toMatchObject({ kind: "stage.end", stage: "extraction", outcome: "ERROR", errorCode: "PROVIDER_UNAVAILABLE" });
    expect(events[3]).toMatchObject({ kind: "run.end", outcome: "ERROR", errorCode: "PROVIDER_UNAVAILABLE" });
  });

  it("failed() records a typed rejection as a start/end pair", () => {
    const { file } = tmp();
    const log = createRunEventLog("discovery", options(file));
    log.failed("resolve_job", { company: "Acme", jobId: "101" }, "WRONG_EMPLOYER");
    const { events } = readRunEvents(file);
    expect(events.map((e) => [e.kind, e.outcome ?? "", e.errorCode ?? ""])).toEqual([["stage.start", "", ""], ["stage.end", "ERROR", "WRONG_EMPLOYER"]]);
  });

  it("stage end is idempotent and the no-op log writes nothing", () => {
    const { file } = tmp();
    const log = createRunEventLog("boards", options(file));
    const s = log.stageStart("board", { company: "Acme" });
    s.end("OK");
    s.end("OK");
    expect(readRunEvents(file).events).toHaveLength(2);
    const noop = noopRunEventLog();
    noop.runStart();
    noop.failed("x", {}, "Y");
    expect(noop.failedWrites).toBe(0);
  });

  it("never throws into the run when the file cannot be written", () => {
    const { dir } = tmp();
    const asDirectory = path.join(dir, "is-a-dir.jsonl");
    mkdirSync(asDirectory);
    const log = createRunEventLog("pipeline", options(asDirectory));
    expect(() => { log.runStart(); log.runEnd("OK"); }).not.toThrow();
    expect(log.failedWrites).toBe(2);
  });
});

describe("redaction", () => {
  const JD = "Active TS/SCI clearance required; candidate SSN 123-45-6789 answered Yes";

  it("keeps error messages, free text and unknown keys out of the file", async () => {
    const { file } = tmp();
    const log = createRunEventLog("pipeline", options(file));
    log.runStart();
    // Error whose message carries JD/candidate text and whose name is not a plain code.
    const leaky = Object.assign(new Error(JD), { name: "Error with spaces: " + JD });
    await expect(log.stage("extraction", { company: "Acme" }, () => { throw leaky; })).rejects.toBe(leaky);
    // Attempts to push free text through every field.
    log.stageStart("note: " + JD, { company: "Acme", jobId: JD }).end(JD, JD);
    log.failed("x", { company: "Acme" }, JD);
    (log as unknown as { stageStart(s: string, f: object): { end(): void } }).stageStart("lane", { jdText: JD, answers: [JD], url: "https://example.test/" + JD }).end();
    log.runEnd(JD, JD);

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("clearance");
    expect(raw).not.toContain("SSN");
    expect(raw).not.toContain("123-45");
    expect(raw).not.toContain("example.test");
    for (const e of readRunEvents(file).events) {
      expect(Object.keys(e).every((k) => ["v", "seq", "at", "runId", "runType", "kind", "stage", "company", "jobId", "outcome", "errorCode", "durationMs"].includes(k))).toBe(true);
    }
    const errors = readRunEvents(file).events.filter((e) => e.errorCode);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.every((e) => e.errorCode === "UNTYPED_ERROR")).toBe(true);
  });

  it("errorCodeOf accepts plain codes and rejects everything else", () => {
    expect(errorCodeOf({ code: "BOARD_NOT_FOUND" })).toBe("BOARD_NOT_FOUND");
    expect(errorCodeOf({ name: "TypeError" })).toBe("TypeError");
    expect(errorCodeOf({ code: "has space", name: "also bad!" })).toBe("UNTYPED_ERROR");
    expect(errorCodeOf("a string")).toBe("UNTYPED_ERROR");
    expect(errorCodeOf(null)).toBe("UNTYPED_ERROR");
  });

  it("strips control characters from company labels and caps their length", () => {
    const { file } = tmp();
    const log = createRunEventLog("boards", options(file));
    log.stageStart("board", { company: ["Ac", "me", String.fromCharCode(0x2028), " Inc", String.fromCharCode(0), "x".repeat(300)].join(String.fromCharCode(10)) }).end("OK");
    const company = readRunEvents(file).events[0]!.company!;
    expect(company.startsWith("Ac me")).toBe(true);
    expect(company.length).toBeLessThanOrEqual(120);
    expect([...company].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 0x2028)).toBe(false);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("the reader re-sanitizes foreign lines and drops invalid ones", () => {
    const good = JSON.stringify({ v: 1, seq: 1, at: "2026-10-09T12:00:00.000Z", runId: "r1", runType: "boards", kind: "run.start", secret: "JD text", errorCode: "has space" });
    const e = parseEventLine(good)!;
    expect("secret" in e).toBe(false);
    expect(e.errorCode).toBe("UNTYPED_ERROR");
    expect(parseEventLine('{"v":2}')).toBeNull();
    expect(parseEventLine("[]")).toBeNull();
    expect(parseEventLine("not json")).toBeNull();
  });
});

describe("partial trailing line recovery", () => {
  it("skips a torn last line, never edits earlier bytes, and starts new events on a fresh line", () => {
    const { file } = tmp();
    const first = createRunEventLog("pipeline", { ...options(file), runId: "run-a" });
    first.runStart();
    first.stageStart("lane", { company: "Acme" }).end("OK");
    const before = readFileSync(file, "utf8");
    // Simulated crash mid-append: half an event, no newline.
    appendFileSync(file, '{"v":1,"seq":4,"at":"2026-10-09T12:00:09.000Z","runId":"run-a","runType":"pipeline","kind":"stage.sta');

    // Reader alone tolerates the tear.
    const torn = readRunEvents(file);
    expect(torn.events).toHaveLength(3);
    expect(torn.skippedLines).toBe(1);

    // A new process appends: the torn bytes stay, the new event is on its own line.
    const second = createRunEventLog("pipeline", { ...options(file), runId: "run-b" });
    second.runStart();
    second.runEnd("OK");
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const recovered = readRunEvents(file);
    expect(recovered.skippedLines).toBe(1);
    expect(recovered.events.map((e) => `${e.runId}:${e.kind}`)).toEqual(["run-a:run.start", "run-a:stage.start", "run-a:stage.end", "run-b:run.start", "run-b:run.end"]);
  });

  it("does not insert a blank line when the file already ends in a newline, and handles an empty or missing file", () => {
    const { file } = tmp();
    expect(readRunEvents(file)).toEqual({ events: [], skippedLines: 0 });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
    const log = createRunEventLog("boards", options(file));
    log.runStart();
    log.runEnd("OK");
    expect(readFileSync(file, "utf8").split("\n")).toHaveLength(3); // two events + trailing empty
    expect(readRunEvents(file).skippedLines).toBe(0);
  });
});

describe("boards discovery wiring (production module, stubbed network only)", () => {
  it("emits run + one stage per company, with the failed company's typed code", async () => {
    const { dir, file } = tmp();
    const configPath = path.join(dir, "company-boards.json");
    const acme = { company: "Acme", ats: "greenhouse", board: "acme" } as const;
    const globex = { company: "Globex", ats: "greenhouse", board: "globex" } as const;
    writeFileSync(configPath, JSON.stringify({ version: 1, titleKeywords: ["QA"], companies: [acme, globex] }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === boardApiUrl(acme)) return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
      if (String(url) === boardApiUrl(globex)) return new Response("{}", { status: 404 });
      throw new Error(`unexpected request: ${String(url)}`);
    }) as unknown as typeof fetch;
    const events = createRunEventLog("boards", options(file));
    await runBoardDiscovery({ configPath, dataDir: dir, fetchImpl, delayMs: 0, events, now: () => "2026-10-09T12:00:00.000Z" });

    const { events: written } = readRunEvents(file);
    expect(written.map((e) => [e.kind, e.company ?? "", e.outcome ?? "", e.errorCode ?? ""])).toEqual([
      ["run.start", "", "", ""],
      ["stage.start", "Acme", "", ""],
      ["stage.end", "Acme", "OK", ""],
      ["stage.start", "Globex", "", ""],
      ["stage.end", "Globex", "ERROR", "BOARD_NOT_FOUND"],
      ["run.end", "", "PARTIAL", ""],
    ]);
  });
});

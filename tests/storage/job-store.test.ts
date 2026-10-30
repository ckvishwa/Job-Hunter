import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { mergeJobs } from "../../src/dedup/deduplicator.js";
import { JobStoreError, acquireLock, loadJobs, lockPathFor, saveJobs, updateJobs } from "../../src/storage/job-store.js";

// Real temp files and the production storage entry points. Substituted boundaries: none for
// files; process death is simulated by writing a lock file for a pid that is not alive.

function job(id: string, overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id,
    source: "acme",
    sourceType: "greenhouse",
    company: "Acme",
    title: `Role ${id}`,
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: id,
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: `https://acme.example/jobs/${id}`,
    applyUrl: `https://acme.example/jobs/${id}`,
    descriptionText: `Description for ${id}. `.repeat(10),
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["acme"],
    rawMetadata: {},
    ...overrides,
  };
}

function storeIn(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-store-"));
  return { dir, file: path.join(dir, "jobs.jsonl") };
}

const line = (j: JobPosting) => JSON.stringify(j);
const SECRET = "SECRET-DESCRIPTION-TEXT";

describe("strict reads", () => {
  it("corrupt middle record: load throws CORRUPT_RECORD with line numbers only, never record content", () => {
    const { file } = storeIn();
    writeFileSync(file, `${line(job("1", { descriptionText: SECRET }))}\n{"id":"2", broken ${SECRET}\n${line(job("3"))}\n`);
    try {
      loadJobs(file);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(JobStoreError);
      const e = err as JobStoreError;
      expect(e.code).toBe("CORRUPT_RECORD");
      expect(e.diagnostics).toMatchObject({ file, lines: [2], badRecordCount: 1 });
      expect(e.message + JSON.stringify(e.diagnostics)).not.toContain(SECRET);
    }
  });

  it("incomplete final record (no newline, not parseable) is reported as INCOMPLETE_TRAILING_RECORD", () => {
    const { file } = storeIn();
    writeFileSync(file, `${line(job("1"))}\n{"id":"2","title":"cut off ${SECRET}`);
    try {
      loadJobs(file);
      expect.unreachable();
    } catch (err) {
      const e = err as JobStoreError;
      expect(e.code).toBe("INCOMPLETE_TRAILING_RECORD");
      expect(e.diagnostics.lines).toEqual([2]);
      expect(e.diagnostics.fragmentBytes).toBeGreaterThan(10);
      expect(e.message + JSON.stringify(e.diagnostics)).not.toContain(SECRET);
    }
  });

  it("a complete final record that merely lacks a trailing newline is valid", () => {
    const { file } = storeIn();
    writeFileSync(file, `${line(job("1"))}\n${line(job("2"))}`);
    expect(loadJobs(file).map((j) => j.id)).toEqual(["1", "2"]);
  });

  it("valid JSON that is not a job record counts as corrupt", () => {
    const { file } = storeIn();
    writeFileSync(file, `${line(job("1"))}\n[1,2,3]\n`);
    expect(() => loadJobs(file)).toThrow(/CORRUPT_RECORD/);
  });
});

describe("never replace what cannot be read", () => {
  it("saveJobs and updateJobs leave a store with a corrupt middle record byte-for-byte unchanged", async () => {
    const { file } = storeIn();
    const original = `${line(job("1"))}\nnot json at all\n${line(job("3"))}\n`;
    writeFileSync(file, original);
    const before = readFileSync(file);

    expect(() => saveJobs(file, [job("9")])).toThrow(/CORRUPT_RECORD/);
    await expect(updateJobs(file, (cur) => [...cur, job("9")])).rejects.toThrow(/CORRUPT_RECORD/);

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(lockPathFor(file))).toBe(false); // lock released on the error path
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("an incomplete trailing record is preserved and reported, never discarded by a rewrite", async () => {
    const { file } = storeIn();
    const original = `${line(job("1"))}\n{"id":"2","tit`;
    writeFileSync(file, original);
    await expect(updateJobs(file, (cur) => cur)).rejects.toMatchObject({ code: "INCOMPLETE_TRAILING_RECORD" });
    expect(readFileSync(file, "utf-8")).toBe(original);
  });
});

describe("atomic replacement", () => {
  it("a failure before the rename leaves the prior authoritative file readable and unchanged, with no temp file", async () => {
    const { file } = storeIn();
    saveJobs(file, [job("1"), job("2")]);
    const before = readFileSync(file);

    await expect(
      updateJobs(file, (cur) => [...cur, job("3")], {
        beforeReplace: () => {
          throw new Error("simulated crash before replace");
        },
      }),
    ).rejects.toMatchObject({ code: "WRITE_FAILED" });

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(loadJobs(file).map((j) => j.id)).toEqual(["1", "2"]);
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(lockPathFor(file))).toBe(false);
  });

  it("an update callback that throws leaves the store unchanged and releases the lock", async () => {
    const { file } = storeIn();
    saveJobs(file, [job("1")]);
    const before = readFileSync(file);
    await expect(
      updateJobs(file, () => {
        throw new Error("merge exploded");
      }),
    ).rejects.toThrow("merge exploded");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(existsSync(lockPathFor(file))).toBe(false);
  });

  it("normal completion releases the lock and writes one complete record per line", async () => {
    const { file } = storeIn();
    const result = await updateJobs(file, (cur) => [...cur, job("1")]);
    expect(result).toHaveLength(1);
    expect(existsSync(lockPathFor(file))).toBe(false);
    expect(readFileSync(file, "utf-8").endsWith("\n")).toBe(true);
  });
});

describe("single-writer lock", () => {
  it("a second writer times out within the bound and the store is not modified", async () => {
    const { file } = storeIn();
    saveJobs(file, [job("1")]);
    const before = readFileSync(file);
    const held = await acquireLock(file);
    const started = Date.now();
    try {
      await expect(updateJobs(file, (cur) => [...cur, job("2")], { timeoutMs: 300, pollMs: 20 })).rejects.toMatchObject({
        code: "LOCK_TIMEOUT",
        diagnostics: { lockOwnerPid: process.pid },
      });
      expect(Date.now() - started).toBeLessThan(2500);
      expect(readFileSync(file).equals(before)).toBe(true);
    } finally {
      held.release();
    }
    expect(existsSync(lockPathFor(file))).toBe(false);
  });

  it("never removes a live owner's lock, however old it looks", async () => {
    const { file } = storeIn();
    const held = await acquireLock(file);
    const old = new Date(Date.now() - 3_600_000);
    (await import("node:fs")).utimesSync(lockPathFor(file), old, old);
    await expect(acquireLock(file, { timeoutMs: 200, pollMs: 20 })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(existsSync(lockPathFor(file))).toBe(true);
    held.release();
  });

  it("recovers a lock whose owner process is dead (same host), then works normally", async () => {
    const { file } = storeIn();
    writeFileSync(lockPathFor(file), JSON.stringify({ pid: 999999, host: hostname(), token: "dead", acquiredAt: "2026-01-01T00:00:00.000Z" }));
    const result = await updateJobs(file, () => [job("1")], { timeoutMs: 1000, isProcessAlive: () => false });
    expect(result).toHaveLength(1);
    expect(existsSync(lockPathFor(file))).toBe(false);
  });

  it("does not recover a lock from another host even if its pid looks dead", async () => {
    const { file } = storeIn();
    writeFileSync(lockPathFor(file), JSON.stringify({ pid: 1, host: "some-other-host", token: "remote", acquiredAt: "2026-01-01T00:00:00.000Z" }));
    await expect(updateJobs(file, () => [job("1")], { timeoutMs: 200, pollMs: 20, isProcessAlive: () => false })).rejects.toMatchObject({
      code: "LOCK_TIMEOUT",
    });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(lockPathFor(file))).toBe(true);
  });

  it("an unreadable (empty) lock is respected while young and recovered once past the grace period", async () => {
    const { file } = storeIn();
    writeFileSync(lockPathFor(file), "");
    await expect(acquireLock(file, { timeoutMs: 150, pollMs: 20, unreadableGraceMs: 60_000 })).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    const held = await acquireLock(file, { timeoutMs: 1000, pollMs: 20, unreadableGraceMs: 0 });
    held.release();
    expect(existsSync(lockPathFor(file))).toBe(false);
  });

  it("release only removes the lock this operation owns", async () => {
    const { file } = storeIn();
    const mine = await acquireLock(file);
    writeFileSync(lockPathFor(file), JSON.stringify({ pid: process.pid, host: hostname(), token: "someone-else", acquiredAt: "x" }));
    expect(() => mine.release()).toThrow(/LOCK_LOST/);
    expect(existsSync(lockPathFor(file))).toBe(true); // the other writer's lock survives
  });

  it("two real competing processes cannot lose either acknowledged update", async () => {
    const { dir, file } = storeIn();
    saveJobs(file, [job("seed")]);
    const worker = path.resolve("tests/storage/fixtures/store-writer.ts");
    const run = (prefix: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", worker, file, prefix, "12"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("close", (code) => resolve({ code, out }));
      });
    const [a, b] = await Promise.all([run("A"), run("B")]);
    expect(a.out + b.out).toContain("done");
    expect([a.code, b.code]).toEqual([0, 0]);

    const ids = loadJobs(file).map((j) => j.id);
    expect(ids).toHaveLength(1 + 12 + 12);
    for (let i = 0; i < 12; i += 1) {
      expect(ids).toContain(`A-${i}`);
      expect(ids).toContain(`B-${i}`);
    }
    expect(existsSync(lockPathFor(file))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }, 60_000);
});

describe("existing merge semantics are preserved through updateJobs", () => {
  it("keeps first-seen time, merges duplicates, keeps distinct requisitions distinct", async () => {
    const { file } = storeIn();
    const t1 = "2026-10-07T10:00:00.000Z";
    const t2 = "2026-10-08T10:00:00.000Z";
    const a = job("a", { atsIdentity: "greenhouse:acme:1", title: "Same", descriptionText: "shared description text. ".repeat(8) });
    const b = job("b", { atsIdentity: "greenhouse:acme:2", title: "Same", descriptionText: "shared description text. ".repeat(8), canonicalUrl: "https://acme.example/jobs/b" });
    await updateJobs(file, (cur) => mergeJobs(cur, [a, b], t1));
    const after = await updateJobs(file, (cur) => mergeJobs(cur, [{ ...a }], t2));
    expect(after).toHaveLength(2);
    const first = after.find((j) => j.atsIdentity === "greenhouse:acme:1")!;
    expect(first.discoveredAt).toBe(t1);
    expect(first.lastSeenAt).toBe(t2);
  });
});

describe("log safety", () => {
  it("storage errors do not echo record content to the console", () => {
    const { file } = storeIn();
    writeFileSync(file, `${line(job("1", { descriptionText: SECRET }))}\nbroken ${SECRET}\n`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadJobs(file)).toThrow();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore();
  });
});

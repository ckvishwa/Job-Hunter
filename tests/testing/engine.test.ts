import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestEngine, type Executors, type UnitResult } from "../../src/testing/engine.js";
import { treeFingerprint, type Context } from "../../src/testing/fingerprint.js";

// The smart-test engine against a throwaway fake repository and a scripted executor (no real Vitest). TEST-EFFICIENCY proof cases.

let root: string;
let calls: { vitest: string[][]; python: number; typecheck: number };
let failing: Set<string>;
let skipping: Set<string>;
let interruptAtBatch: number | null;
let batchesSeen: number;

const write = (rel: string, text: string): void => {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, text);
};
const pass = (tests = 3): UnitResult => ({ status: "pass", tests, failedTests: [], durationMs: 5, skipped: 0 });

function executors(): Executors {
  return {
    async vitest(files) {
      batchesSeen += 1;
      if (interruptAtBatch !== null && batchesSeen === interruptAtBatch) return null; // crashed batch: no result at all
      calls.vitest.push(files);
      return new Map(files.map((f) => [f, failing.has(f) ? { status: "fail", tests: 3, failedTests: [`${f} > case`], durationMs: 5, skipped: 0 } : skipping.has(f) ? { ...pass(3), skipped: 1 } : pass(3)]));
    },
    async python(files) { calls.python += 1; return new Map(files.map((file) => [file, pass(7)])); },
    async typecheck() { calls.typecheck += 1; return pass(0); },
  };
}
const ctx = (): Context => ({ root, chromeVersion: "1.0", vitestVersion: "2.1.9", nodeVersion: "v24", neverCache: [] });
const engine = (batchSize = 2, neverCache: RegExp[] = [], gitChangedFiles: () => string[] | null = () => null): TestEngine => new TestEngine({ ctx: { ...ctx(), neverCache }, executors: executors(), batchSize, now: () => new Date("2026-10-11T12:00:00Z"), gitChangedFiles });

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "orbital-testcache-"));
  calls = { vitest: [], python: 0, typecheck: 0 };
  failing = new Set(); skipping = new Set(); interruptAtBatch = null; batchesSeen = 0;
  write("package.json", JSON.stringify({ dependencies: { a: "1" }, devDependencies: {} }));
  write("package-lock.json", "{}");
  write("vitest.config.ts", "export default {}");
  write("tsconfig.json", "{}");
  write("src/a.ts", "export const a = 1;");
  write("src/b.ts", "export const b = 1;");
  write("src/shared.ts", "export const shared = 1;");
  write("config/x.json", '{"x":1}');
  write("db/migrations/0001.sql", "select 1;");
  write("tests/a.test.ts", 'import { a } from "../src/a.js";\nimport { shared } from "../src/shared.js";\nvoid a; void shared;');
  write("tests/b.test.ts", 'import { b } from "../src/b.js";\nimport { readFileSync } from "node:fs";\nreadFileSync("config/x.json"); void b;');
  write("tests/c.test.ts", 'import { shared } from "../src/shared.js";\nvoid shared;');
  write("tests/db.test.ts", 'import { startHarness } from "./helpers/h.js";\nvoid startHarness;');
  write("tests/helpers/h.ts", "export const startHarness = 1;");
  write("tests/dyn.test.ts", 'const name = "x"; await import(name + ".js");');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const executedFiles = (): string[] => calls.vitest.flat().sort();
const ALL = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/db.test.ts", "tests/dyn.test.ts"];

describe("TEST-EFFICIENCY: change-aware execution with verified reuse", () => {
  it("a cold cache without a git diff refuses to become a full run", async () => {
    const first = await engine().run("changed");
    expect(first.executedNow.units).toBe(0);
    expect(first.selectionReason).toMatch(/refused to expand/);
    expect(calls.vitest).toEqual([]);
    expect(calls.python + calls.typecheck).toBe(0);
  });

  it("a cold cache with a git diff runs only the affected tests", async () => {
    const selected = await engine(2, [], () => ["src/b.ts"]).run("changed");
    expect(executedFiles()).toEqual(["tests/b.test.ts"]);
    expect(calls.typecheck).toBe(1);
    expect(calls.python).toBe(0);
    expect(selected.selectionReason).toMatch(/git diff/);
  });

  it("a full run seeds receipts; an unchanged repeat executes nothing but the uncertain unit", async () => {
    const first = await engine().run("full");
    expect(first.executedNow.files).toEqual(expect.arrayContaining(ALL));
    expect(first.executedNow.units).toBe(7); // 5 test files + python + typecheck
    expect(first.reused).toEqual({ units: 0, tests: 0 });
    calls = { vitest: [], python: 0, typecheck: 0 };
    const second = await engine().run("changed");
    expect(executedFiles()).toEqual(["tests/dyn.test.ts"]); // a computed dynamic import cannot be scanned: always rerun
    expect(calls.python + calls.typecheck).toBe(0);
    expect(second.reused.units).toBe(6);
    expect(second.reused.tests).toBe(3 * 4 + 7 + 0);
    expect(second.executedNow.tests).toBe(3); // only what really ran now
    expect(second.invalidated.map((i) => i.unit)).toEqual(["tests/dyn.test.ts"]); // reported as not reusable, with the reason
  });

  it("an edit to a source file invalidates exactly the tests that import it, and names the changed file", async () => {
    await engine().run("full");
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("src/b.ts", "export const b = 2;");
    const s = await engine().run("changed");
    expect(executedFiles()).toEqual(["tests/b.test.ts", "tests/dyn.test.ts"]);
    expect(calls.typecheck).toBe(1); // sources changed: the typecheck unit is stale too
    expect(calls.python).toBe(0);
    expect(s.invalidated.find((i) => i.unit === "tests/b.test.ts")?.reasons).toEqual(expect.arrayContaining(["closure", "changed: src/b.ts"]));
  });

  it("a shared utility invalidates every test that imports it, and a brand-new untracked file is picked up", async () => {
    await engine().run("full");
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("src/shared.ts", "export const shared = 2;");
    write("tests/new.test.ts", 'import { a } from "../src/a.js";\nvoid a;');
    await engine().run("changed");
    expect(executedFiles()).toEqual(["tests/a.test.ts", "tests/c.test.ts", "tests/dyn.test.ts", "tests/new.test.ts"]);
  });

  it("a data file named by a string literal (fixtures, config, SQL) is part of the fingerprint", async () => {
    await engine().run("full");
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("config/x.json", '{"x":2}');
    await engine().run("changed");
    expect(executedFiles()).toEqual(["tests/b.test.ts", "tests/dyn.test.ts"]);
  });

  it("runtime state under private-runtime is not a data dependency (the runner's own checkpoint would otherwise invalidate the runner's own test forever)", async () => {
    write("private-runtime/test-cache/current-run.json", '{"n":1}');
    write("tests/rt.test.ts", 'import { readFileSync } from "node:fs";\nreadFileSync("private-runtime/test-cache/current-run.json");');
    await engine().run("changed");
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("private-runtime/test-cache/current-run.json", '{"n":2}');
    await engine().run("changed");
    expect(executedFiles()).not.toContain("tests/rt.test.ts");
  });

  it("a database migration invalidates database tests only; package lock and config changes invalidate everything", async () => {
    await engine().run("full");
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("db/migrations/0001.sql", "select 2;");
    await engine().run("changed");
    expect(executedFiles()).toEqual(["tests/db.test.ts", "tests/dyn.test.ts"]);
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("package-lock.json", '{"changed":true}');
    await engine().run("changed");
    expect(executedFiles()).toEqual(ALL);
    expect(calls.python).toBe(0); // the Python unit watches services/ai, not the npm lock file
    expect(calls.typecheck).toBe(1);
    calls = { vitest: [], python: 0, typecheck: 0 };
    write("vitest.config.ts", "export default { test: {} }");
    await engine().run("changed");
    expect(executedFiles()).toEqual(ALL);
  });

  it("a failing test is never hidden by an older green result, and passing again needs a real pass", async () => {
    await engine().run("full");
    write("src/b.ts", "export const b = 99;");
    failing.add("tests/b.test.ts");
    const bad = await engine().run("changed");
    expect(bad.failed).toEqual([{ unit: "tests/b.test.ts", tests: ["tests/b.test.ts > case"] }]);
    // revert the source to the exact bytes of the earlier green run: the old receipt must NOT come back
    write("src/b.ts", "export const b = 1;");
    calls = { vitest: [], python: 0, typecheck: 0 };
    failing.clear();
    const again = await engine().run("changed");
    expect(executedFiles()).toContain("tests/b.test.ts");
    expect(again.failed).toEqual([]);
    // test:failed reruns only units whose latest receipt is a failure
    write("src/b.ts", "export const b = 7;");
    failing.add("tests/b.test.ts");
    await engine().run("changed");
    calls = { vitest: [], python: 0, typecheck: 0 };
    failing.clear();
    const only = await engine().run("failed");
    expect(executedFiles()).toEqual(["tests/b.test.ts"]);
    expect(only.failed).toEqual([]);
    expect(only.reused.units).toBe(0);
    expect(only.skipped.length).toBeGreaterThan(0);
  });

  it("tests that skipped anything, uncertain scans and never-cache policies are never served from a receipt", async () => {
    skipping.add("tests/c.test.ts");
    await engine(2, [/^tests\/a\.test\.ts$/]).run("full");
    calls = { vitest: [], python: 0, typecheck: 0 };
    const s = await engine(2, [/^tests\/a\.test\.ts$/]).run("changed");
    expect(executedFiles()).toEqual(["tests/a.test.ts", "tests/c.test.ts", "tests/dyn.test.ts"]);
    expect(s.invalidated.map((i) => i.unit).sort()).toEqual(["tests/a.test.ts", "tests/c.test.ts", "tests/dyn.test.ts"]);
    expect(s.invalidated.find((i) => i.unit === "tests/c.test.ts")!.reasons[0]).toMatch(/skipped/);
    expect(s.invalidated.find((i) => i.unit === "tests/a.test.ts")!.reasons[0]).toMatch(/never cached/);
  });

  it("a corrupt or tampered receipt is ignored and the unit is rerun", async () => {
    await engine().run("full");
    const dir = path.join(root, "private-runtime", "test-cache", "receipts");
    for (const f of readdirSync(dir)) {
      const text = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if (text.unit === "tests/a.test.ts") writeFileSync(path.join(dir, f), JSON.stringify({ ...text, tests: 999 })); // selfHash no longer matches
      if (text.unit === "tests/c.test.ts") writeFileSync(path.join(dir, f), "{ not json");
    }
    calls = { vitest: [], python: 0, typecheck: 0 };
    await engine().run("changed");
    expect(executedFiles()).toEqual(["tests/a.test.ts", "tests/c.test.ts", "tests/dyn.test.ts"]);
  });
});

describe("crash recovery", () => {
  it("resumes an interrupted run: verified completed units are reused, the interrupted batch and the rest are rerun", async () => {
    interruptAtBatch = 2; // batch size 2 over 5 files: batch 1 completes, batch 2 'crashes'
    const first = await engine().run("full");
    expect(first.pending.length).toBeGreaterThan(0);
    const done = first.executedNow.files.filter((f) => f.startsWith("tests/"));
    expect(done).toHaveLength(2);
    interruptAtBatch = null;
    calls = { vitest: [], python: 0, typecheck: 0 };
    const resumed = await engine().resume();
    expect(resumed).not.toBeNull();
    expect(resumed!.pending).toEqual([]);
    for (const f of done.filter((x) => x !== "tests/dyn.test.ts")) expect(executedFiles()).not.toContain(f); // not redone
    expect(resumed!.reused.units).toBeGreaterThanOrEqual(1);
    expect(await engine().resume()).toBeNull(); // nothing left to resume
  });

  it("a file edited between the interruption and the resume is rerun even though its batch had finished", async () => {
    interruptAtBatch = 2;
    await engine().run("full");
    interruptAtBatch = null;
    write("src/a.ts", "export const a = 5;");
    calls = { vitest: [], python: 0, typecheck: 0 };
    await engine().resume();
    expect(executedFiles()).toContain("tests/a.test.ts");
  });

  it("a corrupt checkpoint is ignored (nothing to resume) and the receipts still prevent duplicate work", async () => {
    interruptAtBatch = 2;
    await engine().run("full");
    writeFileSync(path.join(root, "private-runtime", "test-cache", "current-run.json"), "garbage");
    interruptAtBatch = null;
    expect(await engine().resume()).toBeNull();
    calls = { vitest: [], python: 0, typecheck: 0 };
    await engine().run("changed");
    expect(executedFiles().length).toBeLessThan(ALL.length + 1);
  });
});

describe("full regression gate", () => {
  it("ignores generated runtime receipts named in test source when verifying a full run", async () => {
    write("tests/runtime.test.ts", 'import { readFileSync } from "node:fs"; readFileSync("private-runtime/test-cache/current-run.json");');
    const full = await engine().run("full");
    expect(full.fullGate.state).toBe("PASS_CURRENT");
    expect(full.executedNow.units).toBe(8);
  });

  it("test:full ignores receipts, and its gate is PASS_CURRENT only for the exact tree it passed on", async () => {
    await engine().run("full");
    calls = { vitest: [], python: 0, typecheck: 0 };
    const full = await engine().run("full");
    expect(executedFiles()).toEqual(ALL); // uncached: every file ran again
    expect(full.reused).toEqual({ units: 0, tests: 0 });
    expect(full.fullGate.state).toBe("PASS_CURRENT");
    expect(full.fullGate.units).toBe(7);
    write("src/a.ts", "export const a = 123;");
    expect(engine().status().fullGate.state).toBe("PASS_STALE");
    // incremental runs never create or refresh the gate
    await engine().run("changed");
    expect(engine().status().fullGate.state).toBe("PASS_STALE");
  });

  it("an interrupted full run has no gate until it is completed; resuming it reuses only that run's own verified units", async () => {
    await engine().run("changed"); // older receipts must not count towards the full gate
    batchesSeen = 0;
    interruptAtBatch = 2;
    const partial = await engine().run("full");
    expect(partial.pending.length).toBeGreaterThan(0);
    expect(engine().status().fullGate.state).toBe("NONE");
    interruptAtBatch = null;
    calls = { vitest: [], python: 0, typecheck: 0 };
    const finished = await engine().resume();
    expect(finished!.pending).toEqual([]);
    expect(finished!.fullGate.state).toBe("PASS_CURRENT");
    expect(executedFiles().length).toBeGreaterThan(0);
    expect(executedFiles().length).toBeLessThan(ALL.length); // the batch that finished before the crash was not redone
  });

  it("a failing file fails the gate", async () => {
    failing.add("tests/c.test.ts");
    const s = await engine().run("full");
    expect(s.failed.map((f) => f.unit)).toEqual(["tests/c.test.ts"]);
    expect(s.fullGate.state).toBe("FAILED");
  });

  it("the tree fingerprint changes on any relevant edit and not on irrelevant files", () => {
    const before = treeFingerprint(ctx());
    write("README.md", "docs outside the fingerprinted trees");
    expect(treeFingerprint(ctx())).toBe(before);
    write("src/b.ts", "export const b = 'edit';");
    expect(treeFingerprint(ctx())).not.toBe(before);
  });
});

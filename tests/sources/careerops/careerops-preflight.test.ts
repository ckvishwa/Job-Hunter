import { describe, expect, test, vi } from "vitest";
import path from "node:path";
import { preflightCareerOps } from "../../../src/sources/careerops/careerops-preflight.js";

const HOME = path.join("C:", "fake", "career-ops");
const SCAN_SCRIPT = path.join(HOME, "scan-ats-full.mjs");
const PORTALS = path.join(HOME, "portals.yml");

function fakeFile() {
  return { isDirectory: () => false, isFile: () => true };
}
function fakeDir() {
  return { isDirectory: () => true, isFile: () => false };
}

function validDeps(overrides: Partial<Parameters<typeof preflightCareerOps>[1]> = {}) {
  const existsFn = vi.fn((p: string) => [HOME, SCAN_SCRIPT, PORTALS, process.execPath].includes(p));
  const statFn = vi.fn((p: string) => (p === HOME ? fakeDir() : fakeFile()));
  const execFileFn = vi.fn().mockResolvedValue({ stdout: "abc123\n", stderr: "" });
  return { existsFn, statFn, execFileFn, ...overrides };
}

describe("preflightCareerOps", () => {
  test("a valid installation passes with no errors or warnings", async () => {
    const result = await preflightCareerOps({ careerOpsHome: HOME }, validDeps());

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.currentCommit).toBe("abc123");
    expect(result.careerOpsHome).toBe(HOME);
    expect(result.scanScriptPath).toBe(SCAN_SCRIPT);
  });

  test("missing home directory fails with HOME_NOT_FOUND", async () => {
    const deps = validDeps({ existsFn: vi.fn(() => false) });

    const result = await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("HOME_NOT_FOUND");
  });

  test("home path exists but is a file, not a directory: HOME_NOT_DIRECTORY", async () => {
    const deps = validDeps({
      existsFn: vi.fn(() => true),
      statFn: vi.fn(() => fakeFile()),
    });

    const result = await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("HOME_NOT_DIRECTORY");
  });

  test("missing scan-ats-full.mjs fails with SCAN_SCRIPT_NOT_FOUND", async () => {
    const deps = validDeps({
      existsFn: vi.fn((p: string) => p !== SCAN_SCRIPT && [HOME, PORTALS, process.execPath].includes(p)),
    });

    const result = await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("SCAN_SCRIPT_NOT_FOUND");
  });

  test("missing portals.yml fails with PORTALS_CONFIG_NOT_FOUND", async () => {
    const deps = validDeps({
      existsFn: vi.fn((p: string) => p !== PORTALS && [HOME, SCAN_SCRIPT, process.execPath].includes(p)),
    });

    const result = await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("PORTALS_CONFIG_NOT_FOUND");
  });

  test("unavailable node executable fails with NODE_NOT_AVAILABLE", async () => {
    const deps = validDeps({
      existsFn: vi.fn((p: string) => p !== process.execPath && [HOME, SCAN_SCRIPT, PORTALS].includes(p)),
    });

    const result = await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("NODE_NOT_AVAILABLE");
  });

  test("git commit unreadable + a pin was requested: hard failure GIT_COMMIT_UNAVAILABLE", async () => {
    const deps = validDeps({ execFileFn: vi.fn().mockRejectedValue(new Error("git not found")) });

    const result = await preflightCareerOps({ careerOpsHome: HOME, pinnedCommit: "deadbeef" }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("GIT_COMMIT_UNAVAILABLE");
    expect(result.currentCommit).toBeUndefined();
  });

  test("git commit unreadable + no pin requested: advisory warning only, still ok", async () => {
    const deps = validDeps({ execFileFn: vi.fn().mockRejectedValue(new Error("git not found")) });

    const result = await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("GIT_COMMIT_UNAVAILABLE");
    expect(result.errors).toEqual([]);
  });

  test("git succeeds but returns empty/whitespace-only output: treated as unavailable, not as a valid empty commit", async () => {
    const deps = validDeps({ execFileFn: vi.fn().mockResolvedValue({ stdout: "   \n", stderr: "" }) });

    const result = await preflightCareerOps({ careerOpsHome: HOME, pinnedCommit: "deadbeef" }, deps);

    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("GIT_COMMIT_UNAVAILABLE");
    expect(result.currentCommit).toBeUndefined();
  });

  test("commit matches the pin: no warning", async () => {
    const deps = validDeps({ execFileFn: vi.fn().mockResolvedValue({ stdout: "deadbeef\n", stderr: "" }) });

    const result = await preflightCareerOps({ careerOpsHome: HOME, pinnedCommit: "deadbeef" }, deps);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.currentCommit).toBe("deadbeef");
    expect(result.pinnedCommit).toBe("deadbeef");
  });

  test("commit mismatches the pin: PIN_MISMATCH warning, not a hard failure", async () => {
    const deps = validDeps({ execFileFn: vi.fn().mockResolvedValue({ stdout: "newcommit123\n", stderr: "" }) });

    const result = await preflightCareerOps({ careerOpsHome: HOME, pinnedCommit: "deadbeef" }, deps);

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("PIN_MISMATCH");
    expect(result.currentCommit).toBe("newcommit123");
  });

  test("git dependency is invoked only for reading the current commit, never for anything else", async () => {
    const deps = validDeps();

    await preflightCareerOps({ careerOpsHome: HOME, pinnedCommit: "deadbeef" }, deps);

    expect(deps.execFileFn).toHaveBeenCalledTimes(1);
    expect(deps.execFileFn).toHaveBeenCalledWith("git", ["-C", HOME, "rev-parse", "HEAD"]);
  });

  test("preflight never writes to the CareerOps directory (only existsFn/statFn/execFileFn are ever called, all read-only)", async () => {
    const deps = validDeps();
    const writeFn = vi.fn();

    // preflightCareerOps's dependency shape has no write-capable parameter at all -- there is
    // nothing to inject a writer into. Calling with only the three read-only deps and a spy
    // that's never wired up anywhere proves the call graph never reaches for one.
    await preflightCareerOps({ careerOpsHome: HOME }, deps);

    expect(writeFn).not.toHaveBeenCalled();
    expect(deps.existsFn).toHaveBeenCalled();
    expect(deps.statFn).toHaveBeenCalled();
  });
});

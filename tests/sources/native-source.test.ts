import { describe, expect, test, vi } from "vitest";
import { NativeSource } from "../../src/sources/native-source.js";

const PATHS = {
  sitesConfigPath: "a",
  rolesConfigPath: "b",
  portalsConfigPath: "c",
  discoveredJobsPath: "d",
  jobsStorePath: "e",
  checkpointsPath: "f",
};

describe("NativeSource", () => {
  test("has id 'native'", () => {
    const source = new NativeSource(PATHS, vi.fn());
    expect(source.id).toBe("native");
  });

  test("calls the injected runDiscover with mapped options", async () => {
    const runDiscoverFn = vi.fn().mockResolvedValue({
      sourcesAttempted: 3,
      sourcesSucceeded: 2,
      sourcesFailed: 1,
      errors: [],
    });
    const source = new NativeSource(PATHS, runDiscoverFn);

    await source.discover({ profileIds: ["sdet"], limit: 50, dryRun: true });

    expect(runDiscoverFn).toHaveBeenCalledWith(PATHS, {
      profileIds: ["sdet"],
      limit: 50,
      dryRun: true,
    });
  });

  test("returns an empty jobs array because native already persists via runDiscover", async () => {
    const runDiscoverFn = vi.fn().mockResolvedValue({
      sourcesAttempted: 1,
      sourcesSucceeded: 1,
      sourcesFailed: 0,
      errors: [],
    });
    const source = new NativeSource(PATHS, runDiscoverFn);

    const result = await source.discover({});

    expect(result.jobs).toEqual([]);
  });

  test("maps the summary's source counts and errors into SourceHealth/SourceError", async () => {
    const runDiscoverFn = vi.fn().mockResolvedValue({
      sourcesAttempted: 3,
      sourcesSucceeded: 2,
      sourcesFailed: 1,
      errors: [{ source: "lever::sdet", message: "boom" }],
    });
    const source = new NativeSource(PATHS, runDiscoverFn);

    const result = await source.discover({});

    expect(result.health).toEqual({ attempted: 3, succeeded: 2, failed: 1 });
    expect(result.errors).toEqual([{ source: "lever::sdet", message: "boom" }]);
  });
});

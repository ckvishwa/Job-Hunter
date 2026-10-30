import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadCheckpoints,
  saveCheckpoints,
  getOrCreateCheckpoint,
  buildCheckpointKey,
  resetCheckpoints,
} from "../../src/discovery/checkpoints.js";
import type { DiscoveryCheckpoint } from "../../src/discovery/types.js";

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-test-checkpoint-"));
  const filePath = path.join(dir, name);
  writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

describe("Checkpoints Manager", () => {
  it("loads checkpoints correctly from file", () => {
    const data = {
      "indeed::sdet::us": {
        key: "indeed::sdet::us",
        source: "indeed",
        keyword: "sdet",
        location: "us",
        lastPage: 3,
        completed: false,
        lastUpdated: "2026-01-01",
        sourceJobIds: ["1", "2"],
      },
    };
    const filePath = tempFile("checkpoints.json", JSON.stringify(data));
    const loaded = loadCheckpoints(filePath);
    expect(loaded).toEqual(data);
  });

  it("returns empty object if file does not exist", () => {
    const loaded = loadCheckpoints("non-existent-file-path.json");
    expect(loaded).toEqual({});
  });

  it("saves checkpoints correctly to file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-test-checkpoint-"));
    const filePath = path.join(dir, "checkpoints.json");
    const data = {
      "indeed::sdet::us": {
        key: "indeed::sdet::us",
        source: "indeed",
        keyword: "sdet",
        location: "us",
        lastPage: 3,
        completed: false,
        lastUpdated: "2026-01-01",
        sourceJobIds: ["1", "2"],
      },
    };
    saveCheckpoints(filePath, data);
    const loaded = loadCheckpoints(filePath);
    expect(loaded).toEqual(data);
  });

  it("builds checkpoint keys correctly", () => {
    expect(buildCheckpointKey("Indeed", "SDET", "United States")).toBe("indeed::sdet::united states");
  });

  it("gets or creates checkpoints", () => {
    const checkpoints = {};
    const cp = getOrCreateCheckpoint(checkpoints, "Indeed", "SDET", "US");
    expect(cp.source).toBe("Indeed");
    expect(cp.keyword).toBe("SDET");
    expect(cp.location).toBe("US");
    expect(cp.lastPage).toBe(0);
    expect(cp.completed).toBe(false);
  });

  describe("resetCheckpoints", () => {
    function makeCheckpoints(): Record<string, DiscoveryCheckpoint> {
      const base = {
        lastPage: 0,
        completed: true,
        lastUpdated: "2026-01-01",
        sourceJobIds: [],
      };
      return {
        "indeed::sdet::us": { key: "indeed::sdet::us", source: "indeed", keyword: "sdet", location: "us", ...base },
        "company-careers::sdet::us": {
          key: "company-careers::sdet::us",
          source: "company-careers",
          keyword: "sdet",
          location: "us",
          ...base,
        },
        "company-careers::qa::us": {
          key: "company-careers::qa::us",
          source: "company-careers",
          keyword: "qa",
          location: "us",
          ...base,
        },
      };
    }

    it("clears everything when no source is given", () => {
      const result = resetCheckpoints(makeCheckpoints());
      expect(result).toEqual({});
    });

    it("clears only keys matching the given source, leaving others untouched", () => {
      const original = makeCheckpoints();
      const result = resetCheckpoints(original, "company-careers");
      expect(Object.keys(result)).toEqual(["indeed::sdet::us"]);
      // Does not mutate the input.
      expect(Object.keys(original)).toHaveLength(3);
    });

    it("is case-insensitive on the source prefix", () => {
      const result = resetCheckpoints(makeCheckpoints(), "Company-Careers");
      expect(Object.keys(result)).toEqual(["indeed::sdet::us"]);
    });

    it("returns an empty object unchanged when the source matches nothing", () => {
      const result = resetCheckpoints(makeCheckpoints(), "monster");
      expect(Object.keys(result).sort()).toEqual(["company-careers::qa::us", "company-careers::sdet::us", "indeed::sdet::us"]);
    });
  });
});

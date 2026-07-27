import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadCheckpoints,
  saveCheckpoints,
  getOrCreateCheckpoint,
  buildCheckpointKey,
} from "../../src/discovery/checkpoints.js";

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
});

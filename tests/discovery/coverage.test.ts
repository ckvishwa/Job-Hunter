import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceCoverage } from "../../src/discovery/coverage.js";

describe("source coverage inventory", () => {
  it("keeps the disabled portals disabled and does not claim a live verification", () => {
    const coverage = sourceCoverage(readFileSync("config/portals.yml", "utf8"));
    const google = coverage.sources.find((source) => source.id === "google-jobs");
    expect(google).toMatchObject({ enabled: false, verifiedThisRun: false });
    expect(coverage.sources.find((source) => source.id === "greenhouse")).toMatchObject({ implemented: true, enabled: true, verifiedThisRun: false });
    expect(coverage.verifiedLiveThisRun).toBe(0);
  });
});

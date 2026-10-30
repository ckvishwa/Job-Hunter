import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { CareerOpsSource } from "../../../src/sources/careerops/careerops-source.js";
import type { CareerOpsRunResult } from "../../../src/sources/careerops/careerops-runner.js";
import { loadRolesConfig } from "../../../src/config/loader.js";
import { UNRESOLVED_PLACEHOLDER_PREFIX } from "../../../src/discovery/resolve-phase.js";

const FIXTURE_PATH = new URL("../../fixtures/careerops/scan-ats-full.json", import.meta.url);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
const roles = loadRolesConfig(path.resolve("config/roles.yml"));

function successResult(offers: unknown[]): CareerOpsRunResult {
  return {
    kind: "success",
    stderr: "",
    preflight: { ok: true, careerOpsHome: "C:/fake/career-ops", errors: [], warnings: [] },
    result: {
      date: "2026-07-29",
      sources: ["greenhouse", "lever", "workday"],
      resumed: false,
      sinceDays: 7,
      companiesAvailable: 1,
      companiesScanned: 1,
      capHit: false,
      datasetStatus: {},
      postingsKept: offers.length,
      postingsDroppedNoDate: 0,
      postingsFilteredBlacklist: 0,
      postingsAnnotatedBlacklisted: 0,
      postingsDroppedContent: 0,
      unreachableBoards: 0,
      cappedBoards: 0,
      saved: false,
      offers,
    } as never,
  };
}

describe("CareerOpsSource", () => {
  test("has id 'careerops'", () => {
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn: vi.fn() });
    expect(source.id).toBe("careerops");
  });

  test("a runner failure (preflight/spawn/timeout/etc.) never throws -- returns jobs:[] with a reported error", async () => {
    const runScanFn = vi.fn().mockResolvedValue({ kind: "empty-stdout", stderr: "" } satisfies CareerOpsRunResult);
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({});

    expect(result.jobs).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.source).toBe("careerops");
  });

  test("valid, relevant offers are mapped, classified by our own evaluateRelevance, and returned as unresolved placeholders", async () => {
    const runScanFn = vi.fn().mockResolvedValue(successResult(fixture.offers));
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({});

    const cyber = result.jobs.find((j) => j.title === "Cybersecurity Engineer");
    expect(cyber).toBeDefined();
    expect(cyber!.matchedProfiles).toContain("security"); // via our evaluateRelevance, not CareerOps
    expect(cyber!.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)).toBe(true); // not fabricated
    expect(cyber!.location).toBe("Remote · 10a Labs");
  });

  test("irrelevant titles (no profile match) are dropped, matching relevance.ts's documented false-positive guard", async () => {
    const runScanFn = vi.fn().mockResolvedValue(successResult(fixture.offers));
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({});

    expect(result.jobs.find((j) => j.title === "Corporate Security Guard")).toBeUndefined();
    expect(result.jobs.find((j) => j.title === "Assistant Chief Engineer")).toBeUndefined();
  });

  test("a --profile filter narrows to only the requested profile's matches", async () => {
    const runScanFn = vi.fn().mockResolvedValue(successResult(fixture.offers));
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({ profileIds: ["sdet"] });

    expect(result.jobs.every((j) => j.matchedProfiles.includes("sdet"))).toBe(true);
    expect(result.jobs.find((j) => j.title === "Cybersecurity Engineer")).toBeUndefined(); // security-only
  });

  test("one invalid/malformed offer does not stop the surrounding valid, relevant offers", async () => {
    const runScanFn = vi.fn().mockResolvedValue(successResult(fixture.offers)); // fixture has 3 invalid records
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({});

    expect(result.jobs.length).toBeGreaterThan(0);
    expect(result.health.failed).toBeGreaterThan(0); // the invalid records are counted
  });

  test("no description is fabricated -- every returned job's descriptionText is the existing unresolved-placeholder convention", async () => {
    const runScanFn = vi.fn().mockResolvedValue(successResult(fixture.offers));
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({});

    expect(result.jobs.length).toBeGreaterThan(0);
    for (const job of result.jobs) {
      expect(job.descriptionText.startsWith(UNRESOLVED_PLACEHOLDER_PREFIX)).toBe(true);
      expect(job.remoteType).toBeNull(); // never inferred
    }
  });

  test("null location maps to JobPosting.location: null, never a fabricated value", async () => {
    const runScanFn = vi.fn().mockResolvedValue(successResult(fixture.offers));
    const source = new CareerOpsSource({ careerOpsHome: "C:/fake/career-ops", roles, runScanFn });

    const result = await source.discover({});

    const sdet2 = result.jobs.find((j) => j.title === "SDET II"); // fixture's location:null record
    expect(sdet2).toBeDefined();
    expect(sdet2!.location).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { computeFreshness } from "../../src/hunt/freshness.js";

const DAY_MS = 86_400_000;

describe("computeFreshness", () => {
  it("treats everything as new on the very first (bootstrap) run", () => {
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", postingDate: null },
      { now: "2026-01-01T00:00:00.000Z", previousHuntAt: null, staleDays: 14 },
    );
    expect(result.isNew).toBe(true);
    expect(result.isUpdated).toBe(false);
    expect(result.isStale).toBe(false);
  });

  it("marks a job discovered after the previous hunt as new", () => {
    const result = computeFreshness(
      { discoveredAt: "2026-01-05T00:00:00.000Z", lastSeenAt: "2026-01-05T00:00:00.000Z", postingDate: null },
      { now: "2026-01-05T00:00:00.000Z", previousHuntAt: "2026-01-04T00:00:00.000Z", staleDays: 14 },
    );
    expect(result.isNew).toBe(true);
  });

  it("marks a job discovered before the previous hunt, but seen again since, as updated (not new)", () => {
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-05T00:00:00.000Z", postingDate: null },
      { now: "2026-01-05T00:00:00.000Z", previousHuntAt: "2026-01-04T00:00:00.000Z", staleDays: 14 },
    );
    expect(result.isNew).toBe(false);
    expect(result.isUpdated).toBe(true);
  });

  it("marks a job neither newly discovered nor re-seen since the previous hunt as neither new nor updated", () => {
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-02T00:00:00.000Z", postingDate: null },
      { now: "2026-01-05T00:00:00.000Z", previousHuntAt: "2026-01-04T00:00:00.000Z", staleDays: 14 },
    );
    expect(result.isNew).toBe(false);
    expect(result.isUpdated).toBe(false);
  });

  it("computes postingAgeDays from postingDate when available", () => {
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", postingDate: "2026-01-01T00:00:00.000Z" },
      { now: new Date(Date.parse("2026-01-01T00:00:00.000Z") + 5 * DAY_MS).toISOString(), previousHuntAt: null, staleDays: 14 },
    );
    expect(result.postingAgeDays).toBe(5);
  });

  it("never fabricates postingAgeDays when postingDate is absent", () => {
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", postingDate: null },
      { now: "2026-01-05T00:00:00.000Z", previousHuntAt: null, staleDays: 14 },
    );
    expect(result.postingAgeDays).toBeNull();
  });

  it("marks a job stale when lastSeenAt is older than staleDays before now", () => {
    const now = new Date(Date.parse("2026-01-01T00:00:00.000Z") + 20 * DAY_MS).toISOString();
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", postingDate: null },
      { now, previousHuntAt: "2025-12-31T00:00:00.000Z", staleDays: 14 },
    );
    expect(result.isStale).toBe(true);
  });

  it("does not mark a job stale when lastSeenAt is within staleDays of now", () => {
    const now = new Date(Date.parse("2026-01-01T00:00:00.000Z") + 5 * DAY_MS).toISOString();
    const result = computeFreshness(
      { discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", postingDate: null },
      { now, previousHuntAt: null, staleDays: 14 },
    );
    expect(result.isStale).toBe(false);
  });
});

import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadHuntState, saveHuntState } from "../../src/hunt/hunt-state.js";

const TMP_DIR = path.resolve("tests/hunt/.tmp-hunt-state");
const STATE_PATH = path.join(TMP_DIR, "hunt-state.json");

afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("hunt-state", () => {
  it("returns an empty state when the file doesn't exist", () => {
    const state = loadHuntState(STATE_PATH);
    expect(state).toEqual({ lastSuccessfulHuntAt: {} });
  });

  it("round-trips a saved state", () => {
    mkdirSync(TMP_DIR, { recursive: true });
    saveHuntState(STATE_PATH, { lastSuccessfulHuntAt: { sdet: "2026-01-01T00:00:00.000Z", "*": "2026-01-02T00:00:00.000Z" } });
    const loaded = loadHuntState(STATE_PATH);
    expect(loaded.lastSuccessfulHuntAt.sdet).toBe("2026-01-01T00:00:00.000Z");
    expect(loaded.lastSuccessfulHuntAt["*"]).toBe("2026-01-02T00:00:00.000Z");
  });

  it("creates the parent directory on save if missing", () => {
    saveHuntState(STATE_PATH, { lastSuccessfulHuntAt: { security: "2026-01-01T00:00:00.000Z" } });
    expect(existsSync(STATE_PATH)).toBe(true);
  });
});

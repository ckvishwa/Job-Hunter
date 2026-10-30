import { describe, expect, test } from "vitest";
import { RENAMED_MIGRATIONS, aliasRenamedMigrations } from "../../src/db/migrate.js";

describe("renamed migrations (ADR-0005)", () => {
  test("a database that recorded the old M4 name is treated as having applied the renamed file", () => {
    const recorded = new Map([["0006_m4_decision_intelligence", "abc"], ["0001_s1_candidate", "def"]]);
    const moved = aliasRenamedMigrations(recorded);
    expect(moved).toEqual([["0006_m4_decision_intelligence", "0012_m4_decision_intelligence"]]);
    expect(recorded.get("0012_m4_decision_intelligence")).toBe("abc");
    expect(recorded.has("0006_m4_decision_intelligence")).toBe(false);
  });

  test("nothing moves when the new name is already recorded or the old name is absent", () => {
    const both = new Map([["0006_m4_decision_intelligence", "abc"], ["0012_m4_decision_intelligence", "abc"]]);
    expect(aliasRenamedMigrations(both)).toEqual([]);
    expect(aliasRenamedMigrations(new Map())).toEqual([]);
    expect(Object.keys(RENAMED_MIGRATIONS)).toEqual(["0012_m4_decision_intelligence"]);
  });
});

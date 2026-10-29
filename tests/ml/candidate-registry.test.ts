import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CANDIDATES } from "../../src/ml/artifact.js";

// Regression: `{"ok": false, "error": "unknown candidate tfidf"}` came from the TypeScript, Python and database candidate lists drifting apart.
describe("candidate registry", () => {
  const py = readFileSync("services/ml/ml_common.py", "utf8");
  it("TypeScript and Python accept exactly the same candidate names", () => {
    const m = /^CANDIDATES = \(([^)]*)\)/m.exec(py);
    expect(m).not.toBeNull();
    const pyNames = [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect([...CANDIDATES]).toEqual(pyNames);
  });
  it("the latest migration that defines ml_models_candidate_check allows every candidate", () => {
    const sql = readFileSync("db/migrations/0010_ml_evidence_integrity.sql", "utf8");
    const m = /ml_models_candidate_check\s+CHECK \(candidate IN \(([^)]*)\)\)/.exec(sql);
    expect(m).not.toBeNull();
    const dbNames = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(dbNames.sort()).toEqual([...CANDIDATES].sort());
  });
});

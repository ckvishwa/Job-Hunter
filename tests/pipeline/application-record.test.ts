import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { saveApplicationRecord } from "../../src/pipeline/run.js";

describe("durable ready application record", () => {
  it("refuses to mask a changed profile with a stale READY record", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "application-record-")), "application.json");
    const ready = { applicationKey: "one", jdHash: "a", profileDigest: "p1", decisionId: "d1", artifactSha256: "r1", outcome: "READY_TO_SUBMIT" };
    await saveApplicationRecord(file, ready);
    await expect(saveApplicationRecord(file, { ...ready, profileDigest: "p2", outcome: "WAITING_FOR_USER" })).rejects.toThrow("STALE_READY_RECORD");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(ready);
  });
});

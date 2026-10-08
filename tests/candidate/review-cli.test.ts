import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCandidateReview } from "../../src/candidate/review-cli.js";
import { fact, profile } from "../helpers/decision-fixtures.js";

describe("private candidate review CLI", () => {
  it("writes a redacted packet and applies only a supplied individual decision", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "candidate-review-"));
    const input = path.join(dir, "profile.json");
    const packet = path.join(dir, "packet.json");
    const decisions = path.join(dir, "decisions.json");
    const output = path.join(dir, "reviewed.json");
    writeFileSync(input, JSON.stringify(profile([fact({ factId: "secret", kind: "skill", value: "Synthetic secret", pending: true })])));
    expect(runCandidateReview({ profilePath: input, packetPath: packet, asOf: "2026-10-08" })).toBe(0);
    expect(readFileSync(packet, "utf8")).not.toContain("Synthetic secret");
    writeFileSync(decisions, JSON.stringify({ factId: "secret", action: "approve", reviewer: "candidate", reviewedAt: "2026-10-08" }));
    expect(runCandidateReview({ profilePath: input, decisionPath: decisions, outputPath: output, asOf: "2026-10-08" })).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).facts[0].approvalStatus).toBe("approved");
    expect(() => runCandidateReview({ profilePath: input, decisionPath: decisions, outputPath: output, asOf: "2026-10-08" })).toThrow();
  });
});

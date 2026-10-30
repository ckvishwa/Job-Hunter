import { describe, expect, it } from "vitest";
import { HUMAN_LABELS, MIN_INDEPENDENT_LABELS, prepareLearningSet, type LearningJob } from "../../src/learning/labels.js";
import { evaluateShadow, shadowRelevance } from "../../src/learning/shadow.js";
import type { RoleConfig } from "../../src/types.js";

const roles = [{ profile: "sdet", keywords: ["SDET"] }] as RoleConfig[];

function job(id: string, employer: string, title: string, at: string, source = "greenhouse"): LearningJob {
  return { jobId: id, employer, title, location: "Remote", jdSha256: `hash-${id}`, capturedAt: at, source };
}

function label(id: string, value: string, at: string, origin = "human") {
  return {
    jobId: id,
    jdSha256: `hash-${id}`,
    queryProvenance: { searchRunId: "run", source: "greenhouse", keyword: "analyst" },
    label: value,
    reason: "reviewed the description",
    labeledAt: at,
    labeler: origin === "human" ? "owner" : "agent",
    origin,
  };
}

describe("learning labels", () => {
  it("rejects scenario-authored labels and withholds training when independent labels are scarce", () => {
    const jobs = [job("a", "Acme", "SDET", "2026-01-01T00:00:00.000Z")];
    const manifest = prepareLearningSet([
      label("a", "RELEVANT", "2026-01-02T00:00:00.000Z", "scenario-authored"),
      label("missing", "IRRELEVANT", "2026-01-03T00:00:00.000Z"),
    ], jobs);
    expect(manifest.status).toBe("WITHHELD");
    expect(manifest.m4ScenarioLabelsUsedAsTruth).toBe(false);
    expect(manifest.heldoutFrozen).toBe(false);
    expect(manifest.rejectedScenarioLabels).toBe(1);
    expect(manifest.trainIds).toEqual([]);
    expect(evaluateShadow(manifest, new Map(), []).status).toBe("WITHHELD");
  });

  it("dedupes near-identical postings and reports employer overlap on a frozen split", () => {
    const jobs: LearningJob[] = [];
    const labels = [];
    for (let index = 0; index < MIN_INDEPENDENT_LABELS; index += 1) {
      const employer = index === 0 || index === MIN_INDEPENDENT_LABELS - 1 ? "Shared Co" : `Employer ${index}`;
      const id = `job-${index}`;
      jobs.push(job(id, employer, `Title ${index}`, `2026-02-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`, index % 2 === 0 ? "greenhouse" : "lever"));
      labels.push(label(id, index % 2 === 0 ? "RELEVANT" : "IRRELEVANT", `2026-04-01T00:${String(index).padStart(2, "0")}:00.000Z`));
    }
    jobs.push(job("dup", "Employer 3", "Title 3", "2026-04-01T00:00:00.000Z"));
    labels.push(label("dup", "ADJACENT", "2026-04-02T00:00:00.000Z"));
    const manifest = prepareLearningSet(labels, jobs);
    expect(manifest.status).toBe("READY");
    expect(manifest.rejectedDuplicates).toBe(1);
    expect(manifest.heldoutFrozen).toBe(true);
    expect(manifest.heldoutSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set([...manifest.trainIds, ...manifest.heldoutIds]).size).toBe(manifest.trainIds.length + manifest.heldoutIds.length);
    expect(manifest.leakage.employers).toEqual(["shared co"]);
    expect(manifest.leakage.sources.length).toBeGreaterThan(0);
    expect(manifest.leakage.chronological).toBe(false);
    expect(HUMAN_LABELS).toContain("UNSURE");
  });

  it("does not hard-reject an uncertain or unlikely listing", () => {
    expect(shadowRelevance({ jobId: "1", title: "" }, roles).hardReject).toBe(false);
    expect(shadowRelevance({ jobId: "2", title: "Account Executive" }, roles)).toMatchObject({ band: "UNLIKELY", hardReject: false });
    expect(shadowRelevance({ jobId: "3", title: "SDET II" }, roles)).toMatchObject({ band: "LIKELY", hardReject: false });
  });
});

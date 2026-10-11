import { describe, expect, it } from "vitest";
import { GOLD_SCHEMA, buildPool, freezeSplit, goldFileSchema, scoreRun, validateGold, verifySplit, type SystemRun } from "../../src/match/gold.js";
import { SYNTHETIC_JD, makeJob } from "./helpers.js";

// The numbers in this file check the SCORING MATH on tiny hand-made label files. They are test fixtures, not evaluation results, and they are
// never reported as accuracy. Real accuracy exists only for a real independent human label file (see docs/S4A-MATCHING.md).

const pool = buildPool([makeJob(SYNTHETIC_JD)]);
const split = freezeSplit(pool, "2026-10-11T00:00:00.000Z");

const labels = (over: Record<string, unknown> = {}) => ({
  schema: GOLD_SCHEMA, independent: true, labeledBy: "Test Person", labeledAt: "2026-10-12", splitManifestSha256: split.manifestSha256,
  items: pool.map((p) => ({ itemKey: p.itemKey, requirements: [] })), conditions: [], evidence: [], ...over,
});

describe("gold-set workflow", () => {
  it("builds the pool from source items only, deterministically", () => {
    expect(pool.length).toBeGreaterThanOrEqual(8);
    expect(buildPool([makeJob(SYNTHETIC_JD)])).toEqual(pool);
    for (const p of pool) expect(SYNTHETIC_JD.slice(p.start, p.end)).toBe(p.quote);
    expect(pool.every((p) => /^[0-9a-f]{8}:\d+$/.test(p.itemKey))).toBe(true);
  });

  it("freezes a deterministic, disjoint, complete split that detects tampering and does not depend on any extractor", () => {
    expect(freezeSplit(pool, "2026-10-11T00:00:00.000Z")).toEqual(split);
    expect(new Set([...split.development, ...split.heldOut]).size).toBe(pool.length);
    expect(split.development.filter((k) => split.heldOut.includes(k))).toEqual([]);
    expect(verifySplit(split)).toBe(true);
    expect(verifySplit({ ...split, heldOut: [...split.heldOut, "x:1"] })).toBe(false);
  });

  it("refuses to evaluate without an independent, human, complete label file bound to the frozen split", () => {
    expect(validateGold(labels(), split, "heldOut")).toMatchObject({ ok: true });
    const problems = (raw: unknown) => { const r = validateGold(raw, split, "heldOut"); return r.ok ? [] : r.problems.map((p) => p.code); };
    expect(problems({ ...labels(), independent: false })).toEqual(["NOT_A_GOLD_FILE"]);
    expect(problems(labels({ labeledBy: "Qwen2.5 model" }))).toContain("NOT_HUMAN_LABELLED");
    expect(problems(labels({ labeledBy: "Claude" }))).toContain("NOT_HUMAN_LABELLED");
    expect(problems(labels({ splitManifestSha256: "a".repeat(64) }))).toContain("SPLIT_MISMATCH");
    expect(problems(labels({ items: pool.map((p) => ({ itemKey: p.itemKey, requirements: null })) }))).toContain("INCOMPLETE");
    // the template a labeller starts from cannot be scored until a person fills it in
    expect(goldFileSchema.safeParse({ ...labels(), independent: false }).success).toBe(false);
  });

  it("computes extraction, level, retrieval, false-support, eligibility and negation metrics from labels (math check)", () => {
    const [a, b, c] = pool.filter((p) => split.heldOut.includes(p.itemKey)).slice(0, 3);
    if (!a || !b || !c) throw new Error("test JD must put at least three items in the held-out split");
    const items = pool.map((p) => ({ itemKey: p.itemKey, requirements: p.itemKey === a.itemKey ? [{ value: "Splunk", level: "required" as const }] : p.itemKey === b.itemKey ? [{ value: "Python", level: "preferred" as const }, { value: "Go", level: "required" as const }] : [] }));
    const gold = goldFileSchema.parse(labels({
      items, conditions: [{ jdSha256: pool[0]!.jdSha256, citizenship: "required", clearance: "unknown", work_authorization: "required", sponsorship: "not_offered" }],
      evidence: [{ itemKey: a.itemKey, requirementValue: "Splunk", relevantFactIds: ["f1"] }, { itemKey: b.itemKey, requirementValue: "Python", relevantFactIds: ["f2"] }],
    }));
    const run: SystemRun = {
      requirements: [
        { itemKey: a.itemKey, value: "Splunk", level: "required", minimumYears: null, yearsKind: "none", negated: false },
        { itemKey: b.itemKey, value: "Python", level: "required", minimumYears: null, yearsKind: "none", negated: false }, // wrong level
        { itemKey: c.itemKey, value: "Rust", level: "required", minimumYears: null, yearsKind: "none", negated: false }, // not in the gold set
      ],
      conditions: [{ jdSha256: pool[0]!.jdSha256, citizenship: "required", clearance: "unknown", work_authorization: "unknown", sponsorship: "not_offered" }],
      decisions: [
        { itemKey: a.itemKey, requirementValue: "Splunk", status: "SUPPORTED", matchedFactIds: ["f1"] },
        { itemKey: b.itemKey, requirementValue: "Python", status: "SUPPORTED", matchedFactIds: ["f9"] }, // supported by a fact a person says is not relevant
      ],
      retrieval: [
        { itemKey: a.itemKey, requirementValue: "Splunk", methods: { lexical: ["f1"], semantic: ["fx", "f1"] } },
        { itemKey: b.itemKey, requirementValue: "Python", methods: { lexical: ["fz"], semantic: ["f2"] } },
      ],
    };
    const m = scoreRun(gold, [a.itemKey, b.itemKey, c.itemKey], run);
    expect(m.extraction).toMatchObject({ truePositives: 2, system: 3, gold: 3, precision: 0.6667, recall: 0.6667, f1: 0.6667 });
    expect(m.levelAccuracy).toBe(0.5);
    expect(m.retrieval.lexical).toEqual({ requirements: 2, recallAt5: 0.5, mrr: 0.5 });
    expect(m.retrieval.semantic).toEqual({ requirements: 2, recallAt5: 1, mrr: 0.75 });
    expect(m.falseSupportRate).toBe(0.5);
    expect(m.unsupportedClaimRate).toBe(0);
    expect(m.eligibilityErrors).toEqual({ checked: 4, wrong: 1, rate: 0.25 });
  });
});

describe("review status", () => {
  it("reports NOT_EVALUATED with no labels, AI-labelled files and partial files, and ELIGIBLE only for a complete human file", async () => {
    const { goldStatus, parseSplitName } = await import("../../src/match/gold.js");
    expect(parseSplitName("dev")).toBe("development");
    expect(parseSplitName("heldout")).toBe("heldOut");
    expect(parseSplitName("both")).toBeNull();
    const none = goldStatus(split, null);
    expect(none).toMatchObject({ labelFile: "NONE", splitOk: true });
    expect(none.development.metrics).toBe("NOT_EVALUATED");
    expect(none.heldOut.unlabelled.length).toBe(split.heldOut.length);
    const ai = goldStatus(split, labels({ labeledBy: "Qwen2.5 agent" }));
    expect(ai.heldOut.metrics).toBe("NOT_EVALUATED");
    expect(ai.heldOut.reasons.join(" ")).toMatch(/NOT_HUMAN_LABELLED/);
    // only the held-out items are labelled: held-out becomes eligible, development stays NOT_EVALUATED
    const partial = labels({ items: pool.map((p) => ({ itemKey: p.itemKey, requirements: split.heldOut.includes(p.itemKey) ? [] : null })) });
    const st = goldStatus(split, partial);
    expect(st.heldOut.metrics).toBe(split.heldOut.length ? "ELIGIBLE" : "NOT_EVALUATED");
    if (split.development.length) expect(st.development.metrics).toBe("NOT_EVALUATED");
    expect(goldStatus(split, { nonsense: true }).labelFile).toBe("INVALID");
    expect(goldStatus({ ...split, heldOut: [...split.heldOut, "x:1"] }, null).splitOk).toBe(false);
  });
});

describe("posting freshness policy", () => {
  it("never claims a stored posting is open today", async () => {
    const { postingFreshness } = await import("../../src/match/store.js");
    const now = new Date("2026-10-11T12:00:00Z");
    expect(postingFreshness("2026-10-10T12:00:00Z", now)).toMatchObject({ state: "RECENT", ageDays: 1 });
    expect(postingFreshness("2026-10-11T11:00:00Z", now).note).toMatch(/may have closed/);
    expect(postingFreshness("2026-09-01T00:00:00Z", now)).toMatchObject({ state: "STALE" });
    expect(postingFreshness("2026-09-01T00:00:00Z", now).note).toMatch(/refresh before relying/);
    expect(postingFreshness(null, now)).toMatchObject({ state: "UNKNOWN", ageDays: null });
    expect(postingFreshness("garbage", now).state).toBe("UNKNOWN");
  });
});

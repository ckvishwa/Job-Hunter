import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { binaryMetrics, bestF1Threshold, calibration, precisionAtK, recallAtK } from "../../src/ml/metrics.js";
import { buildDataset, sufficiency, type LabeledPair } from "../../src/ml/split.js";
import { breakLongRuns, GATES, jdPassages, labelInput, MAX_PASSAGES, MAX_RUN_CHARS, PASSAGE_CHARS } from "../../src/ml/types.js";
import { mlMode } from "../../src/ml/workflows.js";
import { FEATURE_REVISION } from "../../src/ml/features.js";

const pair = (company: string, n: number, rel: LabeledPair["relevance"] = "relevant", role = "soc-analyst", sha?: string): LabeledPair & { currentTextSha256: string } => {
  const s = sha ?? `${company}${n}`.padEnd(64, "a").replace(/[^a-f0-9]/g, "a").slice(0, 64);
  return { postingId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, roleSlug: role, textSha256: s, currentTextSha256: s, company, relevance: rel, seniority: null, workMode: null, labelIds: [n] };
};

describe("labels are human, job-role pair level", () => {
  const base = { postingId: "00000000-0000-4000-8000-000000000001", textSha256: "a".repeat(64), reviewer: "tester", sessionId: "s1", selectionBasis: "unit" };
  it("requires a role for relevance and false-positive labels", () => {
    expect(labelInput.safeParse({ ...base, task: "relevance", value: "relevant" }).success).toBe(false);
    expect(labelInput.safeParse({ ...base, task: "relevance", value: "relevant", roleSlug: "soc-analyst" }).success).toBe(true);
    expect(labelInput.safeParse({ ...base, task: "false_positive_admission", value: "true" }).success).toBe(false);
  });
  it("accepts seniority/work-mode assessments without a role and rejects unknown values and unknown keys", () => {
    expect(labelInput.safeParse({ ...base, task: "seniority", value: "entry" }).success).toBe(true);
    expect(labelInput.safeParse({ ...base, task: "work_mode", value: "remote" }).success).toBe(true);
    expect(labelInput.safeParse({ ...base, task: "work_mode", value: "moon" }).success).toBe(false);
    expect(labelInput.safeParse({ ...base, task: "relevance", roleSlug: "x", value: "maybe" }).success).toBe(false);
    // there is no way to say a label came from a model or a rule
    expect(labelInput.safeParse({ ...base, task: "relevance", roleSlug: "x", value: "relevant", labelSource: "model" }).success).toBe(false);
    expect(labelInput.safeParse({ ...base, reviewer: "  ", task: "relevance", roleSlug: "x", value: "relevant" }).success).toBe(false);
  });
});

describe("employer-grouped frozen split", () => {
  const companies = Array.from({ length: 30 }, (_, i) => `Employer${i}`);
  const labeled = companies.flatMap((c, i) => [pair(c, i * 10 + 1), pair(c, i * 10 + 2, "irrelevant")]);

  it("never puts one employer on both sides and is independent of input order", () => {
    const a = buildDataset(labeled, "salt", new Map());
    const b = buildDataset([...labeled].reverse(), "salt", new Map());
    expect(b.items.map((i) => `${i.postingId}${i.split}`)).toEqual(a.items.map((i) => `${i.postingId}${i.split}`));
    expect(b.splitHash).toBe(a.splitHash);
    const sides = new Map<string, Set<string>>();
    for (const it of a.items) sides.set(it.company, (sides.get(it.company) ?? new Set()).add(it.split));
    expect([...sides.values()].every((s) => s.size === 1)).toBe(true);
    expect(a.counts.heldout.relevant + a.counts.train.relevant).toBe(30);
    expect(a.counts.groups.heldout).toBeGreaterThan(0);
  });
  it("keeps an earlier held-out employer held out even when the salt changes", () => {
    const first = buildDataset(labeled, "salt", new Map());
    const prior = new Map(first.items.map((i) => [i.company.toLowerCase(), i.split] as const));
    const second = buildDataset(labeled, "different-salt", prior);
    for (const it of second.items) expect(it.split).toBe(prior.get(it.company.toLowerCase()));
  });
  it("merges employers that share a near-duplicate JD family so the template cannot leak across the split", () => {
    const links: Array<[string, string]> = [["Employer1", "Employer2"], ["Employer2", "Employer3"]];
    const built = buildDataset(labeled, "salt", new Map(), links);
    const side = new Set(built.items.filter((i) => ["Employer1", "Employer2", "Employer3"].includes(i.company)).map((i) => i.split));
    expect(side.size).toBe(1);
    expect(new Set(built.items.filter((i) => ["Employer1", "Employer2", "Employer3"].includes(i.company)).map((i) => i.groupKey)).size).toBe(1);
  });
  it("excludes stale labels and duplicate pair text instead of silently using them", () => {
    const stale = { ...pair("EmployerX", 900), currentTextSha256: "b".repeat(64) };
    const dupA = pair("EmployerY", 901, "relevant", "soc-analyst", "c".repeat(64));
    const dupB = pair("EmployerZ", 902, "relevant", "soc-analyst", "c".repeat(64));
    const built = buildDataset([stale, dupA, dupB], "salt", new Map());
    expect(built.excluded.map((e) => e.reason).sort()).toEqual(["DUPLICATE_PAIR_TEXT", "STALE_LABEL"]);
    expect(built.items).toHaveLength(1);
  });
  it("keeps adjacent and unsure out of the binary sufficiency counts but still counts them", () => {
    const built = buildDataset([pair("A", 1, "adjacent"), pair("B", 2, "unsure")], "salt", new Map());
    const total = (s: "train" | "heldout") => Object.values(built.counts[s]).reduce((x, y) => x + y, 0);
    expect(total("train") + total("heldout")).toBe(2);
    const suff = sufficiency(built.counts);
    expect(suff.ok).toBe(false);
  });
  it("sufficiency is satisfied only with enough independent positives and negatives on both sides and enough held-out employers", () => {
    const rich = Array.from({ length: 60 }, (_, i) => `Org${i}`).flatMap((c, i) => Array.from({ length: 4 }, (_, k) => pair(c, i * 10 + k, k % 2 === 0 ? "relevant" : "irrelevant")));
    const built = buildDataset(rich, "salt", new Map());
    expect(built.counts.train.relevant).toBeGreaterThanOrEqual(GATES.minTrainPerClass);
    expect(sufficiency(built.counts)).toEqual({ ok: true });
  });
});

describe("metrics (hand-computed)", () => {
  const rows = [
    { score: 0.9, label: true }, { score: 0.8, label: true }, { score: 0.7, label: false }, { score: 0.4, label: true }, { score: 0.3, label: false }, { score: 0.1, label: false },
  ];
  it("precision/recall/F1/FPR at 0.5", () => {
    const m = binaryMetrics(rows, 0.5);
    expect([m.tp, m.fp, m.fn, m.tn]).toEqual([2, 1, 1, 2]);
    expect(m.precision).toBeCloseTo(2 / 3);
    expect(m.recall).toBeCloseTo(2 / 3);
    expect(m.f1).toBeCloseTo(2 / 3);
    expect(m.falsePositiveRate).toBeCloseTo(1 / 3);
  });
  it("precision@k / recall@k and undefined when there is nothing to divide by", () => {
    expect(precisionAtK(rows, 2)).toBe(1);
    expect(precisionAtK(rows, 3)).toBeCloseTo(2 / 3);
    expect(recallAtK(rows, 3)).toBeCloseTo(2 / 3);
    expect(binaryMetrics([], 0.5).precision).toBeNull();
    expect(recallAtK([{ score: 1, label: false }], 1)).toBeNull();
  });
  it("threshold is chosen on the rows given only", () => {
    expect(bestF1Threshold(rows)).toBe(0.4);
  });
  it("brier and ECE", () => {
    const c = calibration([{ score: 1, label: true }, { score: 0, label: false }]);
    expect(c.brier).toBe(0);
    expect(c.ece).toBe(0);
    expect(calibration([{ score: 0.9, label: false }]).brier).toBeCloseTo(0.81);
  });
});

describe("JD passages are bounded and truncation is reported", () => {
  it("packs paragraphs and flags text beyond the cap instead of silently dropping it", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(150)).join("\n\n");
    const { passages, truncated } = jdPassages(long);
    expect(passages.length).toBe(MAX_PASSAGES);
    expect(passages.every((p) => p.length <= PASSAGE_CHARS)).toBe(true);
    expect(truncated).toBe(true);
    expect(jdPassages("Short posting text.").truncated).toBe(false);
    expect(jdPassages("").passages).toEqual([]);
  });
});

describe("over-long unspaced runs (URLs, unspaced CJK text) are split so the encoder never sees one huge token", () => {
  it("cuts runs longer than the limit without losing characters, and leaves ordinary text alone", () => {
    const run = "あ".repeat(200);
    const out = breakLongRuns(`hello ${run} world`);
    expect(out.split(" ").every((p) => Array.from(p).length <= MAX_RUN_CHARS)).toBe(true);
    expect(out.replace(/ /g, "")).toBe(`hello${run}world`);
    expect(breakLongRuns("ordinary words stay as they are")).toBe("ordinary words stay as they are");
    expect(jdPassages(`intro

https://x.example/${"a".repeat(300)}`).passages.join(" ").split(" ").every((p) => p.length <= MAX_RUN_CHARS)).toBe(true);
  });
});

describe("feature flag and isolation", () => {
  it("defaults to off; only 'shadow' enables shadow mode; there is no mode that ranks or filters", () => {
    expect(mlMode({})).toBe("off");
    expect(mlMode({ JH_ML_MODE: "shadow" })).toBe("shadow");
    expect(mlMode({ JH_ML_MODE: "on" })).toBe("off");
    expect(mlMode({ JH_ML_MODE: "rank" })).toBe("off");
  });
  it("the ML modules import nothing that touches candidate facts, application packets, ATS forms or submission", () => {
    const dir = path.resolve("src", "ml");
    const forbidden = [/candidate\//, /candidate-repo/, /profile-repo/, /packet\//, /adapters\//, /tracker\//, /decision\//, /browser\//, /submit/i];
    // fact-feedback.ts / facts-cli.ts are the résumé-review feedback tool (a different task); job-relevance code must not import candidate data.
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !["fact-feedback.ts", "facts-cli.ts"].includes(x))) {
      const imports = readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => /^\s*import /.test(l));
      for (const line of imports) for (const re of forbidden) expect(`${f}: ${line}`, `${f} must not import ${re}`).not.toMatch(re);
    }
  });
  it("feature revision is pinned", () => {
    expect(FEATURE_REVISION).toBe("ml-features@3-full-text");
  });
});

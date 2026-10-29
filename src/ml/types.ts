import { createHash } from "node:crypto";
import { z } from "zod";

// ML engine V1 vocabulary. Labels come only from a named human reviewer; nothing in this module can produce one from a model or a rule.

export const RELEVANCE = ["relevant", "irrelevant", "adjacent", "unsure"] as const;
export type Relevance = (typeof RELEVANCE)[number];
export const SENIORITY = ["entry", "junior", "mid", "senior", "unclear"] as const;

export const WORK_MODES = ["remote", "hybrid", "onsite", "unclear"] as const;
export const LABEL_TASKS = ["relevance", "role_family", "seniority", "work_mode", "false_positive_admission", "needs_review"] as const;
export type LabelTask = (typeof LABEL_TASKS)[number];

export const labelInput = z
  .object({
    postingId: z.string().uuid(),
    textSha256: z.string().regex(/^[a-f0-9]{64}$/),
    task: z.enum(LABEL_TASKS),
    roleSlug: z.string().max(64).default(""),
    value: z.string().min(1).max(64),
    reviewer: z.string().trim().min(1).max(64),
    sessionId: z.string().min(1).max(64),
    selectionBasis: z.string().min(1).max(200),
    note: z.string().max(500).optional(),
    /** How this HUMAN label came to be. Model output is never a value here; llm_provisional lives only in ml_llm_labels. */
    origin: z.enum(["human_verified", "human_corrected"]).default("human_verified"),
    /** Provisional LLM rows the person saw when deciding (provenance only). */
    llmLabelIds: z.array(z.number().int().positive()).max(4).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Relevance and false-positive checks are about a JOB-ROLE PAIR, so a role is mandatory for them.
    if ((v.task === "relevance" || v.task === "false_positive_admission") && !v.roleSlug) ctx.addIssue({ code: "custom", message: `${v.task} needs a roleSlug (labels are job-role pairs)` });
    const ok =
      v.task === "relevance" ? (RELEVANCE as readonly string[]).includes(v.value)
      : v.task === "seniority" ? (SENIORITY as readonly string[]).includes(v.value)
      : v.task === "work_mode" ? (WORK_MODES as readonly string[]).includes(v.value)
      : v.task === "false_positive_admission" || v.task === "needs_review" ? v.value === "true" || v.value === "false"
      : /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.value);
    if (!ok) ctx.addIssue({ code: "custom", message: `"${v.value}" is not a valid ${v.task} value` });
  });
export type LabelInput = z.infer<typeof labelInput>;
/** What callers pass: `origin` defaults to human_verified. */
export type LabelInputIn = z.input<typeof labelInput>;

export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Fixed, documented limits below which a classifier may not be trained or promoted. Chosen before any result was seen. */
export const GATES = {
  minTrainPerClass: 25,
  minHeldoutPerClass: 10,
  minHeldoutEmployers: 3,
  heldoutFraction: 0.3,
  /** A challenger must beat the rule baseline's held-out F1 by this margin AND not exceed its false-positive rate by more than the tolerance. */
  minF1Gain: 0.05,
  maxFprIncrease: 0.02,
} as const;

export const TEXT_PREPROCESS = { title: "ml-title@1", passage: "ml-jd-passage@2", role: "ml-role@1" } as const;
/** JD passages: whitespace-normalised paragraphs packed up to PASSAGE_CHARS, at most MAX_PASSAGES. Text beyond that is NOT embedded and the posting is flagged `truncated`. */
export const PASSAGE_CHARS = 1000;
/** A whitespace-free run longer than this (URLs, unspaced CJK text) is cut into pieces so the encoder never sees one over-long token. */
export const MAX_RUN_CHARS = 80;
export const breakLongRuns = (s: string): string => s.replace(new RegExp(String.raw`\S{${MAX_RUN_CHARS + 1},}`, "gu"), (run) => (Array.from(run).reduce<string[]>((parts, ch, n) => { if (n % MAX_RUN_CHARS === 0) parts.push(""); parts[parts.length - 1] += ch; return parts; }, [])).join(" "));
export const MAX_PASSAGES = 4;

/** Job text only. Candidate facts, contact data, eligibility and sponsorship text never enter an embedding or a feature. */
export function jdPassages(description: string): { passages: string[]; truncated: boolean } {
  const paras = description.split(/\r?\n\s*\r?\n/).map((p) => breakLongRuns(p.replace(/\s+/g, " ").trim())).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { out.push(cur); cur = ""; } };
  for (const para of paras) {
    for (let i = 0; i < para.length; i += PASSAGE_CHARS) {
      const piece = para.slice(i, i + PASSAGE_CHARS);
      if (cur && cur.length + piece.length + 1 > PASSAGE_CHARS) flush();
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  flush();
  return { passages: out.slice(0, MAX_PASSAGES), truncated: out.length > MAX_PASSAGES };
}

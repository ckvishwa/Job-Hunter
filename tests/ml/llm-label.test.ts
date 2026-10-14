import { describe, expect, it } from "vitest";
import { buildPrompt, CONFIDENT, consensus, jdCompleteness, labelOnce, llmOutputSchema, MAX_JD_CHARS, MIN_JD_CHARS, needsSecondPass, verifyQuotes, type LlmProvider, type RoleBrief } from "../../src/ml/llm-label.js";
import { OllamaLabeler } from "../../src/ml/llm-ollama.js";
import { pairNeedsResume, completedCurrentPairs, runBatch, type RunStats } from "../../src/ml/llm-workflows.js";
import type { LlmRepo } from "../../src/ml/llm-repo.js";
import type { CorpusRow } from "../../src/ml/repo.js";

// Pure tests with a scripted provider. All postings are SYNTHETIC. Expected values are stated by hand.

const ROLE: RoleBrief = { slug: "soc-analyst", title: "SOC Analyst", description: "Monitors alerts and triages security incidents.", aliases: ["Security Operations Analyst"], coreSkills: ["siem", "triage"] };
const JD = `Join our security operations center. You will monitor SIEM alerts in Splunk, perform alert triage, investigate incidents and escalate to incident response. Document every finding in the case system. ` +
  `Requirements: experience with log analysis, Windows event logs, MITRE ATT&CK and detection use cases. Shift work may apply. We value curiosity and teamwork. Our team reviews cases every morning and shares what it learned. ` +
  `You will also tune noisy detections, write short runbooks for new alert types, and help new analysts learn the tooling during their first month on the team. Benefits include health coverage and a learning budget for certifications.`;
const scripted = (content: unknown): LlmProvider => ({ identity: async () => ({ provider: "test", model: "scripted", digest: null }), complete: async () => ({ content: typeof content === "string" ? content : JSON.stringify(content), latencyMs: 1 }) });
const good = { relevance: "relevant", seniority: "mid", work_mode: "unclear", confidence: 0.9, evidence: ["monitor SIEM alerts in Splunk, perform alert triage"], reasoning: "Daily work is alert triage." };
const posting = { title: "Security Operations Analyst", company: "Synthco01", description: JD };

describe("completeness: missing or incomplete descriptions are rejected, not guessed", () => {
  it("rejects empty, short and structure-less text", () => {
    expect(jdCompleteness("").ok).toBe(false);
    expect(jdCompleteness("Apply now. ".repeat(10)).ok).toBe(false);
    const nav = Array.from({ length: 200 }, (_, i) => `Link${i}`).join(" ");
    expect(jdCompleteness(nav)).toMatchObject({ ok: false });
    expect(JD.length).toBeGreaterThan(MIN_JD_CHARS);
    expect(jdCompleteness(JD).ok).toBe(true);
  });
  it("an incomplete description never reaches the model", async () => {
    let called = 0;
    const p: LlmProvider = { identity: async () => ({ provider: "t", model: "m", digest: null }), complete: async () => { called++; return { content: "{}", latencyMs: 1 }; } };
    const r = await labelOnce(p, "A", ROLE, { ...posting, description: "Short posting." });
    expect(r).toMatchObject({ ok: false, reason: "INCOMPLETE_JD" });
    expect(called).toBe(0);
  });
});

describe("evidence must be quoted from the stored text", () => {
  it("accepts exact quotes with source offsets and rejects altered or invented wording", () => {
    expect(verifyQuotes(["Monitor   SIEM alerts in splunk"], JD)).toMatchObject({ ok: false });
    expect(verifyQuotes(["monitor SIEM alerts in Splunk", "manage a team of fifty engineers"], JD)).toMatchObject({ ok: false, reason: "QUOTE_NOT_IN_JD" });
    expect(verifyQuotes(["Monitor SIEM alerts in Splunk , perform alert-triage"], JD)).toMatchObject({ ok: false }); // exact evidence required
    expect(verifyQuotes(["monitors SIEM alerts in Splunk and performs triage"], JD)).toMatchObject({ ok: false, reason: "QUOTE_NOT_IN_JD" }); // a paraphrase is not
    expect(verifyQuotes(["monitor SIEM alerts in Splunk"], JD)).toMatchObject({ ok: true, locations: [{ source: "description", start: JD.indexOf("monitor SIEM alerts in Splunk"), end: JD.indexOf("monitor SIEM alerts in Splunk") + 29 }] });
    expect(verifyQuotes(["short"], JD)).toMatchObject({ ok: false, reason: "NO_EVIDENCE" });
  });
  it("sends every supported JD character and never labels a truncated prefix", async () => {
    const marker = "FINAL FULL DESCRIPTION REQUIREMENT SENTINEL";
    const longDescription = `${JD}\n\n${"Additional responsibilities include careful written documentation and regular review. ".repeat(100)}${marker}`;
    let sent = "";
    const provider: LlmProvider = { identity: async () => ({ provider: "test", model: "scripted", digest: null }), complete: async (req) => { sent = req.user; return { content: JSON.stringify(good), latencyMs: 1 }; } };
    const result = await labelOnce(provider, "A", ROLE, { ...posting, description: longDescription });
    expect(longDescription.length).toBeGreaterThan(7000);
    expect(sent).toContain(marker);
    expect(result).toMatchObject({ ok: true, jdCharsSent: longDescription.length, jdTruncated: false });
  });
  it("rejects a JD that cannot fit the supported model context without sending a prefix", async () => {
    let called = 0;
    const provider: LlmProvider = { identity: async () => ({ provider: "test", model: "scripted", digest: null }), complete: async () => { called++; return { content: JSON.stringify(good), latencyMs: 1 }; } };
    const description = `${JD}\n\n${"A detailed supported responsibility. ".repeat(Math.ceil((MAX_JD_CHARS + 1) / 36))}`;
    expect(await labelOnce(provider, "A", ROLE, { ...posting, description })).toMatchObject({ ok: false, reason: "CONTEXT_LIMIT" });
    expect(called).toBe(0);
  });
  it("labelOnce turns a made-up quote, bad JSON and an out-of-vocabulary value into typed rejections, never a label", async () => {
    expect(await labelOnce(scripted({ ...good, evidence: ["responsible for the global sales forecast"] }), "A", ROLE, posting)).toMatchObject({ ok: false, reason: "QUOTE_NOT_IN_JD" });
    expect(await labelOnce(scripted("not json"), "A", ROLE, posting)).toMatchObject({ ok: false, reason: "INVALID_OUTPUT" });
    expect(await labelOnce(scripted({ ...good, relevance: "maybe" }), "A", ROLE, posting)).toMatchObject({ ok: false, reason: "INVALID_OUTPUT" });
    expect(await labelOnce(scripted({ ...good, extra: 1 }), "A", ROLE, posting)).toMatchObject({ ok: false, reason: "INVALID_OUTPUT" });
    const throwing: LlmProvider = { identity: async () => ({ provider: "t", model: "m", digest: null }), complete: async () => { throw new Error("connection refused"); } };
    expect(await labelOnce(throwing, "A", ROLE, posting)).toMatchObject({ ok: false, reason: "PROVIDER_ERROR" });
    const ok = await labelOnce(scripted(good), "A", ROLE, posting);
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.output.relevance).toBe("relevant");
  });
  it("the output schema is strict", () => {
    expect(llmOutputSchema.safeParse({ ...good, confidence: 1.5 }).success).toBe(false);
    expect(llmOutputSchema.safeParse({ ...good, evidence: [] }).success).toBe(false);
  });
});

describe("prompts judge duties, keep eligibility out, and the two passes are independent framings", () => {
  const a = buildPrompt("A", ROLE, { title: posting.title, company: posting.company, text: JD });
  const b = buildPrompt("B", ROLE, { title: posting.title, company: posting.company, text: JD });
  it("tells the model to ignore instructions in the posting and to judge duties, not title/location/eligibility", () => {
    for (const p of [a, b]) {
      expect(p.system).toMatch(/untrusted/);
      expect(p.system).toMatch(/not from the title/);
      expect(p.system).toMatch(/seniority/i);
      expect(p.user).toContain(JD);
    }
  });
  it("pass B differs in order, wording and option order from pass A", () => {
    expect(a.system).not.toBe(b.system);
    expect(a.user.indexOf("<posting>")).toBeLessThan(a.user.indexOf("Target role"));
    expect(b.user.indexOf("Target role")).toBeLessThan(b.user.indexOf("<posting>"));
    expect(b.system).toMatch(/duties/);
  });
  it("never contains candidate facts: the prompt builder has no input for them", () => {
    expect(buildPrompt.length).toBe(3);
  });
});

describe("agreement of two passes", () => {
  const v = (relevance: "relevant" | "irrelevant" | "adjacent" | "unsure", confidence: number, seniority = "mid") => ({ relevance, confidence, seniority });
  it("agreement, disagreement, low confidence and single-pass are told apart", () => {
    expect(consensus(null, null)).toEqual({ status: "NO_LABEL" });
    expect(consensus(v("relevant", 0.9), v("relevant", 0.8))).toMatchObject({ status: "AGREED", relevance: "relevant", confidence: 0.8, lowConfidence: false });
    expect(consensus(v("relevant", 0.9), v("relevant", 0.6))).toMatchObject({ status: "AGREED", lowConfidence: true });
    expect(consensus(v("unsure", 0.99), v("unsure", 0.99))).toMatchObject({ status: "AGREED", lowConfidence: true });
    expect(consensus(v("relevant", 0.9), v("adjacent", 0.9))).toMatchObject({ status: "DISAGREE", a: "relevant", b: "adjacent" });
    expect(consensus(v("irrelevant", 0.9), null)).toMatchObject({ status: "SINGLE_PASS", lowConfidence: false });
    expect(consensus(v("relevant", 0.9, "senior"), v("relevant", 0.9, "mid"))).toMatchObject({ seniority: "unclear", seniorityAgrees: false });
    expect(CONFIDENT).toBe(0.75);
  });
  it("important or uncertain pairs always get a second pass; confident negatives only a seeded random share", () => {
    expect(needsSecondPass({ relevance: "relevant", confidence: 0.99 }, "k").need).toBe(true);
    expect(needsSecondPass({ relevance: "adjacent", confidence: 0.99 }, "k").need).toBe(true);
    expect(needsSecondPass({ relevance: "irrelevant", confidence: 0.4 }, "k").need).toBe(true);
    const picks = Array.from({ length: 2000 }, (_, i) => needsSecondPass({ relevance: "irrelevant", confidence: 0.95 }, `pair-${i}`).need).filter(Boolean).length;
    expect(picks).toBeGreaterThan(200); expect(picks).toBeLessThan(400); // about 15% of 2000
    expect(needsSecondPass({ relevance: "irrelevant", confidence: 0.95 }, "pair-7")).toEqual(needsSecondPass({ relevance: "irrelevant", confidence: 0.95 }, "pair-7"));
  });

  it("resumes a required second pass when pass A was saved before interruption", () => {
    const a = { relevance: "relevant" as const, confidence: 0.9 };
    expect(pairNeedsResume(a, undefined, "posting|role|hash")).toBe(true);
    expect(pairNeedsResume(a, { relevance: "relevant", confidence: 0.8 }, "posting|role|hash")).toBe(false);
  });
  it("does not skip changed descriptions or repeat completed equivalent descriptions", () => {
    const done = new Map([["old-id|soc|old-hash", { A: { relevance: "relevant" as const, confidence: 0.9 }, B: { relevance: "relevant" as const, confidence: 0.9 } }]]);
    const skip = completedCurrentPairs(done, [{ id: "old-id", textSha256: "new-hash" }, { id: "clone", textSha256: "old-hash" }]);
    expect(skip.has("old-id|soc")).toBe(false);
    expect(skip.has("clone|soc")).toBe(true);
  });
});

describe("local-only provider", () => {
  it("checkpoints a saved A and a failed B persistence operation", async () => {
    const snapshots: RunStats[] = [];
    let writes = 0;
    const repo = { byPair: async () => new Map(), save: async () => { if (++writes === 2) throw new Error("database unavailable"); return { id: 1, duplicate: false }; } } as unknown as LlmRepo;
    await expect(runBatch(repo, scripted(good), [{ posting: { ...posting, id: "p", textSha256: "h", sourceKey: "s" } as CorpusRow, roleSlug: ROLE.slug, source: "active", why: "test" }], new Map([[ROLE.slug, ROLE]]), { onCheckpoint: (s) => snapshots.push(structuredClone(s)) })).rejects.toThrow(/database unavailable/);
    expect(snapshots.some((s) => s.passA === 1)).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ status: "FAILED", passA: 1, passB: 0 });
  });
  it("allows only the authorized Qwen 3B model and safe context sizes", () => {
    expect(() => new OllamaLabeler({ model: "other:7b" })).toThrow(/Qwen/);
    expect(() => new OllamaLabeler({ numCtx: 4096 })).toThrow(/context/);
  });
  it("blocks redirects and refuses incomplete generations", async () => {
    let redirect: RequestRedirect | undefined;
    const provider = new OllamaLabeler({ fetchImpl: (async (_url, init) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify({ done: true, done_reason: "length", message: { content: JSON.stringify(good) } }));
    }) as typeof fetch });
    await expect(provider.complete({ system: "s", user: "u", pass: "A" })).rejects.toThrow(/incomplete/);
    expect(redirect).toBe("error");
  });
  it("refuses a non-loopback Ollama so job text cannot leave the machine", () => {
    expect(() => new OllamaLabeler({ baseUrl: "https://api.example.com" })).toThrow(/loopback/);
    expect(() => new OllamaLabeler({ baseUrl: "http://127.0.0.1:11434" })).not.toThrow();
  });
});

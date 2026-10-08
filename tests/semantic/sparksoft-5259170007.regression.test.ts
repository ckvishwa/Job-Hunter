import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { computeJdContentHash } from "../../src/domain/canonical-job.js";
import { parseCanonicalJob } from "../../src/semantic/parse-job.js";
import { OllamaJobSemanticProvider } from "../../src/semantic/ollama-provider.js";
import { buildExtractionCoverage, inventorySource } from "../../src/semantic/source-coverage.js";

// Regression for the Sparksoft Greenhouse 5259170007 failure that was reported as PROVIDER_FAILED.
// Substituted boundary: the Ollama HTTP endpoint, replaying the two responses recorded from the
// live run (both done_reason "stop", well under the 2048-token output budget). Everything else
// (provider assembly, StructuredJob validator, parseCanonicalJob, failure log) is production code.

const JD = readFileSync(path.join(__dirname, "../fixtures/sparksoft-5259170007.jd.txt"), "utf8");
const recorded = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/sparksoft-5259170007.recorded-annotations.json"), "utf8")) as {
  jdSha256: string;
  doneReasons: string[];
  responses: unknown[];
};

function replayFetch(responses: unknown[]) {
  const queue = [...responses];
  return vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return Response.json({ models: [{ name: "m", digest: "abc" }] });
    if (u.endsWith("/api/show")) return Response.json({ details: { quantization_level: "Q4_K_M" }, model_info: { "qwen2.context_length": 32768 } });
    if (u.endsWith("/api/ps")) return Response.json({ models: [] });
    if (u.endsWith("/api/generate")) return Response.json({ done: true, load_duration: 1 });
    JSON.parse(init.body);
    const out = queue.length > 1 ? queue.shift() : queue[0];
    return Response.json({ model: "m", done: true, done_reason: "stop", prompt_eval_count: 800, eval_count: 300, message: { content: JSON.stringify(out) } });
  }) as unknown as typeof fetch;
}

function sparksoftJob(): JobPosting {
  return {
    id: "0c7da8c8ee74e26e", source: "company-careers::sparksoft", sourceType: "company-careers", company: "Sparksoft Corporation",
    title: "Jr Functional /Automation Tester", location: null, remoteType: null, employmentType: null, department: null,
    requisitionId: "5259170007", postingDate: null, discoveredAt: "2026-10-08T00:00:00.000Z", lastSeenAt: "2026-10-08T00:00:00.000Z",
    canonicalUrl: "https://job-boards.greenhouse.io/sparksoft/jobs/5259170007", applyUrl: "https://job-boards.greenhouse.io/sparksoft/jobs/5259170007",
    descriptionText: JD, descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: ["sdet"], discoveredFrom: ["company-careers"],
    schemaVersion: 1, jdContentHash: computeJdContentHash(JD), extractedAt: "2026-10-08T00:00:00.000Z", resolutionStatus: "resolved",
    atsIdentity: "greenhouse:sparksoft:5259170007", rawMetadata: {},
  } as JobPosting;
}

describe("Sparksoft 5259170007 recorded Qwen response", () => {
  it("fixture is the exact saved JD and the recorded responses were complete, not truncated", () => {
    expect(computeJdContentHash(JD)).toBe(recorded.jdSha256);
    expect(recorded.doneReasons).toEqual(["stop", "stop"]);
  });

  it("source inventory keeps 14 required, 9 preferred, and the Public Trust / residence clauses verbatim", () => {
    const items = inventorySource(JD).items;
    expect(items.filter((i) => i.section === "required")).toHaveLength(14);
    expect(items.filter((i) => i.section === "preferred")).toHaveLength(9);
    const work = items.filter((i) => i.section === "work").map((i) => i.text);
    expect(work).toContain("Candidates must be able to obtain and maintain a Public Trust clearance.");
    expect(work).toContain("Candidates must have lived in the United States for at least 3 of the past 5 years.");
  });

  it("a response whose logic terms are not verbatim source terms is a validation failure, not PROVIDER_FAILED", async () => {
    const fetchImpl = replayFetch(recorded.responses);
    const provider = new OllamaJobSemanticProvider({ baseUrl: "http://127.0.0.1:19017", model: "m", contextTokens: 8192, outputTokens: 2048, timeoutMs: 1000, fetchImpl });
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-sparksoft-"));
    const structuredPath = path.join(dir, "structured-jobs.jsonl");
    const failuresPath = path.join(dir, "structured-failures.jsonl");

    const result = await parseCanonicalJob(sparksoftJob(), provider, { structuredPath, failuresPath });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe("SEMANTIC_PARSE_FAILED");
    expect(result.failure.code).toBe("EVIDENCE_INVALID");
    expect(result.failure.retryable).toBe(false);
    expect(provider.metadata()).toMatchObject({ requestCount: 2, repairCount: 1, lifecycle: { unloaded: true } });
    expect(existsSync(structuredPath)).toBe(false);

    // Diagnostics stay safe: no provider-echoed or JD text in the persisted failure record.
    const logged = readFileSync(failuresPath, "utf8");
    expect(logged).not.toContain("ReadyAPI");
    expect(logged).not.toContain("Selenium");
  });

  it("fixed extraction: the model classifies whole items, code derives alternatives, the recorded live response is accepted with source-backed coverage", async () => {
    const v16 = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/sparksoft-5259170007.recorded-annotations-v16.json"), "utf8")) as { doneReasons: string[]; responses: unknown[] };
    expect(v16.doneReasons).toEqual(["stop", "stop"]);
    const provider = new OllamaJobSemanticProvider({ baseUrl: "http://127.0.0.1:19018", model: "m", contextTokens: 8192, outputTokens: 2048, timeoutMs: 1000, fetchImpl: replayFetch(v16.responses) });
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-sparksoft-v16-"));
    const result = await parseCanonicalJob(sparksoftJob(), provider, { structuredPath: path.join(dir, "structured-jobs.jsonl"), failuresPath: path.join(dir, "failures.jsonl") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(provider.metadata()).toMatchObject({ requestCount: 2, repairCount: 0 });

    const coverage = buildExtractionCoverage({ rawJd: JD, jdHash: computeJdContentHash(JD), structured: result.structured });
    expect(coverage.sections.minimumQualifications).toMatchObject({ sourceItemCount: 14, extractedCount: 13, unresolvedCount: 1 });
    expect(coverage.sections.preferredQualifications).toMatchObject({ sourceItemCount: 9, extractedCount: 6, unresolvedCount: 3 });

    // Hand-read from the JD: these four items mix connectors or elaborate a term, so they stay unresolved evidence.
    const unresolvedIds = (provider.metadata()!.diagnostics!.unresolved as Array<{ sourceId: string }>).map((u) => u.sourceId);
    for (const id of ["s2yd", "s4a2", "s4o0", "s4ri"]) expect(unresolvedIds).toContain(id);

    // The Public Trust clause is a verbatim clearance constraint; the residency clause is retained, not invented into a constraint.
    const clearance = result.structured.constraints.filter((c) => c.type === "clearance" && c.status === "required");
    expect(clearance).toHaveLength(1);
    expect(clearance[0]!.evidence[0]!.quote).toBe("Candidates must be able to obtain and maintain a Public Trust clearance.");
    expect(result.structured.constraints.some((c) => c.value?.includes("lived in the United States"))).toBe(false);
    expect(unresolvedIds.length).toBeGreaterThan(4);
    const residency = (provider.metadata()!.diagnostics!.unresolved as Array<{ sourceId: string }>).find((u) => u.sourceId === "s42r");
    expect(residency).toBeDefined();
  });
});

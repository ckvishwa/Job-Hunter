import { describe, expect, it } from "vitest";
import { AiServiceError, createAiClient } from "../../src/ai/client.js";

const base = { baseUrl: "http://127.0.0.1:8765", serviceToken: "t".repeat(40), timeoutMs: 5000 };
const ok = {
  schemaRevision: 1, parserRevision: "resume-rules@1", fileType: "docx", text: "x", textSha256: "0".repeat(64), warnings: [], facts: [],
  stats: { pageCount: 1, characterCount: 1, deterministicFacts: 0, qwenFacts: 0, qwenDropped: 0, qwenStatus: "DISABLED" },
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("AI client", () => {
  it("only talks to credential-free loopback HTTP with a long enough token", () => {
    expect(() => createAiClient({ ...base, baseUrl: "http://example.com:8765" })).toThrow(/loopback/);
    expect(() => createAiClient({ ...base, baseUrl: "http://u:p@127.0.0.1:8765" })).toThrow(/loopback/);
    expect(() => createAiClient({ ...base, baseUrl: "https://127.0.0.1:8765" })).toThrow(/loopback/);
    expect(() => createAiClient({ ...base, serviceToken: "short" })).toThrow(/32/);
  });

  it("retries a failed connection, then succeeds, sending the bearer token and raw bytes", async () => {
    let calls = 0;
    const seen: Array<{ auth: string | null; type: string | null }> = [];
    const client = createAiClient({
      ...base,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        calls += 1;
        const h = new Headers(init.headers);
        seen.push({ auth: h.get("authorization"), type: h.get("content-type") });
        if (calls < 3) throw new TypeError("fetch failed");
        return json(200, ok);
      }) as never,
    });
    await expect(client.extractResume(new Uint8Array([1, 2, 3]), "docx")).resolves.toMatchObject({ parserRevision: "resume-rules@1" });
    expect(calls).toBe(3);
    expect(seen[2]).toEqual({ auth: `Bearer ${"t".repeat(40)}`, type: "application/octet-stream" });
  }, 15_000);

  it("gives up after repeated connection failures as a retryable AI_UNAVAILABLE", async () => {
    let calls = 0;
    const client = createAiClient({ ...base, fetchImpl: (async () => { calls += 1; throw new TypeError("fetch failed"); }) as never });
    await expect(client.extractResume(new Uint8Array([1]), "pdf")).rejects.toMatchObject({ code: "AI_UNAVAILABLE", retryable: true });
    expect(calls).toBe(3);
  }, 15_000);

  it("does not retry a timeout", async () => {
    let calls = 0;
    const client = createAiClient({ ...base, fetchImpl: (async () => { calls += 1; throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as never });
    await expect(client.extractResume(new Uint8Array([1]), "pdf")).rejects.toMatchObject({ code: "AI_TIMEOUT", retryable: true });
    expect(calls).toBe(1);
  });

  it("maps typed document errors as non-retryable and rejects malformed or off-contract responses", async () => {
    const typed = createAiClient({ ...base, fetchImpl: (async () => json(422, { error: { code: "NO_TEXT_LAYER", message: "scan" } })) as never });
    await expect(typed.extractResume(new Uint8Array([1]), "pdf")).rejects.toMatchObject({ code: "NO_TEXT_LAYER", retryable: false, status: 422 });
    const unauthorized = createAiClient({ ...base, fetchImpl: (async () => json(401, { error: { code: "UNAUTHORIZED", message: "no" } })) as never });
    await expect(unauthorized.extractResume(new Uint8Array([1]), "pdf")).rejects.toMatchObject({ code: "AI_UNAUTHORIZED" });
    const extra = createAiClient({ ...base, fetchImpl: (async () => json(200, { ...ok, surprise: true })) as never });
    await expect(extra.extractResume(new Uint8Array([1]), "pdf")).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
    const forbiddenKind = createAiClient({
      ...base,
      fetchImpl: (async () => json(200, { ...ok, facts: [{ kind: "citizenship", value: "x", attributes: {}, span: { start: 0, end: 1, quote: "x" }, proposedBy: "rules" }] })) as never,
    });
    await expect(forbiddenKind.extractResume(new Uint8Array([1]), "pdf")).rejects.toBeInstanceOf(AiServiceError);
    const html = createAiClient({ ...base, fetchImpl: (async () => new Response("<html>", { status: 200 })) as never });
    await expect(html.extractResume(new Uint8Array([1]), "pdf")).rejects.toMatchObject({ code: "AI_SCHEMA_INVALID" });
  });
});

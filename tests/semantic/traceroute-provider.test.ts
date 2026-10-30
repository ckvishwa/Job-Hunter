import { describe, expect, it, vi } from "vitest";
import { bindQuoteOffsets, TraceRouteJobSemanticProvider } from "../../src/semantic/traceroute-provider.js";

describe("TraceRoute semantic provider boundary", () => {
  it("binds a unique exact source quote and leaves a duplicate ambiguous", () => {
    const source = "Python is required. Python is preferred.";
    const bound = bindQuoteOffsets({ requirements: [{ evidence: [{ quote: "Python is required." }, { quote: "Python" }] }] }, source) as { requirements: Array<{ evidence: Array<{ quote: string; start?: number; end?: number }> }> };
    expect(source.slice(bound.requirements[0]!.evidence[0]!.start, bound.requirements[0]!.evidence[0]!.end)).toBe("Python is required.");
    expect(bound.requirements[0]!.evidence[1]).toEqual({ quote: "Python" });
  });

  it("sends only the JD to the configured provider and records served model metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ content: string }> };
      expect(request.model).toBe("test-route");
      expect(request.messages[1]?.content).toContain("PUBLIC JOB DESCRIPTION");
      expect(request.messages[1]?.content).not.toContain("candidate-profile");
      return new Response(JSON.stringify({ model: "served-model@rev1", choices: [{ message: { content: JSON.stringify({ requirements: [{ id: "r1", type: "skill", value: "Python", level: "required", minimumYears: null, scope: { kind: "unspecified", value: null }, groupId: null, evidence: [{ quote: "Python required" }] }], responsibilities: [], constraints: [], alternativeGroups: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200, headers: { "content-type": "application/json", "x-gateway-route-version": "route-v3", "x-gateway-request-id": "request-1" } });
    });
    const provider = new TraceRouteJobSemanticProvider({ baseUrl: "http://127.0.0.1:8000/v1/chat/completions", routeAlias: "test-route", gatewayKey: "test-key", contextTokens: 8_000, fetchImpl });
    const rawJd = "Python required";
    await provider.extractJob({ rawJd, jdHash: "a".repeat(64) });
    expect(provider.metadata()).toMatchObject({ servedModel: "served-model@rev1", routeVersion: "route-v3", requestId: "request-1", inputTokens: 10, outputTokens: 20, totalTokens: 30, usageSource: "provider_reported" });
  });

  it("requires an explicitly verified context window", () => {
    expect(() => new TraceRouteJobSemanticProvider({ baseUrl: "http://localhost/v1/chat/completions", routeAlias: "r", gatewayKey: "k", contextTokens: 1_000 })).toThrow(/context limit/);
  });

  it("rejects a successful JSON response when the actual served model is not identified", async () => {
    const provider = new TraceRouteJobSemanticProvider({
      baseUrl: "http://localhost/v1/chat/completions", routeAlias: "test-route", gatewayKey: "test-key", contextTokens: 8_000,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ requirements: [], responsibilities: [], constraints: [], alternativeGroups: [] }) } }] }), { status: 200 }),
    });
    await expect(provider.extractJob({ rawJd: "A sufficiently long source document.", jdHash: "b".repeat(64) })).rejects.toThrow("TraceRouteMissingServedModel");
    expect(provider.metadata()).toBeNull();
  });
});

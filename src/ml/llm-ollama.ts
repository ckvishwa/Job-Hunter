import type { CompletionResult, LlmProvider, ModelIdentity } from "./llm-label.js";
import { LABEL_CONTEXT, CONTEXT_RESERVE } from "./llm-label.js";

// Local Ollama on loopback only. Posting text never leaves the machine. Structured output (JSON schema) constrains the SHAPE; correctness is checked in llm-label.ts.

export const DEFAULT_LABEL_MODEL = "qwen2.5:3b-instruct-q4_K_M";

const schema = (pass: "A" | "B") => ({
  type: "object",
  properties: {
    ...(pass === "B" ? { duties: { type: "array", items: { type: "string" }, maxItems: 6 } } : {}),
    relevance: { type: "string", enum: pass === "A" ? ["relevant", "irrelevant", "adjacent", "unsure"] : ["unsure", "adjacent", "irrelevant", "relevant"] },
    seniority: { type: "string", enum: ["junior", "mid", "senior", "unclear"] },
    work_mode: { type: "string", enum: ["remote", "hybrid", "onsite", "unclear"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
    reasoning: { type: "string" },
  },
  required: [...(pass === "B" ? ["duties"] : []), "relevance", "seniority", "work_mode", "confidence", "evidence", "reasoning"],
});

export interface OllamaLabelerOptions { baseUrl?: string; model?: string; numCtx?: number; timeoutMs?: number; fetchImpl?: typeof fetch }

export class OllamaLabeler implements LlmProvider {
  readonly baseUrl: string;
  readonly model: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private ident: ModelIdentity | null = null;

  constructor(o: OllamaLabelerOptions = {}) {
    this.baseUrl = (o.baseUrl ?? process.env.JOBHUNTER_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const host = new URL(this.baseUrl).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("The labeler only talks to a loopback Ollama: job text must not leave this machine.");
    this.model = o.model ?? process.env.JH_LLM_LABEL_MODEL ?? DEFAULT_LABEL_MODEL;
    if (![DEFAULT_LABEL_MODEL, "qwen2.5:3b"].includes(this.model)) throw new Error("Only local Qwen 2.5 3B is authorized for labeling.");
    this.numCtx = o.numCtx ?? LABEL_CONTEXT;
    if (this.numCtx !== LABEL_CONTEXT) throw new Error(`Labeling requires context ${LABEL_CONTEXT} to preserve complete descriptions.`);
    this.timeoutMs = o.timeoutMs ?? 180_000;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async identity(): Promise<ModelIdentity> {
    if (this.ident) return this.ident;
    const r = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!r.ok) throw new Error(`Ollama /api/tags returned ${r.status}`);
    const m = ((await r.json()) as { models?: Array<{ name: string; digest?: string }> }).models?.find((x) => x.name === this.model);
    if (!m) throw new Error(`Ollama model "${this.model}" is not installed.`);
    return (this.ident = { provider: "ollama", model: this.model, digest: m.digest ?? null });
  }

  async complete(req: { system: string; user: string; pass: "A" | "B" }): Promise<CompletionResult> {
    if (Buffer.byteLength(req.system + req.user, "utf8") + CONTEXT_RESERVE > this.numCtx) throw new Error("Complete prompt exceeds context budget.");
    const t0 = Date.now();
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(this.timeoutMs), redirect: "error",
        body: JSON.stringify({
          model: this.model, stream: false, keep_alive: "10m", format: schema(req.pass),
          messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
          options: { num_ctx: this.numCtx, num_predict: 700, temperature: 0, seed: req.pass === "A" ? 11 : 29 },
        }),
      });
      if (r.ok) {
        const body = (await r.json()) as { done?: boolean; done_reason?: string; message?: { content?: string } };
        if (body.done !== true || body.done_reason !== "stop") throw new Error("Ollama generation was incomplete; review required.");
        const content = body.message?.content;
        if (typeof content !== "string") throw new Error("Ollama response had no message content.");
        return { content, latencyMs: Date.now() - t0 };
      }
      lastStatus = r.status;
      if (r.status < 500 || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt)); // a model that is still loading answers 500 once or twice
    }
    throw new Error(`Ollama /api/chat returned ${lastStatus}`);
  }
}

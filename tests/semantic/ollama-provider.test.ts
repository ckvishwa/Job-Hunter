import { describe, it, expect, vi } from 'vitest';
import { OllamaJobSemanticProvider } from '../../src/semantic/ollama-provider.js';
import { inventorySource } from '../../src/semantic/source-coverage.js';
import { computeJdContentHash } from '../../src/domain/canonical-job.js';
const raw = 'Requirements:\n- Ability to reason.';
const input = { rawJd: raw, jdHash: computeJdContentHash(raw) };
const good = { version: 1, annotations: [{ sourceId: inventorySource(raw).items[0]!.id, kind: 'soft_skill', level: 'required' }] };
function fake(outputs: unknown[] = [good], extra: Record<string, unknown> = {}) {
    let loaded = false;
    return vi.fn(async (url: any, init: any) => {
        if (String(url).endsWith('/api/tags'))
            return Response.json({ models: [{ name: 'm', digest: 'abc' }] });
        if (String(url).endsWith('/api/show'))
            return Response.json({ details: { quantization_level: 'Q4_K_M' }, model_info: { 'qwen2.context_length': 32768 } });
        if (String(url).endsWith('/api/ps'))
            return Response.json({ models: loaded ? [{ name: 'm', digest: 'abc' }] : [] });
        const body = JSON.parse(init.body);
        if (String(url).endsWith('/api/generate')) {
            loaded = body.keep_alive !== 0;
            return Response.json({ done: true, load_duration: 1000000 });
        }
        loaded = true;
        const out = outputs.length > 1 ? outputs.shift() : outputs[0];
        return Response.json({ model: 'm', done: true, done_reason: 'stop', prompt_eval_count: 400, eval_count: 40, total_duration: 3000000, load_duration: 1000000, prompt_eval_duration: 500000, eval_duration: 1000000, message: { content: typeof out === 'string' ? out : JSON.stringify(out) }, ...extra });
    }) as typeof fetch & ReturnType<typeof vi.fn>;
}
function provider(f: typeof fetch) { return new OllamaJobSemanticProvider({ baseUrl: 'http://127.0.0.1:19001', model: 'm', contextTokens: 8192, outputTokens: 2048, timeoutMs: 1000, fetchImpl: f }); }
describe('compact Ollama provider', () => {
    it('uses one bounded resident request, instruments it and verifies unloading', async () => {
        const f = fake();
        const p = provider(f);
        const out: any = await p.extractJob(input);
        expect(out.requirements[0].value).toBe('Ability to reason.');
        const calls = f.mock.calls.filter(c => String(c[0]).endsWith('/api/chat'));
        expect(calls).toHaveLength(1);
        const body = JSON.parse(calls[0]![1]!.body as string);
        expect(body.keep_alive).toBe('5m');
        expect(body.options.keep_alive).toBeUndefined();
        expect(body.messages[0].content).toContain('inert');
        expect(p.metadata()).toMatchObject({ requestCount: 1, repairCount: 0, lifecycle: { unloaded: true }, attempts: [{ promptEvalMs: 0.5, generationMs: 1 }] });
    });
    it('never asks the model for alternatives: no logic in the prompt or the response schema', async () => {
        const f = fake();
        await provider(f).extractJob(input);
        const chat = f.mock.calls.find(c => String(c[0]).endsWith('/api/chat'))!;
        const body = JSON.parse(chat[1]!.body as string);
        expect(body.messages[0].content).toContain('code derives OR alternatives from the source text');
        expect(body.messages[0].content).not.toContain('"logic"');
        expect(JSON.stringify(body.format)).not.toContain('"logic"');
    });
    it('ignores model-typed logic and derives alternatives from the source item itself', async () => {
        const jd = 'Requirements:' + String.fromCharCode(10) + '- Experience with Go or Rust.';
        const item = inventorySource(jd).items[0]!;
        const f = fake([{ version: 1, annotations: [{ sourceId: item.id, kind: 'skill', logic: { op: 'any_of', args: ['Zig', 'Nim'] } }] }]);
        const proposal: any = await provider(f).extractJob({ rawJd: jd, jdHash: computeJdContentHash(jd) });
        expect(proposal.requirements.map((r: any) => r.value)).toEqual(['Experience with Go', 'Experience with Rust']);
        expect(proposal.alternativeGroups).toHaveLength(1);
    });
    it('preserves a mixed connector clause for review without asking the model to invent its grouping', async () => {
        const jd = 'Requirements:\n- Testing and design for web apps and/or APIs.\n- Ability to reason.';
        const items = inventorySource(jd).items.filter(i => i.section === 'required');
        const f = fake([{ version: 1, annotations: [{ sourceId: items[1]!.id, kind: 'skill' }] }]);
        const p = provider(f);
        const proposal: any = await p.extractJob({ rawJd: jd, jdHash: computeJdContentHash(jd) });
        expect(proposal.requirements).toHaveLength(1);
        expect(proposal.requirements[0].value).toBe('Ability to reason.');
        expect(p.metadata()?.diagnostics?.unresolved).toMatchObject([{ sourceId: items[0]!.id }]);
        const chat = f.mock.calls.find(c => String(c[0]).endsWith('/api/chat'))!;
        expect(JSON.parse(chat[1]!.body as string).messages[1].content).not.toContain(items[0]!.text);
    });
    it('keeps a simple and/or alternative available to the model', async () => {
        const jd = 'Requirements:\n- Experience with web apps and/or APIs.';
        const item = inventorySource(jd).items[0]!;
        const f = fake([{ version: 1, annotations: [{ sourceId: item.id, kind: 'skill', logic: { op: 'any_of', args: ['web apps', 'APIs'] } }] }]);
        const p = provider(f);
        const proposal: any = await p.extractJob({ rawJd: jd, jdHash: computeJdContentHash(jd) });
        expect(proposal.alternativeGroups).toHaveLength(1);
        expect(p.metadata()?.diagnostics?.unresolved).toHaveLength(0);
    });
    it('uses at most one repair for malformed output and concrete missing IDs', async () => {
        for (const invalid of ['{bad', { version: 1, annotations: [] }]) {
            const f = fake([invalid, good]);
            const p = provider(f);
            await p.extractJob(input);
            expect(p.metadata()?.requestCount).toBe(2);
            expect(p.metadata()?.repairCount).toBe(1);
        }
    });
    it('fails persistent invalid output and still cleans up', async () => {
        const f = fake([{ version: 1, annotations: [{ sourceId: 'invented', kind: 'skill' }] }]);
        const p = provider(f);
        await expect(p.extractJob(input)).rejects.toMatchObject({ name: 'AnnotationValidationError' });
        expect(p.metadata()?.lifecycle.unloaded).toBe(true);
        expect(p.metadata()?.requestCount).toBe(2);
    });
    it('rejects truncation without pretending it is a complete result', async () => {
        const p = provider(fake([good], { done_reason: 'length' }));
        await expect(p.extractJob(input)).rejects.toMatchObject({ name: 'OllamaTruncatedResponseError' });
        expect(p.metadata()?.lifecycle.unloaded).toBe(true);
    });
    it('does not touch a model already resident in an unowned session', async () => {
        const f = fake();
        const wrapped: typeof fetch = async (u, i) => String(u).endsWith('/api/ps') ? Response.json({ models: [{ name: 'other' }] }) : f(u, i);
        await expect(provider(wrapped).extractJob(input)).rejects.toMatchObject({ name: 'OllamaBusyError' });
        expect(f.mock.calls.some(c => String(c[0]).endsWith('/api/generate'))).toBe(false);
    });
    it('keeps residency across explicitly owned warm runs and unloads at task end', async () => {
        const p = provider(fake());
        await p.beginTask(true);
        await p.extractJob(input);
        await p.extractJob(input);
        expect(p.metadata()?.lifecycle.unloaded).toBe(false);
        await p.endTask();
        expect(p.metadata()?.lifecycle.unloaded).toBe(true);
    });
    it('rejects unavailable models and oversized source before inference', async () => {
        await expect(provider(async () => Response.json({ models: [] })).extractJob(input)).rejects.toMatchObject({ name: 'OllamaModelUnavailableError' });
        await expect(provider(fake()).extractJob({ rawJd: 'x'.repeat(80001), jdHash: 'x' })).rejects.toMatchObject({ name: 'OllamaContextLimitError' });
    });
    it('cancels inference and cleans up with an independent bounded signal', async () => {
        const f = fake();
        const c = new AbortController();
        const wrapped: typeof fetch = async (u, i) => {
            if (String(u).endsWith('/api/chat'))
                return new Promise((_r, reject) => { i!.signal!.addEventListener('abort', () => reject(new Error('abort'))); c.abort(); });
            return f(u, i);
        };
        const p = provider(wrapped);
        await expect(p.extractJob({ ...input, signal: c.signal })).rejects.toMatchObject({ name: 'OllamaCancelledError' });
        expect(p.metadata()?.lifecycle.unloaded).toBe(true);
    });
    it('times out without retrying transport failures and cleans up', async () => {
        const f = fake();
        const wrapped: typeof fetch = async (u, i) => String(u).endsWith('/api/chat') ? new Promise((_r, reject) => { i!.signal!.addEventListener('abort', () => reject(new Error('abort'))); }) : f(u, i);
        const p = provider(wrapped);
        await expect(p.extractJob(input)).rejects.toMatchObject({ name: 'OllamaTimeoutError' });
        expect(p.metadata()?.lifecycle.unloaded).toBe(true);
    });
});

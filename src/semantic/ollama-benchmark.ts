/** Explicit local inference benchmark. Not imported by ordinary tests; never downloads models. */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus } from 'node:os';
import { parseArgs } from 'node:util';
import { OllamaJobSemanticProvider } from './ollama-provider.js';
import { parseCanonicalJob } from './parse-job.js';
import { loadJobs } from '../storage/job-store.js';
import { buildExtractionCoverage } from './source-coverage.js';
const { values } = parseArgs({ options: { 'mode': { type: 'string', default: 'both' }, 'data-dir': { type: 'string', default: 'private-runtime/pipeline-live-data' }, 'job-id': { type: 'string', default: '56c567cff6dda2b7' }, 'output-dir': { type: 'string' }, 'reference': { type: 'string', default: 'tests/fixtures/stripe-client-platform-security-engineer.reference.json' }, 'runs': { type: 'string', default: '3' }, 'context-tokens': { type: 'string', default: '8192' }, 'output-tokens': { type: 'string', default: '2048' }, 'ollama-url': { type: 'string', default: 'http://127.0.0.1:11435' }, 'model': { type: 'string', default: 'qwen2.5:3b-instruct-q4_K_M' } } });
if (!values['output-dir'])
    throw new Error('--output-dir is required and must be new (fresh inference).');
const root = path.resolve(values['output-dir']);
if (existsSync(root))
    throw new Error('Output directory exists; use a new isolated benchmark directory.');
if (!['cold', 'warm', 'both'].includes(values.mode))
    throw new Error('--mode must be cold, warm or both.');
const runs = Number(values.runs);
if (!Number.isInteger(runs) || runs < 1 || runs > 3)
    throw new Error('--runs must be 1..3 (each cold and warm).');
const job = loadJobs(path.resolve(values['data-dir'], 'jobs.jsonl')).find(j => j.id === values['job-id']);
if (!job)
    throw new Error('Saved canonical job not found.');
const reference = JSON.parse(readFileSync(values.reference, 'utf8'));
if (reference.jdHash !== job.jdContentHash)
    throw new Error('Reference JD hash mismatch.');
mkdirSync(root, { recursive: true });
function save(file: string, value: unknown) {
    const p = path.join(root, file);
    writeFileSync(p + '.tmp', JSON.stringify(value, null, 2));
    const fd = openSync(p + '.tmp', 'r+');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(p + '.tmp', p);
}
const command = promisify(execFile);
const samples: any[] = [];
let stopped = false;
async function sample() {
    const t = Date.now();
    const results = await Promise.allSettled([
        command('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000 }),
        command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process ollama* -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 5000 }),
        fetch(values['ollama-url'] + '/api/ps', { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
    ]);
    samples.push({ at: new Date(t).toISOString(), logicalCpus: cpus().length, gpu: results[0].status === 'fulfilled' ? results[0].value.stdout.trim() : null, processes: results[1].status === 'fulfilled' ? JSON.parse(results[1].value.stdout || 'null') : null, ps: results[2].status === 'fulfilled' ? results[2].value : null });
}
const sampling = (async () => {
    while (!stopped) {
        await sample();
        if (!stopped)
            await new Promise(r => setTimeout(r, 1000));
    }
})();
const provider = () => new OllamaJobSemanticProvider({ baseUrl: values['ollama-url'], model: values.model, contextTokens: Number(values['context-tokens']), outputTokens: Number(values['output-tokens']), timeoutMs: 240000 });
const results: any[] = [];
let warm: OllamaJobSemanticProvider | undefined;
async function run(p: OllamaJobSemanticProvider, mode: string, index: number) {
    await p.prepare();
    const before = await (await fetch(values['ollama-url'] + '/api/ps')).json();
    const start = performance.now();
    const name = `${mode}-${index}`;
    let result: any, error: string | null = null;
    try {
        result = await parseCanonicalJob(job!, p, { structuredPath: path.join(root, name + '-structured.jsonl'), failuresPath: path.join(root, name + '-failures.jsonl') });
    }
    catch (e) {
        error = e instanceof Error ? e.name : 'UnknownError';
    }
    const elapsedMs = performance.now() - start;
    const metadata = p.metadata();
    const spans = (text: string) => {
        const start = job!.descriptionText.indexOf(text);
        if (start < 0)
            throw new Error('Manual reference is not exact source');
        return { start, end: start + text.length };
    };
    const quality = result?.ok ? {
        minimum: reference.minimumQualifications.map((text: string) => ({ text, covered: result.structured.requirements.some((r: any) => r.level === 'required' && r.evidence.some((e: any) => e.start <= spans(text).start && e.end >= spans(text).end)) })),
        preferred: reference.preferredQualifications.map((text: string) => ({ text, covered: result.structured.requirements.some((r: any) => r.level === 'preferred' && r.evidence.some((e: any) => e.start <= spans(text).start && e.end >= spans(text).end)) })),
        years: reference.experienceClauses.map((text: string, index: number) => ({ text, covered: result.structured.requirements.some((r: any) => r.minimumYears === reference.experienceThresholds[index] && r.scope.kind === 'role' && r.evidence.some((e: any) => e.start <= spans(text).start && e.end >= spans(text).end)) })),
        alternatives: reference.alternativeClauses.map((text: string) => ({ text, covered: result.structured.alternativeGroups.some((g: any) => result.structured.requirements.filter((r: any) => r.groupId === g.id && r.evidence.some((e: any) => e.start <= spans(text).start && e.end >= spans(text).end)).length >= 2) })),
        workEvidence: reference.workArrangement.map((text: string) => ({ text, preserved: metadata?.diagnostics?.inventory.items.some(i => i.start <= spans(text).start && i.end >= spans(text).end) })),
        diagnostics: buildExtractionCoverage({ rawJd: job!.descriptionText, jdHash: job!.jdContentHash!, structured: result.structured }),
    } : null;
    const row = { name, mode, index, startedAt: new Date(Date.now() - elapsedMs).toISOString(), elapsedMs, before, metadata, result, error, quality, after: await (await fetch(values['ollama-url'] + '/api/ps')).json() };
    results.push(row);
    save(name + '.json', row);
    console.log(JSON.stringify({ name, ok: result?.ok ?? false, error, elapsedMs, requests: metadata?.requestCount, repair: metadata?.repairCount, quality: quality ? Object.fromEntries(['minimum', 'preferred', 'years', 'alternatives'].map(k => [k, (quality as any)[k].filter((i: any) => i.covered).length])) : null }));
}
try {
    save('configuration.json', { values, jobId: job.id, jdHash: job.jdContentHash, sourceHashes: Object.fromEntries(['src/semantic/ollama-provider.ts', 'src/semantic/source-coverage.ts', 'src/semantic/compact-annotations.ts', values.reference].map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])), referenceProvenance: 'agent-authored source comparison; NOT independent human attestation', hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length }, startedAt: new Date().toISOString(), ollama: await (await fetch(values['ollama-url'] + '/api/version')).json() });
    if (values.mode !== 'warm')
        for (let i = 1; i <= runs; i++)
            await run(provider(), 'cold', i);
    if (values.mode !== 'cold') {
        warm = provider();
        await warm.beginTask(true);
        save('preload.json', warm.metadata() ?? { verifiedResidency: await (await fetch(values['ollama-url'] + '/api/ps')).json() });
        for (let i = 1; i <= runs; i++)
            await run(warm, 'warm', i);
    }
}
finally {
    if (warm)
        await warm.endTask();
    stopped = true;
    await sampling;
    await sample();
    save('resources.json', samples);
    save('results.json', results);
    save('final-residency.json', { ps: await (await fetch(values['ollama-url'] + '/api/ps')).json(), lifecycle: warm?.metadata()?.lifecycle });
}

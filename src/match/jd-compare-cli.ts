import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseCanonicalJob } from "../semantic/parse-job.js";
import { OllamaJobSemanticProvider } from "../semantic/ollama-provider.js";
import { compareExtractions } from "./jd-compare.js";
import { loadStoredJobs } from "./jd-source.js";
import { RulesJobSemanticProvider } from "./rules-provider.js";

// npm run match:jd-compare -- --jobs-file <jsonl> [--model qwen2.5:3b-instruct-q4_K_M]
// Runs the deterministic baseline and the LOCAL Qwen challenger (loopback Ollama, no employer contact) on the same stored JDs and reports
// agreement, rejection (fail closed) and operational cost. Shadow only: nothing is stored and no match result uses the challenger.

const { values } = parseArgs({ options: { "jobs-file": { type: "string" }, model: { type: "string", default: "qwen2.5:3b-instruct-q4_K_M" }, out: { type: "string" } } });
const fail = (m: string, code = 2): never => {
  console.error(m);
  process.exit(code);
};

async function ollamaResident(): Promise<unknown> {
  try {
    const r = await fetch("http://127.0.0.1:11434/api/ps");
    return ((await r.json()) as { models: Array<{ name: string; size: number; size_vram: number }> }).models.map((m) => ({ name: m.name, bytes: m.size, vramBytes: m.size_vram }));
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  if (!values["jobs-file"]) return fail("--jobs-file is required");
  const jobs = loadStoredJobs(values["jobs-file"]);
  const rows = [];
  for (const job of jobs) {
    const base = await parseCanonicalJob(job, new RulesJobSemanticProvider());
    if (!base.ok) { rows.push({ job: `${job.company} / ${job.title}`, baseline: "FAILED", code: base.failure.code }); continue; }
    const provider = new OllamaJobSemanticProvider({ baseUrl: "http://127.0.0.1:11434", model: values.model!, contextTokens: 8192, outputTokens: 2048 });
    const started = Date.now();
    const q = await parseCanonicalJob(job, provider);
    const wallMs = Date.now() - started;
    const meta = provider.metadata();
    rows.push({
      job: `${job.company} / ${job.title}`, jdSha8: (job.jdContentHash ?? "").slice(0, 8), jdChars: job.descriptionText.length, wallMs,
      comparison: compareExtractions(base.structured, q.ok ? q.structured : null, q.ok ? undefined : q.failure.code),
      challengerIssues: q.ok ? [] : q.failure.issues.slice(0, 5).map((i) => `${i.code} ${i.path}: ${i.message}`),
      model: meta ? { served: meta.servedModel, digest: meta.modelDigest, quantization: meta.quantization, requestCount: meta.requestCount, repairCount: meta.repairCount, inputTokens: meta.inputTokens, outputTokens: meta.outputTokens, loadMs: meta.loadDurationMs } : null,
    });
  }
  const failures = rows.filter((r) => "comparison" in r && r.comparison?.challenger.status === "REJECTED").length;
  const report = { schema: "orbital-jd-shadow-compare/1", generatedAt: new Date().toISOString(), mode: "SHADOW", model: values.model, jobs: rows.length, challengerRejected: failures, challengerFailureRate: rows.length ? failures / rows.length : null, resident: await ollamaResident(), rows,
    note: "Label-free: agreement, integrity and cost only. Not accuracy." };
  const dir = path.resolve(values.out ?? path.join("private-runtime", "s4a-eval"));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `jd-shadow-compare-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  console.error(`wrote ${file}`);
  return 0;
}

process.exit(await main().catch((e) => fail(`jd-compare failed: ${e instanceof Error ? e.message : String(e)}`, 1)));

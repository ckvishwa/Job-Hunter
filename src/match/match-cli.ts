import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { JobPosting } from "../adapters/types.js";
import { CandidateRepo } from "../db/candidate-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { OllamaJobSemanticProvider } from "../semantic/ollama-provider.js";
import type { JobSemanticProvider } from "../semantic/provider.js";
import { buildEvidenceCorpus } from "./evidence.js";
import { renderMatchMarkdown, runMatch } from "./pipeline.js";
import { RulesJobSemanticProvider } from "./rules-provider.js";
import { loadStoredJobs, pickJob } from "./jd-source.js";

// npm run match -- --jobs-file <jobs.jsonl> --job <id|index|title text> [--extractor rules|qwen] [--encoder minilm|none] [--json] [--no-write]
// Read-only: it never approves or edits a fact, never contacts an employer (it reads the stored, hash-verified JD), and never submits anything.

const { values } = parseArgs({
  options: {
    "jobs-file": { type: "string" }, job: { type: "string" }, user: { type: "string" }, extractor: { type: "string", default: "rules" }, encoder: { type: "string", default: "minilm" },
    json: { type: "boolean", default: false }, "no-write": { type: "boolean", default: false }, "as-of": { type: "string" }, out: { type: "string" }, model: { type: "string", default: "qwen2.5:3b-instruct-q4_K_M" },
  },
});
const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};

loadEnvFile(DEFAULT_ENV_FILE);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
const asOf = values["as-of"] ?? new Date().toISOString().slice(0, 10);

async function main(): Promise<number> {
  if (!values["jobs-file"]) return fail("--jobs-file <path to a stored jobs .jsonl> is required");
  const jobs = loadStoredJobs(values["jobs-file"]);
  const job: JobPosting | null = pickJob(jobs, values.job);
  if (!job) return fail(`No unique stored job matches "${values.job ?? ""}". Stored: ${jobs.map((j, i) => `${i}: ${j.company} / ${j.title}`).join("; ")}`);

  const pool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
  try {
    const candidates = new CandidateRepo(pool);
    const user = await candidates.findUser(handle);
    if (!user) return fail(`No user "${handle}" in the database.`);
    const corpus = await buildEvidenceCorpus({ pool, candidates, userId: user.id, asOf });
    const selection = await new RolesRepo(pool).getSelection(user.id);

    let provider: JobSemanticProvider = new RulesJobSemanticProvider();
    if (values.extractor === "qwen") provider = new OllamaJobSemanticProvider({ baseUrl: "http://127.0.0.1:11434", model: values.model, contextTokens: 8192, outputTokens: 2048 });
    else if (values.extractor !== "rules") return fail("--extractor must be rules or qwen");

    const useEncoder = values.encoder === "minilm";
    const report = await runMatch({
      job, provider, corpus, asOf, encoder: useEncoder ? new LocalTransformerEncoder() : null, encoderLabel: useEncoder ? "sentence-transformers/all-MiniLM-L6-v2" : null,
      selection: selection ? { workModes: selection.workModes, locations: selection.locations } : null,
    });
    const md = renderMatchMarkdown(report);
    if (!values["no-write"]) {
      const dir = path.resolve(values.out ?? path.join("private-runtime", "match-reports"));
      mkdirSync(dir, { recursive: true });
      const stem = `${job.company}-${job.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) + `-${(job.jdContentHash ?? "nohash").slice(0, 8)}-${values.extractor}`;
      writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(report, null, 2) + "\n");
      writeFileSync(path.join(dir, `${stem}.md`), md);
      console.error(`wrote ${path.join(dir, stem)}.{json,md}`);
    }
    console.log(values.json ? JSON.stringify(report, null, 2) : md);
    return report.status === "COMPLETE" ? 0 : 3;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch((error) => fail(`match failed: ${error instanceof Error ? error.message : String(error)}`, 1));

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { JobsRepo } from "../db/jobs-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { LocalTransformerEncoder } from "../nlu/local-transformer.js";
import { renderMatchMarkdown } from "./pipeline.js";
import { MatchStore } from "./store.js";

// npm run match:store -- list | run --job <atsIdentity|jobId> [--encoder minilm|none] [--force] | show --job <...>
// S3 PostgreSQL job -> S4 match -> persisted, versioned report. Read-only toward candidate facts and employers. Rerunning with identical inputs reuses the stored row.

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { job: { type: "string" }, all: { type: "boolean", default: false }, encoder: { type: "string", default: "minilm" }, force: { type: "boolean", default: false }, user: { type: "string" }, json: { type: "boolean", default: false }, out: { type: "string" } } });
const fail = (m: string, code = 2): never => {
  console.error(m);
  process.exit(code);
};
loadEnvFile(DEFAULT_ENV_FILE);

async function main(): Promise<number> {
  if (!["list", "run", "show"].includes(command ?? "")) return fail("usage: match:store list | run --job <id> | show --job <id>");
  const pool = createPool(pgSettingsFromEnv(), { max: 3, connectTimeoutMs: 15_000 });
  try {
    const candidates = new CandidateRepo(pool);
    const jobs = new JobsRepo(pool);
    const user = await candidates.findUser(values.user ?? process.env.JH_USER_HANDLE ?? "local");
    if (!user) return fail("No such user.");
    const store = new MatchStore({ pool, candidates, jobs, encoder: values.encoder === "minilm" ? () => new LocalTransformerEncoder() : null });
    if (command === "list") {
      const l = await store.list(user.id);
      for (const j of l.jobs) console.log(`${j.jobId}  ${j.atsIdentity.padEnd(34)} ${j.company} / ${j.title}  |  ${j.match ? `${j.match.status}${j.match.current ? "" : ` STALE(${j.match.staleReasons.join(",")})`} ${j.match.summary ? `req S${j.match.summary.required.SUPPORTED}/P${j.match.summary.required.PARTIAL}/U${j.match.summary.required.UNSUPPORTED}/?${j.match.summary.required.UNKNOWN}` : ""}` : "no match yet"}`);
      console.log(`${l.total} job(s)`);
      return 0;
    }
    if (command === "run" && values.all) {
      const l = await store.list(user.id, 100);
      let computed = 0, reused = 0;
      for (const j of l.jobs) {
        const out = await store.compute(user.id, j.jobId, { force: values.force });
        if (out?.computed) computed += 1; else reused += 1;
      }
      console.log(JSON.stringify({ jobs: l.jobs.length, computed, reusedUnchanged: reused }));
      return 0;
    }
    if (!values.job) return fail("--job <atsIdentity|jobId> is required");
    const row = (await pool.query("SELECT j.id FROM jobs j WHERE j.ats_identity=$1 OR j.id::text=$1", [values.job])).rows[0];
    if (!row) return fail("No such stored job.");
    if (command === "show") {
      const g = await store.get(user.id, row.id);
      if (!g?.match) return fail("No stored match yet; run: match:store run --job ...", 1);
      console.log(values.json ? JSON.stringify({ current: g.current, staleReasons: g.staleReasons, match: g.match }, null, 2) : `${g.current ? "CURRENT" : `STALE (${g.staleReasons.join(", ")})`}  stored ${g.match.createdAt}\n\n${renderMatchMarkdown(g.match.report)}`);
      return 0;
    }
    const out = await store.compute(user.id, row.id, { force: values.force });
    if (!out) return fail("No such job for this user.");
    console.error(out.computed ? `computed${out.superseded ? ` (superseded ${out.superseded.id}: inputs changed)` : ""}${out.embeddingCache ? `; embedding cache hits ${out.embeddingCache.hits}, misses ${out.embeddingCache.misses}` : ""}` : "reused the stored match: every input is identical (nothing recomputed)");
    if (values.out) {
      mkdirSync(path.resolve(values.out), { recursive: true });
      writeFileSync(path.join(path.resolve(values.out), `${out.match.jobId}-${out.match.inputDigest.slice(0, 8)}.md`), renderMatchMarkdown(out.match.report));
    }
    console.log(values.json ? JSON.stringify(out.match, null, 2) : `match ${out.match.id}\n  status ${out.match.status}  input ${out.match.inputDigest.slice(0, 12)}  jd ${out.match.jdSha256.slice(0, 12)}\n  profile ${out.match.versions.profileId}  evidence ${out.match.versions.evidenceDigest.slice(0, 12)}  extractor ${out.match.versions.extractorRevision}`);
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exitCode = await main().catch((e) => fail(`match:store ${command} failed: ${e instanceof Error ? e.message : String(e)}`, 1));

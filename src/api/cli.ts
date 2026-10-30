import path from "node:path";
import { createAiClient } from "../ai/client.js";
import { CandidateRepo } from "../db/candidate-repo.js";
import { migrationsCurrent } from "../db/migrate.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { loadApiConfig } from "./config.js";
import { ExtractionQueue } from "./extraction.js";
import { createFileStore } from "./file-store.js";
import { JobsRepo } from "../db/jobs-repo.js";
import { DiscoveryRunner, loadBoardsConfig } from "../jobs/runner.js";
import { defaultLimits } from "./jobs-routes.js";
import { buildServer } from "./server.js";

// npm run api   (loopback only; reads infra/.env; refuses to start if migrations are pending)
loadEnvFile(DEFAULT_ENV_FILE);
const config = loadApiConfig();
const pool = createPool(pgSettingsFromEnv());
if (!(await migrationsCurrent(pool))) {
  console.error("Database migrations are pending. Run: npm run db:migrate");
  await pool.end();
  process.exit(1);
}
const repo = new CandidateRepo(pool);
const files = createFileStore(config.uploadDir);
const ai = createAiClient({ baseUrl: config.aiBaseUrl, serviceToken: config.aiServiceToken, timeoutMs: config.aiTimeoutMs });
const queue = new ExtractionQueue({ repo, ai, files, onEvent: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })) });
const jobsRepo = new JobsRepo(pool);
const runner = new DiscoveryRunner({ repo: jobsRepo, boards: () => loadBoardsConfig(), delayMs: defaultLimits().delayMs, provenancePath: path.resolve("data/listing-provenance.jsonl"), onEvent: (e) => console.log(JSON.stringify(e)) });
const app = await buildServer({ config, repo, files, queue, jobsRepo, runner });
const recovered = await queue.recover();
const resumedRuns = await runner.recover(); // discovery runs a previous process left active continue where they stopped
await app.listen({ host: config.host, port: config.port });
console.log(JSON.stringify({ listening: `${config.host}:${config.port}`, recoveredVersions: recovered, resumedDiscoveryRuns: resumedRuns }));

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await app.close();
  await queue.idle();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

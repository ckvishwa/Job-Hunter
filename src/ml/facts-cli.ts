import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { collectFactFeedback } from "./fact-feedback.js";

// npm run ml:facts [-- --list-bulk]
// Résumé-review history -> parser feedback report (private-runtime/ml/reports). Read-only: it approves, edits and rejects nothing, and reviewer acceptance
// rates here are NOT model accuracy. Kept apart from the job-relevance code on purpose: that code never imports candidate data.

const { values } = parseArgs({ options: { "list-bulk": { type: "boolean", default: false } } });
loadEnvFile(DEFAULT_ENV_FILE);
const pool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
try {
  const fb = await collectFactFeedback(new CandidateRepo(pool));
  const dir = path.resolve("private-runtime", "ml", "reports");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `fact-feedback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(fb, null, 1));
  console.log(JSON.stringify({
    file, parsers: fb.parsers, totals: fb.totals, byKind: fb.byKind, errorClasses: fb.errorClasses, challenger: fb.challenger,
    bulkApprovalCandidates: values["list-bulk"] ? fb.bulkApprovalCandidates : `${fb.bulkApprovalCandidates.length} (use --list-bulk to list; nothing is approved by this command)`,
  }, null, 2));
} finally {
  await pool.end();
}

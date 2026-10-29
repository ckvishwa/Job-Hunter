import { createHash, randomBytes } from "node:crypto";
import { migrate } from "../../src/db/migrate.js";
import { createPool, loadEnvFile, retryConnect, DEFAULT_ENV_FILE, pgSettingsFromEnv } from "../../src/db/pool.js";
import { RolesRepo } from "../../src/db/roles-repo.js";
import type { CorpusInput } from "../../src/ml/repo.js";
import type { TextEncoder } from "../../src/ml/engine.js";

// SYNTHETIC fixtures for the ML engine tests. Every employer, posting and label below is invented by the test author; none is real data and none of it
// is ever used outside a throwaway database. Labels are written by hand from the title/role rule stated next to each template, NOT produced by the code under test.

export async function throwawayDb(): Promise<{ pool: ReturnType<typeof createPool>; dbName: string; drop: () => Promise<void> }> {
  loadEnvFile(DEFAULT_ENV_FILE);
  const dbName = `jh_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const admin = createPool(pgSettingsFromEnv(process.env, "postgres"), { max: 1, connectTimeoutMs: 30_000 });
  await retryConnect(() => admin.query(`CREATE DATABASE ${dbName}`), 5); // connect-phase failures only; statement errors surface
  const pool = createPool(pgSettingsFromEnv(process.env, dbName), { max: 3, connectTimeoutMs: 30_000 });
  // Windows loopback sometimes fails a fresh connect under load (docs/KNOWN_FLAKES.md). Retry only connect-phase failures; statement errors surface.
  const rawQuery = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: unknown }).query = (...a: unknown[]) => retryConnect(() => rawQuery(...a), 5);
  const rawConnect = pool.connect.bind(pool) as (...a: unknown[]) => Promise<unknown>;
  (pool as unknown as { connect: unknown }).connect = (...a: unknown[]) => retryConnect(() => rawConnect(...a), 5);
  await migrate(pool);
  await new RolesRepo(pool).seedCatalog();
  return {
    pool, dbName,
    drop: async () => {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    },
  };
}

/** Deterministic bag-of-words hashing encoder (384 dims): texts that share words are closer. Stands in for MiniLM so tests never load a model. */
export const fakeEncoder: TextEncoder & { calls: number } = {
  calls: 0,
  async embed(text: string) {
    fakeEncoder.calls++;
    const v = new Array<number>(384).fill(0);
    for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      const h = createHash("sha256").update(w).digest();
      v[h.readUInt16BE(0) % 384]! += 1;
      v[h.readUInt16BE(2) % 384]! += 0.5;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return { vector: v.map((x) => x / n) };
  },
};

const SOC_TITLES = ["SOC Analyst", "Security Operations Analyst", "Tier 1 SOC Analyst - Remote", "Cyber Defense Analyst"];
const SOC_JD = (company: string) => `${company} is hiring in our security operations center. You will monitor SIEM alerts in Splunk, perform alert triage, investigate incidents, escalate to incident response and document findings. ` +
  `Requirements: experience with SIEM, log analysis, Windows event logs, MITRE ATT&CK, and detection use cases. Shift work may apply. ` + "We value curiosity and teamwork.";
const OTHER_TITLES = ["Marketing Manager", "Sales Development Representative", "Office Manager"];
const OTHER_JD = (company: string) => `${company} seeks a candidate to grow our brand, manage campaigns, plan events, run budgets and coordinate with agencies and customers. ` +
  "Requirements: communication skills, spreadsheets, presentation skills and stakeholder management. " + "We offer a friendly workplace and growth.";

/** Employer-specific vocabulary so two synthetic employers are NOT near-duplicate JD families (that guard is tested separately). */
const flavour = (company: string): string => Array.from({ length: 45 }, (_, k) => `${company.toLowerCase()}x${k}y${(k * 7) % 11}`).join(" ");

export const SYNTHETIC_ROLE = "soc-analyst";

export interface SyntheticPosting extends CorpusInput { synthetic: { relevantToSoc: boolean } }

export function syntheticCorpus(employers = 20): SyntheticPosting[] {
  const out: SyntheticPosting[] = [];
  for (let e = 1; e <= employers; e++) {
    const company = `Synthco${String(e).padStart(2, "0")}`;
    const board = `synthco${String(e).padStart(2, "0")}`;
    const add = (title: string, jd: string, i: number, relevant: boolean) => {
      const reqId = `${e}${i}`.padStart(6, "0");
      const description = `${jd}\n\nPosting ref ${company}-${reqId}`;
      out.push({
        sourceKey: `greenhouse:${board}:${reqId}`, company, ats: "greenhouse", board, requisitionId: reqId, title, location: "Remote - United States", department: null,
        sourceUrl: `https://boards.greenhouse.io/${board}/jobs/${reqId}`, description, textSha256: createHash("sha256").update(`${title}\n${description}`).digest("hex"), synthetic: { relevantToSoc: relevant },
      });
    };
    SOC_TITLES.forEach((t, i) => add(t, SOC_JD(company), i, true));
    OTHER_TITLES.forEach((t, i) => add(t, OTHER_JD(company), 10 + i, false));
  }
  return out;
}

/** Throwaway-database cleanup only. Lifts the human-label immutability trigger (0010) for one statement; product code never does this. */
export async function purgeHumanLabelsForTest(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query("ALTER TABLE ml_labels DISABLE TRIGGER ml_human_labels_immutable");
  try { await pool.query("DELETE FROM ml_labels"); } finally { await pool.query("ALTER TABLE ml_labels ENABLE TRIGGER ml_human_labels_immutable"); }
}

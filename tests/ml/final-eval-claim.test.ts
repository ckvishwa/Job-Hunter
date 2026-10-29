import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MlRepo } from "../../src/ml/repo.js";
import { dbAvailable } from "../helpers/s1-harness.js";
import { throwawayDb } from "../helpers/ml-fixtures.js";

// Frozen-test reservation (migration 0011). SYNTHETIC hashes on a throwaway database.
const available = await dbAvailable();
const suite = available ? describe : describe.skip;
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

suite("frozen final-evaluation reservation", { timeout: 120_000 }, () => {
  let env: Awaited<ReturnType<typeof throwawayDb>>;
  let repo: MlRepo;
  beforeAll(async () => { env = await throwawayDb(); repo = new MlRepo(env.pool); });
  afterAll(async () => { await env?.drop(); });

  it("grants exactly one of many concurrent claims, then refuses every repeat", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => repo.claimFinalEvaluation(H1, "ds-x", `rev-${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.claimFinalEvaluation(H1, "ds-x", "rev-late")).toBe(false);
    expect((await env.pool.query("SELECT count(*)::int n FROM ml_final_eval_claims WHERE split_hash=$1", [H1])).rows[0].n).toBe(1);
  });

  it("an interrupted attempt stays RESERVED and cannot be re-claimed, deleted, truncated or reset", async () => {
    expect(await repo.claimFinalEvaluation(H2, "ds-y", "rev-y")); // claimed, never completed: simulates a crash
    expect(await repo.claimFinalEvaluation(H2, "ds-y", "rev-y")).toBe(false);
    await expect(env.pool.query("DELETE FROM ml_final_eval_claims WHERE split_hash=$1", [H2])).rejects.toThrow(/append-only/);
    await expect(env.pool.query("TRUNCATE ml_final_eval_claims")).rejects.toThrow(/append-only/);
    await expect(env.pool.query("UPDATE ml_final_eval_claims SET selected_revision='other' WHERE split_hash=$1", [H2])).rejects.toThrow(/only RESERVED -> COMPLETED/);
    await expect(env.pool.query("UPDATE ml_final_eval_claims SET split_hash=$1 WHERE split_hash=$2", ["c".repeat(64), H2])).rejects.toThrow(/only RESERVED -> COMPLETED/);
    const st = (await env.pool.query("SELECT state FROM ml_final_eval_claims WHERE split_hash=$1", [H2])).rows[0].state;
    expect(st).toBe("RESERVED");
  });

  it("completion is one-way", async () => {
    await repo.completeFinalEvaluation(H2);
    const row = (await env.pool.query("SELECT state, completed_at FROM ml_final_eval_claims WHERE split_hash=$1", [H2])).rows[0];
    expect(row.state).toBe("COMPLETED");
    expect(row.completed_at).not.toBeNull();
    await expect(env.pool.query("UPDATE ml_final_eval_claims SET state='RESERVED', completed_at=NULL WHERE split_hash=$1", [H2])).rejects.toThrow(/only RESERVED -> COMPLETED|check/);
  });

  it("synthetic claims never consume the real reservation for the same split hash", async () => {
    const H3 = "d".repeat(64);
    expect(await repo.claimFinalEvaluation(H3, "ds-z", "r", "synthetic")).toBe(true);
    expect(await repo.claimFinalEvaluation(H3, "ds-z", "r", "synthetic")).toBe(false);
    expect(await repo.claimFinalEvaluation(H3, "ds-z", "r", "real")).toBe(true);
  });

  it("human and provisional ledgers cannot be truncated", async () => {
    for (const t of ["ml_labels", "ml_llm_labels", "ml_llm_rejects"]) await expect(env.pool.query(`TRUNCATE ${t} CASCADE`)).rejects.toThrow(/append-only/);
  });
});

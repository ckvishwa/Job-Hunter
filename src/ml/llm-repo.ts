import type pg from "pg";
import { retryConnect } from "../db/pool.js";
import type { LlmOutput, RejectReason, EvidenceLocation } from "./llm-label.js";

// Storage for PROVISIONAL (llm_provisional) labels. ml_llm_labels is append-only and physically separate from ml_labels (human). Only the LLM workflow
// modules (llm-workflows, llm-cli, llm-review-cli) may import this file; dataset building, training and evaluation never do (tested).

export interface LlmLabelRow {
  id: number; postingId: string; sourceKey: string; textSha256: string; roleSlug: string; pass: "A" | "B"; provider: string; model: string; modelDigest: string | null;
  promptVersion: string; relevance: LlmOutput["relevance"]; seniority: string; workMode: string; confidence: number; evidence: string[]; evidenceLocations?: EvidenceLocation[]; reasoning: string;
  jdCharsSent: number; jdTruncated: boolean; latencyMs: number | null; runId: string; createdAt: Date;
}

export interface NewLlmLabel extends Omit<LlmLabelRow, "id" | "createdAt"> {}

const rowOf = (r: Record<string, unknown>): LlmLabelRow => ({
  id: Number(r.id), postingId: r.posting_id as string, sourceKey: r.source_key as string, textSha256: (r.text_sha256 as string).trim(), roleSlug: r.role_slug as string, pass: r.pass as "A" | "B",
  provider: r.provider as string, model: r.model as string, modelDigest: (r.model_digest as string | null) ?? null, promptVersion: r.prompt_version as string,
  relevance: r.relevance as LlmLabelRow["relevance"], seniority: r.seniority as string, workMode: r.work_mode as string, confidence: Number(r.confidence),
  evidence: r.evidence as string[], evidenceLocations: (r.evidence_locations ?? []) as EvidenceLocation[], reasoning: r.reasoning as string, jdCharsSent: Number(r.jd_chars_sent), jdTruncated: r.jd_truncated as boolean,
  latencyMs: r.latency_ms == null ? null : Number(r.latency_ms), runId: r.run_id as string, createdAt: r.created_at as Date,
});

export class LlmRepo {
  constructor(private readonly pool: pg.Pool) {}

  async save(l: NewLlmLabel): Promise<{ id: number; duplicate: boolean }> {
    const r = await retryConnect(() => this.pool.query(
      `INSERT INTO ml_llm_labels (posting_id, source_key, text_sha256, role_slug, pass, provider, model, model_digest, prompt_version, relevance, seniority, work_mode, confidence, evidence, reasoning, jd_chars_sent, jd_truncated, latency_ms, run_id, evidence_locations)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20::jsonb)
       ON CONFLICT (posting_id, text_sha256, role_slug, pass, model, prompt_version) DO NOTHING RETURNING id`,
      [l.postingId, l.sourceKey, l.textSha256, l.roleSlug, l.pass, l.provider, l.model, l.modelDigest, l.promptVersion, l.relevance, l.seniority, l.workMode, l.confidence, JSON.stringify(l.evidence), l.reasoning.slice(0, 1200), l.jdCharsSent, l.jdTruncated, l.latencyMs, l.runId, JSON.stringify(l.evidenceLocations ?? [])],
    ));
    return r.rows[0] ? { id: Number((r.rows[0] as { id: string }).id), duplicate: false } : { id: 0, duplicate: true };
  }

  async reject(r: { postingId: string; textSha256: string; roleSlug: string; pass: "A" | "B"; model: string; promptVersion: string; reason: RejectReason; detail: string; runId: string }): Promise<void> {
    await retryConnect(() => this.pool.query("INSERT INTO ml_llm_rejects (posting_id, text_sha256, role_slug, pass, model, prompt_version, reason, detail, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (posting_id, text_sha256, role_slug, pass, model, prompt_version, reason, run_id) DO NOTHING", [r.postingId, r.textSha256, r.roleSlug, r.pass, r.model, r.promptVersion, r.reason, r.detail.slice(0, 400), r.runId]));
  }

  async all(model?: string, promptVersion?: string): Promise<LlmLabelRow[]> {
    const rows = (await retryConnect(() => this.pool.query("SELECT * FROM ml_llm_labels WHERE ($1::text IS NULL OR model=$1) AND ($2::text IS NULL OR prompt_version=$2) ORDER BY id", [model ?? null, promptVersion ?? null]))).rows as Array<Record<string, unknown>>;
    return rows.map(rowOf);
  }

  async byIds(ids: readonly number[]): Promise<LlmLabelRow[]> {
    if (!ids.length) return [];
    return (await retryConnect(() => this.pool.query("SELECT * FROM ml_llm_labels WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]))).rows.map((r) => rowOf(r as Record<string, unknown>));
  }

  async rejects(): Promise<Array<{ postingId: string; textSha256: string; roleSlug: string; pass: string; reason: string; detail: string | null; model: string }>> {
    return (await retryConnect(() => this.pool.query("SELECT posting_id, text_sha256, role_slug, pass, reason, detail, model FROM ml_llm_rejects ORDER BY id"))).rows.map((r) => ({ postingId: r.posting_id as string, textSha256: (r.text_sha256 as string).trim(), roleSlug: r.role_slug as string, pass: r.pass as string, reason: r.reason as string, detail: r.detail as string | null, model: r.model as string }));
  }

  /** Pass A / pass B rows of one model+prompt, keyed `postingId|roleSlug|textSha`. */
  async byPair(model: string, promptVersion: string): Promise<Map<string, { A?: LlmLabelRow; B?: LlmLabelRow }>> {
    const out = new Map<string, { A?: LlmLabelRow; B?: LlmLabelRow }>();
    for (const l of await this.all(model, promptVersion)) {
      const k = `${l.postingId}|${l.roleSlug}|${l.textSha256}`;
      out.set(k, { ...(out.get(k) ?? {}), [l.pass]: l });
    }
    return out;
  }
}

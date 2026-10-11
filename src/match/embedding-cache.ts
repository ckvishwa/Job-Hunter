import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { EvidenceUnit } from "./evidence.js";

// Embedding cache for APPROVED, authorized candidate evidence only (migration 0005). A vector is reusable iff ALL of these are identical: the owning user and active profile,
// the evidence unit, the fact's content digest (an edit, rejection or re-approval changes it), the exact normalized text, and the encoder identity (model, revision,
// tokenizer/preprocessing). Anything no longer in the current authorized corpus is purged, so revoking a source or rejecting a fact also removes its vectors.

export const PREPROCESS_REVISION = "minilm-chunk-mean-pool@1";

export interface EncoderIdentity { modelId: string; modelRevision: string; preprocess: string }

export const textSha = (text: string): string => createHash("sha256").update(text.normalize("NFC").trim(), "utf8").digest("hex");
const toBytes = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);
const fromBytes = (b: Buffer): number[] => Array.from(new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4));

export interface VectorCache {
  get(unit: EvidenceUnit): Promise<number[] | null>;
  put(unit: EvidenceUnit, vector: number[]): Promise<void>;
}

export class PgEmbeddingCache implements VectorCache {
  hits = 0;
  misses = 0;
  constructor(private readonly pool: Pool, private readonly scope: { userId: string; profileId: string }, private readonly encoder: EncoderIdentity) {}

  private key(unit: EvidenceUnit): unknown[] {
    return [this.scope.userId, this.scope.profileId, unit.unitId, unit.verification.contentDigest, textSha(unit.text), this.encoder.modelId, this.encoder.modelRevision, this.encoder.preprocess];
  }

  async get(unit: EvidenceUnit): Promise<number[] | null> {
    const { rows } = await this.pool.query<{ vector: Buffer; dims: number }>(
      `SELECT vector, dims FROM embedding_cache WHERE user_id=$1 AND profile_id=$2 AND unit_id=$3 AND content_digest=$4 AND text_sha256=$5 AND model_id=$6 AND model_revision=$7 AND preprocess_rev=$8`, this.key(unit));
    const r = rows[0];
    if (!r || r.vector.byteLength !== r.dims * 4) { this.misses += 1; return null; }
    this.hits += 1;
    return fromBytes(r.vector);
  }

  async put(unit: EvidenceUnit, vector: number[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO embedding_cache (user_id, profile_id, unit_id, content_digest, text_sha256, model_id, model_revision, preprocess_rev, dims, vector) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`, [...this.key(unit), vector.length, toBytes(vector)]);
  }
}

/** Removes every cached vector of this user that the current authorized corpus no longer contains (revoked source, rejected/edited fact, other profile, other model). */
export async function pruneEmbeddingCache(pool: Pool, userId: string, profileId: string | null, units: readonly EvidenceUnit[], encoder: EncoderIdentity | null): Promise<number> {
  if (!profileId || !encoder || units.length === 0) {
    const r = await pool.query("DELETE FROM embedding_cache WHERE user_id=$1", [userId]);
    return r.rowCount ?? 0;
  }
  const keep = units.map((u) => `${u.unitId}|${u.verification.contentDigest}|${textSha(u.text)}`);
  const r = await pool.query(
    `DELETE FROM embedding_cache WHERE user_id=$1 AND NOT (profile_id=$2 AND model_id=$3 AND model_revision=$4 AND preprocess_rev=$5 AND (unit_id || '|' || content_digest || '|' || text_sha256) = ANY($6::text[]))`,
    [userId, profileId, encoder.modelId, encoder.modelRevision, encoder.preprocess, keep]);
  return r.rowCount ?? 0;
}

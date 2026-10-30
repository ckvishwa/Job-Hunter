import type pg from "pg";
import { labelInput, type LabelInputIn } from "./types.js";
import type { DatasetItem, Split } from "./split.js";

export interface CorpusRow {
  id: string; sourceKey: string; company: string; ats: string; board: string; requisitionId: string;
  title: string; location: string | null; department: string | null; sourceUrl: string; description: string; textSha256: string;
}
export type CorpusInput = Omit<CorpusRow, "id">;

export class MlLabelError extends Error {
  constructor(readonly code: "UNKNOWN_POSTING" | "STALE_TEXT" | "INVALID_LABEL", message: string) {
    super(message);
    this.name = "MlLabelError";
  }
}

const rowOf = (r: Record<string, unknown>): CorpusRow => ({
  id: r.id as string, sourceKey: r.source_key as string, company: r.company as string, ats: r.ats as string, board: r.board as string,
  requisitionId: r.requisition_id as string, title: r.title as string, location: (r.location as string | null) ?? null, department: (r.department as string | null) ?? null,
  sourceUrl: r.source_url as string, description: r.description_text as string, textSha256: (r.text_sha256 as string).trim(),
});

export interface CurrentLabel { id: number; postingId: string; textSha256: string; task: string; roleSlug: string; value: string; reviewer: string; reviewedAt: Date; selectionBasis: string }

export interface LabelRow extends CurrentLabel { note: string | null; sessionId: string }

export interface EmbeddingKey { subjectKey: string; textSha256: string; kind: string; chunk: number; preprocess: string; modelId: string; modelRevision: string }

export type ModelStatus = "candidate" | "shadow" | "promoted" | "retired";
export interface ModelRecord { revision: string; candidate: string; datasetVersion: string; splitHash: string; artifactPath: string; artifactSha256: string; featureRevision: string; libraryVersions: Record<string, string>; seed: number; status: ModelStatus; metrics: unknown }

export class MlRepo {
  constructor(private readonly pool: pg.Pool) {}

  async upsertCorpus(rows: readonly CorpusInput[], snapshotId: string): Promise<{ inserted: number; changed: number; unchanged: number }> {
    let inserted = 0, changed = 0, unchanged = 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        const prior = (await client.query("SELECT text_sha256 FROM ml_corpus_postings WHERE source_key=$1", [r.sourceKey])).rows[0] as { text_sha256: string } | undefined;
        if (!prior) inserted++; else if (prior.text_sha256.trim() !== r.textSha256) changed++; else { unchanged++; continue; }
        await client.query(
          `INSERT INTO ml_corpus_postings (source_key, company, ats, board, requisition_id, title, location, department, source_url, description_text, text_sha256, snapshot_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (source_key) DO UPDATE SET title=EXCLUDED.title, location=EXCLUDED.location, department=EXCLUDED.department, source_url=EXCLUDED.source_url,
             description_text=EXCLUDED.description_text, text_sha256=EXCLUDED.text_sha256, snapshot_id=EXCLUDED.snapshot_id, fetched_at=now()`,
          [r.sourceKey, r.company, r.ats, r.board, r.requisitionId, r.title, r.location, r.department, r.sourceUrl, r.description, r.textSha256, snapshotId],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return { inserted, changed, unchanged };
  }

  async corpus(): Promise<CorpusRow[]> {
    return (await this.pool.query("SELECT * FROM ml_corpus_postings ORDER BY source_key")).rows.map(rowOf);
  }

  async posting(id: string): Promise<CorpusRow | null> {
    const r = (await this.pool.query("SELECT * FROM ml_corpus_postings WHERE id=$1", [id])).rows[0];
    return r ? rowOf(r) : null;
  }

  async getEmbedding(k: EmbeddingKey): Promise<number[] | null> {
    const r = (await this.pool.query(
      "SELECT vector FROM ml_job_embeddings WHERE subject_key=$1 AND text_sha256=$2 AND kind=$3 AND chunk_index=$4 AND preprocess=$5 AND model_id=$6 AND model_revision=$7",
      [k.subjectKey, k.textSha256, k.kind, k.chunk, k.preprocess, k.modelId, k.modelRevision])).rows[0] as { vector: number[] } | undefined;
    return r ? r.vector : null;
  }

  async putEmbedding(e: EmbeddingKey & { jdSha256: string | null; vector: readonly number[] }): Promise<void> {
    await this.pool.query(
      `INSERT INTO ml_job_embeddings (subject_key, text_sha256, jd_sha256, kind, chunk_index, preprocess, model_id, model_revision, dims, vector)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [e.subjectKey, e.textSha256, e.jdSha256, e.kind, e.chunk, e.preprocess, e.modelId, e.modelRevision, e.vector.length, e.vector]);
  }

  /**
   * Validates, binds the label to the exact text the reviewer saw and appends. Never updates or deletes an earlier label. A label that repeats the
   * newest value for the same (posting, task, role, text) is not stored again (no duplicate rows); its existing id is returned.
   */
  async saveLabel(input: LabelInputIn): Promise<{ id: number; duplicate: boolean }> {
    const parsed = labelInput.safeParse(input);
    if (!parsed.success) throw new MlLabelError("INVALID_LABEL", parsed.error.issues[0]?.message ?? "invalid label");
    const l = parsed.data;
    const posting = await this.posting(l.postingId);
    if (!posting) throw new MlLabelError("UNKNOWN_POSTING", "No such corpus posting.");
    if (posting.textSha256 !== l.textSha256) throw new MlLabelError("STALE_TEXT", "The posting text changed since the reviewer saw it.");
    const newest = (await this.pool.query("SELECT id, value, note FROM ml_labels WHERE posting_id=$1 AND task=$2 AND role_slug=$3 AND text_sha256=$4 ORDER BY id DESC LIMIT 1", [l.postingId, l.task, l.roleSlug, l.textSha256])).rows[0] as { id: string; value: string; note: string | null } | undefined;
    if (newest && newest.value === l.value && (newest.note ?? null) === (l.note ?? null)) return { id: Number(newest.id), duplicate: true };
    const r = await this.pool.query(
      `INSERT INTO ml_labels (posting_id, text_sha256, task, role_slug, value, reviewer, session_id, selection_basis, note, origin, llm_label_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [l.postingId, l.textSha256, l.task, l.roleSlug, l.value, l.reviewer, l.sessionId, l.selectionBasis, l.note ?? null, l.origin, l.llmLabelIds ?? null],
    );
    return { id: Number((r.rows[0] as { id: string }).id), duplicate: false };
  }

  /** Newest label per (posting, task, role_slug). */
  async currentLabels(): Promise<CurrentLabel[]> {
    const rows = (await this.pool.query(
      `SELECT DISTINCT ON (posting_id, task, role_slug) id, posting_id, text_sha256, task, role_slug, value, reviewer, reviewed_at, selection_basis
       FROM ml_labels ORDER BY posting_id, task, role_slug, id DESC`,
    )).rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), postingId: r.posting_id as string, textSha256: (r.text_sha256 as string).trim(), task: r.task as string, roleSlug: r.role_slug as string, value: r.value as string, reviewer: r.reviewer as string, reviewedAt: r.reviewed_at as Date, selectionBasis: r.selection_basis as string }));
  }

  private labelRow(r: Record<string, unknown>): LabelRow {
    return { id: Number(r.id), postingId: r.posting_id as string, textSha256: (r.text_sha256 as string).trim(), task: r.task as string, roleSlug: r.role_slug as string, value: r.value as string, reviewer: r.reviewer as string, reviewedAt: r.reviewed_at as Date, selectionBasis: r.selection_basis as string, note: (r.note as string | null) ?? null, sessionId: r.session_id as string };
  }

  async labelById(id: number): Promise<LabelRow | null> {
    const r = (await this.pool.query("SELECT * FROM ml_labels WHERE id=$1", [id])).rows[0] as Record<string, unknown> | undefined;
    return r ? this.labelRow(r) : null;
  }

  /** Every label ever saved for one (posting, task, role), oldest first: the full correction history. */
  async labelHistory(postingId: string, task: string, roleSlug: string): Promise<LabelRow[]> {
    return (await this.pool.query("SELECT * FROM ml_labels WHERE posting_id=$1 AND task=$2 AND role_slug=$3 ORDER BY id", [postingId, task, roleSlug])).rows.map((r) => this.labelRow(r as Record<string, unknown>));
  }

  async labelBasisByIds(ids: readonly number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const rows = (await this.pool.query("SELECT id, selection_basis FROM ml_labels WHERE id = ANY($1::bigint[])", [ids])).rows as Array<{ id: string; selection_basis: string }>;
    return new Map(rows.map((r) => [Number(r.id), r.selection_basis]));
  }

  /** How each human relevance label came to be, and whether the person saw a model proposal. Provenance only. */
  async humanOrigins(): Promise<Map<number, { origin: string; llm: boolean }>> {
    const rows = (await this.pool.query("SELECT id, origin, llm_label_ids FROM ml_labels WHERE task='relevance'")).rows as Array<{ id: string; origin: string; llm_label_ids: string[] | null }>;
    return new Map(rows.map((r) => [Number(r.id), { origin: r.origin, llm: !!r.llm_label_ids?.length }]));
  }

  async allLabelRows(): Promise<LabelRow[]> {
    return (await this.pool.query("SELECT * FROM ml_labels ORDER BY id")).rows.map((r) => this.labelRow(r as Record<string, unknown>));
  }

  async labelHistoryCount(): Promise<number> {
    return Number(((await this.pool.query("SELECT count(*) c FROM ml_labels")).rows[0] as { c: string }).c);
  }

  /** Side each employer already has in an earlier dataset version (held-out wins), so a frozen held-out employer never moves to train. */
  async priorSplits(): Promise<Map<string, Split>> {
    const rows = (await this.pool.query("SELECT lower(company) AS company, bool_or(split='heldout') AS held FROM ml_dataset_items GROUP BY lower(company)")).rows as Array<{ company: string; held: boolean }>;
    return new Map(rows.map((r) => [r.company, r.held ? "heldout" : "train"]));
  }

  async nextDatasetVersion(): Promise<string> {
    const r = (await this.pool.query("SELECT version FROM ml_dataset_versions ORDER BY version DESC LIMIT 1")).rows[0] as { version: string } | undefined;
    return `ds-${String((r ? Number(r.version.slice(3)) : 0) + 1).padStart(4, "0")}`;
  }

  async latestDatasetVersion(): Promise<string | null> {
    const r = (await this.pool.query("SELECT version FROM ml_dataset_versions ORDER BY version DESC LIMIT 1")).rows[0] as { version: string } | undefined;
    return r?.version ?? null;
  }

  async datasetManifest(version: string): Promise<{ splitHash: string; manifest: Record<string, unknown> } | null> {
    const r = (await this.pool.query("SELECT split_hash, manifest FROM ml_dataset_versions WHERE version=$1", [version])).rows[0] as { split_hash: string; manifest: Record<string, unknown> } | undefined;
    return r ? { splitHash: r.split_hash.trim(), manifest: r.manifest } : null;
  }

  async createDataset(version: string, createdBy: string, splitHash: string, manifest: Record<string, unknown>, items: readonly DatasetItem[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO ml_dataset_versions (version, created_by, split_hash, manifest) VALUES ($1,$2,$3,$4)", [version, createdBy, splitHash, JSON.stringify(manifest)]);
      for (const it of items) {
        await client.query(
          "INSERT INTO ml_dataset_items (version, posting_id, role_slug, text_sha256, company, group_key, split, relevance, seniority, work_mode, label_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [version, it.postingId, it.roleSlug, it.textSha256, it.company, it.groupKey, it.split, it.relevance, it.seniority, it.workMode, it.labelIds]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async datasetItems(version: string): Promise<DatasetItem[]> {
    const rows = (await this.pool.query("SELECT * FROM ml_dataset_items WHERE version=$1 ORDER BY posting_id, role_slug", [version])).rows as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      postingId: r.posting_id as string, roleSlug: r.role_slug as string, textSha256: (r.text_sha256 as string).trim(), company: r.company as string, groupKey: r.group_key as string,
      split: r.split as Split, relevance: r.relevance as DatasetItem["relevance"], seniority: (r.seniority as string | null) ?? null, workMode: (r.work_mode as string | null) ?? null,
      labelIds: (r.label_ids as string[]).map(Number),
    }));
  }

  async recordRun(kind: "train" | "evaluate" | "shadow" | "cluster", status: "OK" | "REFUSED" | "NOT_EVALUATED" | "FAILED", fields: { datasetVersion?: string; modelRevision?: string; detail?: unknown; artifactPath?: string }): Promise<string> {
    const r = await this.pool.query("INSERT INTO ml_model_runs (kind, dataset_version, model_revision, status, detail, artifact_path) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [kind, fields.datasetVersion ?? null, fields.modelRevision ?? null, status, JSON.stringify(fields.detail ?? {}), fields.artifactPath ?? null]);
    return (r.rows[0] as { id: string }).id;
  }

  async registerModel(m: Omit<ModelRecord, "status" | "metrics">): Promise<void> {
    await this.pool.query(
      `INSERT INTO ml_models (revision, candidate, dataset_version, split_hash, artifact_path, artifact_sha256, feature_revision, library_versions, seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (revision) DO NOTHING`,
      [m.revision, m.candidate, m.datasetVersion, m.splitHash, m.artifactPath, m.artifactSha256, m.featureRevision, JSON.stringify(m.libraryVersions), m.seed]);
  }

  /**
   * Reserve a frozen test exactly once per (scope, split). The primary key makes the claim atomic across concurrent workers; an interrupted attempt stays
   * RESERVED and the trigger in migration 0011 forbids deleting or resetting it. Synthetic runs use their own scope and can never consume the real one.
   */
  async claimFinalEvaluation(splitHash: string, datasetVersion: string, selectedRevision: string, scope: "real" | "synthetic" = "real"): Promise<boolean> {
    const r = await this.pool.query(
      "INSERT INTO ml_final_eval_claims (scope, split_hash, dataset_version, selected_revision) VALUES ($1,$2,$3,$4) ON CONFLICT (scope, split_hash) DO NOTHING",
      [scope, splitHash, datasetVersion, selectedRevision]);
    return r.rowCount === 1;
  }

  /** Mark a claimed final evaluation as finished. A claim that never reaches this stays RESERVED and requires independent review. */
  async completeFinalEvaluation(splitHash: string, scope: "real" | "synthetic" = "real"): Promise<void> {
    await this.pool.query("UPDATE ml_final_eval_claims SET state='COMPLETED', completed_at=now() WHERE scope=$1 AND split_hash=$2 AND state='RESERVED'", [scope, splitHash]);
  }

  async model(revision: string): Promise<ModelRecord | null> {
    const r = (await this.pool.query("SELECT * FROM ml_models WHERE revision=$1", [revision])).rows[0] as Record<string, any> | undefined;
    return r ? { revision: r.revision, candidate: r.candidate, datasetVersion: r.dataset_version, splitHash: r.split_hash.trim(), artifactPath: r.artifact_path, artifactSha256: r.artifact_sha256.trim(), featureRevision: r.feature_revision, libraryVersions: r.library_versions, seed: r.seed, status: r.status, metrics: r.metrics } : null;
  }

  async models(datasetVersion?: string): Promise<ModelRecord[]> {
    const rows = (await this.pool.query(datasetVersion ? "SELECT revision FROM ml_models WHERE dataset_version=$1 ORDER BY created_at" : "SELECT revision FROM ml_models ORDER BY created_at", datasetVersion ? [datasetVersion] : [])).rows as Array<{ revision: string }>;
    const out: ModelRecord[] = [];
    for (const r of rows) out.push((await this.model(r.revision))!);
    return out;
  }

  async setModelStatus(revision: string, status: ModelStatus, metrics?: unknown): Promise<void> {
    await this.pool.query("UPDATE ml_models SET status=$2, metrics=COALESCE($3, metrics) WHERE revision=$1", [revision, status, metrics === undefined ? null : JSON.stringify(metrics)]);
  }

  async saveShadow(runId: string, rows: ReadonlyArray<{ postingId: string; roleSlug: string; textSha256: string; ruleRelevant: boolean; sim: number; modelRevision: string | null; modelScore: number | null; decision: string | null; inferenceMs: number | null }>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
        await client.query("INSERT INTO ml_shadow_predictions (run_id, posting_id, role_slug, text_sha256, rule_relevant, sim_score, model_revision, model_score, decision, inference_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [runId, r.postingId, r.roleSlug, r.textSha256, r.ruleRelevant, r.sim, r.modelRevision, r.modelScore, r.decision, r.inferenceMs]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}

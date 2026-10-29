import type pg from "pg";
import { candidateFactSchema, factContentDigest, type CandidateFact } from "../domain/candidate-profile.js";
import { RESUME_EXTRACT_CONTRACT } from "../ai/contracts.js";
import {
  FactRuleError,
  assembleProfile,
  digestOfProfile,
  reviewFact,
  type FactDraft,
  type ReviewInput,
} from "../candidate/fact-lifecycle.js";

// PostgreSQL access for the S1 candidate workflow. This module is the only writer of these tables.

export interface ResumeRow {
  id: string;
  sha256: string;
  fileType: "pdf" | "docx";
  byteSize: number;
  storageRef: string;
  createdAt: Date;
}

export type VersionState = "UPLOADED" | "EXTRACTING" | "PROPOSED" | "FAILED";

export interface VersionRow {
  id: string;
  resumeId: string;
  contractRevision: string;
  parserRevision: string | null;
  state: VersionState;
  errorCode: string | null;
  errorDetail: string | null;
  warnings: unknown[];
  stats: unknown;
  updatedAt: Date;
}

export interface FactView {
  factId: string;
  resumeVersionId: string | null;
  kind: CandidateFact["kind"];
  value: string;
  polarity: CandidateFact["polarity"];
  attributes: CandidateFact["attributes"];
  source: CandidateFact["source"];
  span: { start: number; end: number; quote: string } | null;
  proposedBy: "rules" | "qwen" | "user";
  approvalStatus: CandidateFact["approvalStatus"];
  sensitivity: CandidateFact["sensitivity"];
  verification: CandidateFact["verification"];
  contentDigest: string;
  headRevision: number;
  notes: string | null;
}

export interface RevisionView {
  revision: number;
  action: string;
  actor: string;
  explicitConfirmation: boolean;
  contentDigest: string;
  createdAt: Date;
  snapshot: unknown;
}

interface VersionDbRow {
  id: string; resume_id: string; contract_revision: string; parser_revision: string | null; state: VersionState;
  error_code: string | null; error_detail: string | null; warnings: unknown[]; stats: unknown; updated_at: Date;
}
interface FactDbRow {
  id: string; fact_id: string; resume_version_id: string | null; kind: CandidateFact["kind"]; value: string; polarity: CandidateFact["polarity"];
  attributes: CandidateFact["attributes"]; source: CandidateFact["source"]; span: FactView["span"]; proposed_by: FactView["proposedBy"];
  approval_status: CandidateFact["approvalStatus"]; sensitivity: CandidateFact["sensitivity"]; verification: CandidateFact["verification"];
  content_digest: string; head_revision: number; notes: string | null;
}

const toVersion = (r: VersionDbRow): VersionRow => ({
  id: r.id, resumeId: r.resume_id, contractRevision: r.contract_revision, parserRevision: r.parser_revision, state: r.state,
  errorCode: r.error_code, errorDetail: r.error_detail, warnings: r.warnings, stats: r.stats, updatedAt: r.updated_at,
});

export function rowToFact(r: FactDbRow): CandidateFact {
  return candidateFactSchema.parse({
    factId: r.fact_id, kind: r.kind, value: r.value, polarity: r.polarity, attributes: r.attributes, source: r.source,
    verification: r.verification, approvalStatus: r.approval_status, sensitivity: r.sensitivity, ...(r.notes ? { notes: r.notes } : {}),
  });
}

const toFactView = (r: FactDbRow): FactView => {
  const fact = rowToFact(r);
  return {
    factId: r.fact_id, resumeVersionId: r.resume_version_id, kind: r.kind, value: r.value, polarity: r.polarity, attributes: r.attributes,
    source: r.source, span: r.span, proposedBy: r.proposed_by, approvalStatus: r.approval_status, sensitivity: r.sensitivity,
    verification: r.verification, contentDigest: factContentDigest(fact), headRevision: r.head_revision, notes: r.notes,
  };
};

const FACT_COLUMNS = `id, fact_id, resume_version_id, kind, value, polarity, attributes, source, span, proposed_by, approval_status,
  sensitivity, verification, content_digest, head_revision, notes`;

/** Optional guards/provenance for callers that review in bulk (the JSON/CLI workflow). The browser path does not use them. */
export interface ReviewExtras {
  /** Refuse unless the fact is still at this revision (checked under the row lock). */
  expectedHeadRevision?: number;
  /** Recorded in the append-only revision snapshot. Never part of the content digest. */
  provenance?: { channel: string; reason: string | null; batchId: string; changes?: unknown };
  /**
   * Edit only: widen the source quotation. It is verified here against the stored resume text, must overlap the old quotation, and the
   * previous quotation is kept in the append-only revision snapshot.
   */
  span?: { start: number; end: number; quote: string };
}

export class CandidateRepo {
  constructor(readonly pool: pg.Pool) {}

  async ensureUser(handle: string): Promise<{ id: string; handle: string }> {
    const { rows } = await this.pool.query<{ id: string; handle: string }>(
      "INSERT INTO users (handle) VALUES ($1) ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle RETURNING id, handle",
      [handle],
    );
    return rows[0]!;
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // --- uploads ------------------------------------------------------------------------------------------------------

  /** Idempotent: the same bytes for the same user always resolve to the same resume and the same version. */
  async registerResume(input: {
    userId: string; sha256: string; fileType: "pdf" | "docx"; byteSize: number; storageRef: string; retryableErrorCodes: ReadonlySet<string>;
  }): Promise<{ resume: ResumeRow; version: VersionRow; created: boolean; requeued: boolean }> {
    return this.tx(async (c) => {
      const inserted = await c.query(
        `INSERT INTO resumes (user_id, sha256, file_type, byte_size, storage_ref) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, sha256) DO NOTHING RETURNING id, sha256, file_type, byte_size, storage_ref, created_at`,
        [input.userId, input.sha256, input.fileType, input.byteSize, input.storageRef],
      );
      const created = inserted.rowCount === 1;
      const resumeRow = created
        ? inserted.rows[0]
        : (await c.query("SELECT id, sha256, file_type, byte_size, storage_ref, created_at FROM resumes WHERE user_id=$1 AND sha256=$2", [input.userId, input.sha256])).rows[0];
      const resume: ResumeRow = { id: resumeRow.id, sha256: resumeRow.sha256, fileType: resumeRow.file_type, byteSize: resumeRow.byte_size, storageRef: resumeRow.storage_ref, createdAt: resumeRow.created_at };
      await c.query(
        "INSERT INTO resume_versions (resume_id, contract_revision, state) VALUES ($1,$2,'UPLOADED') ON CONFLICT (resume_id, contract_revision) DO NOTHING",
        [resume.id, RESUME_EXTRACT_CONTRACT],
      );
      let version = toVersion((await c.query<VersionDbRow>("SELECT * FROM resume_versions WHERE resume_id=$1 AND contract_revision=$2 FOR UPDATE", [resume.id, RESUME_EXTRACT_CONTRACT])).rows[0]!);
      let requeued = false;
      if (version.state === "FAILED" && version.errorCode && input.retryableErrorCodes.has(version.errorCode)) {
        version = toVersion((await c.query<VersionDbRow>(
          "UPDATE resume_versions SET state='UPLOADED', error_code=NULL, error_detail=NULL, updated_at=now() WHERE id=$1 RETURNING *", [version.id])).rows[0]!);
        requeued = true;
      }
      return { resume, version, created, requeued };
    });
  }

  // --- extraction lifecycle -----------------------------------------------------------------------------------------

  async getVersionWithResume(versionId: string): Promise<{ version: VersionRow; resume: ResumeRow; userId: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT v.*, r.sha256, r.file_type, r.byte_size, r.storage_ref, r.created_at AS resume_created, r.user_id
         FROM resume_versions v JOIN resumes r ON r.id = v.resume_id WHERE v.id = $1`, [versionId]);
    const r = rows[0];
    if (!r) return null;
    return {
      version: toVersion(r),
      resume: { id: r.resume_id, sha256: r.sha256, fileType: r.file_type, byteSize: r.byte_size, storageRef: r.storage_ref, createdAt: r.resume_created },
      userId: r.user_id,
    };
  }

  async pendingVersionIds(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>("SELECT id FROM resume_versions WHERE state IN ('UPLOADED','EXTRACTING') ORDER BY created_at");
    return rows.map((r) => r.id);
  }

  async beginExtraction(versionId: string): Promise<boolean> {
    const r = await this.pool.query("UPDATE resume_versions SET state='EXTRACTING', updated_at=now() WHERE id=$1 AND state IN ('UPLOADED','EXTRACTING')", [versionId]);
    return r.rowCount === 1;
  }

  async failExtraction(versionId: string, code: string, detail: string): Promise<void> {
    await this.pool.query(
      "UPDATE resume_versions SET state='FAILED', error_code=$2, error_detail=$3, updated_at=now() WHERE id=$1 AND state IN ('UPLOADED','EXTRACTING')",
      [versionId, code, detail.slice(0, 500)],
    );
  }

  /** Stores text + PENDING facts atomically. Re-running with the same version inserts nothing new. */
  async completeExtraction(input: {
    versionId: string; userId: string; parserRevision: string; text: string; textSha256: string; warnings: unknown[]; stats: unknown; drafts: FactDraft[];
  }): Promise<{ inserted: number; completed: boolean }> {
    return this.tx(async (c) => {
      const upd = await c.query(
        `UPDATE resume_versions SET state='PROPOSED', parser_revision=$2, extracted_text=$3, text_sha256=$4, warnings=$5::jsonb, stats=$6::jsonb,
           error_code=NULL, error_detail=NULL, updated_at=now() WHERE id=$1 AND state='EXTRACTING'`,
        [input.versionId, input.parserRevision, input.text, input.textSha256, JSON.stringify(input.warnings), JSON.stringify(input.stats)],
      );
      if (upd.rowCount !== 1) return { inserted: 0, completed: false };
      let inserted = 0;
      for (const d of input.drafts) {
        const f = d.fact;
        const digest = factContentDigest(f);
        const res = await c.query<{ id: string }>(
          `INSERT INTO candidate_facts (user_id, fact_id, resume_version_id, fact_key, kind, value, polarity, attributes, source, span, proposed_by,
             approval_status, sensitivity, verification, content_digest, head_revision, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14::jsonb,$15,1,$16)
           ON CONFLICT (resume_version_id, fact_key) DO NOTHING RETURNING id`,
          [input.userId, f.factId, input.versionId, d.factKey, f.kind, f.value, f.polarity, JSON.stringify(f.attributes), JSON.stringify(f.source),
            d.span ? JSON.stringify(d.span) : null, d.proposedBy, f.approvalStatus, f.sensitivity, JSON.stringify(f.verification), digest, f.notes ?? null],
        );
        if (res.rowCount !== 1) continue;
        inserted += 1;
        await c.query(
          `INSERT INTO fact_revisions (fact_pk, revision, action, actor, explicit_confirmation, snapshot, content_digest)
           VALUES ($1, 1, 'PROPOSED', $2, false, $3::jsonb, $4)`,
          [res.rows[0]!.id, `ai:${input.parserRevision}`.slice(0, 200), JSON.stringify({ fact: f, span: d.span, proposedBy: d.proposedBy }), digest],
        );
      }
      return { inserted, completed: true };
    });
  }

  // --- reads --------------------------------------------------------------------------------------------------------

  async findUser(handle: string): Promise<{ id: string; handle: string } | null> {
    const { rows } = await this.pool.query<{ id: string; handle: string }>("SELECT id, handle FROM users WHERE handle=$1", [handle]);
    return rows[0] ?? null;
  }

  /** The newest extraction of one owned resume: version id, the hash of the extracted text, and the text itself. */
  async getResumeSource(userId: string, resumeId: string): Promise<{ versionId: string; textSha256: string; text: string } | null> {
    const { rows } = await this.pool.query<{ id: string; text_sha256: string | null; extracted_text: string | null }>(
      `SELECT v.id, v.text_sha256, v.extracted_text FROM resume_versions v JOIN resumes r ON r.id=v.resume_id
        WHERE r.user_id=$1 AND r.id=$2 AND v.state='PROPOSED' ORDER BY v.updated_at DESC LIMIT 1`, [userId, resumeId]);
    const r = rows[0];
    return r && r.text_sha256 && r.extracted_text !== null ? { versionId: r.id, textSha256: r.text_sha256, text: r.extracted_text } : null;
  }

  async listResumes(userId: string) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.sha256, r.file_type, r.byte_size, r.created_at, v.id AS version_id, v.state, v.error_code, v.parser_revision,
              COUNT(f.id) FILTER (WHERE f.approval_status='pending')  AS pending,
              COUNT(f.id) FILTER (WHERE f.approval_status='approved') AS approved,
              COUNT(f.id) FILTER (WHERE f.approval_status='rejected') AS rejected
         FROM resumes r JOIN resume_versions v ON v.resume_id = r.id
         LEFT JOIN candidate_facts f ON f.resume_version_id = v.id
        WHERE r.user_id = $1 GROUP BY r.id, v.id ORDER BY r.created_at DESC`, [userId]);
    return rows.map((r) => ({
      resumeId: r.id as string, sha256: r.sha256 as string, fileType: r.file_type as string, byteSize: r.byte_size as number, createdAt: r.created_at as Date,
      versionId: r.version_id as string, state: r.state as VersionState, errorCode: r.error_code as string | null, parserRevision: r.parser_revision as string | null,
      counts: { pending: Number(r.pending), approved: Number(r.approved), rejected: Number(r.rejected) },
    }));
  }

  async getResumeDetail(userId: string, resumeId: string) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.sha256, r.file_type, r.byte_size, r.created_at, v.* FROM resumes r JOIN resume_versions v ON v.resume_id = r.id
        WHERE r.user_id=$1 AND r.id=$2 AND v.contract_revision=$3`, [userId, resumeId, RESUME_EXTRACT_CONTRACT]);
    const r = rows[0];
    if (!r) return null;
    return {
      resumeId: r.resume_id as string, sha256: r.sha256 as string, fileType: r.file_type as string, byteSize: r.byte_size as number, createdAt: r.created_at as Date,
      version: toVersion(r), text: (r.extracted_text as string | null) ?? null,
    };
  }

  async listFacts(userId: string, resumeId: string): Promise<FactView[]> {
    const { rows } = await this.pool.query<FactDbRow>(
      `SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 AND resume_version_id IN
         (SELECT v.id FROM resume_versions v JOIN resumes r ON r.id=v.resume_id WHERE r.id=$2 AND r.user_id=$1)
       ORDER BY (span->>'start')::int NULLS LAST, fact_id`, [userId, resumeId]);
    return rows.map(toFactView);
  }

  async listAttestedFacts(userId: string): Promise<FactView[]> {
    const { rows } = await this.pool.query<FactDbRow>(
      `SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 AND resume_version_id IS NULL ORDER BY created_at, fact_id`, [userId]);
    return rows.map(toFactView);
  }

  async getFact(userId: string, factId: string): Promise<FactView | null> {
    const { rows } = await this.pool.query<FactDbRow>(`SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 AND fact_id=$2`, [userId, factId]);
    return rows[0] ? toFactView(rows[0]) : null;
  }

  async listRevisions(userId: string, factId: string): Promise<RevisionView[]> {
    const { rows } = await this.pool.query(
      `SELECT fr.revision, fr.action, fr.actor, fr.explicit_confirmation, fr.content_digest, fr.created_at, fr.snapshot
         FROM fact_revisions fr JOIN candidate_facts f ON f.id = fr.fact_pk WHERE f.user_id=$1 AND f.fact_id=$2 ORDER BY fr.revision`, [userId, factId]);
    return rows.map((r) => ({ revision: r.revision, action: r.action, actor: r.actor, explicitConfirmation: r.explicit_confirmation, contentDigest: r.content_digest, createdAt: r.created_at, snapshot: r.snapshot }));
  }

  /** Revision actions per fact for one résumé (PROPOSED, EDIT, APPROVE, REJECT ...). Read-only; used by diagnostics. */
  async listRevisionActions(userId: string, resumeId: string): Promise<Map<string, Array<{ revision: number; action: string; actor: string; snapshot: unknown }>>> {
    const { rows } = await this.pool.query(
      `SELECT f.fact_id, fr.revision, fr.action, fr.actor, fr.snapshot FROM fact_revisions fr JOIN candidate_facts f ON f.id = fr.fact_pk
        WHERE f.user_id=$1 AND f.resume_version_id IN (SELECT v.id FROM resume_versions v JOIN resumes r ON r.id=v.resume_id WHERE r.id=$2 AND r.user_id=$1)
        ORDER BY f.fact_id, fr.revision`, [userId, resumeId]);
    const out = new Map<string, Array<{ revision: number; action: string; actor: string; snapshot: unknown }>>();
    for (const r of rows) {
      const list = out.get(r.fact_id) ?? [];
      list.push({ revision: r.revision, action: r.action, actor: r.actor, snapshot: r.snapshot });
      out.set(r.fact_id, list);
    }
    return out;
  }

  async listProfileRevisions(userId: string) {
    const { rows } = await this.pool.query(
      "SELECT revision_no, profile_digest, approved_count, reason, created_at FROM profile_revisions WHERE user_id=$1 ORDER BY revision_no", [userId]);
    return rows.map((r) => ({ revisionNo: r.revision_no as number, profileDigest: r.profile_digest as string, approvedCount: r.approved_count as number, reason: r.reason as string, createdAt: r.created_at as Date }));
  }

  // --- review -------------------------------------------------------------------------------------------------------

  async applyReview(userId: string, userHandle: string, factId: string, input: ReviewInput & ReviewExtras): Promise<{ fact: FactView; changed: boolean }> {
    return this.tx(async (c) => {
      const { rows } = await c.query<FactDbRow>(`SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 AND fact_id=$2 FOR UPDATE`, [userId, factId]);
      const row = rows[0];
      if (!row) throw new FactRuleError("NOT_ALLOWED", "Unknown fact.");
      if (input.expectedHeadRevision !== undefined && row.head_revision !== input.expectedHeadRevision) {
        throw new FactRuleError("STALE_FACT", "The fact has a newer revision than the one that was reviewed.");
      }
      const outcome = reviewFact(rowToFact(row), input);
      if (outcome.revisionAction === null) return { fact: toFactView(row), changed: false };
      let nextSpan = row.span;
      if (input.span) {
        const s = input.span;
        if (input.action !== "edit" || !row.span || !row.resume_version_id) throw new FactRuleError("INVALID_EDIT", "Only an extracted fact's evidence can be adjusted, and only by an edit.");
        const text = (await c.query<{ t: string | null }>("SELECT extracted_text AS t FROM resume_versions WHERE id=$1", [row.resume_version_id])).rows[0]?.t ?? null;
        if (text === null || !(s.start >= 0 && s.start < s.end && s.end <= text.length) || text.slice(s.start, s.end) !== s.quote || !(s.start < row.span.end && s.end > row.span.start)) {
          throw new FactRuleError("INVALID_EDIT", "The adjusted quotation does not match the extracted text at that position, or does not overlap the original evidence.");
        }
        nextSpan = { start: s.start, end: s.end, quote: s.quote };
        outcome.fact = { ...outcome.fact, source: { ...outcome.fact.source, locator: `chars ${s.start}-${s.end}` } };
      }
      if (outcome.revisionAction === "APPROVE") await this.assertNoConflict(c, userId, outcome.fact);
      const digest = factContentDigest(outcome.fact);
      const next = row.head_revision + 1;
      await c.query(
        `UPDATE candidate_facts SET value=$3, attributes=$4::jsonb, approval_status=$5, verification=$6::jsonb, content_digest=$7, head_revision=$8,
           span=$9::jsonb, source=$10::jsonb, updated_at=now()
          WHERE user_id=$1 AND fact_id=$2`,
        [userId, factId, outcome.fact.value, JSON.stringify(outcome.fact.attributes), outcome.fact.approvalStatus, JSON.stringify(outcome.fact.verification), digest, next,
          nextSpan === null ? null : JSON.stringify(nextSpan), JSON.stringify(outcome.fact.source)],
      );
      await c.query(
        `INSERT INTO fact_revisions (fact_pk, revision, action, actor, explicit_confirmation, snapshot, content_digest) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [row.id, next, outcome.revisionAction, `user:${input.actor}`, outcome.explicitConfirmation, JSON.stringify({ fact: outcome.fact, span: nextSpan, proposedBy: row.proposed_by, ...(input.span ? { previousSpan: row.span } : {}), ...(input.provenance ? { review: input.provenance } : {}) }), digest],
      );
      await this.recordProfileRevision(c, userId, userHandle, input.today, `${outcome.revisionAction} ${factId}`);
      const fresh = (await c.query<FactDbRow>(`SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 AND fact_id=$2`, [userId, factId])).rows[0]!;
      return { fact: toFactView(fresh), changed: true };
    });
  }

  async attest(userId: string, userHandle: string, draft: FactDraft, today: string): Promise<{ fact: FactView; created: boolean }> {
    return this.tx(async (c) => {
      const f = draft.fact;
      await this.assertNoConflict(c, userId, f);
      const digest = factContentDigest(f);
      const res = await c.query<{ id: string }>(
        `INSERT INTO candidate_facts (user_id, fact_id, resume_version_id, fact_key, kind, value, polarity, attributes, source, span, proposed_by,
           approval_status, sensitivity, verification, content_digest, head_revision, notes)
         VALUES ($1,$2,NULL,NULL,$3,$4,$5,'{}'::jsonb,$6::jsonb,NULL,'user','approved','sensitive',$7::jsonb,$8,1,NULL)
         ON CONFLICT (user_id, fact_id) DO NOTHING RETURNING id`,
        [userId, f.factId, f.kind, f.value, f.polarity, JSON.stringify(f.source), JSON.stringify(f.verification), digest],
      );
      const created = res.rowCount === 1;
      if (created) {
        await c.query(
          `INSERT INTO fact_revisions (fact_pk, revision, action, actor, explicit_confirmation, snapshot, content_digest) VALUES ($1,1,'ATTEST',$2,true,$3::jsonb,$4)`,
          [res.rows[0]!.id, `user:${userHandle}`, JSON.stringify({ fact: f, span: null, proposedBy: "user" }), digest],
        );
        await this.recordProfileRevision(c, userId, userHandle, today, `ATTEST ${f.factId}`);
      }
      const row = (await c.query<FactDbRow>(`SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 AND fact_id=$2`, [userId, f.factId])).rows[0]!;
      return { fact: toFactView(row), created };
    });
  }

  /** An approved fact may not contradict another approved fact about the same kind and wording (has vs lacks). */
  private async assertNoConflict(c: pg.PoolClient, userId: string, fact: CandidateFact): Promise<void> {
    const { rowCount } = await c.query(
      `SELECT 1 FROM candidate_facts WHERE user_id=$1 AND kind=$2 AND fact_id<>$3 AND approval_status='approved' AND polarity<>$4
          AND lower(regexp_replace(value, '\\s+', ' ', 'g')) = lower(regexp_replace($5, '\\s+', ' ', 'g'))`,
      [userId, fact.kind, fact.factId, fact.polarity, fact.value.trim()],
    );
    if (rowCount) throw new FactRuleError("CONFLICTING_FACT", "An approved fact already states the opposite. Reject or revise it first.");
  }

  private async recordProfileRevision(c: pg.PoolClient, userId: string, userHandle: string, today: string, reason: string): Promise<void> {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`profile:${userId}`]);
    const { rows } = await c.query<FactDbRow>(`SELECT ${FACT_COLUMNS.replace(/\n\s*/g, " ")} FROM candidate_facts WHERE user_id=$1 ORDER BY fact_id`, [userId]);
    const next = Number((await c.query("SELECT COALESCE(MAX(revision_no), 0) + 1 AS n FROM profile_revisions WHERE user_id=$1", [userId])).rows[0].n);
    const profile = assembleProfile(rows.map(rowToFact), userHandle, next, today);
    await c.query(
      "INSERT INTO profile_revisions (user_id, revision_no, profile_digest, approved_count, reason) VALUES ($1,$2,$3,$4,$5)",
      [userId, next, digestOfProfile(profile), rows.filter((r) => r.approval_status === "approved").length, reason.slice(0, 200)],
    );
  }

  /**
   * Read-only review history for the parser-feedback dataset (src/ml/fact-feedback.ts). Limited to facts from résumés the owner AUTHORIZED as personal
   * evidence. Returns facts and their revision snapshots; it never writes and is not a scoring read.
   */
  async reviewHistoryForFeedback(): Promise<{ facts: Array<Record<string, any>>; revisions: Array<{ fact_pk: string; revision: number; action: string; snapshot: any }> }> {
    const facts = (await this.pool.query(
      `SELECT f.id AS pk, f.fact_id, f.kind, f.value, f.approval_status, f.sensitivity, f.attributes, f.span, f.notes, v.parser_revision, v.resume_id
         FROM candidate_facts f
         JOIN resume_versions v ON v.id = f.resume_version_id
         JOIN profile_sources ps ON ps.resume_id = v.resume_id AND ps.provenance = 'personal' AND ps.authorized
        WHERE f.resume_version_id IS NOT NULL`,
    )).rows as Array<Record<string, any>>;
    const revisions = (await this.pool.query(`SELECT fact_pk, revision, action, snapshot FROM fact_revisions ORDER BY fact_pk, revision`)).rows as Array<{ fact_pk: string; revision: number; action: string; snapshot: any }>;
    return { facts, revisions };
  }
}

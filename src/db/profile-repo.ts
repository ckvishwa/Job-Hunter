import type pg from "pg";
import { candidateFactSchema } from "../domain/candidate-profile.js";
import {
  selectEvidence, type ConfirmedEmployment, type EvidenceRow, type EvidenceSelection, type ProfileKind, type ProfileRef, type Provenance, type SourceAuth,
} from "../roles/profile-evidence.js";

// PostgreSQL access for the P0 candidate-profile boundary. Additive tables only (0004). Nothing here edits a fact or a résumé.

export class ProfileRuleError extends Error {
  constructor(readonly code: "NO_ACTIVE_PROFILE" | "UNKNOWN_RESUME" | "INVALID_CLASSIFICATION" | "PROFILE_KIND_MISMATCH" | "INVALID_STATEMENT", message: string) {
    super(message);
    this.name = "ProfileRuleError";
  }
}

type Q = pg.Pool | pg.PoolClient;

export interface SourceView {
  resumeId: string;
  provenance: Provenance;
  authorized: boolean;
  basis: string;
  classifiedBy: string;
  classifiedAt: Date;
}

export async function activeProfile(q: Q, userId: string): Promise<ProfileRef | null> {
  const { rows } = await q.query<{ id: string; kind: ProfileKind; label: string }>("SELECT id, kind, label FROM candidate_profiles WHERE user_id=$1 AND active", [userId]);
  return rows[0] ?? null;
}

/** The evidence the active profile allows. This is the ONLY place S2 (and later S4) should read candidate facts from. */
export async function loadScopedEvidence(q: Q, userId: string): Promise<EvidenceSelection & { sources: SourceView[]; confirmed: ConfirmedEmployment[]; resumeText: Map<string, string | null> }> {
  const profile = await activeProfile(q, userId);
  const sourceRows = profile
    ? (await q.query(
        "SELECT resume_id, provenance, authorized, basis, classified_by, classified_at FROM profile_sources WHERE profile_id=$1 ORDER BY resume_id", [profile.id])).rows
    : [];
  const sources: SourceView[] = sourceRows.map((r) => ({ resumeId: r.resume_id, provenance: r.provenance, authorized: r.authorized, basis: r.basis, classifiedBy: r.classified_by, classifiedAt: r.classified_at }));
  const confirmed: ConfirmedEmployment[] = profile
    ? (await q.query("SELECT employer, title, start_date, end_date, employment_type FROM profile_confirmed_employment WHERE profile_id=$1 AND superseded_at IS NULL", [profile.id])).rows
        .map((r) => ({ employer: r.employer, title: r.title, startDate: r.start_date, endDate: r.end_date, employmentType: r.employment_type }))
    : [];
  const { rows } = await q.query(
    `SELECT f.fact_id, f.kind, f.value, f.polarity, f.attributes, f.source, f.approval_status, f.sensitivity, f.verification, f.notes, f.span,
            r.id AS resume_id, r.created_at AS resume_created, v.id AS version_id
       FROM candidate_facts f
       LEFT JOIN resume_versions v ON v.id = f.resume_version_id
       LEFT JOIN resumes r ON r.id = v.resume_id
      WHERE f.user_id=$1 ORDER BY f.fact_id`, [userId]);
  const versionIds = [...new Set(rows.map((r) => r.version_id).filter(Boolean))];
  const texts = new Map<string, string | null>();
  if (versionIds.length) {
    for (const t of (await q.query("SELECT id, extracted_text FROM resume_versions WHERE id = ANY($1::uuid[])", [versionIds])).rows) texts.set(t.id, t.extracted_text);
  }
  const evidenceRows: EvidenceRow[] = rows.map((r) => ({
    fact: candidateFactSchema.parse({
      factId: r.fact_id, kind: r.kind, value: r.value, polarity: r.polarity, attributes: r.attributes, source: r.source, verification: r.verification,
      approvalStatus: r.approval_status, sensitivity: r.sensitivity, ...(r.notes ? { notes: r.notes } : {}),
    }),
    resumeId: r.resume_id ?? null, resumeCreatedAt: r.resume_created ?? null, span: r.span ?? null, sourceText: r.version_id ? texts.get(r.version_id) ?? null : null,
  }));
  const auth: SourceAuth[] = sources.map((s) => ({ resumeId: s.resumeId, provenance: s.provenance, authorized: s.authorized }));
  const resumeText = new Map<string, string | null>();
  for (const r of evidenceRows) if (r.resumeId && !resumeText.has(r.resumeId)) resumeText.set(r.resumeId, r.sourceText);
  return { ...selectEvidence({ profile, sources: auth, confirmed, rows: evidenceRows }), sources, confirmed, resumeText };
}

export class ProfileRepo {
  constructor(readonly pool: pg.Pool) {}

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
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

  active(userId: string): Promise<ProfileRef | null> {
    return activeProfile(this.pool, userId);
  }

  /** Idempotent: returns the active profile if there is one. Never changes an existing profile's kind. */
  async ensureActive(userId: string, kind: ProfileKind, label: string): Promise<{ profile: ProfileRef; created: boolean }> {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`profile:${userId}`]);
      const existing = await activeProfile(c, userId);
      if (existing) return { profile: existing, created: false };
      const { rows } = await c.query<{ id: string }>("INSERT INTO candidate_profiles (user_id, kind, label, active) VALUES ($1,$2,$3,true) RETURNING id", [userId, kind, label.trim().slice(0, 120) || "profile"]);
      return { profile: { id: rows[0]!.id, kind, label }, created: true };
    });
  }

  /** Records (or changes) how a résumé is classified for the active profile. Append-only event log; no fact is touched. */
  async classify(userId: string, input: { resumeId: string; provenance: Provenance; authorized: boolean; basis: string; actor: string }): Promise<SourceView> {
    const basis = input.basis.trim();
    if (basis.length < 5) throw new ProfileRuleError("INVALID_CLASSIFICATION", "A classification needs a basis (the evidence for it).");
    if (input.authorized && input.provenance === "unverified") throw new ProfileRuleError("INVALID_CLASSIFICATION", "An unverified source cannot be authorized.");
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`profile:${userId}`]);
      const profile = await activeProfile(c, userId);
      if (!profile) throw new ProfileRuleError("NO_ACTIVE_PROFILE", "There is no active profile. Create one first.");
      const owned = await c.query("SELECT 1 FROM resumes WHERE id=$1 AND user_id=$2", [input.resumeId, userId]);
      if (!owned.rowCount) throw new ProfileRuleError("UNKNOWN_RESUME", "No such résumé for this user.");
      if (input.authorized && ((profile.kind === "personal" && input.provenance !== "personal") || (profile.kind === "demo" && input.provenance !== "fixture"))) {
        throw new ProfileRuleError("PROFILE_KIND_MISMATCH", `A ${profile.kind} profile cannot authorize ${input.provenance} sources.`);
      }
      const { rows } = await c.query(
        `INSERT INTO profile_sources (profile_id, resume_id, provenance, authorized, basis, classified_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (profile_id, resume_id) DO UPDATE SET provenance=EXCLUDED.provenance, authorized=EXCLUDED.authorized, basis=EXCLUDED.basis,
           classified_by=EXCLUDED.classified_by, classified_at=now()
         RETURNING resume_id, provenance, authorized, basis, classified_by, classified_at`,
        [profile.id, input.resumeId, input.provenance, input.authorized, basis, input.actor]);
      await c.query("INSERT INTO profile_source_events (profile_id, resume_id, provenance, authorized, basis, actor) VALUES ($1,$2,$3,$4,$5,$6)",
        [profile.id, input.resumeId, input.provenance, input.authorized, basis, `user:${input.actor}`]);
      const r = rows[0];
      return { resumeId: r.resume_id, provenance: r.provenance, authorized: r.authorized, basis: r.basis, classifiedBy: r.classified_by, classifiedAt: r.classified_at };
    });
  }

  async listSources(userId: string): Promise<SourceView[]> {
    return (await loadScopedEvidence(this.pool, userId)).sources;
  }

  /** The candidate's own statement of real employment. A reference only: it never becomes a fact and never counts as experience. */
  async confirmEmployment(userId: string, input: {
    employer: string; title: string; startDate: string; endDate: string | null; employmentType: "professional" | "internship" | "academic" | "volunteer"; detail?: string; statement: string; actor: string;
  }): Promise<{ id: string; created: boolean }> {
    if (input.statement.trim().length < 5) throw new ProfileRuleError("INVALID_STATEMENT", "Say how this was confirmed (for example: stated by the candidate, offer letter).");
    return this.tx(async (c) => {
      const profile = await activeProfile(c, userId);
      if (!profile) throw new ProfileRuleError("NO_ACTIVE_PROFILE", "There is no active profile. Create one first.");
      const dup = await c.query(
        `SELECT id FROM profile_confirmed_employment WHERE profile_id=$1 AND superseded_at IS NULL AND lower(employer)=lower($2) AND lower(title)=lower($3)
           AND start_date=$4 AND end_date IS NOT DISTINCT FROM $5 AND employment_type=$6`,
        [profile.id, input.employer.trim(), input.title.trim(), input.startDate, input.endDate, input.employmentType]);
      if (dup.rowCount) return { id: dup.rows[0].id, created: false };
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO profile_confirmed_employment (profile_id, employer, title, start_date, end_date, employment_type, detail, statement, confirmed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [profile.id, input.employer.trim(), input.title.trim(), input.startDate, input.endDate, input.employmentType, input.detail?.trim() || null, input.statement.trim(), input.actor]);
      return { id: rows[0]!.id, created: true };
    });
  }

  async listConfirmed(userId: string) {
    const profile = await this.active(userId);
    if (!profile) return [];
    return (await this.pool.query("SELECT id, employer, title, start_date, end_date, employment_type, detail, statement, confirmed_by, confirmed_at FROM profile_confirmed_employment WHERE profile_id=$1 AND superseded_at IS NULL ORDER BY confirmed_at", [profile.id])).rows;
  }
}

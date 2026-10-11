import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { EmbeddingEncoder } from "../nlu/local-transformer.js";
import type { CandidateRepo } from "../db/candidate-repo.js";
import type { JobsRepo } from "../db/jobs-repo.js";
import { RolesRepo } from "../db/roles-repo.js";
import type { JobSemanticProvider } from "../semantic/provider.js";
import { MATCH_POLICY_VERSION } from "./decide.js";
import { PgEmbeddingCache, PREPROCESS_REVISION, pruneEmbeddingCache, type EncoderIdentity } from "./embedding-cache.js";
import { buildEvidenceCorpus, type EvidenceCorpus } from "./evidence.js";
import { postingFromStoredJob } from "./jd-source.js";
import { lexicon } from "./lexicon.js";
import { REPORT_SCHEMA, runMatch, type MatchReport } from "./pipeline.js";
import { RRF_K } from "./retrieval.js";
import { RulesJobSemanticProvider } from "./rules-provider.js";

// Persisted, versioned matches for jobs in the authoritative S3 store (migration 0005). One live row per (user, job): the same inputs reuse it; any change to the JD revision,
// the authorized evidence, the profile membership, an eligibility answer, the saved selection, or the extractor/policy/lexicon/retrieval settings is detected from a digest and
// produces a NEW row that supersedes the old one with the reason. Nothing is computed twice for identical inputs, and nothing here ever writes a candidate fact.

export interface StoreDeps {
  pool: Pool;
  candidates: CandidateRepo;
  jobs: JobsRepo;
  provider?: () => JobSemanticProvider;
  /** null = AI off: the deterministic baseline only. */
  encoder?: (() => EmbeddingEncoder) | null;
  encoder_identity?: EncoderIdentity;
  asOf?: () => string;
}

export const DEFAULT_ENCODER: EncoderIdentity = { modelId: "sentence-transformers/all-MiniLM-L6-v2", modelRevision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41", preprocess: PREPROCESS_REVISION };

export type StaleReason = "JD_CHANGED" | "EVIDENCE_CHANGED" | "PROFILE_CHANGED" | "EXTRACTOR_CHANGED" | "POLICY_CHANGED";

export interface StoredMatch {
  id: string;
  jobId: string;
  status: "COMPLETE" | "EXTRACTION_FAILED";
  createdAt: string;
  jdSha256: string;
  inputDigest: string;
  versions: { profileId: string | null; profileRevisionNo: number | null; profileDigest: string | null; evidenceDigest: string; extractorRevision: string; policyVersion: string; lexiconVersion: string; retrieval: unknown };
  report: MatchReport;
}

/** Freshness of a stored posting. "Last seen" is when an official read last returned it; a stored posting is never claimed to be open today. */
export const FRESH_DAYS = 7;
export function postingFreshness(lastSeenAt: string | null, now: Date = new Date()): { lastSeenAt: string | null; ageDays: number | null; state: "RECENT" | "STALE" | "UNKNOWN"; note: string } {
  const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (Number.isNaN(t)) return { lastSeenAt, ageDays: null, state: "UNKNOWN", note: "No official read time is recorded; check the posting before relying on it." };
  const ageDays = Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
  return ageDays <= FRESH_DAYS
    ? { lastSeenAt, ageDays, state: "RECENT", note: `Last read from the official board ${ageDays} day${ageDays === 1 ? "" : "s"} ago. It may have closed since.` }
    : { lastSeenAt, ageDays, state: "STALE", note: `Last read from the official board ${ageDays} days ago (over ${FRESH_DAYS}). It may be closed or changed; refresh before relying on it.` };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export class MatchStore {
  constructor(private readonly d: StoreDeps) {}

  private provider(): JobSemanticProvider { return this.d.provider ? this.d.provider() : new RulesJobSemanticProvider(); }
  private asOf(): string { return this.d.asOf ? this.d.asOf() : new Date().toISOString().slice(0, 10); }
  private identity(): EncoderIdentity { return this.d.encoder_identity ?? DEFAULT_ENCODER; }

  private async inputs(userId: string, jobId: string) {
    const stored = await this.d.jobs.getJob(userId, jobId);
    if (!stored) return null; // another user's job is indistinguishable from an unknown one
    const posting = postingFromStoredJob(stored);
    const corpus = await buildEvidenceCorpus({ pool: this.d.pool, candidates: this.d.candidates, userId, asOf: this.asOf() });
    const selection = await new RolesRepo(this.d.pool).getSelection(userId);
    const provider = this.provider();
    const encoderOn = Boolean(this.d.encoder);
    const eligibility = sha(JSON.stringify(corpus.eligibility.map((e) => [e.factId, e.kind, e.polarity, sha(e.value)]).sort()));
    const retrieval = { rrfK: RRF_K, encoder: encoderOn ? `${this.identity().modelId}@${this.identity().modelRevision}` : null, preprocess: encoderOn ? this.identity().preprocess : null };
    const components = {
      jd: posting.jdContentHash, extractor: provider.revision, evidence: corpus.version.evidenceDigest, eligibility, profile: corpus.version.profileId, members: corpus.version.authorizedResumeIds.slice().sort(),
      policy: MATCH_POLICY_VERSION, lexicon: `jd-terms@${lexicon().version}`, retrieval,
      selection: selection ? sha(JSON.stringify([selection.workModes, selection.locations])) : null,
    };
    return { stored, posting, corpus, provider, components, retrieval, inputDigest: sha(JSON.stringify(components)), versions: { evidenceDigest: corpus.version.evidenceDigest, eligibility } };
  }

  private rowToMatch(r: Record<string, unknown>): StoredMatch {
    return {
      id: r.id as string, jobId: r.job_id as string, status: r.status as StoredMatch["status"], createdAt: new Date(r.created_at as string).toISOString(), jdSha256: (r.jd_sha256 as string).trim(),
      inputDigest: (r.input_digest as string).trim(),
      versions: { profileId: (r.profile_id as string) ?? null, profileRevisionNo: (r.profile_revision_no as number) ?? null, profileDigest: (r.profile_digest as string) ?? null, evidenceDigest: r.evidence_digest as string,
        extractorRevision: r.extractor_revision as string, policyVersion: r.policy_version as string, lexiconVersion: r.lexicon_version as string, retrieval: r.retrieval_config },
      report: r.report as MatchReport,
    };
  }

  async liveRow(userId: string, jobId: string): Promise<StoredMatch | null> {
    const { rows } = await this.d.pool.query("SELECT * FROM job_match_reports WHERE user_id=$1 AND job_id=$2 AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", [userId, jobId]);
    return rows[0] ? this.rowToMatch(rows[0]) : null;
  }

  /** The stored match and whether it is still current. Computes nothing. */
  async get(userId: string, jobId: string): Promise<{ match: StoredMatch | null; current: boolean; staleReasons: StaleReason[]; currentJdSha256: string } | null> {
    const inp = await this.inputs(userId, jobId);
    if (!inp) return null;
    const match = await this.liveRow(userId, jobId);
    if (!match) return { match: null, current: false, staleReasons: [], currentJdSha256: inp.posting.jdContentHash! };
    return { match, current: match.inputDigest === inp.inputDigest, staleReasons: match.inputDigest === inp.inputDigest ? [] : this.reasons(match, inp), currentJdSha256: inp.posting.jdContentHash! };
  }

  private reasons(m: StoredMatch, inp: NonNullable<Awaited<ReturnType<MatchStore["inputs"]>>>): StaleReason[] {
    const out: StaleReason[] = [];
    const storedMembers = (m.report as { versions?: { profile?: { authorizedResumeIds?: string[] } } }).versions?.profile?.authorizedResumeIds ?? [];
    if (m.jdSha256 !== inp.posting.jdContentHash) out.push("JD_CHANGED");
    if (m.versions.profileId !== inp.corpus.version.profileId || JSON.stringify([...storedMembers].sort()) !== JSON.stringify([...inp.corpus.version.authorizedResumeIds].sort())) out.push("PROFILE_CHANGED");
    else if (m.versions.evidenceDigest !== inp.corpus.version.evidenceDigest) out.push("EVIDENCE_CHANGED");
    if (m.versions.extractorRevision !== inp.provider.revision) out.push("EXTRACTOR_CHANGED");
    if (m.versions.policyVersion !== MATCH_POLICY_VERSION || m.versions.lexiconVersion !== `jd-terms@${lexicon().version}`) out.push("POLICY_CHANGED");
    return out.length ? out : ["EVIDENCE_CHANGED"]; // a digest difference with no named cause is an eligibility answer or a saved-selection change
  }

  /** Idempotent: identical inputs return the stored row (computed:false). Changed inputs insert a new row and supersede the old one. */
  async compute(userId: string, jobId: string, opts: { force?: boolean } = {}): Promise<{ match: StoredMatch; computed: boolean; superseded: StoredMatch | null; embeddingCache: { hits: number; misses: number } | null } | null> {
    const inp = await this.inputs(userId, jobId);
    if (!inp) return null;
    const live = await this.liveRow(userId, jobId);
    if (live && live.inputDigest === inp.inputDigest && !opts.force) return { match: live, computed: false, superseded: null, embeddingCache: null };

    const enc = this.d.encoder ? this.d.encoder() : null;
    const cache = enc && inp.corpus.version.profileId ? new PgEmbeddingCache(this.d.pool, { userId, profileId: inp.corpus.version.profileId }, this.identity()) : null;
    const report = await runMatch({
      job: inp.posting, provider: inp.provider, corpus: inp.corpus, encoder: enc, encoderLabel: enc ? `${this.identity().modelId}@${this.identity().modelRevision}` : null, asOf: this.asOf(),
      selection: await this.selection(userId), cache,
    });
    await pruneEmbeddingCache(this.d.pool, userId, inp.corpus.version.profileId, inp.corpus.units, enc ? this.identity() : null);

    const reason = live ? (this.reasons(live, inp)[0] ?? "RECOMPUTED") : null;
    const client = await this.d.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`match:${userId}:${jobId}`]);
      if (live) await client.query("UPDATE job_match_reports SET superseded_at=now(), superseded_reason=$2 WHERE id=$1 AND superseded_at IS NULL", [live.id, opts.force && live.inputDigest === inp.inputDigest ? "RECOMPUTED" : reason]);
      // identical inputs seen before (for example after a revert) re-open that exact row instead of duplicating it
      const prior = await client.query("SELECT * FROM job_match_reports WHERE user_id=$1 AND job_id=$2 AND input_digest=$3", [userId, jobId, inp.inputDigest]);
      let row: Record<string, unknown>;
      if (prior.rows[0]) {
        row = (await client.query("UPDATE job_match_reports SET superseded_at=NULL, superseded_reason=NULL, report=$2::jsonb, created_at=now(), status=$3 WHERE id=$1 RETURNING *", [prior.rows[0].id, JSON.stringify(report), report.status])).rows[0];
      } else {
        row = (await client.query(
          `INSERT INTO job_match_reports (user_id, job_id, revision_id, jd_sha256, input_digest, status, profile_id, profile_revision_no, profile_digest, evidence_digest, extractor_revision, policy_version, lexicon_version, retrieval_config, report)
           VALUES ($1,$2,(SELECT current_revision_id FROM jobs WHERE id=$2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb) RETURNING *`,
          [userId, jobId, inp.posting.jdContentHash, inp.inputDigest, report.status, inp.corpus.version.profileId, inp.corpus.version.profileRevisionNo, inp.corpus.version.profileDigest, inp.corpus.version.evidenceDigest,
            inp.provider.revision, MATCH_POLICY_VERSION, `jd-terms@${lexicon().version}`, JSON.stringify(inp.retrieval), JSON.stringify(report)])).rows[0];
      }
      await client.query("COMMIT");
      return { match: this.rowToMatch(row), computed: true, superseded: live, embeddingCache: cache ? { hits: cache.hits, misses: cache.misses } : null };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async selection(userId: string): Promise<{ workModes: string[]; locations: Array<{ kind: string; value: string }> } | null> {
    const s = await new RolesRepo(this.d.pool).getSelection(userId);
    return s ? { workModes: s.workModes, locations: s.locations } : null;
  }

  /** Jobs the user can see (their own S3 runs) with the state of their stored match. */
  async list(userId: string, limit = 50) {
    const jobs = await this.d.jobs.listJobs(userId, { limit });
    const out = [];
    for (const j of jobs.jobs) {
      const g = await this.get(userId, j.jobId);
      const summary = g?.match && g.match.report.status === "COMPLETE" ? { required: g.match.report.summary.required, preferred: g.match.report.summary.preferred, blockers: g.match.report.summary.criticalBlockers.length } : null;
      out.push({ ...j, freshness: postingFreshness(j.lastSeenAt), match: g?.match ? { id: g.match.id, status: g.match.status, createdAt: g.match.createdAt, current: g.current, staleReasons: g.staleReasons, summary } : null });
    }
    return { total: jobs.total, jobs: out };
  }

  async flag(userId: string, reportId: string, requirementId: string, note: string): Promise<{ id: string } | null> {
    const own = await this.d.pool.query("SELECT 1 FROM job_match_reports WHERE id=$1 AND user_id=$2", [reportId, userId]);
    if (!own.rowCount) return null;
    const { rows } = await this.d.pool.query("INSERT INTO job_match_flags (report_id, user_id, requirement_id, note) VALUES ($1,$2,$3,$4) RETURNING id", [reportId, userId, requirementId.slice(0, 80), note.trim().slice(0, 1000)]);
    return { id: rows[0].id };
  }
}

export type { EvidenceCorpus };

-- S4B: persisted, versioned job-match reports; a saved-posting import run kind for S3; an embedding cache scoped to the active profile.
-- Additive. The S3 job tables stay the single authoritative job store; nothing here copies a job.

-- An IMPORT run records postings that were already verified and saved earlier (or a live read-only refresh the owner asked for explicitly). It has no saved
-- role selection behind it, so its selection revision is 0. A normal discovery run still requires revision >= 1.
ALTER TABLE discovery_runs ADD COLUMN run_kind text NOT NULL DEFAULT 'discovery' CHECK (run_kind IN ('discovery', 'import'));
ALTER TABLE discovery_runs DROP CONSTRAINT discovery_runs_selection_revision_no_check;
ALTER TABLE discovery_runs ADD CONSTRAINT discovery_runs_selection_rev_check CHECK ((run_kind = 'import' AND selection_revision_no >= 0) OR selection_revision_no >= 1);

-- One row per (user, job revision, evidence/profile/extractor/policy state). The same inputs always map to the same row (no duplicates on rerun); changed
-- inputs insert a new row and supersede the old one with the reason.
CREATE TABLE job_match_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  job_id                uuid NOT NULL REFERENCES jobs(id),
  revision_id           uuid NOT NULL REFERENCES job_revisions(id),
  jd_sha256             char(64) NOT NULL CHECK (jd_sha256 ~ '^[a-f0-9]{64}$'),
  input_digest          char(64) NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  status                text NOT NULL CHECK (status IN ('COMPLETE', 'EXTRACTION_FAILED')),
  profile_id            uuid,
  profile_revision_no   integer,
  profile_digest        text,
  evidence_digest       text NOT NULL,
  extractor_revision    text NOT NULL,
  policy_version        text NOT NULL,
  lexicon_version       text NOT NULL,
  retrieval_config      jsonb NOT NULL,
  report                jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at            timestamptz NOT NULL DEFAULT now(),
  superseded_at         timestamptz,
  superseded_reason     text CHECK (superseded_reason IS NULL OR superseded_reason IN ('JD_CHANGED', 'EVIDENCE_CHANGED', 'PROFILE_CHANGED', 'EXTRACTOR_CHANGED', 'POLICY_CHANGED', 'RECOMPUTED')),
  UNIQUE (user_id, job_id, input_digest)
);
CREATE INDEX job_match_reports_live_idx ON job_match_reports (user_id, job_id) WHERE superseded_at IS NULL;

-- A person flagging that a requirement was interpreted wrongly. It never edits the report or the requirement; it is feedback for review and for gold labels.
CREATE TABLE job_match_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       uuid NOT NULL REFERENCES job_match_reports(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  requirement_id  text NOT NULL CHECK (length(requirement_id) BETWEEN 1 AND 80),
  note            text NOT NULL CHECK (length(note) BETWEEN 3 AND 1000),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- MiniLM vectors of APPROVED, authorized candidate evidence only. Keyed by fact, its content digest and the exact model/tokenizer/preprocessing, scoped to the profile
-- (a revoked source or rejected fact is purged by pruneEmbeddingCache). Requirement text is never cached here.
CREATE TABLE IF NOT EXISTS embedding_cache (
  user_id            uuid NOT NULL REFERENCES users(id),
  profile_id         uuid NOT NULL REFERENCES candidate_profiles(id),
  unit_id            text NOT NULL,
  content_digest     text NOT NULL,
  text_sha256        char(64) NOT NULL,
  model_id           text NOT NULL,
  model_revision     text NOT NULL,
  preprocess_rev     text NOT NULL,
  dims               integer NOT NULL CHECK (dims BETWEEN 1 AND 4096),
  vector             bytea NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, profile_id, unit_id, content_digest, text_sha256, model_id, model_revision, preprocess_rev)
);

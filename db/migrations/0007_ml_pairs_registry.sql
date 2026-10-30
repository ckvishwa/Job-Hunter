-- ML engine V1, step 2 (additive over 0006, which stays applied with its corpus):
--   * labels become JOB-ROLE PAIR labels (relevance needs a role), plus a work_mode assessment
--   * dataset items are pairs and carry a near-duplicate family key used by the split
--   * job vectors move to a versioned, chunk-level table (job identity, JD hash, chunk, preprocess, model id/revision, dimension)
--   * a model registry (artifact hash, dataset, status) and role-level shadow prediction history
-- The replaced tables (ml_embeddings, ml_dataset_items, ml_shadow_predictions) are empty at this point; ml_corpus_postings is untouched.

ALTER TABLE ml_labels DROP CONSTRAINT ml_labels_check;
ALTER TABLE ml_labels DROP CONSTRAINT ml_labels_task_check; -- the column-level check from 0006 (task list without work_mode)
ALTER TABLE ml_labels ADD CONSTRAINT ml_labels_task_check CHECK (task IN ('relevance', 'role_family', 'seniority', 'work_mode', 'false_positive_admission', 'needs_review'));
ALTER TABLE ml_labels ADD CONSTRAINT ml_labels_value_check CHECK (
     (task = 'relevance' AND value IN ('relevant', 'irrelevant', 'adjacent', 'unsure') AND role_slug <> '')
  OR (task = 'seniority' AND value IN ('entry', 'junior', 'mid', 'senior', 'unclear'))
  OR (task = 'work_mode' AND value IN ('remote', 'hybrid', 'onsite', 'unclear'))
  OR (task = 'false_positive_admission' AND value IN ('true', 'false') AND role_slug <> '')
  OR (task = 'needs_review' AND value IN ('true', 'false'))
  OR (task = 'role_family' AND length(value) BETWEEN 1 AND 64));
ALTER TABLE ml_labels ALTER COLUMN role_slug SET DEFAULT '';

DROP TABLE ml_shadow_predictions;
DROP TABLE ml_dataset_items;
DROP TABLE ml_embeddings;

CREATE TABLE ml_job_embeddings (
  subject_key     text NOT NULL,                      -- 'greenhouse:board:123' for a posting, 'role:<slug>' for a catalog role text
  text_sha256     char(64) NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),  -- hash of the exact text embedded (JD content hash for the whole-JD case is in jd_sha256)
  jd_sha256       char(64) CHECK (jd_sha256 IS NULL OR jd_sha256 ~ '^[a-f0-9]{64}$'),
  kind            text NOT NULL CHECK (kind IN ('title', 'jd_passage', 'role_phrase', 'role_text')),
  chunk_index     integer NOT NULL CHECK (chunk_index >= 0),
  preprocess      text NOT NULL,
  model_id        text NOT NULL,
  model_revision  text NOT NULL,
  dims            integer NOT NULL CHECK (dims > 0),
  vector          real[] NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_key, text_sha256, kind, chunk_index, preprocess, model_id, model_revision),
  CHECK (array_length(vector, 1) = dims)
);
CREATE INDEX ml_job_embeddings_jd_idx ON ml_job_embeddings (jd_sha256);

CREATE TABLE ml_dataset_items (
  version       text NOT NULL REFERENCES ml_dataset_versions(version),
  posting_id    uuid NOT NULL REFERENCES ml_corpus_postings(id),
  role_slug     text NOT NULL CHECK (role_slug <> ''),
  text_sha256   char(64) NOT NULL,
  company       text NOT NULL,
  group_key     text NOT NULL,                        -- employer, merged with employers that share a near-duplicate JD family
  split         text NOT NULL CHECK (split IN ('train', 'heldout')),
  relevance     text NOT NULL CHECK (relevance IN ('relevant', 'irrelevant', 'adjacent', 'unsure')),
  seniority     text,
  work_mode     text,
  label_ids     bigint[] NOT NULL,
  PRIMARY KEY (version, posting_id, role_slug)
);

CREATE TABLE ml_models (
  revision        text PRIMARY KEY CHECK (revision ~ '^[a-f0-9]{16}$'),
  candidate       text NOT NULL CHECK (candidate IN ('title_tfidf', 'hybrid', 'hybrid_emb')),
  dataset_version text NOT NULL REFERENCES ml_dataset_versions(version),
  split_hash      char(64) NOT NULL,
  artifact_path   text NOT NULL,
  artifact_sha256 char(64) NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  feature_revision text NOT NULL,
  library_versions jsonb NOT NULL,
  seed            integer NOT NULL,
  status          text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'shadow', 'promoted', 'retired')),
  metrics         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ml_shadow_predictions (
  run_id          uuid NOT NULL REFERENCES ml_model_runs(id),
  posting_id      uuid NOT NULL REFERENCES ml_corpus_postings(id),
  role_slug       text NOT NULL,
  text_sha256     char(64) NOT NULL,
  rule_relevant   boolean NOT NULL,
  sim_score       real,
  model_revision  text REFERENCES ml_models(revision),
  model_score     real,
  decision        text CHECK (decision IN ('relevant', 'irrelevant', 'abstain')),
  inference_ms    real,
  PRIMARY KEY (run_id, posting_id, role_slug)
);

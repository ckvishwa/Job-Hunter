-- ML engine V1: a private corpus of official postings, human-only job labels, frozen dataset versions, embeddings and shadow predictions.
-- Additive. No candidate data lives here: features come from job text only. Labels are written by a named human reviewer; the CHECK
-- constraints refuse any other label source, so a model can never write gold labels.

CREATE TABLE ml_corpus_postings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key      text NOT NULL UNIQUE CHECK (source_key ~ '^(greenhouse|lever):[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$'),
  company         text NOT NULL,
  ats             text NOT NULL CHECK (ats IN ('greenhouse', 'lever')),
  board           text NOT NULL,
  requisition_id  text NOT NULL,
  title           text NOT NULL,
  location        text,
  department      text,
  source_url      text NOT NULL CHECK (source_url ~ '^https://'),
  description_text text NOT NULL,
  text_sha256     char(64) NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_id     text NOT NULL,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ml_corpus_company_idx ON ml_corpus_postings (company);
CREATE INDEX ml_corpus_text_idx ON ml_corpus_postings (text_sha256);

CREATE TABLE ml_embeddings (
  text_sha256     char(64) NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  model_id        text NOT NULL,
  model_revision  text NOT NULL,
  preprocess      text NOT NULL,
  vector          real[] NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_sha256, model_id, model_revision, preprocess)
);

-- Append-only. The newest row per (posting, task, role_slug) is the current label; older rows are the correction history.
CREATE TABLE ml_labels (
  id            bigserial PRIMARY KEY,
  posting_id    uuid NOT NULL REFERENCES ml_corpus_postings(id),
  text_sha256   char(64) NOT NULL,
  task          text NOT NULL CHECK (task IN ('relevance', 'role_family', 'seniority', 'false_positive_admission', 'needs_review')),
  role_slug     text NOT NULL DEFAULT '',
  value         text NOT NULL,
  label_source  text NOT NULL DEFAULT 'human' CHECK (label_source = 'human'),
  reviewer      text NOT NULL CHECK (length(reviewer) > 0),
  session_id    text NOT NULL,
  selection_basis text NOT NULL,
  note          text,
  reviewed_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((task = 'relevance' AND value IN ('relevant', 'irrelevant', 'adjacent', 'unsure'))
      OR (task = 'seniority' AND value IN ('entry', 'junior', 'mid', 'senior', 'unclear'))
      OR (task = 'false_positive_admission' AND value IN ('true', 'false'))
      OR (task = 'needs_review' AND value IN ('true', 'false'))
      OR (task = 'role_family' AND length(value) BETWEEN 1 AND 64))
);
CREATE INDEX ml_labels_current_idx ON ml_labels (posting_id, task, role_slug, id DESC);

-- A dataset version is immutable once written. Splits are by employer so one company's templates never sit on both sides.
CREATE TABLE ml_dataset_versions (
  version       text PRIMARY KEY CHECK (version ~ '^ds-[0-9]{4}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  split_hash    char(64) NOT NULL,
  manifest      jsonb NOT NULL
);
CREATE TABLE ml_dataset_items (
  version       text NOT NULL REFERENCES ml_dataset_versions(version),
  posting_id    uuid NOT NULL REFERENCES ml_corpus_postings(id),
  text_sha256   char(64) NOT NULL,
  company       text NOT NULL,
  split         text NOT NULL CHECK (split IN ('train', 'heldout')),
  relevance     text NOT NULL CHECK (relevance IN ('relevant', 'irrelevant', 'adjacent', 'unsure')),
  role_family   text,
  label_ids     bigint[] NOT NULL,
  PRIMARY KEY (version, posting_id)
);

CREATE TABLE ml_model_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('train', 'evaluate', 'shadow', 'cluster')),
  dataset_version text,
  model_revision text,
  status        text NOT NULL CHECK (status IN ('OK', 'REFUSED', 'NOT_EVALUATED', 'FAILED')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_path text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ml_shadow_predictions (
  run_id        uuid NOT NULL REFERENCES ml_model_runs(id),
  posting_id    uuid NOT NULL REFERENCES ml_corpus_postings(id),
  text_sha256   char(64) NOT NULL,
  rule_relevant boolean NOT NULL,
  rule_roles    text[] NOT NULL DEFAULT '{}',
  sim_score     real,
  sim_family    text,
  model_score   real,
  model_revision text,
  PRIMARY KEY (run_id, posting_id)
);

BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ml_labels WHERE task = 'work_mode') THEN
    RAISE EXCEPTION 'Rollback would delete human work_mode annotations; retain migration 0007.';
  END IF;
END $$;
-- Manual rollback of 0007 back to the 0006 shape. DESTRUCTIVE for ML data created after 0007: embeddings, dataset items, models and shadow predictions are dropped;
-- pair-level labels and corpus rows stay (the stricter label constraints are relaxed back).
DROP TABLE IF EXISTS ml_shadow_predictions;
DROP TABLE IF EXISTS ml_models;
DROP TABLE IF EXISTS ml_dataset_items;
DROP TABLE IF EXISTS ml_job_embeddings;
ALTER TABLE ml_labels DROP CONSTRAINT IF EXISTS ml_labels_value_check;
ALTER TABLE ml_labels DROP CONSTRAINT IF EXISTS ml_labels_task_check;
ALTER TABLE ml_labels ADD CONSTRAINT ml_labels_task_check CHECK (task IN ('relevance', 'role_family', 'seniority', 'false_positive_admission', 'needs_review'));
ALTER TABLE ml_labels ADD CONSTRAINT ml_labels_check CHECK ((task = 'relevance' AND value IN ('relevant', 'irrelevant', 'adjacent', 'unsure'))
  OR (task = 'seniority' AND value IN ('entry', 'junior', 'mid', 'senior', 'unclear'))
  OR (task = 'false_positive_admission' AND value IN ('true', 'false'))
  OR (task = 'needs_review' AND value IN ('true', 'false'))
  OR (task = 'role_family' AND length(value) BETWEEN 1 AND 64));
CREATE TABLE ml_embeddings (
  text_sha256 char(64) NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'), model_id text NOT NULL, model_revision text NOT NULL, preprocess text NOT NULL,
  vector real[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (text_sha256, model_id, model_revision, preprocess));
CREATE TABLE ml_dataset_items (
  version text NOT NULL REFERENCES ml_dataset_versions(version), posting_id uuid NOT NULL REFERENCES ml_corpus_postings(id), text_sha256 char(64) NOT NULL, company text NOT NULL,
  split text NOT NULL CHECK (split IN ('train', 'heldout')), relevance text NOT NULL CHECK (relevance IN ('relevant', 'irrelevant', 'adjacent', 'unsure')), role_family text,
  label_ids bigint[] NOT NULL, PRIMARY KEY (version, posting_id));
CREATE TABLE ml_shadow_predictions (
  run_id uuid NOT NULL REFERENCES ml_model_runs(id), posting_id uuid NOT NULL REFERENCES ml_corpus_postings(id), text_sha256 char(64) NOT NULL, rule_relevant boolean NOT NULL,
  rule_roles text[] NOT NULL DEFAULT '{}', sim_score real, sim_family text, model_score real, model_revision text, PRIMARY KEY (run_id, posting_id));
DELETE FROM schema_migrations WHERE version = '0007_ml_pairs_registry';

COMMIT;

BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ml_llm_labels WHERE jsonb_array_length(evidence_locations) > 0)
    OR EXISTS (SELECT 1 FROM ml_models WHERE candidate IN ('tfidf', 'minilm')) THEN
    RAISE EXCEPTION 'Rollback would discard evidence or model provenance; retain migration 0010.';
  END IF;
END $$;
DROP TRIGGER ml_human_labels_immutable ON ml_labels;
ALTER TABLE ml_llm_labels DROP CONSTRAINT ml_llm_exact_evidence_check;
ALTER TABLE ml_llm_labels DROP COLUMN evidence_locations;
ALTER TABLE ml_models DROP CONSTRAINT ml_models_candidate_check;
ALTER TABLE ml_models ADD CONSTRAINT ml_models_candidate_check CHECK (candidate IN ('title_tfidf', 'hybrid', 'hybrid_emb'));
DELETE FROM schema_migrations WHERE version='0010_ml_evidence_integrity';
COMMIT;

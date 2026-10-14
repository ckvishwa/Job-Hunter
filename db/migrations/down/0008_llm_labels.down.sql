BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ml_labels WHERE origin <> 'human_verified' OR cardinality(llm_label_ids) > 0) THEN
    RAISE EXCEPTION 'Rollback would discard human review provenance; retain migration 0008.';
  END IF;
END $$;
-- Manual rollback of 0008. DESTRUCTIVE for LLM-provisional data only (ml_llm_labels, ml_llm_rejects). Human labels and their text stay; only the provenance columns are dropped.
DROP TABLE IF EXISTS ml_llm_rejects;
DROP TABLE IF EXISTS ml_llm_labels;
DROP FUNCTION IF EXISTS ml_llm_append_only();
ALTER TABLE ml_labels DROP COLUMN IF EXISTS llm_label_ids;
ALTER TABLE ml_labels DROP COLUMN IF EXISTS origin;
DELETE FROM schema_migrations WHERE version = '0008_llm_labels';

COMMIT;

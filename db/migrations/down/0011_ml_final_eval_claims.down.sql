BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ml_final_eval_claims WHERE scope = 'real') THEN
    RAISE EXCEPTION 'Rollback would discard a frozen-test reservation; retain migration 0011.';
  END IF;
END $$;
DROP TRIGGER ml_labels_no_truncate ON ml_labels;
DROP TRIGGER ml_llm_labels_no_truncate ON ml_llm_labels;
DROP TRIGGER ml_llm_rejects_no_truncate ON ml_llm_rejects;
DROP TABLE ml_final_eval_claims;
DROP FUNCTION ml_final_eval_claims_guard();
DELETE FROM schema_migrations WHERE version='0011_ml_final_eval_claims';
COMMIT;

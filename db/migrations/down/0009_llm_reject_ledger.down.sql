-- Manual rollback of 0009. Drops retry idempotency and append-only protection for rejection history.
DROP TRIGGER IF EXISTS ml_llm_rejects_append_only ON ml_llm_rejects;
DROP INDEX IF EXISTS ml_llm_rejects_idempotency_idx;
DELETE FROM schema_migrations WHERE version = '0009_llm_reject_ledger';

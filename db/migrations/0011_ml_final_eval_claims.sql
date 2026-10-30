-- One-shot reservation of a frozen held-out split. The primary key makes the claim atomic across concurrent workers and processes;
-- the trigger makes it permanent: rows cannot be deleted, re-keyed, or moved back to RESERVED. A crashed attempt stays RESERVED.
-- scope separates synthetic/experimental runs from the real (production-purpose) split so tests can never consume a real reservation.
CREATE TABLE ml_final_eval_claims (
  scope             text NOT NULL CHECK (scope IN ('real', 'synthetic')),
  split_hash        char(64) NOT NULL,
  dataset_version   text NOT NULL,
  selected_revision text NOT NULL,
  state             text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED', 'COMPLETED')),
  claimed_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  PRIMARY KEY (scope, split_hash),
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL))
);

CREATE FUNCTION ml_final_eval_claims_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'ml_final_eval_claims is append-only: a frozen-test reservation cannot be deleted or truncated';
  END IF;
  IF OLD.state = 'RESERVED' AND NEW.state = 'COMPLETED'
     AND NEW.scope = OLD.scope AND NEW.split_hash = OLD.split_hash
     AND NEW.dataset_version = OLD.dataset_version AND NEW.selected_revision = OLD.selected_revision
     AND NEW.claimed_at = OLD.claimed_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ml_final_eval_claims: only RESERVED -> COMPLETED is allowed';
END $$;

CREATE TRIGGER ml_final_eval_claims_guard BEFORE UPDATE OR DELETE ON ml_final_eval_claims
  FOR EACH ROW EXECUTE FUNCTION ml_final_eval_claims_guard();
CREATE TRIGGER ml_final_eval_claims_no_truncate BEFORE TRUNCATE ON ml_final_eval_claims
  FOR EACH STATEMENT EXECUTE FUNCTION ml_final_eval_claims_guard();

-- Carry over any reservation the previous implementation recorded in ml_model_runs.
INSERT INTO ml_final_eval_claims (scope, split_hash, dataset_version, selected_revision)
SELECT 'real', detail->>'frozenSplitHash', COALESCE(dataset_version, ''), COALESCE(detail->>'selectedRevision', model_revision, '')
FROM ml_model_runs
WHERE kind = 'evaluate' AND detail->>'frozenSplitHash' ~ '^[0-9a-f]{64}$'
ON CONFLICT DO NOTHING;

-- Human label and provisional ledgers already block UPDATE/DELETE (0008-0010); block TRUNCATE as well. Corrections remain plain appends.
CREATE TRIGGER ml_labels_no_truncate BEFORE TRUNCATE ON ml_labels FOR EACH STATEMENT EXECUTE FUNCTION ml_llm_append_only();
CREATE TRIGGER ml_llm_labels_no_truncate BEFORE TRUNCATE ON ml_llm_labels FOR EACH STATEMENT EXECUTE FUNCTION ml_llm_append_only();
CREATE TRIGGER ml_llm_rejects_no_truncate BEFORE TRUNCATE ON ml_llm_rejects FOR EACH STATEMENT EXECUTE FUNCTION ml_llm_append_only();

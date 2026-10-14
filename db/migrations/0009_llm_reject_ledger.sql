-- Make a retry of a rejected inference in one run idempotent and protect rejection history from edits.
-- This is additive and does not touch human labels or provisional label rows.
CREATE UNIQUE INDEX ml_llm_rejects_idempotency_idx
  ON ml_llm_rejects (posting_id, text_sha256, role_slug, pass, model, prompt_version, reason, run_id);

CREATE TRIGGER ml_llm_rejects_append_only
  BEFORE UPDATE OR DELETE ON ml_llm_rejects
  FOR EACH ROW EXECUTE FUNCTION ml_llm_append_only();

ALTER TABLE ml_llm_labels ADD COLUMN evidence_locations jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(evidence_locations) = 'array');
ALTER TABLE ml_llm_labels ADD CONSTRAINT ml_llm_exact_evidence_check CHECK (
  prompt_version <> 'llm-label@3-full-jd-spans' OR
  (NOT jd_truncated AND jsonb_array_length(evidence_locations) = jsonb_array_length(evidence)
   AND jsonb_array_length(evidence_locations) > 0));
CREATE TRIGGER ml_human_labels_immutable BEFORE UPDATE OR DELETE ON ml_labels
  FOR EACH ROW EXECUTE FUNCTION ml_llm_append_only();
ALTER TABLE ml_models DROP CONSTRAINT ml_models_candidate_check;
ALTER TABLE ml_models ADD CONSTRAINT ml_models_candidate_check
  CHECK (candidate IN ('title_tfidf', 'hybrid', 'hybrid_emb', 'tfidf', 'minilm'));

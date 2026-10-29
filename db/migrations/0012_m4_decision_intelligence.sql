-- M4: the evidence report keeps its S4 contract; candidate-grounded decisions are a separate versioned projection.
ALTER TABLE job_match_reports ADD COLUMN decision jsonb;
ALTER TABLE job_match_reports ADD CONSTRAINT job_match_reports_decision_object CHECK (decision IS NULL OR jsonb_typeof(decision) = 'object');

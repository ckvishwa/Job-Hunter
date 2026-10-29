ALTER TABLE job_match_reports DROP CONSTRAINT job_match_reports_decision_object;
ALTER TABLE job_match_reports DROP COLUMN decision;
DELETE FROM schema_migrations WHERE version = '0012_m4_decision_intelligence';

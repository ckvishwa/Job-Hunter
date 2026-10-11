-- Manual rollback of 0003. DESTRUCTIVE: removes discovery runs, discovered jobs, JD revisions, observations and failure records.
-- S1 candidate data and S2 roles/selections are unaffected. Take a backup first (infra/README.md). Development/non-production only.
DROP TABLE IF EXISTS discovery_failures;
DROP TABLE IF EXISTS job_observations;
ALTER TABLE IF EXISTS jobs DROP CONSTRAINT IF EXISTS jobs_current_revision_fk;
DROP TABLE IF EXISTS job_revisions;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS discovery_run_boards;
DROP TABLE IF EXISTS discovery_runs;
DELETE FROM schema_migrations WHERE version = '0003_s3_discovery';

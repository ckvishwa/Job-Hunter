-- Manual rollback of 0001. DESTRUCTIVE: removes all S1 candidate data. Take a backup first (infra/README.md).
-- Legacy JSONL stores are unaffected; they were never written by S1.
DROP TRIGGER IF EXISTS fact_revisions_no_truncate ON fact_revisions;
DROP TABLE IF EXISTS profile_revisions;
DROP TABLE IF EXISTS fact_revisions;
DROP TABLE IF EXISTS candidate_facts;
DROP TABLE IF EXISTS resume_versions;
DROP TABLE IF EXISTS resumes;
DROP TABLE IF EXISTS users;
DROP FUNCTION IF EXISTS jh_forbid_mutation();
DELETE FROM schema_migrations WHERE version = '0001_s1_candidate';

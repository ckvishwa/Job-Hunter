-- Manual rollback of 0004. DESTRUCTIVE: removes profiles, source classifications and confirmed-employment statements.
-- Résumés, facts and review histories are unaffected. Take a backup first (infra/README.md).
DROP TABLE IF EXISTS profile_confirmed_employment;
DROP TABLE IF EXISTS profile_source_events;
DROP TABLE IF EXISTS profile_sources;
DROP TABLE IF EXISTS candidate_profiles;
DELETE FROM schema_migrations WHERE version = '0004_profile_boundary';

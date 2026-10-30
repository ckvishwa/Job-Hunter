-- Manual rollback of 0002. DESTRUCTIVE: removes the role catalog, recommendations, decisions and saved selections.
-- S1 candidate data is unaffected. Take a backup first (infra/README.md).
DROP TABLE IF EXISTS search_preferences;
DROP TABLE IF EXISTS candidate_role_decisions;
DROP TABLE IF EXISTS candidate_role_recommendations;
DROP TABLE IF EXISTS role_catalog_revisions;
DROP TABLE IF EXISTS role_catalog_versions;
DROP TABLE IF EXISTS role_aliases;
DROP TABLE IF EXISTS role_catalog;
DROP TABLE IF EXISTS role_families;
DELETE FROM schema_migrations WHERE version = '0002_s2_roles';

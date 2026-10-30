-- Manual rollback of 0005. DESTRUCTIVE: removes stored match reports, flags and the embedding cache; import runs lose their kind. Postings, runs and candidate data stay.
DROP TABLE IF EXISTS embedding_cache;
DROP TABLE IF EXISTS job_match_flags;
DROP TABLE IF EXISTS job_match_reports;
ALTER TABLE discovery_runs DROP CONSTRAINT IF EXISTS discovery_runs_selection_rev_check;
-- import runs (revision 0) cannot satisfy the original rule, so they are removed with their per-board rows; their jobs/revisions remain
DELETE FROM job_observations WHERE run_id IN (SELECT id FROM discovery_runs WHERE run_kind = 'import');
DELETE FROM discovery_failures WHERE run_id IN (SELECT id FROM discovery_runs WHERE run_kind = 'import');
DELETE FROM discovery_run_boards WHERE run_id IN (SELECT id FROM discovery_runs WHERE run_kind = 'import');
DELETE FROM discovery_runs WHERE run_kind = 'import';
ALTER TABLE discovery_runs ADD CONSTRAINT discovery_runs_selection_revision_no_check CHECK (selection_revision_no >= 1);
ALTER TABLE discovery_runs DROP COLUMN IF EXISTS run_kind;
DELETE FROM schema_migrations WHERE version = '0005_s4b_matching';

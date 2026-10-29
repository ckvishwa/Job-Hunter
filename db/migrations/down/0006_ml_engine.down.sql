-- Manual rollback of 0006. DESTRUCTIVE: removes the ML corpus, human labels, dataset versions, embeddings and shadow predictions. Jobs and candidate data stay.
DROP TABLE IF EXISTS ml_shadow_predictions;
DROP TABLE IF EXISTS ml_model_runs;
DROP TABLE IF EXISTS ml_dataset_items;
DROP TABLE IF EXISTS ml_dataset_versions;
DROP TABLE IF EXISTS ml_labels;
DROP TABLE IF EXISTS ml_embeddings;
DROP TABLE IF EXISTS ml_corpus_postings;
DELETE FROM schema_migrations WHERE version = '0006_ml_engine';

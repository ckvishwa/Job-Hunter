-- LLM-assisted labeling. Model output NEVER enters ml_labels as if a person had written it.
--  * ml_llm_labels  : append-only provisional labels, one row per (posting text, role, pass, model, prompt version). label_source is constrained to 'llm_provisional'.
--  * ml_llm_rejects : pairs the worker refused or could not label (incomplete JD, invalid output, quote not found in the JD), kept so failures are inspectable.
--  * ml_labels.origin: how a HUMAN label came to be. 'human_verified' = a person reviewed it (alone, or approved a proposal as-is);
--                      'human_corrected' = a person changed an LLM proposal. Every existing row is a from-scratch human label, hence 'human_verified'.
--    ml_labels.llm_label_ids: the provisional rows that were shown to the person for that decision (provenance only; never read by training).

CREATE TABLE ml_llm_labels (
  id              bigserial PRIMARY KEY,
  posting_id      uuid NOT NULL REFERENCES ml_corpus_postings(id),
  source_key      text NOT NULL,
  text_sha256     char(64) NOT NULL CHECK (text_sha256 ~ '^[a-f0-9]{64}$'),
  role_slug       text NOT NULL CHECK (length(role_slug) > 0),
  pass            text NOT NULL CHECK (pass IN ('A', 'B')),
  provider        text NOT NULL,
  model           text NOT NULL,
  model_digest    text,
  prompt_version  text NOT NULL,
  relevance       text NOT NULL CHECK (relevance IN ('relevant', 'irrelevant', 'adjacent', 'unsure')),
  seniority       text NOT NULL CHECK (seniority IN ('junior', 'mid', 'senior', 'unclear')),
  work_mode       text NOT NULL CHECK (work_mode IN ('remote', 'hybrid', 'onsite', 'unclear')),
  confidence      real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence        jsonb NOT NULL,
  reasoning       text NOT NULL,
  jd_chars_sent   integer NOT NULL,
  jd_truncated    boolean NOT NULL,
  latency_ms      integer,
  run_id          text NOT NULL,
  label_source    text NOT NULL DEFAULT 'llm_provisional' CHECK (label_source = 'llm_provisional'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (posting_id, text_sha256, role_slug, pass, model, prompt_version)
);
CREATE INDEX ml_llm_labels_pair_idx ON ml_llm_labels (posting_id, role_slug, id DESC);

CREATE TABLE ml_llm_rejects (
  id              bigserial PRIMARY KEY,
  posting_id      uuid NOT NULL REFERENCES ml_corpus_postings(id),
  text_sha256     char(64) NOT NULL,
  role_slug       text NOT NULL,
  pass            text NOT NULL CHECK (pass IN ('A', 'B')),
  model           text NOT NULL,
  prompt_version  text NOT NULL,
  reason          text NOT NULL,
  detail          text,
  run_id          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ml_llm_rejects_pair_idx ON ml_llm_rejects (posting_id, role_slug);

CREATE FUNCTION ml_llm_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ml_llm_labels / ml_llm_rejects are append-only'; END $$;
CREATE TRIGGER ml_llm_labels_append_only BEFORE UPDATE OR DELETE ON ml_llm_labels FOR EACH ROW EXECUTE FUNCTION ml_llm_append_only();

ALTER TABLE ml_labels ADD COLUMN origin text NOT NULL DEFAULT 'human_verified' CHECK (origin IN ('human_verified', 'human_corrected'));
ALTER TABLE ml_labels ADD COLUMN llm_label_ids bigint[];

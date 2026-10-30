-- S3: official job discovery. Additive: no S1/S2 table is altered. PostgreSQL is authoritative for these tables only; the legacy
-- JSONL discovery history (data/*.jsonl) is untouched.
--
-- Identity vs content: `jobs` is one row per official requisition (ats_identity, e.g. greenhouse:figma:5829751004), shared catalog data.
-- A changed job description is a new immutable `job_revisions` row (sha256 of the normalized JD), never a new job and never an overwrite.
-- A user only ever sees jobs observed in one of THEIR runs (job_observations -> discovery_runs.user_id).

CREATE TABLE discovery_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id),
  status                 text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
  -- The human selection this run was planned from, frozen at start (role slugs, aliases used, locations, band, revisions).
  selection_revision_no  integer NOT NULL CHECK (selection_revision_no >= 1),
  catalog_version        integer NOT NULL,
  snapshot               jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  limits                 jsonb NOT NULL CHECK (jsonb_typeof(limits) = 'object'),
  boards_total           integer NOT NULL DEFAULT 0,
  boards_done            integer NOT NULL DEFAULT 0,
  fetched                integer NOT NULL DEFAULT 0,   -- postings read from official board APIs
  title_matched          integer NOT NULL DEFAULT 0,   -- title matched a selected role phrase
  location_excluded      integer NOT NULL DEFAULT 0,   -- clearly outside the selected locations (counted, not stored)
  seniority_excluded     integer NOT NULL DEFAULT 0,   -- title explicitly senior while senior was not selected (counted, not stored)
  verified               integer NOT NULL DEFAULT 0,   -- passed official-employer/board verification and the JD gate, stored
  new_jobs               integer NOT NULL DEFAULT 0,
  changed_jd             integer NOT NULL DEFAULT 0,   -- a known job whose description text changed (a new revision)
  unchanged              integer NOT NULL DEFAULT 0,
  duplicates             integer NOT NULL DEFAULT 0,
  rejected               integer NOT NULL DEFAULT 0,   -- failed verification or the JD gate (see discovery_failures)
  limit_reached          text CHECK (limit_reached IS NULL OR limit_reached IN ('MAX_CANDIDATES', 'MAX_BOARDS')),
  error_code             text,
  error_detail           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  started_at             timestamptz,
  finished_at            timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('QUEUED', 'RUNNING')) = (finished_at IS NULL))
);
-- At most one run in progress per user, enforced by the database (a double click or a second window cannot start two).
CREATE UNIQUE INDEX discovery_runs_one_active_idx ON discovery_runs (user_id) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX discovery_runs_user_idx ON discovery_runs (user_id, created_at DESC);

CREATE TABLE discovery_run_boards (
  run_id              uuid NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  board_key           text NOT NULL CHECK (board_key ~ '^(greenhouse|lever):[A-Za-z0-9._-]{1,64}$'),
  position            integer NOT NULL,
  company             text NOT NULL,
  ats                 text NOT NULL CHECK (ats IN ('greenhouse', 'lever')),
  board               text NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'OK', 'FAILED', 'SKIPPED')),
  fetched             integer NOT NULL DEFAULT 0,
  title_matched       integer NOT NULL DEFAULT 0,
  location_excluded   integer NOT NULL DEFAULT 0,
  seniority_excluded  integer NOT NULL DEFAULT 0,
  stored              integer NOT NULL DEFAULT 0,
  new_jobs            integer NOT NULL DEFAULT 0,
  changed_jd          integer NOT NULL DEFAULT 0,
  unchanged           integer NOT NULL DEFAULT 0,
  duplicates          integer NOT NULL DEFAULT 0,
  rejected            integer NOT NULL DEFAULT 0,
  failure_code        text,
  failure_detail      text,
  blocked             boolean NOT NULL DEFAULT false,
  retryable           boolean NOT NULL DEFAULT false,
  started_at          timestamptz,
  finished_at         timestamptz,
  PRIMARY KEY (run_id, board_key),
  CHECK (status <> 'FAILED' OR failure_code IS NOT NULL)
);

CREATE TABLE jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ats_identity         text NOT NULL UNIQUE CHECK (ats_identity ~ '^(greenhouse|lever):[a-z0-9._-]+:[a-z0-9._-]+$'),
  company              text NOT NULL,
  ats                  text NOT NULL CHECK (ats IN ('greenhouse', 'lever')),
  board                text NOT NULL,
  requisition_id       text NOT NULL,
  title                text NOT NULL,
  location             text,
  department           text,
  employment_type      text,
  posting_date         text,
  canonical_url        text NOT NULL CHECK (canonical_url ~ '^https?://'),
  current_revision_id  uuid,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           uuid NOT NULL REFERENCES jobs(id),
  jd_sha256        char(64) NOT NULL CHECK (jd_sha256 ~ '^[a-f0-9]{64}$'),
  title            text NOT NULL,
  location         text,
  description_text text NOT NULL CHECK (length(description_text) >= 1),
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, jd_sha256)
);
ALTER TABLE jobs ADD CONSTRAINT jobs_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES job_revisions(id);

CREATE TABLE job_observations (
  id                bigserial PRIMARY KEY,
  run_id            uuid NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  job_id            uuid NOT NULL REFERENCES jobs(id),
  revision_id       uuid NOT NULL REFERENCES job_revisions(id),
  observed_url      text NOT NULL,
  final_url         text NOT NULL,
  source_kind       text NOT NULL,
  extraction_method text NOT NULL CHECK (extraction_method IN ('ats-api', 'browser-dom')),
  -- Why this posting counts as official: host kind, board, employer match. Never an eligibility decision.
  verification      jsonb NOT NULL CHECK (jsonb_typeof(verification) = 'object'),
  matched_roles     text[] NOT NULL CHECK (cardinality(matched_roles) >= 1),
  matched_phrases   text[] NOT NULL,
  location_status   text NOT NULL CHECK (location_status IN ('MATCH', 'UNKNOWN', 'UNSPECIFIED')),
  band_status       text NOT NULL CHECK (band_status IN ('WITHIN', 'OUTSIDE', 'UNSTATED')),
  stated_years      integer CHECK (stated_years IS NULL OR stated_years BETWEEN 0 AND 40),
  years_quote       text,
  seniority_signal  text NOT NULL CHECK (seniority_signal IN ('ENTRY', 'SENIOR', 'UNSPECIFIED')),
  observed_at       timestamptz NOT NULL,
  UNIQUE (run_id, job_id)
);
CREATE INDEX job_observations_job_idx ON job_observations (job_id);

CREATE TABLE discovery_failures (
  id             bigserial PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  board_key      text,
  stage          text NOT NULL CHECK (stage IN ('plan', 'search', 'resolution', 'persistence')),
  code           text NOT NULL,
  category       text,
  retryable      boolean NOT NULL DEFAULT false,
  blocked        boolean NOT NULL DEFAULT false,
  company        text,
  title          text,
  source_job_id  text,
  target_url     text,
  detail         text NOT NULL CHECK (length(detail) <= 400),
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discovery_failures_run_idx ON discovery_failures (run_id);

CREATE TRIGGER job_revisions_no_update BEFORE UPDATE OR DELETE ON job_revisions
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();

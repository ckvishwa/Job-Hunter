-- S1: candidate workflow (upload -> extraction -> pending facts -> human review).
-- PostgreSQL is authoritative for these tables only. Legacy jobs/profile JSONL stores are untouched.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle      text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9._-]{1,64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resumes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  sha256        char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  file_type     text NOT NULL CHECK (file_type IN ('pdf', 'docx')),
  byte_size     integer NOT NULL CHECK (byte_size > 0),
  -- Reference to the private stored file (relative to the private upload root). Never a user-supplied name.
  storage_ref   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, sha256)          -- idempotent upload: same bytes, same resume
);

CREATE TABLE resume_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resume_id          uuid NOT NULL REFERENCES resumes(id),
  contract_revision  text NOT NULL,          -- TypeScript-side extraction contract, e.g. resume-extract-v1
  parser_revision    text,                   -- what the AI service reported (rules / rules+model)
  state              text NOT NULL CHECK (state IN ('UPLOADED', 'EXTRACTING', 'PROPOSED', 'FAILED')),
  error_code         text,
  error_detail       text,
  extracted_text     text,
  text_sha256        char(64),
  warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,
  stats              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resume_id, contract_revision),
  CHECK ((state = 'FAILED') = (error_code IS NOT NULL)),
  CHECK (state <> 'PROPOSED' OR (extracted_text IS NOT NULL AND text_sha256 IS NOT NULL AND parser_revision IS NOT NULL))
);

-- Current head of each fact. History lives in fact_revisions (append-only).
CREATE TABLE candidate_facts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  fact_id            text NOT NULL CHECK (fact_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  resume_version_id  uuid REFERENCES resume_versions(id),   -- NULL for facts the user attested directly
  fact_key           char(64),                              -- deterministic extraction identity (idempotent re-extraction)
  kind               text NOT NULL CHECK (kind IN ('skill','employment','project','education','certification','clearance',
                                                   'work_authorization','citizenship','sponsorship_need','legal_name','email','phone')),
  value              text NOT NULL CHECK (length(value) BETWEEN 1 AND 300),
  polarity           text NOT NULL DEFAULT 'has' CHECK (polarity IN ('has', 'lacks')),
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  source             jsonb NOT NULL,                        -- {kind, reference, locator}
  span               jsonb,                                 -- {start, end, quote} UTF-16 offsets into extracted_text
  notes              text CHECK (notes IS NULL OR length(notes) <= 500),
  proposed_by        text NOT NULL CHECK (proposed_by IN ('rules', 'qwen', 'user')),
  approval_status    text NOT NULL CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  sensitivity        text NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  verification       jsonb NOT NULL,
  content_digest     char(64) NOT NULL,
  head_revision      integer NOT NULL CHECK (head_revision >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fact_id),
  UNIQUE (resume_version_id, fact_key),
  CHECK (kind NOT IN ('clearance','work_authorization','citizenship','sponsorship_need','legal_name','email','phone') OR sensitivity = 'sensitive'),
  -- Sensitive citizenship/clearance/authorization/sponsorship facts can only ever come from the user, never from a resume.
  CHECK (kind NOT IN ('clearance','work_authorization','citizenship','sponsorship_need') OR proposed_by = 'user'),
  CHECK (approval_status <> 'approved' OR ((verification->>'verifiedBy') IS NOT NULL AND (verification->>'verifiedAt') IS NOT NULL)),
  -- Facts proposed by a machine start pending; only a human action (see fact_revisions) moves them.
  CHECK (proposed_by = 'user' OR head_revision > 1 OR approval_status = 'pending')
);
CREATE INDEX candidate_facts_resume_version_idx ON candidate_facts (resume_version_id);

-- Append-only: one row per proposal, edit, approval or rejection. The snapshot is the full fact as it stood.
CREATE TABLE fact_revisions (
  id                    bigserial PRIMARY KEY,
  fact_pk               uuid NOT NULL REFERENCES candidate_facts(id),
  revision              integer NOT NULL CHECK (revision >= 1),
  action                text NOT NULL CHECK (action IN ('PROPOSED', 'EDIT', 'APPROVE', 'REJECT', 'ATTEST')),
  actor                 text NOT NULL,
  explicit_confirmation boolean NOT NULL DEFAULT false,
  snapshot              jsonb NOT NULL,
  content_digest        char(64) NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fact_pk, revision),
  -- Approving or attesting a sensitive fact requires the user's explicit confirmation to have been recorded.
  CHECK (NOT (action IN ('APPROVE', 'ATTEST') AND snapshot #>> '{fact,sensitivity}' = 'sensitive' AND NOT explicit_confirmation)),
  CHECK (action <> 'PROPOSED' OR revision = 1)
);

-- Digest of the approved-and-usable profile after each review action; later slices pin recommendations to one of these.
CREATE TABLE profile_revisions (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id),
  revision_no      integer NOT NULL CHECK (revision_no >= 1),
  profile_digest   char(64) NOT NULL,
  approved_count   integer NOT NULL CHECK (approved_count >= 0),
  reason           text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, revision_no)
);

CREATE FUNCTION jh_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER fact_revisions_no_update BEFORE UPDATE OR DELETE ON fact_revisions
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();
CREATE TRIGGER profile_revisions_no_update BEFORE UPDATE OR DELETE ON profile_revisions
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();
CREATE TRIGGER fact_revisions_no_truncate BEFORE TRUNCATE ON fact_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION jh_forbid_mutation();

INSERT INTO users (handle) VALUES ('local');

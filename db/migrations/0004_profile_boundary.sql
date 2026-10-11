-- P0: active candidate-profile boundary. S2 (and later S4) read evidence only from résumés that are explicitly authorized for the ACTIVE profile.
-- Additive only: no existing row is changed or deleted, and fact review histories are untouched. A résumé with no row here is UNVERIFIED and is
-- excluded from career scoring (never assumed synthetic, never assumed personal).

CREATE TABLE candidate_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  -- personal: evidence from the real candidate's documents.  demo: a fixture/demo profile that accepts fixture documents only.
  kind        text NOT NULL CHECK (kind IN ('personal', 'demo')),
  label       text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  active      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX candidate_profiles_one_active ON candidate_profiles (user_id) WHERE active;

-- Which uploaded résumés are evidence for which profile, what they were classified as, and why.
CREATE TABLE profile_sources (
  profile_id     uuid NOT NULL REFERENCES candidate_profiles(id),
  resume_id      uuid NOT NULL REFERENCES resumes(id),
  provenance     text NOT NULL CHECK (provenance IN ('personal', 'fixture', 'unverified')),
  authorized     boolean NOT NULL DEFAULT false,
  basis          text NOT NULL CHECK (length(basis) BETWEEN 5 AND 1000),
  classified_by  text NOT NULL,
  classified_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, resume_id),
  CHECK (NOT authorized OR provenance <> 'unverified')
);

CREATE TABLE profile_source_events (
  id          bigserial PRIMARY KEY,
  profile_id  uuid NOT NULL REFERENCES candidate_profiles(id),
  resume_id   uuid NOT NULL REFERENCES resumes(id),
  provenance  text NOT NULL,
  authorized  boolean NOT NULL,
  basis       text NOT NULL,
  actor       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER profile_source_events_no_update BEFORE UPDATE OR DELETE ON profile_source_events
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();

-- The candidate's own explicit statement of real employment. It is a REFERENCE: it never counts as experience by itself (experience comes
-- only from approved, source-backed facts) and it carries no quotation. It blocks résumé text that contradicts it from counting.
CREATE TABLE profile_confirmed_employment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id       uuid NOT NULL REFERENCES candidate_profiles(id),
  employer         text NOT NULL CHECK (length(employer) BETWEEN 1 AND 300),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  start_date       text NOT NULL CHECK (start_date ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_date         text CHECK (end_date IS NULL OR end_date ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- NULL = current
  employment_type  text NOT NULL CHECK (employment_type IN ('professional', 'internship', 'academic', 'volunteer')),
  detail           text CHECK (detail IS NULL OR length(detail) <= 500),
  statement        text NOT NULL CHECK (length(statement) BETWEEN 5 AND 1000),   -- how the candidate confirmed it
  confirmed_by     text NOT NULL,
  confirmed_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz
);

-- S2: role catalog, grounded role recommendations, human role selections.
-- Additive: no S1 table is altered. PostgreSQL is authoritative for these tables only.

-- Stable families. Seed-owned (name/tier/order may be refreshed by the seed); the slug is the stable identity.
CREATE TABLE role_families (
  family_slug  text PRIMARY KEY CHECK (family_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(family_slug) <= 64),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  tier         text NOT NULL CHECK (tier IN ('primary', 'secondary')),
  sort_order   integer NOT NULL,
  description  text NOT NULL CHECK (length(description) <= 600)
);

-- Current head of each role definition. History lives in role_catalog_revisions (append-only).
CREATE TABLE role_catalog (
  role_slug          text PRIMARY KEY CHECK (role_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(role_slug) <= 64),
  family_slug        text NOT NULL REFERENCES role_families(family_slug),
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description        text NOT NULL CHECK (length(description) <= 600),
  -- Evidence requirements (validated by the TypeScript role-definition schema): what approved facts could support the role.
  evidence           jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  active             boolean NOT NULL DEFAULT true,
  -- 'seed' rows may be refreshed by a newer seed; a 'user' row has been edited by a person and is never overwritten by the seed.
  origin             text NOT NULL CHECK (origin IN ('seed', 'user')),
  seed_digest        char(64),
  definition_digest  char(64) NOT NULL,
  head_revision      integer NOT NULL CHECK (head_revision >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Titles and aliases are data. An alias is a search/matching label; it never establishes eligibility.
CREATE TABLE role_aliases (
  role_slug   text NOT NULL REFERENCES role_catalog(role_slug),
  alias_norm  text NOT NULL CHECK (alias_norm = lower(alias_norm) AND length(alias_norm) BETWEEN 2 AND 80),
  alias       text NOT NULL CHECK (length(alias) BETWEEN 2 AND 80),
  PRIMARY KEY (role_slug, alias_norm)
);

CREATE TABLE role_catalog_versions (
  version_no  integer PRIMARY KEY CHECK (version_no >= 1),
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_catalog_revisions (
  id                 bigserial PRIMARY KEY,
  role_slug          text NOT NULL REFERENCES role_catalog(role_slug),
  revision           integer NOT NULL CHECK (revision >= 1),
  catalog_version    integer NOT NULL REFERENCES role_catalog_versions(version_no),
  action             text NOT NULL CHECK (action IN ('SEED', 'EDIT')),
  actor              text NOT NULL,
  snapshot           jsonb NOT NULL,
  definition_digest  char(64) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_slug, revision)
);

-- One current recommendation per (user, role). A recommendation is a pure function of the approved facts and the role definition;
-- when either changes the row is superseded (kept as history) and a fresh PROPOSED row replaces it.
CREATE TABLE candidate_role_recommendations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id),
  role_slug                text NOT NULL REFERENCES role_catalog(role_slug),
  family_slug              text NOT NULL REFERENCES role_families(family_slug),
  input_digest             char(64) NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  role_revision            integer NOT NULL,
  role_definition_digest   char(64) NOT NULL,
  catalog_version          integer NOT NULL,
  profile_revision_no      integer NOT NULL CHECK (profile_revision_no >= 0),
  support                  text NOT NULL CHECK (support IN ('SUPPORTED', 'PARTIAL')),
  source_fact_ids          text[] NOT NULL,
  evidence                 jsonb NOT NULL,
  gaps                     jsonb NOT NULL,
  status                   text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'DISMISSED')),
  decided_by               text,
  decided_at               timestamptz,
  superseded_at            timestamptz,
  superseded_reason        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'PROPOSED') = (decided_at IS NULL)),
  CHECK ((superseded_at IS NULL) = (superseded_reason IS NULL)),
  CHECK (cardinality(source_fact_ids) >= 1)
);
CREATE UNIQUE INDEX candidate_role_recommendations_current_idx
  ON candidate_role_recommendations (user_id, role_slug) WHERE superseded_at IS NULL;
CREATE INDEX candidate_role_recommendations_user_idx ON candidate_role_recommendations (user_id, superseded_at);

CREATE TABLE candidate_role_decisions (
  id                bigserial PRIMARY KEY,
  recommendation_id uuid NOT NULL REFERENCES candidate_role_recommendations(id),
  status            text NOT NULL CHECK (status IN ('PROPOSED', 'APPROVED', 'DISMISSED')),
  actor             text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Human target selection. Append-only revisions; the highest revision_no is current. An explicit selection governs S3 discovery;
-- model/rule suggestions never replace it.
CREATE TABLE search_preferences (
  id                bigserial PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id),
  revision_no       integer NOT NULL CHECK (revision_no >= 1),
  target_families   text[] NOT NULL,
  role_slugs        text[] NOT NULL,
  locations         jsonb NOT NULL CHECK (jsonb_typeof(locations) = 'array'),
  work_modes        text[] NOT NULL CHECK (work_modes <@ ARRAY['remote', 'hybrid', 'onsite']::text[]),
  seniority_levels  text[] NOT NULL CHECK (seniority_levels <@ ARRAY['entry', 'junior', 'mid', 'senior']::text[]),
  search_band       jsonb NOT NULL CHECK (jsonb_typeof(search_band) = 'object'),
  catalog_version   integer NOT NULL,
  actor             text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, revision_no)
);

CREATE TRIGGER role_catalog_revisions_no_update BEFORE UPDATE OR DELETE ON role_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();
CREATE TRIGGER role_catalog_versions_no_update BEFORE UPDATE OR DELETE ON role_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();
CREATE TRIGGER candidate_role_decisions_no_update BEFORE UPDATE OR DELETE ON candidate_role_decisions
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();
CREATE TRIGGER search_preferences_no_update BEFORE UPDATE OR DELETE ON search_preferences
  FOR EACH ROW EXECUTE FUNCTION jh_forbid_mutation();

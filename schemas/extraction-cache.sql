-- Matchline extraction cache schema, version 2.
-- Single source of truth: the C# worker writes this shape, packages/model-schema reads it.
-- Bump meta.schema_version on ANY change; readers refuse versions they don't know.
--
-- v2 (search set membership): selection_sets gains membership_resolved. v1 is
-- still readable — packages/model-schema reads a v1 row as resolved for
-- 'folder'/'selection' and unresolved for 'search', which is what a v1 writer
-- actually meant: it recorded saved searches without ever running them.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
-- Required keys:
--   schema_version      '2'
--   input_file_name     original NWD filename (name only, no directory — privacy)
--   input_sha256        lowercase hex digest of the NWD bytes; also the cache filename stem
--   input_bytes         decimal string
--   extracted_at_utc    ISO 8601
--   extractor_version   Matchline extractor semver
--   adapter_version     e.g. 'navisworks-2025'
--   navisworks_version  product version string reported by the API
--   object_count        decimal string, must equal COUNT(*) of objects (integrity check)

CREATE TABLE source_models (
  id           INTEGER PRIMARY KEY,          -- extraction ordinal, depth-first
  parent_id    INTEGER REFERENCES source_models(id),  -- nested appended models
  file_name    TEXT,                          -- as recorded inside the NWD (name only)
  display_name TEXT,
  guid         TEXT
);

CREATE TABLE objects (
  id              INTEGER PRIMARY KEY,        -- extraction ordinal, depth-first document order
  source_model_id INTEGER REFERENCES source_models(id),
  parent_id       INTEGER REFERENCES objects(id),
  path_index      INTEGER NOT NULL,           -- sibling position; (parent_id, path_index) is unique
  depth           INTEGER NOT NULL,
  display_name    TEXT,
  class_name      TEXT,                       -- Navisworks item class/category display
  instance_guid   TEXT,
  authoring_id    TEXT,
  -- bounding box optional per PRODUCT.md §6.4; all-or-none per row
  bbox_min_x REAL, bbox_min_y REAL, bbox_min_z REAL,
  bbox_max_x REAL, bbox_max_y REAL, bbox_max_z REAL
);
CREATE UNIQUE INDEX idx_objects_parent_pos ON objects(parent_id, path_index);

CREATE TABLE properties (
  object_id         INTEGER NOT NULL REFERENCES objects(id),
  category          TEXT NOT NULL,            -- display category name
  category_internal TEXT,
  name              TEXT NOT NULL,            -- display property name
  name_internal     TEXT,
  value_text        TEXT,                     -- canonical string form (culture-invariant)
  value_type        TEXT NOT NULL             -- Navisworks VariantDataType name, e.g. 'DisplayString'
);
CREATE INDEX idx_properties_object   ON properties(object_id);
CREATE INDEX idx_properties_cat_name ON properties(category, name);

CREATE TABLE selection_sets (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES selection_sets(id),   -- folder nesting
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('folder', 'selection', 'search')),
  -- 1 when this set's membership is known, 0 when the extractor could not work
  -- it out (a saved search that would not run). An unresolved set has NO rows
  -- in selection_set_members at all: absent is not empty, and a reader must
  -- refuse to filter on it rather than answer with zero objects.
  membership_resolved INTEGER NOT NULL DEFAULT 1 CHECK (membership_resolved IN (0, 1))
);

CREATE TABLE selection_set_members (
  set_id    INTEGER NOT NULL REFERENCES selection_sets(id),
  object_id INTEGER NOT NULL REFERENCES objects(id),
  PRIMARY KEY (set_id, object_id)
) WITHOUT ROWID;

CREATE TABLE warnings (
  id        INTEGER PRIMARY KEY,
  severity  TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code      TEXT NOT NULL,                    -- stable machine code, e.g. 'PROPERTY_READ_FAILED'
  message   TEXT NOT NULL,
  object_id INTEGER REFERENCES objects(id)
);

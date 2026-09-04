namespace Matchline.Extraction.Extractor
{
    /// <summary>
    /// The cache DDL, verbatim.
    /// <para>
    /// MUST STAY IN SYNC WITH schemas/extraction-cache.sql, which is the
    /// canonical copy that packages/model-schema reads against. It is duplicated
    /// here rather than shipped as a loose file so the launcher is a single
    /// self-contained executable. Any change to the canonical file must be
    /// mirrored here and must bump meta.schema_version on both sides.
    /// </para>
    /// <para>
    /// "Verbatim" is meant literally and is enforced: strip the one leading
    /// newline this string starts with and the remaining bytes equal
    /// schemas/extraction-cache.sql exactly. native/smoke asserts it. That is
    /// why two SQL comments below carry non-ASCII characters (an em dash and a
    /// section sign) -- they are in the canonical file, so they are here. This
    /// source file is UTF-8 with no BOM, which Roslyn reads as UTF-8; the smoke
    /// assertion is also the check that it survived the compiler intact.
    /// </para>
    /// </summary>
    internal static class CacheSchema
    {
        internal const string Ddl = @"
-- Matchline extraction cache schema, version 3.
-- Single source of truth: the C# worker writes this shape, packages/model-schema reads it.
-- Bump meta.schema_version on ANY change; readers refuse versions they don't know.
--
-- v2 (search set membership): selection_sets gains membership_resolved. v1 is
-- still readable — packages/model-schema reads a v1 row as resolved for
-- 'folder'/'selection' and unresolved for 'search', which is what a v1 writer
-- actually meant: it recorded saved searches without ever running them.
--
-- v3 (persistent object identity): objects gains authoring_id_kind,
-- structural_key and flags; source_models gains source_file_name and
-- source_guid; selection_sets gains guid. v1 and v2 stay readable: the reader
-- picks its column list from the declared version, so a column an older writer
-- never wrote reads as absent rather than as a failed SELECT.

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
-- Required keys:
--   schema_version      '3'
--   input_file_name     original NWD filename (name only, no directory — privacy)
--   input_sha256        lowercase hex digest of the NWD bytes; also the cache filename stem
--   input_bytes         decimal string
--   extracted_at_utc    ISO 8601
--   extractor_version   Matchline extractor semver
--   adapter_version     e.g. 'navisworks-2025'
--   navisworks_version  product version string reported by the API
--   object_count        decimal string, must equal COUNT(*) of objects (integrity check)
-- Optional keys, added in v3 and absent from every cache an older adapter wrote:
--   units               Document.Units as the API names it, e.g. 'Meters'
--   ui_language         the extracting process's UI culture, e.g. 'en-US'

CREATE TABLE source_models (
  id               INTEGER PRIMARY KEY,      -- extraction ordinal, depth-first
  parent_id        INTEGER REFERENCES source_models(id),  -- nested appended models
  file_name        TEXT,                     -- as recorded inside the NWD (name only)
  display_name     TEXT,
  guid             TEXT,
  source_file_name TEXT,                     -- Model.SourceFileName (name only, never a directory)
  source_guid      TEXT                      -- Model.SourceGuid, the appended file's own identity
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
  authoring_id    TEXT,                       -- the authoring tool's own object id
  -- Which well-known property pair answered authoring_id, e.g.
  -- 'revit-element-id', 'revit-unique-id', 'ifc-global-id', 'dwg-handle'. NULL
  -- exactly when authoring_id is NULL: an id whose origin is unknown is not one
  -- of these, and two authoring systems can number an object the same.
  authoring_id_kind TEXT,
  -- Lowercase SHA-256 hex over the ancestor chain of
  -- (class_name, display_name, path_index) from the source model's root down to
  -- this object. Shape only, never content, so a re-extraction of an unchanged
  -- model reproduces it; inserting a sibling changes only the siblings after it.
  structural_key  TEXT,
  -- Bitfield: 1 hidden, 2 layer, 4 insert, 8 composite, 16 collection,
  -- 32 has-model (the item is the root of an appended model).
  flags           INTEGER NOT NULL DEFAULT 0,
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
  membership_resolved INTEGER NOT NULL DEFAULT 1 CHECK (membership_resolved IN (0, 1)),
  -- SavedItem.Guid: the set's own persistent identity, which survives a rename.
  guid      TEXT
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
";
    }
}

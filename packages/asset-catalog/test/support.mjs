import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// model-schema is a sibling workspace. The Dragon fixture and the canonical
// DDL are imported by built path rather than by package name: the tests need
// them, the library does not, and `tsc -b` builds them via the project
// reference in this package's tsconfig.
import {
  EXTRACTION_CACHE_DDL,
  EXTRACTION_CACHE_DDL_V1,
  EXTRACTION_CACHE_DDL_V2,
} from '../../model-schema/dist/fixtures/dragon.js';

/**
 * The tables for a declared schema version.
 *
 * Writing a v1 cache means writing v1 tables, not v2 tables under a v1 label:
 * the reader chooses its columns from the declared version, so a mislabelled
 * fixture would prove nothing about the caches this reader will actually meet.
 */
const DDL_BY_VERSION = {
  1: EXTRACTION_CACHE_DDL_V1,
  2: EXTRACTION_CACHE_DDL_V2,
  3: EXTRACTION_CACHE_DDL,
};

/** A throwaway directory under the OS temp dir; callers remove it when done. */
export function makeTempDirectory(label) {
  return mkdtempSync(join(tmpdir(), `matchline-asset-catalog-${label}-`));
}

/** Meta the reader requires. Fixed values only -- no clock, no host paths. */
const META = {
  // Matches EXTRACTION_CACHE_DDL, which this writes: a file declaring one
  // version while carrying another's tables is a shape no writer produces.
  schema_version: '3',
  input_file_name: 'Dragon-Synthetic.nwd',
  input_sha256: '0'.repeat(64),
  input_bytes: '2048',
  extracted_at_utc: '2026-01-15T09:30:00Z',
  extractor_version: '0.1.0',
  adapter_version: 'navisworks-2025',
  navisworks_version: '25.0.1234.56',
};

/**
 * Writes a purpose-built cache: exactly the objects a test needs and nothing
 * else, so an expectation can be worked out by hand and read at a glance.
 *
 * Objects default to `Item` class-less roots; every field the DDL allows is
 * overridable. Property values are `DisplayString`, which is what the
 * extractor writes for text.
 */
export function writeSyntheticCache(path, content) {
  const sourceModels = content.sourceModels ?? [
    { id: 1, parentId: null, fileName: 'Dragon-Synthetic.nwc', displayName: 'Synthetic' },
  ];
  const objects = content.objects ?? [];
  const properties = content.properties ?? [];
  const selectionSets = content.selectionSets ?? [];
  const meta = { ...META, ...(content.meta ?? {}) };
  const ddl = DDL_BY_VERSION[Number(meta.schema_version)];
  if (ddl === undefined) {
    throw new Error(`no frozen DDL for schema_version '${meta.schema_version}'`);
  }

  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(ddl);
    db.exec('BEGIN');

    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(meta)) {
      insertMeta.run(key, value);
    }
    insertMeta.run('object_count', String(objects.length));

    // v3 columns are written only when the fixture declares v3; a v1/v2 file
    // does not have them, and that is the whole point of DDL_BY_VERSION.
    const withV3 = meta.schema_version === '3';
    const insertSourceModel = db.prepare(
      withV3
        ? 'INSERT INTO source_models (id, parent_id, file_name, display_name, guid, ' +
            'source_file_name, source_guid) VALUES (?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO source_models (id, parent_id, file_name, display_name, guid) ' +
            'VALUES (?, ?, ?, ?, ?)',
    );
    for (const model of sourceModels) {
      const columns = [
        model.id,
        model.parentId ?? null,
        model.fileName ?? null,
        model.displayName ?? null,
        model.guid ?? null,
      ];
      if (withV3) {
        columns.push(model.sourceFileName ?? null, model.sourceGuid ?? null);
      }
      insertSourceModel.run(...columns);
    }

    const insertObject = db.prepare(
      withV3
        ? 'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, ' +
            'class_name, instance_guid, authoring_id, authoring_id_kind, structural_key, flags) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, ' +
            'class_name, instance_guid, authoring_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [index, object] of objects.entries()) {
      const objectColumns = [
        object.id,
        // An explicit null means "the cache attributes this to no source
        // model", which is not the same as leaving the field out.
        object.sourceModelId === undefined ? 1 : object.sourceModelId,
        object.parentId ?? null,
        object.pathIndex ?? index,
        object.depth ?? 0,
        object.displayName ?? null,
        object.className ?? null,
        // Derived from the id so every object has one without a test saying so,
        // and overridable (`null` included) because P0-9 makes both the value
        // and its absence identity evidence a test may need to state.
        object.instanceGuid === undefined
          ? `00000000-0000-4000-8000-${String(object.id).padStart(12, '0')}`
          : object.instanceGuid,
        object.authoringId ?? null,
      ];
      if (withV3) {
        objectColumns.push(
          // Paired with the id: an id with no kind, or a kind with no id, is a
          // shape the extractor never writes.
          object.authoringId === undefined || object.authoringId === null
            ? null
            : (object.authoringIdKind ?? 'revit-element-id'),
          // Derived from the id so every object has one without a test saying
          // so, and overridable (`null` included) for the same reason the
          // InstanceGuid is.
          object.structuralKey === undefined
            ? String(object.id).padStart(64, 'b')
            : object.structuralKey,
          object.flags ?? 0,
        );
      }
      insertObject.run(...objectColumns);
    }

    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, value_text, value_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const property of properties) {
      insertProperty.run(
        property.objectId,
        property.category,
        property.category.toLowerCase(),
        property.name,
        property.name.toLowerCase(),
        property.valueText ?? null,
        'DisplayString',
      );
    }

    // v1 has no membership_resolved column, so a v1 fixture cannot write one.
    const writesMembership = ddl === EXTRACTION_CACHE_DDL;
    const insertSet = db.prepare(
      writesMembership
        ? 'INSERT INTO selection_sets (id, parent_id, name, kind, membership_resolved) VALUES (?, ?, ?, ?, ?)'
        : 'INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (?, ?, ?, ?)',
    );
    const insertMember = db.prepare(
      'INSERT INTO selection_set_members (set_id, object_id) VALUES (?, ?)',
    );
    for (const set of selectionSets) {
      // Resolved unless a test says otherwise, and an unresolved set gets no
      // member rows whatever it lists: that is the shape the schema promises.
      const resolved = set.membershipResolved ?? true;
      const columns = [set.id, set.parentId ?? null, set.name, set.kind ?? 'selection'];
      insertSet.run(...(writesMembership ? [...columns, resolved ? 1 : 0] : columns));
      for (const objectId of resolved ? (set.memberObjectIds ?? []) : []) {
        insertMember.run(set.id, objectId);
      }
    }

    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** The mapping every Dragon test starts from. */
export const DRAGON_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Item', name: 'Name' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
};

/** Tag only: for tests that care about candidate selection, not fields. */
export const TAG_ONLY_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
};

/** Filters with both required decisions made and no filter configured. */
export const NO_FILTERS = {
  requireTagProperty: true,
  collapseComponents: false,
};

/** `[stage, inCount, droppedCount]` per stage, for compact assertions. */
export function stageCounts(impact) {
  return impact.candidatesAfterEachFilter.map((stage) => [
    stage.stage,
    stage.inCount,
    stage.droppedCount,
  ]);
}

/** `[tag, assetId, sourceId]` per asset, sorted, for order-free comparison. */
export function assetShape(catalog) {
  return catalog.assets
    .map((asset) => [asset.canonicalTag, asset.assetId, asset.sourceId])
    .sort((left, right) => (left.join() < right.join() ? -1 : 1));
}

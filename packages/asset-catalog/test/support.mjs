import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// model-schema is a sibling workspace. The Dragon fixture and the canonical
// DDL are imported by built path rather than by package name: the tests need
// them, the library does not, and `tsc -b` builds them via the project
// reference in this package's tsconfig.
import { EXTRACTION_CACHE_DDL } from '../../model-schema/dist/fixtures/dragon.js';

/** A throwaway directory under the OS temp dir; callers remove it when done. */
export function makeTempDirectory(label) {
  return mkdtempSync(join(tmpdir(), `matchline-asset-catalog-${label}-`));
}

/** Meta the reader requires. Fixed values only -- no clock, no host paths. */
const META = {
  schema_version: '1',
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

  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(EXTRACTION_CACHE_DDL);
    db.exec('BEGIN');

    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(META)) {
      insertMeta.run(key, value);
    }
    insertMeta.run('object_count', String(objects.length));

    const insertSourceModel = db.prepare(
      'INSERT INTO source_models (id, parent_id, file_name, display_name, guid) VALUES (?, ?, ?, ?, ?)',
    );
    for (const model of sourceModels) {
      insertSourceModel.run(
        model.id,
        model.parentId ?? null,
        model.fileName ?? null,
        model.displayName ?? null,
        model.guid ?? null,
      );
    }

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [index, object] of objects.entries()) {
      insertObject.run(
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
      );
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

    const insertSet = db.prepare(
      'INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (?, ?, ?, ?)',
    );
    const insertMember = db.prepare(
      'INSERT INTO selection_set_members (set_id, object_id) VALUES (?, ?)',
    );
    for (const set of selectionSets) {
      insertSet.run(set.id, set.parentId ?? null, set.name, set.kind ?? 'selection');
      for (const objectId of set.memberObjectIds ?? []) {
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

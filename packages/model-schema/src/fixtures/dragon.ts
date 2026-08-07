/**
 * The Dragon fixture: a small, fully synthetic extraction cache.
 *
 * Dragon is an invented site. Real NWDs and anything derived from them are
 * client data and never enter this repo (docs/EXTRACTION.md, "Confidentiality"),
 * so every tag, building, model name and property here is made up. The file is
 * generated at test time rather than committed as a binary.
 *
 * The generator is deterministic: no clock, no randomness, no host paths. The
 * same call produces byte-identical table contents every run, which is what
 * lets tests assert exact catalog numbers.
 */
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { BoundingBox } from '../schema.js';

/**
 * The canonical DDL from `schemas/extraction-cache.sql`, comments stripped.
 * A test compares this against that file so the two cannot drift apart.
 */
export const EXTRACTION_CACHE_DDL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE source_models (
  id           INTEGER PRIMARY KEY,
  parent_id    INTEGER REFERENCES source_models(id),
  file_name    TEXT,
  display_name TEXT,
  guid         TEXT
);

CREATE TABLE objects (
  id              INTEGER PRIMARY KEY,
  source_model_id INTEGER REFERENCES source_models(id),
  parent_id       INTEGER REFERENCES objects(id),
  path_index      INTEGER NOT NULL,
  depth           INTEGER NOT NULL,
  display_name    TEXT,
  class_name      TEXT,
  instance_guid   TEXT,
  authoring_id    TEXT,
  bbox_min_x REAL, bbox_min_y REAL, bbox_min_z REAL,
  bbox_max_x REAL, bbox_max_y REAL, bbox_max_z REAL
);
CREATE UNIQUE INDEX idx_objects_parent_pos ON objects(parent_id, path_index);

CREATE TABLE properties (
  object_id         INTEGER NOT NULL REFERENCES objects(id),
  category          TEXT NOT NULL,
  category_internal TEXT,
  name              TEXT NOT NULL,
  name_internal     TEXT,
  value_text        TEXT,
  value_type        TEXT NOT NULL
);
CREATE INDEX idx_properties_object   ON properties(object_id);
CREATE INDEX idx_properties_cat_name ON properties(category, name);

CREATE TABLE selection_sets (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES selection_sets(id),
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('folder', 'selection', 'search'))
);

CREATE TABLE selection_set_members (
  set_id    INTEGER NOT NULL REFERENCES selection_sets(id),
  object_id INTEGER NOT NULL REFERENCES objects(id),
  PRIMARY KEY (set_id, object_id)
) WITHOUT ROWID;

CREATE TABLE warnings (
  id        INTEGER PRIMARY KEY,
  severity  TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  code      TEXT NOT NULL,
  message   TEXT NOT NULL,
  object_id INTEGER REFERENCES objects(id)
);
`;

/** Meta values that do not depend on the generated content. */
const DRAGON_META: readonly (readonly [string, string])[] = [
  ['schema_version', '1'],
  ['input_file_name', 'Dragon-Coordination.nwd'],
  ['input_sha256', '5f2c1a9d4b7e0836c5d19af42b6e8730914cad5b2e7f60381c9a4de5f7b02c68'],
  ['input_bytes', '104857600'],
  // Fixed on purpose: a clock reading would make the fixture non-deterministic.
  ['extracted_at_utc', '2026-01-15T09:30:00Z'],
  ['extractor_version', '0.1.0'],
  ['adapter_version', 'navisworks-2025'],
  ['navisworks_version', '25.0.1234.56'],
];

const SOURCE_MODEL_MECHANICAL = 1;
const SOURCE_MODEL_CONTROLS = 2;
const SOURCE_MODEL_CONTROLS_PLC = 3;

interface BuildingSpec {
  readonly name: string;
  /** Middle tag segment, so D1 and D2 tags never collide. */
  readonly levelSegment: string;
}

const BUILDINGS: readonly BuildingSpec[] = [
  { name: 'D1', levelSegment: '10' },
  { name: 'D2', levelSegment: '20' },
];

interface EquipmentSpec {
  readonly prefix: string;
  readonly upn: string;
  readonly count: number;
  /** `null` means the property row exists with no value. */
  readonly service: string | null;
}

const MECHANICAL_EQUIPMENT: readonly EquipmentSpec[] = [
  { prefix: 'MAH', upn: '001', count: 6, service: 'Chilled Water' },
  { prefix: 'MAH', upn: '002', count: 2, service: 'Hot Water' },
  { prefix: 'TIT', upn: '603', count: 4, service: null },
];

const CONTROLS_EQUIPMENT: readonly EquipmentSpec[] = [
  { prefix: 'PLC', upn: '001', count: 1, service: null },
  { prefix: 'VFD', upn: '001', count: 4, service: null },
];

const MANUFACTURERS = ['Dragon Air Systems', 'Wyvern Fans'] as const;
const LOOPS = ['LOOP-01', 'LOOP-02', 'LOOP-03'] as const;

interface FixtureObject {
  readonly id: number;
  readonly sourceModelId: number;
  readonly parentId: number | null;
  readonly pathIndex: number;
  readonly depth: number;
  readonly displayName: string;
  readonly className: string;
  readonly instanceGuid: string;
  readonly authoringId: string | null;
  readonly bbox: BoundingBox | null;
}

interface FixtureProperty {
  readonly objectId: number;
  readonly category: string;
  readonly categoryInternal: string;
  readonly name: string;
  readonly nameInternal: string;
  readonly valueText: string | null;
  readonly valueType: string;
}

interface FixtureSelectionSet {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly kind: string;
  readonly memberObjectIds: readonly number[];
}

interface FixtureWarning {
  readonly id: number;
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly objectId: number | null;
}

interface FixtureContent {
  readonly objects: readonly FixtureObject[];
  readonly properties: readonly FixtureProperty[];
  readonly selectionSets: readonly FixtureSelectionSet[];
  readonly warnings: readonly FixtureWarning[];
}

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function guidFor(id: number): string {
  return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
}

/** Bounds derived from the object id: arbitrary, but the same every run. */
function bboxFor(id: number): BoundingBox {
  return {
    minX: id * 10,
    minY: 0,
    minZ: 0,
    maxX: id * 10 + 5,
    maxY: 4,
    maxZ: 3,
  };
}

/**
 * Builds the Dragon model in memory: two disciplines, two buildings each,
 * equipment with one geometry child apiece, and one geometry node deliberately
 * left with no properties at all so readers get exercised against it.
 */
function buildDragonContent(): FixtureContent {
  const objects: FixtureObject[] = [];
  const properties: FixtureProperty[] = [];
  let nextObjectId = 1;

  const addObject = (object: Omit<FixtureObject, 'id' | 'instanceGuid'>): FixtureObject => {
    const id = nextObjectId;
    nextObjectId += 1;
    const created: FixtureObject = { ...object, id, instanceGuid: guidFor(id) };
    objects.push(created);
    return created;
  };

  const addProperty = (
    objectId: number,
    category: string,
    name: string,
    valueText: string | null,
  ): void => {
    properties.push({
      objectId,
      category,
      categoryInternal: category.toLowerCase().replaceAll(' ', '_'),
      name,
      nameInternal: name.toLowerCase().replaceAll(' ', '_'),
      valueText,
      valueType: 'DisplayString',
    });
  };

  /** Every object but one carries Item/Name and Item/Type. */
  const addItemProperties = (object: FixtureObject): void => {
    addProperty(object.id, 'Item', 'Name', object.displayName);
    addProperty(object.id, 'Item', 'Type', object.className);
  };

  const mahEquipmentIds: number[] = [];
  const plcIds: number[] = [];
  let manufacturerIndex = 0;
  let loopIndex = 0;
  let noteWritten = false;
  // The last mechanical geometry node is left with no properties at all: real
  // extractions hit nodes whose properties fail to read, and readers and the
  // catalog both have to cope with an object that carries nothing.
  let strippedObjectId = 0;

  // --- Dragon-Mechanical.nwc -------------------------------------------------
  const mechanicalRoot = addObject({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: null,
    pathIndex: 0,
    depth: 0,
    displayName: 'Dragon-Mechanical.nwc',
    className: 'File',
    authoringId: null,
    bbox: null,
  });
  addItemProperties(mechanicalRoot);

  for (const [buildingIndex, building] of BUILDINGS.entries()) {
    const buildingObject = addObject({
      sourceModelId: SOURCE_MODEL_MECHANICAL,
      parentId: mechanicalRoot.id,
      pathIndex: buildingIndex,
      depth: 1,
      displayName: building.name,
      className: 'Layer',
      authoringId: null,
      bbox: null,
    });
    addItemProperties(buildingObject);
    addProperty(buildingObject.id, 'Dragon Data', 'Building', building.name);

    let pathIndex = 0;
    for (const [specIndex, spec] of MECHANICAL_EQUIPMENT.entries()) {
      for (let unit = 1; unit <= spec.count; unit += 1) {
        const tag = `${spec.prefix}${spec.upn}-${building.levelSegment}-${twoDigits(unit)}`;
        const equipment = addObject({
          sourceModelId: SOURCE_MODEL_MECHANICAL,
          parentId: buildingObject.id,
          pathIndex,
          depth: 2,
          displayName: tag,
          className: 'Equipment',
          authoringId: `id-${tag}`,
          bbox: bboxFor(nextObjectId),
        });
        pathIndex += 1;
        if (spec.prefix === 'MAH') {
          mahEquipmentIds.push(equipment.id);
        }

        addItemProperties(equipment);
        addProperty(equipment.id, 'Dragon Data', 'Tag', tag);
        addProperty(equipment.id, 'Dragon Data', 'Building', building.name);
        addProperty(equipment.id, 'Dragon Data', 'UPN', spec.upn);
        addProperty(
          equipment.id,
          'Dragon Data',
          'Manufacturer',
          MANUFACTURERS[manufacturerIndex % MANUFACTURERS.length] ?? MANUFACTURERS[0],
        );
        manufacturerIndex += 1;
        addProperty(equipment.id, 'Dragon Data', 'Service', spec.service);
        if (!noteWritten) {
          // One object carries the same property twice: coverage counts
          // objects, not rows, and this is what proves it.
          addProperty(equipment.id, 'Dragon Data', 'Note', 'Verify with vendor');
          addProperty(equipment.id, 'Dragon Data', 'Note', 'Coordinate with controls');
          noteWritten = true;
        }

        const solid = addObject({
          sourceModelId: SOURCE_MODEL_MECHANICAL,
          parentId: equipment.id,
          pathIndex: 0,
          depth: 3,
          displayName: 'Solid',
          className: 'Solid',
          authoringId: null,
          bbox: bboxFor(nextObjectId),
        });
        const isLastMechanicalNode =
          buildingIndex === BUILDINGS.length - 1 &&
          specIndex === MECHANICAL_EQUIPMENT.length - 1 &&
          unit === spec.count;
        if (isLastMechanicalNode) {
          strippedObjectId = solid.id;
        } else {
          addItemProperties(solid);
        }
      }
    }
  }

  // --- Dragon-Controls.nwc ---------------------------------------------------
  const controlsRoot = addObject({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: null,
    pathIndex: 1,
    depth: 0,
    displayName: 'Dragon-Controls.nwc',
    className: 'File',
    authoringId: null,
    bbox: null,
  });
  addItemProperties(controlsRoot);

  for (const [buildingIndex, building] of BUILDINGS.entries()) {
    const buildingObject = addObject({
      sourceModelId: SOURCE_MODEL_CONTROLS,
      parentId: controlsRoot.id,
      pathIndex: buildingIndex,
      depth: 1,
      displayName: building.name,
      className: 'Layer',
      authoringId: null,
      bbox: null,
    });
    addItemProperties(buildingObject);
    addProperty(buildingObject.id, 'Dragon Data', 'Building', building.name);

    let pathIndex = 0;
    for (const spec of CONTROLS_EQUIPMENT) {
      for (let unit = 1; unit <= spec.count; unit += 1) {
        const tag = `${spec.prefix}${spec.upn}-${building.levelSegment}-${twoDigits(unit)}`;
        const equipment = addObject({
          sourceModelId: SOURCE_MODEL_CONTROLS,
          parentId: buildingObject.id,
          pathIndex,
          depth: 2,
          displayName: tag,
          className: 'Equipment',
          authoringId: `id-${tag}`,
          bbox: bboxFor(nextObjectId),
        });
        pathIndex += 1;

        addItemProperties(equipment);
        addProperty(equipment.id, 'Dragon Data', 'Tag', tag);
        addProperty(equipment.id, 'Dragon Data', 'Building', building.name);
        addProperty(equipment.id, 'Dragon Data', 'UPN', spec.upn);

        if (spec.prefix === 'PLC') {
          plcIds.push(equipment.id);
          addProperty(equipment.id, 'Controls Data', 'Firmware', '4.2.1');
          // Modules live in the appended PLC model, not the controls model.
          for (let slot = 1; slot <= 2; slot += 1) {
            const module = addObject({
              sourceModelId: SOURCE_MODEL_CONTROLS_PLC,
              parentId: equipment.id,
              pathIndex: slot - 1,
              depth: 3,
              displayName: `Module ${twoDigits(slot)}`,
              className: 'Module',
              authoringId: null,
              bbox: null,
            });
            addItemProperties(module);
            addProperty(module.id, 'Controls Data', 'Slot', twoDigits(slot));
          }
        } else {
          addProperty(
            equipment.id,
            'Controls Data',
            'Loop',
            LOOPS[loopIndex % LOOPS.length] ?? LOOPS[0],
          );
          loopIndex += 1;
          const terminal = addObject({
            sourceModelId: SOURCE_MODEL_CONTROLS,
            parentId: equipment.id,
            pathIndex: 0,
            depth: 3,
            displayName: 'Terminal',
            className: 'Terminal',
            authoringId: null,
            bbox: null,
          });
          addItemProperties(terminal);
        }
      }
    }
  }

  const selectionSets: readonly FixtureSelectionSet[] = [
    { id: 1, parentId: null, name: 'Dragon Systems', kind: 'folder', memberObjectIds: [] },
    {
      id: 2,
      parentId: 1,
      name: 'Air Handling',
      kind: 'selection',
      memberObjectIds: mahEquipmentIds,
    },
    { id: 3, parentId: null, name: 'PLC Panels', kind: 'search', memberObjectIds: plcIds },
  ];

  const warnings: readonly FixtureWarning[] = [
    {
      id: 1,
      severity: 'warning',
      code: 'PROPERTY_READ_FAILED',
      message: 'Properties could not be read for one geometry node.',
      objectId: strippedObjectId,
    },
    {
      id: 2,
      severity: 'info',
      code: 'BBOX_UNAVAILABLE',
      message: 'Bounding boxes were not published for layer nodes.',
      objectId: null,
    },
  ];

  return { objects, properties, selectionSets, warnings };
}

/**
 * Writes the Dragon cache to `path`, replacing any file already there.
 *
 * The result satisfies `schemas/extraction-cache.sql` including the
 * `meta.object_count` integrity check, so `openExtractionCache` accepts it.
 */
export function writeDragonFixture(path: string): void {
  rmSync(path, { force: true });
  const content = buildDragonContent();
  const db = new DatabaseSync(path);
  try {
    db.exec(EXTRACTION_CACHE_DDL);
    db.exec('BEGIN');

    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of DRAGON_META) {
      insertMeta.run(key, value);
    }
    insertMeta.run('object_count', String(content.objects.length));

    const insertSourceModel = db.prepare(
      'INSERT INTO source_models (id, parent_id, file_name, display_name, guid) VALUES (?, ?, ?, ?, ?)',
    );
    insertSourceModel.run(
      SOURCE_MODEL_MECHANICAL,
      null,
      'Dragon-Mechanical.nwc',
      'Dragon Mechanical',
      guidFor(1001),
    );
    insertSourceModel.run(
      SOURCE_MODEL_CONTROLS,
      null,
      'Dragon-Controls.nwc',
      'Dragon Controls',
      guidFor(1002),
    );
    insertSourceModel.run(
      SOURCE_MODEL_CONTROLS_PLC,
      SOURCE_MODEL_CONTROLS,
      'Dragon-Controls-PLC.nwc',
      'Dragon Controls PLC',
      guidFor(1003),
    );

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id, bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const object of content.objects) {
      insertObject.run(
        object.id,
        object.sourceModelId,
        object.parentId,
        object.pathIndex,
        object.depth,
        object.displayName,
        object.className,
        object.instanceGuid,
        object.authoringId,
        object.bbox === null ? null : object.bbox.minX,
        object.bbox === null ? null : object.bbox.minY,
        object.bbox === null ? null : object.bbox.minZ,
        object.bbox === null ? null : object.bbox.maxX,
        object.bbox === null ? null : object.bbox.maxY,
        object.bbox === null ? null : object.bbox.maxZ,
      );
    }

    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, value_text, value_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const property of content.properties) {
      insertProperty.run(
        property.objectId,
        property.category,
        property.categoryInternal,
        property.name,
        property.nameInternal,
        property.valueText,
        property.valueType,
      );
    }

    const insertSelectionSet = db.prepare(
      'INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (?, ?, ?, ?)',
    );
    const insertMember = db.prepare(
      'INSERT INTO selection_set_members (set_id, object_id) VALUES (?, ?)',
    );
    for (const set of content.selectionSets) {
      insertSelectionSet.run(set.id, set.parentId, set.name, set.kind);
      for (const objectId of set.memberObjectIds) {
        insertMember.run(set.id, objectId);
      }
    }

    const insertWarning = db.prepare(
      'INSERT INTO warnings (id, severity, code, message, object_id) VALUES (?, ?, ?, ?, ?)',
    );
    for (const warning of content.warnings) {
      insertWarning.run(
        warning.id,
        warning.severity,
        warning.code,
        warning.message,
        warning.objectId,
      );
    }

    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

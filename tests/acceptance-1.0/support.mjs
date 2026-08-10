/**
 * Dragon fixtures and failure vocabulary for the 1.0 acceptance suite.
 *
 * ## Why this file exists rather than importing `packages/compiler/test/support.mjs`
 *
 * That file is the compiler package's own fixture, and milestones 2-4 are
 * expected to edit it as the APIs it feeds change shape. An acceptance gate that
 * imports it would quietly change meaning every time somebody adjusted a unit
 * test's scenario. So this suite keeps its own copy of the Dragon scenario and
 * depends only on published package entry points -- the same self-contained
 * habit `tests/integration/*` already follows.
 *
 * ## Dragon only
 *
 * Every tag, building, property and workbook row here is invented (see
 * `packages/model-schema/src/fixtures/dragon.ts`). No client data, no real
 * Navisworks output, nothing derived from either.
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openExtractionCache } from '@matchline/model-schema';
import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { writeWorkbook } from '@matchline/spreadsheet-import';

/* ------------------------------------------------- the failure vocabulary --- */

/**
 * The message every assertion in this suite fails with today.
 *
 * These tests encode 1.0 TARGET semantics against a 0.8.1 engine, so failing is
 * the correct result until the named milestone lands. A failure has to say
 * *which* milestone, or a red suite is indistinguishable from a regression.
 */
export function pending(milestone, what) {
  return (
    `not implemented yet: ${what}\n` +
    `      -> milestone ${milestone} of docs/RELEASE-1.0-PLAN.md is what makes this pass`
  );
}

/**
 * Runs a call against an API that may not exist yet.
 *
 * A missing target API must surface as a named assertion failure, not as an
 * unhandled TypeError from somewhere three packages down: a crash tells a
 * reader the suite is broken, and an assertion tells them the work is not done.
 */
export function attempt(milestone, what, fn) {
  try {
    return fn();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    assert.fail(`${pending(milestone, what)}\n      the current API threw: ${detail}`);
  }
}

/** Fails when a target field is absent, naming the field and the milestone. */
export function requirePresent(milestone, what, value) {
  assert.ok(
    value !== undefined && value !== null,
    pending(milestone, what),
  );
  return value;
}

/**
 * Whether a value's JSON form mentions every one of `needles`.
 *
 * Used where the directive binds the *content* of an output but not the field
 * that carries it -- P0-4 requires "a visible review item" explaining a
 * boundary crossing without naming a `ReviewItem` kind, and pinning an invented
 * kind string here would make this suite a spec for a name rather than for a
 * behaviour. The milestone author picks the shape; the test insists it names
 * the child, the parent and the boundary.
 */
export function mentionsAll(value, needles) {
  const text = JSON.stringify(value, (_key, raw) =>
    raw instanceof Map ? [...raw.entries()] : raw instanceof Set ? [...raw] : raw,
  );
  return text !== undefined && needles.every((needle) => text.includes(needle));
}

/* ----------------------------------------------------------- the profile --- */

/** `MAH001-10-01` -> role `MAH`, system `001`, unit `10`, instance `01`. */
export const DRAGON_ANATOMY = {
  separators: ['-'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
};

/** Dragon has no literal Description/Discipline property; these are the stand-ins. */
export const PROPERTY_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
  nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
};

export const ASSET_FILTERS = {
  requireTagProperty: true,
  collapseComponents: false,
};

/** Model UPN then the tag's own system segment. They agree everywhere on Dragon. */
export const SYSTEM_RESOLVER = {
  keyChain: [
    { kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } },
    { kind: 'tag-segment', segment: 'system' },
  ],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [],
  conflictPolicy: 'review',
};

/**
 * The model alone decides the system (PRODUCT.md §2.5).
 *
 * The RIO is tagged by the loop it serves (`RIO603-…`) and commissioned under
 * its own system (`650`). Keeping the tag rung would make that a resolver
 * conflict instead of the boundary crossing the test is about.
 */
export const MODEL_ONLY_RESOLVER = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } }],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [],
  conflictPolicy: 'review',
};

/** ENGINE.md's MAH -> PLC -> VFD -> TIT ladder, plus §2.5's panel/RIO pairing. */
export const ROLE_GRAPH = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
    { parentRole: 'PNL', childRole: 'RIO' },
  ],
};

/** Building then system, both hard boundaries (DECISIONS.md #1). */
export const HIERARCHY = {
  levels: [
    {
      levelId: 'building',
      displayName: 'Building',
      attributeKey: 'building',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'system',
      displayName: 'System',
      attributeKey: 'systemKey',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'key',
    },
  ],
};

export function siteProfile(overrides = {}) {
  return {
    profileId: 'dragon',
    name: 'Dragon',
    version: 1,
    propertyMappings: PROPERTY_MAPPINGS,
    assetFilters: ASSET_FILTERS,
    tagAnatomy: DRAGON_ANATOMY,
    systemResolver: SYSTEM_RESOLVER,
    ...overrides,
  };
}

/** `tag:<canonicalTag>` -- `asset-catalog`'s id for an unduplicated tag. */
export function idOf(tag) {
  return `tag:${tag}`;
}

/* --------------------------------------------------------------- the MEL --- */

export const MEL_SOURCE_FILE = 'Dragon-MEL.xlsx';

export const MEL_MAPPING = {
  equipmentTag: 'Equipment Tag',
  upn: 'UPN',
  systemDescription: 'System Description',
};

/** System 001's description, as revision A of the MEL states it. */
export const SYSTEM_001_DESCRIPTION_A = 'Mechanical Dry Air Handling';
/** The same system, reworded. P0-6: this must not move a single asset. */
export const SYSTEM_001_DESCRIPTION_B = 'Mechanical Dry Air Handling (Zone 1)';

/** A three-row MEL whose System 001 wording the caller chooses. */
export function melWorkbook(system001Description = SYSTEM_001_DESCRIPTION_A) {
  return {
    bytes: writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description'],
          ['MAH001-10-01', '001', system001Description],
          ['MAH002-10-01', '002', 'Mechanical Hot Water'],
          ['TIT603-10-01', '603', 'Temperature Instrumentation'],
        ],
      },
    ]),
    sourceFile: MEL_SOURCE_FILE,
    sheetName: 'MEL',
    mapping: MEL_MAPPING,
    headerRow: 0,
  };
}

/* -------------------------------------------------------- connectivity --- */

export const CONNECTIVITY_SOURCE_FILE = 'Dragon-Connectivity.xlsx';

/** One EasyPower sheet. `rows` are `[startingSource, idName]` pairs. */
export function connectivityWorkbooks(rows) {
  return [
    {
      bytes: writeWorkbook([
        { name: 'EasyPower', aoa: [['Starting Source', 'ID Name'], ...rows] },
      ]),
      sourceFile: CONNECTIVITY_SOURCE_FILE,
    },
  ];
}

/* ------------------------------------------------------------- the cache --- */

const SOURCE_MODEL_MECHANICAL = 1;
const SOURCE_MODEL_CONTROLS = 2;
const SOURCE_MODEL_CONTROLS_PLC = 3;

/**
 * Appends invented objects to a written Dragon cache.
 *
 * `writeDragonFixture` is shared by every package's tests and stays untouched:
 * the scenarios below need model shapes the base fixture does not have, and
 * growing it would move every other suite's counts. `meta.object_count` is
 * rewritten because `openExtractionCache` validates it against `COUNT(*)`.
 */
function augmentDragonCache(path, build) {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id, bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)',
    );
    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, value_text, value_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    let nextId = db.prepare('SELECT MAX(id) AS id FROM objects').get().id + 1;

    const nextPathIndex = (parentId) => {
      const query = 'SELECT MAX(path_index) AS slot FROM objects WHERE parent_id';
      const row =
        parentId === null
          ? db.prepare(`${query} IS NULL`).get()
          : db.prepare(`${query} = ?`).get(parentId);
      return (row.slot ?? -1) + 1;
    };

    const context = {
      /** The building layer of one discipline model, by its display name. */
      layerId(displayName, sourceModelId) {
        return db
          .prepare(
            'SELECT id FROM objects WHERE display_name = ? AND source_model_id = ? AND depth = 1',
          )
          .get(displayName, sourceModelId).id;
      },

      addProperty(objectId, category, name, value) {
        insertProperty.run(
          objectId,
          category,
          category.toLowerCase().replaceAll(' ', '_'),
          name,
          name.toLowerCase().replaceAll(' ', '_'),
          value,
          'DisplayString',
        );
      },

      /** One tagged piece of equipment: the properties this suite's profile maps. */
      addEquipment({ sourceModelId, parentId, depth, tag, upn, building, service }) {
        const id = nextId;
        nextId += 1;
        insertObject.run(
          id,
          sourceModelId,
          parentId,
          nextPathIndex(parentId),
          depth,
          tag,
          'Equipment',
          `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
          `id-${tag}`,
        );
        context.addProperty(id, 'Item', 'Name', tag);
        context.addProperty(id, 'Item', 'Type', 'Equipment');
        context.addProperty(id, 'Dragon Data', 'Tag', tag);
        context.addProperty(id, 'Dragon Data', 'Building', building);
        context.addProperty(id, 'Dragon Data', 'UPN', upn);
        context.addProperty(id, 'Dragon Data', 'Manufacturer', 'Dragon Air Systems');
        if (service !== undefined) {
          context.addProperty(id, 'Dragon Data', 'Service', service);
        }
        return id;
      },

      /** Rewrites one object's mapped tag, keeping its InstanceGuid untouched. */
      retag(fromTag, toTag) {
        const row = db
          .prepare(
            "SELECT object_id AS id FROM properties WHERE category = 'Dragon Data' " +
              "AND name = 'Tag' AND value_text = ?",
          )
          .get(fromTag);
        assert.ok(row, `the fixture should carry a Dragon Data > Tag of ${fromTag}`);
        db.prepare(
          "UPDATE properties SET value_text = ? WHERE object_id = ? AND category = 'Dragon Data' AND name = 'Tag'",
        ).run(toTag, row.id);
        db.prepare('UPDATE objects SET display_name = ? WHERE id = ?').run(toTag, row.id);
        db.prepare(
          "UPDATE properties SET value_text = ? WHERE object_id = ? AND category = 'Item' AND name = 'Name'",
        ).run(toTag, row.id);
        return row.id;
      },
    };

    build(context);

    const count = db.prepare('SELECT COUNT(*) AS total FROM objects').get().total;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(count), 'object_count');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/**
 * PRODUCT.md §2.5 in Dragon spelling: a panel in System 603 feeding a remote
 * I/O commissioned under System 650.
 *
 * Siblings under the D1 controls layer on purpose -- nesting them would add a
 * model-tree claim and make the test about two rungs instead of one.
 */
export function rioPanel(context) {
  const d1 = context.layerId('D1', SOURCE_MODEL_CONTROLS);
  const shared = { sourceModelId: SOURCE_MODEL_CONTROLS, parentId: d1, depth: 2, building: 'D1' };
  context.addEquipment({ ...shared, tag: 'PNL603-10-01', upn: '603' });
  context.addEquipment({ ...shared, tag: 'RIO603-10-01', upn: '650' });
}

/**
 * P0-5's startup family: one System Key, four native disciplines.
 *
 * ```text
 * MAH007-10-09  UPN 007  Service Mechanical
 * PLC007-10-09  UPN 007  Service Controls
 * VFD007-10-09  UPN 007  Service Electrical
 * TIT007-10-09  UPN 007  Service I&C
 * ```
 *
 * Family key `007-10-09` on all four, so the taught MAH->PLC->VFD->TIT pairings
 * make one chain. Building D1 and System 007 on all four, so the only enabled
 * boundary the chain crosses is the discipline one -- which is exactly the
 * boundary P0-5 says must be off by default.
 */
export const STARTUP_FAMILY = [
  { tag: 'MAH007-10-09', service: 'Mechanical' },
  { tag: 'PLC007-10-09', service: 'Controls' },
  { tag: 'VFD007-10-09', service: 'Electrical' },
  { tag: 'TIT007-10-09', service: 'I&C' },
];

export function startupFamily(context) {
  const d1 = context.layerId('D1', SOURCE_MODEL_MECHANICAL);
  for (const member of STARTUP_FAMILY) {
    context.addEquipment({
      sourceModelId: SOURCE_MODEL_MECHANICAL,
      parentId: d1,
      depth: 2,
      tag: member.tag,
      upn: '007',
      building: 'D1',
      service: member.service,
    });
  }
}

/**
 * A temp-dir Dragon cache. `close` releases the handle and removes the
 * directory, so no test leaves a file behind.
 */
export function openDragonCache(label, build) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-a10-${label}-`));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  if (build !== undefined) {
    augmentDragonCache(path, build);
  }
  const cache = openExtractionCache(path);
  return {
    cache,
    close() {
      cache.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A copy of the Dragon cache holding only some of its source models.
 *
 * The federated Dragon fixture is one cache carrying three `source_models`
 * (Mechanical, Controls, and the appended Controls-PLC). Splitting it is how
 * P0-1's "federated vs split representations of one site" gets two caches whose
 * union is exactly the federated one: same object ids, same InstanceGuids, same
 * properties, just partitioned.
 *
 * `inputFileName` is what the split file calls itself -- P0-1 also requires two
 * sources with the same basename to coexist, and that needs two caches free to
 * claim the same name.
 */
export function openDragonSplit(label, sourceModelIds, inputFileName) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-a10-${label}-`));
  const federated = join(directory, 'federated.sqlite');
  const path = join(directory, 'split.sqlite');
  writeDragonFixture(federated);
  copyFileSync(federated, path);
  rmSync(federated, { force: true });

  const keep = new Set(sourceModelIds);
  const db = new DatabaseSync(path);
  try {
    // Off, and outside the transaction because the pragma is a no-op inside
    // one. A partition removes whole subtrees, so there is a moment where a
    // kept row still points at a dropped one; the deletes below are what make
    // the file consistent again, and `openExtractionCache` is what checks it.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    const drop = [SOURCE_MODEL_MECHANICAL, SOURCE_MODEL_CONTROLS, SOURCE_MODEL_CONTROLS_PLC]
      .filter((id) => !keep.has(id));
    for (const sourceModelId of drop) {
      db.prepare(
        'DELETE FROM properties WHERE object_id IN (SELECT id FROM objects WHERE source_model_id = ?)',
      ).run(sourceModelId);
      db.prepare(
        'DELETE FROM selection_set_members WHERE object_id IN (SELECT id FROM objects WHERE source_model_id = ?)',
      ).run(sourceModelId);
      db.prepare(
        'DELETE FROM warnings WHERE object_id IN (SELECT id FROM objects WHERE source_model_id = ?)',
      ).run(sourceModelId);
      db.prepare('DELETE FROM objects WHERE source_model_id = ?').run(sourceModelId);
      db.prepare('DELETE FROM source_models WHERE id = ?').run(sourceModelId);
    }
    const count = db.prepare('SELECT COUNT(*) AS total FROM objects').get().total;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(count), 'object_count');
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(inputFileName, 'input_file_name');
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const cache = openExtractionCache(path);
  return {
    cache,
    close() {
      cache.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export const DRAGON_MECHANICAL_MODELS = [SOURCE_MODEL_MECHANICAL];
export const DRAGON_CONTROLS_MODELS = [SOURCE_MODEL_CONTROLS, SOURCE_MODEL_CONTROLS_PLC];

/** The `sourceId` a gate that is not about the universe registers its cache under. */
export const SINGLE_SOURCE_ID = 'dragon';

/**
 * One cache as the universe of one `compileProject` takes (P0-1).
 *
 * Milestone 2 removed `CompileProjectInput.cache` outright rather than
 * deprecating it, so every gate has to say which source its cache is. The gates
 * that are not about the universe say it once, here, and their assertions are
 * untouched: `assetId` only names a source for a duplicated tag or an untagged
 * asset, and none of those scenarios has either.
 */
export function oneSource(cache) {
  return [{ sourceId: SINGLE_SOURCE_ID, cache }];
}

/* ------------------------------------------------------- canonicalization --- */

/**
 * A compiled project reduced to what P0-1 says two representations of one site
 * must agree on: the asset set by tag, who parents whom, what depends on what,
 * and every asset's system.
 *
 * Provenance is excluded on purpose -- the directive excepts it, because a
 * federated compile really did read one file where a split compile read two,
 * and a canonical form that hid that would be lying rather than comparing.
 */
export function canonicalOutputs(project) {
  const tagOf = new Map();
  for (const asset of project.catalog.assets) {
    tagOf.set(asset.assetId, asset.canonicalTag);
  }
  const name = (assetId) => tagOf.get(assetId) ?? assetId;

  const parents = [];
  const dependencies = [];
  for (const [assetId, node] of project.snapshot.nodes) {
    parents.push(
      `${name(assetId)} -> ${node.parent.parentAssetId === null ? '(root)' : name(node.parent.parentAssetId)}`,
    );
    for (const dependency of node.dependencies) {
      dependencies.push(
        `${name(assetId)} <- ${name(dependency.parentAssetId)} (${dependency.relationshipType})`,
      );
    }
  }

  const systems = [];
  for (const [assetId, resolved] of project.systems.bySubject) {
    systems.push(`${name(assetId)} = ${resolved.resolution?.systemKey ?? '(none)'}`);
  }

  return {
    tags: [...tagOf.values()].sort(),
    parents: parents.sort(),
    dependencies: dependencies.sort(),
    systems: systems.sort(),
  };
}

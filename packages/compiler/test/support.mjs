/**
 * The Dragon project the compiler tests compile.
 *
 * One invented site, described once: the Site Profile, the hierarchy, the
 * taught role graph, the invented MEL and the invented connectivity workbook.
 * Every number the tests assert is worked out on paper from what is here, so
 * this file states each choice and what it is worth.
 *
 * ## The asset universe (34 assets)
 *
 * `packages/model-schema/src/fixtures/dragon.ts` builds two disciplines across
 * two buildings, and `requireTagProperty` keeps exactly the tagged equipment:
 *
 * | building | mechanical                          | controls               |
 * |----------|-------------------------------------|------------------------|
 * | D1 (`10`)| MAH001 x6, MAH002 x2, TIT603 x4     | PLC001 x1, VFD001 x4   |
 * | D2 (`20`)| MAH001 x6, MAH002 x2, TIT603 x4     | PLC001 x1, VFD001 x4   |
 *
 * 12 + 12 mechanical, 5 + 5 controls = 34. Every tag is unique (the middle
 * segment differs per building), so there are no duplicate-tag review items.
 *
 * ## Anatomy, and the families it produces
 *
 * `MAH001-10-01` -> role `MAH`, system `001`, familyKey `001-10-01`. The family
 * key is what makes `MAH001-10-01`, `PLC001-10-01` and `VFD001-10-01` one
 * family and `TIT603-10-01` a family of its own -- which is why the taught
 * `VFD -> TIT` rule below produces nothing, and is supposed to.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrateSiteProfileV1 } from '@matchline/domain';
import { openExtractionCache } from '@matchline/model-schema';
import {
  DRAGON_SOURCE_MODEL_IDS,
  writeDragonFixture,
  writeDragonFixtureSubset,
} from '@matchline/model-schema/fixtures/dragon';
import { writeWorkbook } from '@matchline/spreadsheet-import';

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

/**
 * Dragon has no property literally called "Description" or "Discipline", so the
 * profile maps the roles onto properties that exist -- the same move the E1
 * integration test makes with `Manufacturer`.
 *
 * `Dragon Data > Service` is only written on the MAH equipment (`Chilled Water`
 * on MAH001, `Hot Water` on MAH002) and is a null-valued row on TIT; the
 * controls model has no such property at all. That spread is deliberate: it
 * gives the discipline tests assets with a value, assets whose value is blank,
 * and assets nobody stated one for.
 */
export const PROPERTY_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
  nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
};

/** Both disciplines: the feed chain below needs MAH/TIT and PLC/VFD alike. */
export const ASSET_FILTERS = {
  requireTagProperty: true,
  collapseComponents: false,
};

/**
 * Two rungs that agree everywhere on Dragon: the mapped model UPN and the tag's
 * own system segment. Agreement, not conflict, is the point -- a compile whose
 * every asset conflicted would make the conflict counts meaningless.
 */
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

/** ENGINE.md's MAH -> PLC -> VFD -> TIT ladder, as three directional rules. */
export const ROLE_GRAPH = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
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

/**
 * One `SiteProfileV2`. `overrides` replaces whole sections, never merges them.
 *
 * Built through `migrateSiteProfileV1` rather than written out longhand, so this
 * fixture exercises the same lift every stored profile goes through and cannot
 * drift into a shape only the tests can produce. The two sections a Dragon
 * compile needs beyond the V1 half -- the level stack and the role graph -- are
 * supplied as the migration's `sections`, which is exactly how the desktop hands
 * over the rows its config table used to hold.
 */
export function siteProfile(overrides = {}) {
  const base = migrateSiteProfileV1(
    {
      profileId: 'dragon',
      name: 'Dragon',
      version: 1,
      propertyMappings: PROPERTY_MAPPINGS,
      assetFilters: ASSET_FILTERS,
      tagAnatomy: DRAGON_ANATOMY,
      systemResolver: SYSTEM_RESOLVER,
    },
    { hierarchy: HIERARCHY, roleGraph: ROLE_GRAPH },
  );
  return { ...base, ...overrides };
}

/* ------------------------------------------------------------------ MEL --- */

export const MEL_SOURCE_FILE = 'Dragon-MEL.xlsx';

/** The MEL's `UPN` column is the System Key (PRODUCT.md §2.3: "System Key = UPN"). */
export const MEL_MAPPING = {
  equipmentTag: 'Equipment Tag',
  upn: 'UPN',
  systemDescription: 'System Description',
};

/**
 * Four rows describing three systems.
 *
 * The fourth row gives `603` a second description on purpose: one system key
 * carrying several descriptions is a `system-catalog-conflict` review item
 * (PRODUCT.md §5.7), and it is the compile's only MEL-stage item.
 */
export function melWorkbookBytes() {
  return writeWorkbook([
    {
      name: 'MEL',
      aoa: [
        ['Equipment Tag', 'UPN', 'System Description'],
        ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
        ['MAH002-10-01', '002', 'Mechanical Hot Water'],
        ['TIT603-10-01', '603', 'Temperature Instrumentation'],
        ['TIT603-10-02', '603', 'Temperature Instruments'],
      ],
    },
  ]);
}

export function melWorkbook() {
  return {
    bytes: melWorkbookBytes(),
    sourceFile: MEL_SOURCE_FILE,
    sheetName: 'MEL',
    mapping: MEL_MAPPING,
    headerRow: 0,
  };
}

/* --------------------------------------------------------- connectivity --- */

export const CONNECTIVITY_SOURCE_FILE = 'Dragon-Connectivity.xlsx';

/** A switchgear bus the model never modeled: the feed root, and FLOW_ONLY. */
export const FEED_ROOT_TAG = 'SWBD-1';
/** A feed tag with no relationship to any Dragon tag, fuzzy or otherwise. */
export const UNKNOWN_FEED_TAG = 'UNKNOWN-PANEL-99';
/** A one-character typo of `TIT603-10-01`: proposed, never auto-matched (§9.2). */
export const FUZZY_PMD_TAG = 'TIT603-1O-01';
/** A PMD instrument with no resemblance to anything in the model. */
export const UNKNOWN_PMD_TAG = 'PMD-INST-999';

/**
 * Nine observations across three sheets, every header taken from the *exact*
 * detection rungs so no override is needed.
 *
 * The rows are chosen against the anatomy above:
 *
 * - `MAH001-10-01 -> PLC001-10-01` and `PLC001-10-01 -> VFD001-10-01` are
 *   same-family, taught-pairing edges: flow-anchored family claims.
 * - `VFD001-10-01 -> TIT603-10-01` crosses a family (`001-10-01` vs
 *   `603-10-01`), so it is a dependency and never a nesting.
 * - The two cable rows into `PLC001-20-01` are the parallel-cable pair: two
 *   observations, two edges, one multi-fed node, and one deduped claim.
 */
export function connectivityWorkbookBytes(extraEasyPowerRows = []) {
  return writeWorkbook([
    {
      name: 'EasyPower',
      aoa: [
        ['Starting Source', 'ID Name'],
        [FEED_ROOT_TAG, 'MAH001-10-01'],
        ['MAH001-10-01', 'PLC001-10-01'],
        ['PLC001-10-01', 'VFD001-10-01'],
        ['VFD001-10-01', 'TIT603-10-01'],
        ['VFD001-10-01', UNKNOWN_FEED_TAG],
        ...extraEasyPowerRows,
      ],
    },
    {
      name: 'Cable Schedule',
      aoa: [
        ['Panel (From)', 'Load Name (To)', 'Cable Tag'],
        ['MAH001-20-01', 'PLC001-20-01', 'C-201'],
        ['MAH001-20-01', 'PLC001-20-01', 'C-202'],
      ],
    },
    {
      name: 'PMD',
      aoa: [
        ['Panel', 'Instrument Tag'],
        ['PLC001-10-01', FUZZY_PMD_TAG],
        ['PLC001-10-01', UNKNOWN_PMD_TAG],
      ],
    },
  ]);
}

export function connectivityWorkbooks(extraEasyPowerRows = []) {
  return [
    {
      bytes: connectivityWorkbookBytes(extraEasyPowerRows),
      sourceFile: CONNECTIVITY_SOURCE_FILE,
    },
  ];
}

/* ------------------------------------------------------------ the cache --- */

const SOURCE_MODEL_MECHANICAL = 1;
const SOURCE_MODEL_CONTROLS = 2;

/**
 * Appends invented objects to a written Dragon cache.
 *
 * `writeDragonFixture` is a shared fixture and stays exactly as it is: two
 * scenarios below need model shapes the base Dragon does not have (equipment
 * nested inside equipment, and a cross-system panel/RIO pair), and growing the
 * shared fixture for them would move every other package's counts. So the
 * additions are written here, into this test's own copy of the cache.
 *
 * `meta.object_count` is rewritten to match, because `openExtractionCache`
 * validates it against `COUNT(*)` and would reject a partially grown cache.
 */
function augmentDragonCache(path, build) {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id, authoring_id_kind, structural_key, flags, ' +
        'bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE 'revit-element-id' END, " +
        "'', 0, NULL, NULL, NULL, NULL, NULL, NULL)",
    );
    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, value_text, value_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    let nextId = db.prepare('SELECT MAX(id) AS id FROM objects').get().id + 1;

    /** The next free sibling slot: `objects(parent_id, path_index)` is unique. */
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
        const row = db
          .prepare(
            'SELECT id FROM objects WHERE display_name = ? AND source_model_id = ? AND depth = 1',
          )
          .get(displayName, sourceModelId);
        return row.id;
      },

      addObject({ sourceModelId, parentId, depth, displayName, className }) {
        const id = nextId;
        nextId += 1;
        insertObject.run(
          id,
          sourceModelId,
          parentId,
          nextPathIndex(parentId),
          depth,
          displayName,
          className,
          `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
          null,
          null,
        );
        context.addProperty(id, 'Item', 'Name', displayName);
        context.addProperty(id, 'Item', 'Type', className);
        return id;
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

      /**
       * Rewrites one meta value.
       *
       * Used to give a cache a different `input_sha256` without changing an
       * object: a re-extraction of an unchanged model is exactly that, and P0-9
       * says a content hash is never part of identity.
       */
      setMeta(key, value) {
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key);
      },

      /** The object carrying a mapped tag. */
      objectIdOfTag(tag) {
        const row = db
          .prepare(
            "SELECT object_id AS id FROM properties WHERE category = 'Dragon Data' " +
              "AND name = 'Tag' AND value_text = ?",
          )
          .get(tag);
        return row === undefined ? null : row.id;
      },

      /**
       * Rewrites one object's mapped tag, its display name and its `Item > Name`.
       *
       * `instance_guid` and `authoring_id` are deliberately untouched: this is a
       * tag CORRECTION, and the whole question P0-9 asks is whether the engine
       * can tell that from a replacement.
       */
      retag(fromTag, toTag) {
        const id = context.objectIdOfTag(fromTag);
        if (id === null) {
          throw new Error(`the fixture carries no Dragon Data > Tag of ${fromTag}`);
        }
        db.prepare(
          "UPDATE properties SET value_text = ? WHERE object_id = ? AND category = 'Dragon Data' AND name = 'Tag'",
        ).run(toTag, id);
        db.prepare(
          "UPDATE properties SET value_text = ? WHERE object_id = ? AND category = 'Item' AND name = 'Name'",
        ).run(toTag, id);
        db.prepare('UPDATE objects SET display_name = ? WHERE id = ?').run(toTag, id);
        return id;
      },

      /** Re-parents one object, which is what moves its structural key. */
      moveUnder(tag, parentId, depth) {
        const id = context.objectIdOfTag(tag);
        if (id === null) {
          throw new Error(`the fixture carries no Dragon Data > Tag of ${tag}`);
        }
        db.prepare('UPDATE objects SET parent_id = ?, path_index = ?, depth = ? WHERE id = ?').run(
          parentId,
          nextPathIndex(parentId),
          depth,
          id,
        );
        return id;
      },

      /**
       * Rewrites one object's durable ids.
       *
       * The other half of {@link retag}: this is what a REPLACEMENT looks like
       * in the cache, so a test can tell the two apart instead of assuming the
       * engine can.
       */
      setObjectIdentity(objectId, { authoringId, authoringIdKind, instanceGuid }) {
        if (authoringId !== undefined) {
          // The kind travels with the id, because that is the only shape the
          // extractor writes: authoring_id_kind is NULL exactly when
          // authoring_id is. Setting one without the other would produce a row
          // no cache has, and would quietly stop two objects with the same id
          // from colliding at that tier -- which is the thing a split test is
          // about.
          db.prepare(
            'UPDATE objects SET authoring_id = ?, authoring_id_kind = ? WHERE id = ?',
          ).run(
            authoringId,
            authoringId === null ? null : (authoringIdKind ?? 'revit-element-id'),
            objectId,
          );
        }
        if (instanceGuid !== undefined) {
          db.prepare('UPDATE objects SET instance_guid = ? WHERE id = ?').run(
            instanceGuid,
            objectId,
          );
        }
      },

      /** One tagged piece of equipment: the four properties the profile maps. */
      addEquipment({ sourceModelId, parentId, depth, tag, className, upn, building, service }) {
        const id = context.addObject({
          sourceModelId,
          parentId,
          depth,
          displayName: tag,
          className,
        });
        context.addProperty(id, 'Dragon Data', 'Tag', tag);
        context.addProperty(id, 'Dragon Data', 'Building', building);
        context.addProperty(id, 'Dragon Data', 'UPN', upn);
        if (service !== undefined) {
          context.addProperty(id, 'Dragon Data', 'Service', service);
        }
        return id;
      },
    };

    build(context);

    // Every mutation above -- a move, a rename, a new object -- changes the
    // shape of the tree, and a re-extraction is what these fixtures stand in
    // for: the extractor recomputes objects.structural_key from the chain above
    // each object, so leaving stale keys behind would let that identity tier
    // answer a question the real cache cannot, and quietly disarm every test
    // about falling through to a weaker tier.
    recomputeStructuralKeys(db);

    const count = db.prepare('SELECT COUNT(*) AS total FROM objects').get().total;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(count), 'object_count');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/**
 * Recomputes every `objects.structural_key`, the way the extractor does.
 *
 * The same computation as `DocumentWalker.StructuralKey` and the fixture
 * generators: a digest of (class name, display name, sibling position) chained
 * through the parent's digest, from the model root down. Ordered by id, which
 * is depth-first extraction order, so a parent's key is always in hand before
 * its children need it.
 */
function recomputeStructuralKeys(db) {
  const rows = db
    .prepare('SELECT id, parent_id, path_index, display_name, class_name FROM objects ORDER BY id')
    .all();
  const update = db.prepare('UPDATE objects SET structural_key = ? WHERE id = ?');
  const keys = new Map();
  for (const row of rows) {
    const parentKey = row.parent_id === null ? '' : (keys.get(row.parent_id) ?? '');
    const material =
      `${parentKey}\u001e${row.class_name ?? ''}\u001f${row.display_name ?? ''}` +
      `\u001f${String(row.path_index)}`;
    const key = createHash('sha256').update(material, 'utf8').digest('hex');
    keys.set(row.id, key);
    update.run(key, row.id);
  }
}

/**
 * A skid in D1: equipment nested inside equipment, plus one yard item modeled
 * at the top of the file.
 *
 * Everything the model-tree rung has to answer for is in this one shape:
 *
 * ```text
 * Dragon-Mechanical.nwc
 * +- D1
 * |  +- SKD001-10-01            <- no asset above it: no suggestion
 * |     +- Skid Frame           <- untagged, so no asset owns it
 * |        +- PMP001-10-01      <- suggestion: SKD (the climb passes the frame)
 * |           +- VLV001-10-01   <- suggestion: PMP, the NEARER of two ancestors
 * +- YRD001-10-01               <- a root object: no suggestion
 * ```
 *
 * `Valve` is the class the collapse test lists as separately commissionable, so
 * the same cache serves both readings: with `collapseComponents` on, PMP is
 * absorbed into SKD, the valve escapes, and its suggestion becomes SKD.
 *
 * Every added asset carries UPN `001` and building `D1`, so the boundary fold
 * keeps what the model tree suggests rather than folding it away -- the point
 * here is the rung, not the fold.
 */
export function nestedSkid(context) {
  const d1 = context.layerId('D1', SOURCE_MODEL_MECHANICAL);
  const shared = {
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    upn: '001',
    building: 'D1',
    service: 'Chilled Water',
  };

  const skid = context.addEquipment({
    ...shared,
    parentId: d1,
    depth: 2,
    tag: 'SKD001-10-01',
    className: 'Equipment',
  });
  const frame = context.addObject({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: skid,
    depth: 3,
    displayName: 'Skid Frame',
    className: 'Frame',
  });
  const pump = context.addEquipment({
    ...shared,
    parentId: frame,
    depth: 4,
    tag: 'PMP001-10-01',
    className: 'Equipment',
  });
  context.addEquipment({
    ...shared,
    parentId: pump,
    depth: 5,
    tag: 'VLV001-10-01',
    className: 'Valve',
  });
  context.addEquipment({
    ...shared,
    parentId: null,
    depth: 0,
    tag: 'YRD001-10-01',
    className: 'Equipment',
  });
}

/**
 * An untagged skid that absorbs a tagged pump.
 *
 * ```text
 * Dragon-Mechanical.nwc
 * +- D1
 *    +- (Assembly, no Tag property)   <- the representative object
 *       +- PMP002-10-01 (Equipment)   <- absorbed, and it carries a tag
 * ```
 *
 * The catalog reads `canonicalTag` off the representative only, so this asset's
 * tag is `''` -- an absorbed component is a part of the asset, not the asset,
 * and its tag never renames the whole. The property-bag seam reads across every
 * owned object, so without a special case the same asset would report a tag the
 * catalog says it does not have. That disagreement is what
 * `properties.test.mjs` pins.
 *
 * Both objects are class `Assembly`/`Equipment` so that
 * {@link UNTAGGED_SKID_FILTERS}'s class restriction makes exactly these two the
 * collapse candidates: the D1 layer above them is a different class and never
 * becomes a candidate ancestor, so nothing else in Dragon collapses.
 */
export const UNTAGGED_SKID_TAG = 'PMP002-10-01';

export function untaggedSkid(context) {
  const d1 = context.layerId('D1', SOURCE_MODEL_MECHANICAL);
  const skid = context.addObject({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: d1,
    depth: 2,
    displayName: 'Unlabelled Skid',
    className: 'Assembly',
  });
  // A property the skid does state, so the bag is not empty and the assertion
  // is about the tag specifically rather than about reading nothing at all.
  context.addProperty(skid, 'Dragon Data', 'Building', 'D1');
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: skid,
    depth: 3,
    tag: UNTAGGED_SKID_TAG,
    className: 'Equipment',
    upn: '001',
    building: 'D1',
    service: 'Chilled Water',
  });
}

/** Keeps untagged objects, and restricts collapse to the skid and its pump. */
export const UNTAGGED_SKID_FILTERS = {
  includedClasses: ['Assembly', 'Equipment'],
  requireTagProperty: false,
  collapseComponents: true,
};

/**
 * PRODUCT.md §2.5's own example, in Dragon spelling: an electrical panel in
 * System 603 feeding a remote I/O commissioned under System 650.
 *
 * The two tags share a family key (`603-10-01`, from the anatomy's system, unit
 * and instance segments) and the taught `PNL -> RIO` pairing applies, so the
 * connectivity edge between them is a flow-anchored *structural* claim. What
 * separates them is the UPN the model states, which is what {@link RIO_RESOLVER}
 * reads. That is the whole scenario: one nesting claim, crossing one boundary.
 *
 * They are siblings under the D1 controls layer on purpose -- nesting them
 * would add a model-tree claim and make the test about two rungs instead of one.
 */
export function rioPanel(context) {
  const d1 = context.layerId('D1', SOURCE_MODEL_CONTROLS);
  const shared = { sourceModelId: SOURCE_MODEL_CONTROLS, parentId: d1, depth: 2, building: 'D1' };

  context.addEquipment({ ...shared, tag: 'PNL603-10-01', className: 'Equipment', upn: '603' });
  context.addEquipment({ ...shared, tag: 'RIO603-10-01', className: 'Equipment', upn: '650' });
}

/**
 * The system a site STATES, not the one a tag spells.
 *
 * {@link SYSTEM_RESOLVER}'s second rung reads the tag's own system segment, and
 * a RIO whose tag reads `603` while the model says `650` would resolve as a
 * conflict rather than as System 650. Dropping the tag rung is what makes the
 * model the single authority -- and it is the only honest way to describe a site
 * whose RIO is tagged by the loop it serves and commissioned under its own
 * system (PRODUCT.md §2.5).
 */
export const RIO_RESOLVER = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } }],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [],
  conflictPolicy: 'review',
};

/** {@link ROLE_GRAPH} plus the panel/RIO pairing §2.5's example needs. */
export const RIO_ROLE_GRAPH = {
  rules: [...ROLE_GRAPH.rules, { parentRole: 'PNL', childRole: 'RIO' }],
};

/**
 * A temp-dir Dragon cache. The caller closes it and removes the directory
 * through the returned `close`, so no test leaves a file behind.
 *
 * `build` is an optional cache extension -- {@link nestedSkid} or
 * {@link rioPanel} -- applied to this cache only.
 */
export function openDragonCache(label, build) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-compiler-${label}-`));
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
 * A temp-dir cache holding only part of Dragon, under its own file name.
 *
 * The federated Dragon fixture is one file carrying a Mechanical source model,
 * a Controls one and the Controls-PLC model appended inside it.
 * `writeDragonFixtureSubset` partitions it into caches whose tagged objects
 * partition the federated file exactly -- same ids, same InstanceGuids, same
 * properties -- which is what makes "federated versus split" a comparison of
 * two representations of one site rather than of two sites.
 *
 * `build` is the same optional cache extension {@link openDragonCache} takes,
 * applied after the subset is written.
 */
export function openDragonSubset(label, opts, build) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-compiler-${label}-`));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixtureSubset(path, opts);
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

/** The mechanical half of Dragon: 24 of the fixture's 34 tagged assets. */
export const DRAGON_MECHANICAL_MODELS = [DRAGON_SOURCE_MODEL_IDS.mechanical];
/** The controls half, PLC module included: the other 10. */
export const DRAGON_CONTROLS_MODELS = [
  DRAGON_SOURCE_MODEL_IDS.controls,
  DRAGON_SOURCE_MODEL_IDS.controlsPlc,
];

/**
 * One cache as the universe of one `compileProject` takes.
 *
 * Every test that is not about the universe registers its cache under this one
 * id, which keeps the asset ids in their assertions stable: an `assetId` only
 * names its source for a duplicated tag or an untagged asset, and the tests that
 * have either are in `multi-source.test.mjs`.
 */
export function oneSource(cache) {
  return [{ sourceId: 'dragon', cache }];
}

/**
 * The full input: the universe, the whole profile, both workbooks.
 *
 * The hierarchy and the role graph are no longer arguments of their own -- they
 * are sections of the profile, and `siteProfile()` already carries them. A test
 * that wants different ones passes `profile: siteProfile({ hierarchy })`.
 */
export function fullInput(cache, overrides = {}) {
  return {
    sources: oneSource(cache),
    profile: siteProfile(),
    melWorkbook: melWorkbook(),
    connectivityWorkbooks: connectivityWorkbooks(),
    ...overrides,
  };
}

/** `tag:<canonicalTag>` -- `asset-catalog`'s id for an unduplicated tag. */
export function idOf(tag) {
  return `tag:${tag}`;
}

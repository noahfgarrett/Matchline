/**
 * The scale fixture: an invented site as large as a real one.
 *
 * Dragon is small on purpose — every count a test asserts against it is worked
 * out on paper. This is the opposite fixture and answers the other question
 * (RELEASE-1.0-PLAN, "Scale tests: multi-cache >=250k objects aggregate, >=40k
 * assets, >=1M property rows"): does the pipeline still finish, still agree
 * with itself, and still leave the main loop alone, at the size a refinery
 * actually has.
 *
 * Invented like Dragon and for the same reason (docs/EXTRACTION.md,
 * "Confidentiality"): no real tag, building, system or file name has ever been
 * in this repo and none ever will be. Generated at test time rather than
 * committed, because a quarter of a million objects is not a fixture anyone
 * should be checking in.
 *
 * Deterministic in full: no clock, no randomness, no host path. The same shape
 * produces byte-identical table contents every run, which is what lets a
 * shuffled-source-order determinism test mean anything.
 *
 * ## The shape it builds
 *
 * ```text
 * <inputFileName>                       the file root
 * +- U10                                one layer per unit code
 * |  +- MAH001-10-0001                  a family: four roles, one instance
 * |  |  +- Solid 1 .. Solid N           untagged geometry, one asset owns them
 * |  +- PLC001-10-0001
 * |  +- VFD001-10-0001
 * |  +- TIT001-10-0001
 * |  +- MAH002-10-0002 ...
 * +- U11 ...
 * ```
 *
 * The four roles of a family share their system, unit and instance segments, so
 * a `familyKeyTemplate` of `{system}-{token:1}-{token:2}` groups them — which is
 * what gives the taught MAH -> PLC -> VFD -> TIT ladder something to resolve at
 * every one of forty thousand assets rather than a hierarchy that is all roots.
 */
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { EXTRACTION_CACHE_DDL } from './dragon.js';

/** The roles of one family, parent-first, as {@link SCALE_ROLE_GRAPH} pairs them. */
export const SCALE_ROLES: readonly string[] = ['MAH', 'PLC', 'VFD', 'TIT'];

/** The taught ladder these tags are built for. */
export const SCALE_ROLE_GRAPH = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
  ],
} as const;

/** `MAH001-10-0001` -> role MAH, system 001, unit 10, instance 0001. */
export const SCALE_ANATOMY = {
  separators: ['-'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
} as const;

/** Where the fixture writes the fields a profile maps. */
export const SCALE_PROPERTIES = {
  equipmentTag: { category: 'Site Data', name: 'Tag' },
  description: { category: 'Site Data', name: 'Description' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Site Data', name: 'Building' },
  nativeDiscipline: { category: 'Site Data', name: 'Service' },
  systemKey: { category: 'Site Data', name: 'UPN' },
} as const;

/** How many distinct system keys the tags cycle through. */
const SYSTEM_COUNT = 20;

/** The disciplines `Site Data > Service` cycles through. */
const SERVICES: readonly string[] = ['Chilled Water', 'Hot Water', 'Process Air', 'Instrument'];

/** The mapped property rows every asset carries. Filler is written on top. */
const MAPPED_PROPERTIES_PER_ASSET = 7;

/** What one cache is asked to contain. */
export interface ScaleFixtureShape {
  /** What the cache says it was extracted from. Shown in provenance. */
  readonly inputFileName: string;
  /**
   * The unit codes this file's tags use — one building layer each.
   *
   * Must not overlap between files of one universe: the unit is the tag segment
   * that keeps two caches' tags apart, and a repeat would make duplicate tags
   * the subject of a test that is not about them.
   */
  readonly unitCodes: readonly string[];
  /** Families per unit code. Each family is one asset per {@link SCALE_ROLES}. */
  readonly familiesPerUnit: number;
  /** Untagged geometry children per asset. */
  readonly componentsPerAsset: number;
  /**
   * Property rows written on each asset, the mapped ones included.
   *
   * Anything above {@link MAPPED_PROPERTIES_PER_ASSET} is filler under its own
   * category, which is what a real model's hundreds of authoring properties
   * are to this pipeline: read past, counted, never mapped.
   */
  readonly propertiesPerAsset: number;
}

/** What one written cache actually holds. */
export interface ScaleFixtureCounts {
  readonly objectCount: number;
  readonly assetCount: number;
  readonly propertyCount: number;
}

function guidFor(id: number): string {
  return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
}

/**
 * A stand-in `input_sha256`, derived from the invented file name.
 *
 * Never the hash of any real content, and deliberately not a real digest: the
 * desktop records a cache's actual hash itself, and all a fixture owes is a
 * well-formed 64-hex value that differs between two files of one universe and
 * does not differ between two writes of one file.
 */
function fixtureSha256(inputFileName: string): string {
  let hex = '';
  for (let index = 0; index < 64; index += 1) {
    const code = inputFileName.charCodeAt(index % inputFileName.length);
    hex += ((code + index * 7) % 16).toString(16);
  }
  return hex;
}

/**
 * Writes a scale cache to `path`, replacing any file already there.
 *
 * Rows are streamed into one transaction as they are invented rather than
 * assembled into arrays first: a quarter of a million objects and a million
 * properties held in memory before the first insert would make the fixture
 * itself the thing that runs out of heap.
 *
 * @throws Error when the shape asks for fewer properties per asset than the
 * mapped fields need, which would produce assets the profile cannot read.
 */
export function writeScaleFixture(path: string, shape: ScaleFixtureShape): ScaleFixtureCounts {
  if (shape.propertiesPerAsset < MAPPED_PROPERTIES_PER_ASSET) {
    throw new Error(
      `an asset needs at least ${String(MAPPED_PROPERTIES_PER_ASSET)} property rows for the ` +
        'mapped fields; the shape asked for ' + String(shape.propertiesPerAsset),
    );
  }

  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  let objectCount = 0;
  let assetCount = 0;
  let propertyCount = 0;

  try {
    db.exec(EXTRACTION_CACHE_DDL);
    db.exec('BEGIN');

    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, ' +
        'class_name, instance_guid, authoring_id, bbox_min_x, bbox_min_y, bbox_min_z, ' +
        'bbox_max_x, bbox_max_y, bbox_max_z) ' +
        'VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)',
    );
    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, ' +
        'value_text, value_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    db.prepare(
      'INSERT INTO source_models (id, parent_id, file_name, display_name, guid) VALUES (?, ?, ?, ?, ?)',
    ).run(1, null, shape.inputFileName, shape.inputFileName, guidFor(1));

    let nextId = 1;
    const addObject = (
      parentId: number | null,
      pathIndex: number,
      depth: number,
      displayName: string,
      className: string,
    ): number => {
      const id = nextId;
      nextId += 1;
      objectCount += 1;
      insertObject.run(
        id,
        parentId,
        pathIndex,
        depth,
        displayName,
        className,
        guidFor(id),
        // An authoring id on every asset: the identity ledger's tier-2 evidence,
        // and the thing that makes a re-compile of an unchanged universe report
        // nothing moved.
        `A${String(id)}`,
      );
      return id;
    };

    const addProperty = (objectId: number, category: string, name: string, value: string): void => {
      propertyCount += 1;
      insertProperty.run(
        objectId,
        category,
        category.toLowerCase().replaceAll(' ', '_'),
        name,
        name.toLowerCase().replaceAll(' ', '_'),
        value,
        'DisplayString',
      );
    };

    const root = addObject(null, 0, 0, shape.inputFileName, 'File');

    shape.unitCodes.forEach((unitCode, unitIndex): void => {
      const layer = addObject(root, unitIndex, 1, `U${unitCode}`, 'Layer');
      let slot = 0;

      for (let family = 0; family < shape.familiesPerUnit; family += 1) {
        const instance = String(family + 1).padStart(4, '0');
        const systemKey = String((family % SYSTEM_COUNT) + 1).padStart(3, '0');
        const service = SERVICES[family % SERVICES.length] ?? 'Process Air';

        for (const role of SCALE_ROLES) {
          const tag = `${role}${systemKey}-${unitCode}-${instance}`;
          const asset = addObject(layer, slot, 2, tag, 'Equipment');
          slot += 1;
          assetCount += 1;

          addProperty(asset, 'Item', 'Name', tag);
          addProperty(asset, 'Item', 'Type', 'Equipment');
          addProperty(asset, 'Site Data', 'Tag', tag);
          addProperty(asset, 'Site Data', 'Building', `U${unitCode}`);
          addProperty(asset, 'Site Data', 'UPN', systemKey);
          addProperty(asset, 'Site Data', 'Service', service);
          addProperty(asset, 'Site Data', 'Description', `${role} unit ${instance}`);

          // Filler: what a real model's authoring properties are to this
          // pipeline. Deterministic values, so two writes of one shape are the
          // same file.
          for (
            let extra = MAPPED_PROPERTIES_PER_ASSET;
            extra < shape.propertiesPerAsset;
            extra += 1
          ) {
            addProperty(
              asset,
              'Authoring Data',
              `Field ${String(extra - MAPPED_PROPERTIES_PER_ASSET + 1)}`,
              `${tag}:${String(extra)}`,
            );
          }

          for (let part = 0; part < shape.componentsPerAsset; part += 1) {
            const component = addObject(asset, part, 3, `Solid ${String(part + 1)}`, 'Solid');
            addProperty(component, 'Item', 'Name', `Solid ${String(part + 1)}`);
            addProperty(component, 'Item', 'Type', 'Solid');
          }
        }
      }
    });

    for (const [key, value] of [
      ['schema_version', '1'],
      ['input_file_name', shape.inputFileName],
      // A stand-in, derived from the invented file name so two files of one
      // universe differ and two writes of one file do not. It is never the hash
      // of any real content: the desktop records a cache's real hash itself.
      ['input_sha256', fixtureSha256(shape.inputFileName)],
      ['input_bytes', '1073741824'],
      ['extracted_at_utc', '2026-02-01T08:00:00Z'],
      ['extractor_version', '0.1.0'],
      ['adapter_version', 'navisworks-2025'],
      ['navisworks_version', '25.0.1234.56'],
      ['object_count', String(objectCount)],
    ] as const) {
      insertMeta.run(key, value);
    }

    db.exec('COMMIT');
  } finally {
    db.close();
  }

  return { objectCount, assetCount, propertyCount };
}

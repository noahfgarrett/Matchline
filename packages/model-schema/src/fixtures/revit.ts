/**
 * The Revit-shaped fixture: a synthetic extraction cache that looks like a
 * federated NWD exported out of Revit.
 *
 * Dragon (`dragon.ts`) is the fixture every engine suite counts against, and it
 * is shaped the way a well-run Plant model is shaped: one `Tag` property on
 * every piece of equipment, tags like `MAH001-10-01` that carry the system in
 * them, and a `Building` property that says which building. A Revit federation
 * says almost none of that:
 *
 * - the equipment tag is `Element > Mark`, and only equipment carries one —
 *   here 18 of 178 objects, which is the ~10% a real MEP federation runs at,
 *   because ducts, pipes, conduit and cable trays are the rest of the file;
 * - the MEP marks are `AHU-1`, `P101`, `MCC-2A`, `VFD-2A-1` — a role and a
 *   number, with no system segment anywhere in them. The CONTROLS package is
 *   the other half: `MAH101-01`, `TIT101-01`, `VFD101-01`, marks carrying the
 *   approved Exto UPN, and `Element > Discipline` saying `I&C`. One federation
 *   where half the tags can be read against the approved list and half cannot
 *   is what a site part-way onto the standard actually looks like;
 * - nothing is called Building. The building is in the FILE NAME
 *   (`B14-Mechanical.nwc`), and the closest properties are `Level` (`L01`,
 *   which repeats in every building) and `Workset` (`B14 - Mechanical`);
 * - `System Classification` and `System Name` exist and are about air and power
 *   distribution, not about the commissioning register's classification column.
 *
 * Every value here is invented. Real NWDs and anything derived from them are
 * client data and never enter this repo (docs/EXTRACTION.md,
 * "Confidentiality"). The generator is deterministic in exactly the way
 * Dragon's is: no clock, no randomness, no host paths, so the same call writes
 * byte-identical table contents every run.
 *
 * The DDL is Dragon's — that is `schemas/extraction-cache.sql`, and there is one
 * of it. Only the content differs.
 */
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { AuthoringIdKind, BoundingBox } from '../schema.js';

import { EXTRACTION_CACHE_DDL } from './dragon.js';

/** Meta values that do not depend on the generated content. */
const REVIT_META: readonly (readonly [string, string])[] = [
  ['schema_version', '3'],
  ['input_file_name', 'Campus-Federated.nwd'],
  ['input_sha256', 'a41d6f0b93c27e5849d0bb17c62f3a8e5d704169bb2c83f5a90e7d41c6b28035'],
  ['input_bytes', '268435456'],
  ['extracted_at_utc', '2026-02-03T14:05:00Z'],
  ['extractor_version', '0.1.0'],
  ['adapter_version', 'navisworks-2025'],
  ['navisworks_version', '25.0.1234.56'],
  ['units', 'Feet'],
  ['ui_language', 'en-US'],
];

const SOURCE_MODEL_B14_MECHANICAL = 1;
const SOURCE_MODEL_B14_ELECTRICAL = 2;
const SOURCE_MODEL_B22_MECHANICAL = 3;
const SOURCE_MODEL_B14_CONTROLS = 4;

/** The source model ids, published so a split or a rule can name one. */
export const REVIT_SOURCE_MODEL_IDS = {
  b14Mechanical: SOURCE_MODEL_B14_MECHANICAL,
  b14Electrical: SOURCE_MODEL_B14_ELECTRICAL,
  b22Mechanical: SOURCE_MODEL_B22_MECHANICAL,
  b14Controls: SOURCE_MODEL_B14_CONTROLS,
} as const;

/** The category and name a Revit export writes the equipment tag under. */
export const REVIT_MARK_PROPERTY = { category: 'Element', name: 'Mark' } as const;

/**
 * The architectural and MEP marks, in the order the walk emits them.
 *
 * Role and number, no system anywhere in them. This is the shape the audit
 * found the engine mishandling, and it stays exactly as it was: `inferAnatomy`
 * over this list must keep teaching no `system` segment.
 */
export const REVIT_MARKS: readonly string[] = [
  'AHU-1',
  'P101',
  'AHU-2',
  'P102',
  'EF-3',
  'EF-4',
  'MCC-2A',
  'VFD-2A-1',
  'VFD-2A-2',
  'PNL-5',
  'AHU-3',
  'P103',
];

/**
 * The controls package's marks: the same federation, on the approved standard.
 *
 * A site that has been mapped onto the VF Exto template writes the UPN into the
 * mark — `MAH101-01` is on system 101, and so are `VFD101-01`, `PLC101-01`,
 * `LCP101-01` and `TIT101-01`. `P102-01` is on 102. That is Noah's directive
 * made concrete, and it is the half of a real federation the approved-UPN rung
 * can read; the twelve marks above are the half it cannot, which is why both
 * are in one fixture rather than two.
 *
 * Kept as its own list so the anatomy inference over {@link REVIT_MARKS} is
 * unchanged: mixing these in would teach a `system` segment and the finding
 * that says a Revit mark carries none would stop being tested.
 */
export const REVIT_IC_MARKS: readonly string[] = [
  'MAH101-01',
  'P102-01',
  'PLC101-01',
  'LCP101-01',
  'TIT101-01',
  'VFD101-01',
];

/** Every mark the fixture writes, in walk order. */
export const REVIT_ALL_MARKS: readonly string[] = [...REVIT_MARKS, ...REVIT_IC_MARKS];

/* --------------------------------------------------------------- the content */

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
  readonly authoringIdKind: AuthoringIdKind | null;
  /** Filled in by {@link assignStructuralKeys}, never by hand. */
  readonly structuralKey: string;
  readonly flags: number;
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

interface FixtureSourceModel {
  readonly id: number;
  readonly parentId: number | null;
  readonly fileName: string;
  readonly displayName: string;
  readonly guid: string;
  /** The `.rvt` the `.nwc` was published from. */
  readonly sourceFileName: string;
  readonly sourceGuid: string;
}

interface FixtureContent {
  readonly sourceModels: readonly FixtureSourceModel[];
  readonly objects: readonly FixtureObject[];
  readonly properties: readonly FixtureProperty[];
}

function guidFor(id: number): string {
  return `00000000-0000-4000-9000-${String(id).padStart(12, '0')}`;
}

function bboxFor(id: number): BoundingBox {
  return { minX: id * 4, minY: 0, minZ: 0, maxX: id * 4 + 3, maxY: 2, maxZ: 2 };
}

const UNIT_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

/** `objects.flags` bits, as the DDL defines them. */
const FLAG_LAYER = 2;
const FLAG_INSERT = 4;
const FLAG_COMPOSITE = 8;
const FLAG_COLLECTION = 16;
const FLAG_HAS_MODEL = 32;

/**
 * The extractor's own structural-key algorithm — see the same function in
 * `dragon.ts`, which explains why it is restated rather than invented.
 */
function structuralKeyOf(
  parentKey: string,
  className: string,
  displayName: string,
  pathIndex: number,
): string {
  const material =
    `${parentKey}${RECORD_SEPARATOR}${className}${UNIT_SEPARATOR}${displayName}` +
    `${UNIT_SEPARATOR}${String(pathIndex)}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Fills in every object's structural key, parents before children. */
function assignStructuralKeys(objects: readonly FixtureObject[]): FixtureObject[] {
  const keys = new Map<number, string>();
  return objects.map((object): FixtureObject => {
    const parentKey = object.parentId === null ? '' : (keys.get(object.parentId) ?? '');
    const structuralKey = structuralKeyOf(
      parentKey,
      object.className,
      object.displayName,
      object.pathIndex,
    );
    keys.set(object.id, structuralKey);
    return { ...object, structuralKey };
  });
}

/** The structure bits a Navisworks item of this class would carry. */
function flagsForClass(className: string): number {
  switch (className) {
    case 'File':
      return FLAG_HAS_MODEL | FLAG_COLLECTION;
    case 'Layer':
      return FLAG_LAYER | FLAG_COLLECTION;
    case 'Composite Object':
      return FLAG_COMPOSITE;
    case 'Insert Geometry':
      return FLAG_INSERT;
    default:
      return 0;
  }
}

/** The three files, and what each one is called on disk. */
const REVIT_SOURCE_MODELS: readonly FixtureSourceModel[] = [
  {
    id: SOURCE_MODEL_B14_MECHANICAL,
    parentId: null,
    fileName: 'B14-Mechanical.nwc',
    displayName: 'B14 Mechanical',
    guid: guidFor(2001),
    sourceFileName: 'B14-Mechanical.rvt',
    sourceGuid: guidFor(2101),
  },
  {
    id: SOURCE_MODEL_B14_ELECTRICAL,
    parentId: null,
    fileName: 'B14-Electrical.nwc',
    displayName: 'B14 Electrical',
    guid: guidFor(2002),
    sourceFileName: 'B14-Electrical.rvt',
    sourceGuid: guidFor(2102),
  },
  {
    id: SOURCE_MODEL_B22_MECHANICAL,
    parentId: null,
    fileName: 'B22-Mechanical.nwc',
    displayName: 'B22 Mechanical',
    guid: guidFor(2003),
    sourceFileName: 'B22-Mechanical.rvt',
    sourceGuid: guidFor(2103),
  },
  {
    id: SOURCE_MODEL_B14_CONTROLS,
    parentId: null,
    fileName: 'B14-Controls.nwc',
    displayName: 'B14 Controls',
    guid: guidFor(2004),
    sourceFileName: 'B14-Controls.rvt',
    sourceGuid: guidFor(2104),
  },
];

/** One piece of tagged equipment, as Revit would have published it. */
interface EquipmentSpec {
  readonly mark: string;
  readonly category: string;
  readonly family: string;
  readonly typeName: string;
  readonly systemClassification: string;
  readonly systemName: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly description: string;
  /** Equipment this one sits INSIDE in the model tree, by mark. */
  readonly insideMark?: string;
  /**
   * `Element > Discipline`, when the package states one.
   *
   * Only the controls file does. A Revit MEP model routinely publishes no such
   * parameter at all, which is why the other three files carry none and the
   * building has to come off the file name.
   */
  readonly discipline?: string;
}

/** One run of duct, pipe or tray: no mark, and most of the file by count. */
interface RunSpec {
  readonly namePrefix: string;
  readonly category: string;
  readonly family: string;
  readonly typeName: string;
  readonly systemClassification: string;
  readonly systemName: string;
  readonly count: number;
}

interface LevelSpec {
  readonly level: string;
  readonly equipment: readonly EquipmentSpec[];
  readonly runs: readonly RunSpec[];
}

interface FileSpec {
  readonly sourceModelId: number;
  readonly fileName: string;
  readonly workset: string;
  readonly levels: readonly LevelSpec[];
}

const AHU_1: EquipmentSpec = {
  mark: 'AHU-1',
  category: 'Mechanical Equipment',
  family: 'Air Handling Unit',
  typeName: 'AHU 40k CFM',
  systemClassification: 'Supply Air',
  systemName: 'Supply Air 1',
  manufacturer: 'Northwind Air',
  model: 'NW-40K',
  description: 'Air handling unit serving the level 1 supply system',
};

const AHU_2: EquipmentSpec = {
  ...AHU_1,
  mark: 'AHU-2',
  systemName: 'Supply Air 2',
  description: 'Air handling unit serving the level 1 north supply system',
};

const AHU_3: EquipmentSpec = {
  ...AHU_1,
  mark: 'AHU-3',
  systemName: 'Supply Air 3',
  description: 'Air handling unit serving the B22 level 1 supply system',
};

/**
 * A pump published as a child of its air handler, sharing the air handler's
 * system name.
 *
 * The shared system is what lets it nest under the unit once System is a
 * boundary: a boundary compares the key, and two assets on different systems do
 * not nest however the model tree drew them.
 */
function pumpUnder(mark: string, parent: EquipmentSpec): EquipmentSpec {
  return {
    mark,
    category: 'Mechanical Equipment',
    family: 'Pump',
    typeName: 'End Suction 50 GPM',
    systemClassification: parent.systemClassification,
    systemName: parent.systemName,
    manufacturer: 'Cascade Pumps',
    model: 'CP-50',
    description: `Condensate pump built into ${parent.mark}`,
    insideMark: parent.mark,
  };
}

const MCC_2A: EquipmentSpec = {
  mark: 'MCC-2A',
  category: 'Electrical Equipment',
  family: 'Motor Control Center',
  typeName: 'MCC 600A',
  systemClassification: 'Power',
  systemName: 'Power 2A',
  manufacturer: 'Ironline Electric',
  model: 'IL-600',
  description: 'Motor control centre feeding the level 1 mechanical drives',
};

function driveIn(mark: string): EquipmentSpec {
  return {
    mark,
    category: 'Electrical Equipment',
    family: 'Variable Frequency Drive',
    typeName: 'VFD 30HP',
    systemClassification: MCC_2A.systemClassification,
    systemName: MCC_2A.systemName,
    manufacturer: 'Ironline Electric',
    model: 'IL-VFD30',
    description: `Variable frequency drive in ${MCC_2A.mark}`,
    insideMark: MCC_2A.mark,
  };
}

/**
 * The controls package, whose marks carry the approved UPN.
 *
 * `Element > Discipline` says `I&C` on every one of them — the discipline the
 * approved Exto list does not contain, and which the SSM SOP reads as
 * FACILITIES MONITORING SYSTEM on the system its own tag names.
 */
function icDevice(
  mark: string,
  family: string,
  typeName: string,
  description: string,
  insideMark?: string,
): EquipmentSpec {
  return {
    mark,
    category: 'Specialty Equipment',
    family,
    typeName,
    systemClassification: 'Controls',
    systemName: 'Building Automation',
    manufacturer: 'Meridian Controls',
    model: 'MC-100',
    description,
    discipline: 'I&C',
    ...(insideMark === undefined ? {} : { insideMark }),
  };
}

const FILES: readonly FileSpec[] = [
  {
    sourceModelId: SOURCE_MODEL_B14_MECHANICAL,
    fileName: 'B14-Mechanical.nwc',
    workset: 'B14 - Mechanical',
    levels: [
      {
        level: 'L01',
        equipment: [AHU_1, pumpUnder('P101', AHU_1), AHU_2, pumpUnder('P102', AHU_2)],
        runs: [
          {
            namePrefix: 'Rectangular Duct',
            category: 'Ducts',
            family: 'Rectangular Duct',
            typeName: 'Mitred Elbows / Taps',
            systemClassification: 'Supply Air',
            systemName: 'Supply Air 1',
            count: 24,
          },
          {
            namePrefix: 'Pipe Type',
            category: 'Pipes',
            family: 'Pipe Types',
            typeName: 'Standard',
            systemClassification: 'Hydronic Supply',
            systemName: 'Hydronic Supply 1',
            count: 14,
          },
        ],
      },
      {
        level: 'L02',
        equipment: [
          {
            mark: 'EF-3',
            category: 'Mechanical Equipment',
            family: 'Exhaust Fan',
            typeName: 'EF 4k CFM',
            systemClassification: 'Exhaust Air',
            systemName: 'Exhaust Air 3',
            manufacturer: 'Northwind Air',
            model: 'NW-EF4',
            description: 'Roof exhaust fan serving the level 2 toilet exhaust',
          },
          {
            mark: 'EF-4',
            category: 'Mechanical Equipment',
            family: 'Exhaust Fan',
            typeName: 'EF 4k CFM',
            systemClassification: 'Exhaust Air',
            systemName: 'Exhaust Air 4',
            manufacturer: 'Northwind Air',
            model: 'NW-EF4',
            description: 'Roof exhaust fan serving the level 2 kitchen exhaust',
          },
        ],
        runs: [
          {
            namePrefix: 'Round Duct',
            category: 'Ducts',
            family: 'Round Duct',
            typeName: 'Taps',
            systemClassification: 'Exhaust Air',
            systemName: 'Exhaust Air 3',
            count: 14,
          },
        ],
      },
    ],
  },
  {
    sourceModelId: SOURCE_MODEL_B14_ELECTRICAL,
    fileName: 'B14-Electrical.nwc',
    workset: 'B14 - Electrical',
    levels: [
      {
        level: 'L01',
        equipment: [MCC_2A, driveIn('VFD-2A-1'), driveIn('VFD-2A-2')],
        runs: [
          {
            namePrefix: 'Cable Tray',
            category: 'Cable Trays',
            family: 'Cable Tray with Fittings',
            typeName: 'Ladder Tray',
            systemClassification: 'Power',
            systemName: 'Power 2A',
            count: 20,
          },
        ],
      },
      {
        level: 'L02',
        equipment: [
          {
            mark: 'PNL-5',
            category: 'Electrical Equipment',
            family: 'Lighting Panel',
            typeName: 'Panel 225A',
            systemClassification: 'Power',
            systemName: 'Power 5',
            manufacturer: 'Ironline Electric',
            model: 'IL-225',
            description: 'Lighting panel serving level 2',
          },
        ],
        runs: [
          {
            namePrefix: 'Cable Tray',
            category: 'Cable Trays',
            family: 'Cable Tray with Fittings',
            typeName: 'Ladder Tray',
            systemClassification: 'Power',
            systemName: 'Power 5',
            count: 10,
          },
        ],
      },
    ],
  },
  {
    sourceModelId: SOURCE_MODEL_B22_MECHANICAL,
    fileName: 'B22-Mechanical.nwc',
    workset: 'B22 - Mechanical',
    levels: [
      {
        level: 'L01',
        equipment: [AHU_3, pumpUnder('P103', AHU_3)],
        runs: [
          {
            namePrefix: 'Rectangular Duct',
            category: 'Ducts',
            family: 'Rectangular Duct',
            typeName: 'Mitred Elbows / Taps',
            systemClassification: 'Supply Air',
            systemName: 'Supply Air 3',
            count: 22,
          },
          {
            namePrefix: 'Pipe Type',
            category: 'Pipes',
            family: 'Pipe Types',
            typeName: 'Standard',
            systemClassification: 'Hydronic Supply',
            systemName: 'Hydronic Supply 3',
            count: 12,
          },
        ],
      },
    ],
  },
  {
    sourceModelId: SOURCE_MODEL_B14_CONTROLS,
    fileName: 'B14-Controls.nwc',
    workset: 'B14 - Controls',
    levels: [
      {
        level: 'L01',
        equipment: [
          icDevice('MAH101-01', 'Air Handling Unit', 'MAH 20k CFM', 'Cleanroom makeup air unit'),
          icDevice('P102-01', 'Pump', 'End Suction 80 GPM', 'Process cooling water pump'),
          icDevice('PLC101-01', 'Controller', 'PLC Rack', 'Programmable controller for MAH101-01'),
          icDevice('LCP101-01', 'Control Panel', 'LCP 24V', 'Local control panel', 'PLC101-01'),
          icDevice(
            'TIT101-01',
            'Transmitter',
            'TIT 4-20mA',
            'Supply air temperature transmitter',
            'LCP101-01',
          ),
          icDevice('VFD101-01', 'Variable Frequency Drive', 'VFD 40HP', 'Supply fan drive'),
        ],
        runs: [
          {
            namePrefix: 'Conduit',
            category: 'Conduits',
            family: 'Conduit with Fittings',
            typeName: 'EMT',
            systemClassification: 'Controls',
            systemName: 'Building Automation',
            count: 18,
          },
        ],
      },
    ],
  },
];

/**
 * Builds the federation in memory.
 *
 * Class names are Navisworks', not Revit's: a Revit element arrives as a
 * `Composite Object` with its solids underneath, and a duct run arrives as an
 * `Insert Geometry`. That distinction is the one the class step reads, and it
 * is the reason a Revit model can be filtered down to its equipment at all.
 */
function buildRevitContent(): FixtureContent {
  const objects: FixtureObject[] = [];
  const properties: FixtureProperty[] = [];
  let nextObjectId = 1;

  // `objects(parent_id, path_index)` is unique, so sibling positions are handed
  // out per parent rather than tracked by each caller.
  const nextPathIndex = new Map<number | null, number>();
  const addObject = (
    object: Omit<
      FixtureObject,
      'id' | 'instanceGuid' | 'pathIndex' | 'structuralKey' | 'flags' | 'authoringIdKind'
    >,
  ): FixtureObject => {
    const id = nextObjectId;
    nextObjectId += 1;
    const pathIndex = nextPathIndex.get(object.parentId) ?? 0;
    nextPathIndex.set(object.parentId, pathIndex + 1);
    const created: FixtureObject = {
      ...object,
      pathIndex,
      id,
      instanceGuid: guidFor(id),
      // An authoring id here is always a Revit element id: that is what this
      // fixture is a model of.
      authoringIdKind: object.authoringId === null ? null : 'revit-element-id',
      structuralKey: '',
      flags: flagsForClass(object.className),
    };
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

  const addItemProperties = (object: FixtureObject): void => {
    addProperty(object.id, 'Item', 'Name', object.displayName);
    addProperty(object.id, 'Item', 'Type', object.className);
  };

  /** The block every Revit-authored element carries. */
  const addElementProperties = (
    object: FixtureObject,
    element: {
      readonly category: string;
      readonly family: string;
      readonly typeName: string;
      readonly level: string;
      readonly workset: string;
      readonly systemClassification: string;
      readonly systemName: string;
    },
  ): void => {
    addProperty(object.id, 'Element', 'Category', element.category);
    addProperty(object.id, 'Element', 'Family', element.family);
    addProperty(object.id, 'Element', 'Type Name', element.typeName);
    addProperty(
      object.id,
      'Element',
      'Family and Type',
      `${element.family}: ${element.typeName}`,
    );
    addProperty(object.id, 'Element', 'Level', element.level);
    addProperty(object.id, 'Element', 'Workset', element.workset);
    addProperty(object.id, 'Element', 'System Classification', element.systemClassification);
    addProperty(object.id, 'Element', 'System Name', element.systemName);
    addProperty(object.id, 'Revit Family', 'Family Name', element.family);
  };

  for (const file of FILES) {
    const root = addObject({
      sourceModelId: file.sourceModelId,
      parentId: null,
      depth: 0,
      displayName: file.fileName,
      className: 'File',
      authoringId: null,
      bbox: null,
    });
    addItemProperties(root);

    for (const level of file.levels) {
      const levelObject = addObject({
        sourceModelId: file.sourceModelId,
        parentId: root.id,
        depth: 1,
        displayName: level.level,
        className: 'Layer',
        authoringId: null,
        bbox: null,
      });
      addItemProperties(levelObject);

      // Equipment first, so a piece published inside another (a drive in its
      // motor control centre) finds its host already built.
      const equipmentByMark = new Map<string, FixtureObject>();
      for (const spec of level.equipment) {
        const host = spec.insideMark === undefined ? undefined : equipmentByMark.get(spec.insideMark);
        const parent = host ?? levelObject;
        const equipment = addObject({
          sourceModelId: file.sourceModelId,
          parentId: parent.id,
          depth: host === undefined ? 2 : 3,
          displayName: `${spec.family} [${String(700000 + nextObjectId)}]`,
          className: 'Composite Object',
          // Navisworks shows the Revit element id in the node name and also
          // publishes it as a property; the extractor promotes it into the
          // column, so the fixture records it in both places.
          authoringId: String(700000 + nextObjectId),
          bbox: bboxFor(nextObjectId),
        });
        equipmentByMark.set(spec.mark, equipment);

        addItemProperties(equipment);
        addElementProperties(equipment, {
          category: spec.category,
          family: spec.family,
          typeName: spec.typeName,
          level: level.level,
          workset: file.workset,
          systemClassification: spec.systemClassification,
          systemName: spec.systemName,
        });
        addProperty(equipment.id, 'Element', 'Mark', spec.mark);
        if (spec.discipline !== undefined) {
          addProperty(equipment.id, 'Element', 'Discipline', spec.discipline);
        }
        addProperty(equipment.id, 'Element', 'Comments', 'Coordinate with the controls package');
        addProperty(equipment.id, 'Revit Type', 'Type Name', spec.typeName);
        addProperty(equipment.id, 'Revit Type', 'Manufacturer', spec.manufacturer);
        addProperty(equipment.id, 'Revit Type', 'Model', spec.model);
        addProperty(equipment.id, 'Revit Type', 'Description', spec.description);

        // One solid apiece: geometry carries no Revit parameters of its own,
        // which is why the class step can tell it from the element above it.
        const solid = addObject({
          sourceModelId: file.sourceModelId,
          parentId: equipment.id,
          depth: (host === undefined ? 2 : 3) + 1,
          displayName: 'Solid',
          className: 'Geometry',
          authoringId: null,
          bbox: bboxFor(nextObjectId),
        });
        addItemProperties(solid);
      }

      for (const run of level.runs) {
        for (let index = 1; index <= run.count; index += 1) {
          const segment = addObject({
            sourceModelId: file.sourceModelId,
            parentId: levelObject.id,
            depth: 2,
            displayName: run.namePrefix,
            className: 'Insert Geometry',
            authoringId: null,
            bbox: bboxFor(nextObjectId),
          });
          addItemProperties(segment);
          addElementProperties(segment, {
            category: run.category,
            family: run.family,
            typeName: run.typeName,
            level: level.level,
            workset: file.workset,
            systemClassification: run.systemClassification,
            systemName: run.systemName,
          });
        }
      }
    }
  }

  return { sourceModels: REVIT_SOURCE_MODELS, objects: assignStructuralKeys(objects), properties };
}

/**
 * Writes the Revit-shaped cache to `path`, replacing any file already there.
 *
 * The result satisfies `schemas/extraction-cache.sql` including the
 * `meta.object_count` integrity check, so `openExtractionCache` accepts it. It
 * records no selection sets and no warnings: a Revit export routinely has
 * neither, and a fixture that invented them would be testing Dragon again.
 */
export function writeRevitShapedFixture(path: string): void {
  const content = buildRevitContent();
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(EXTRACTION_CACHE_DDL);
    db.exec('BEGIN');

    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of REVIT_META) {
      insertMeta.run(key, value);
    }
    insertMeta.run('object_count', String(content.objects.length));

    const insertSourceModel = db.prepare(
      'INSERT INTO source_models (id, parent_id, file_name, display_name, guid, source_file_name, ' +
        'source_guid) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const model of content.sourceModels) {
      insertSourceModel.run(
        model.id,
        model.parentId,
        model.fileName,
        model.displayName,
        model.guid,
        model.sourceFileName,
        model.sourceGuid,
      );
    }

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id, authoring_id_kind, structural_key, flags, ' +
        'bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        object.authoringIdKind,
        object.structuralKey,
        object.flags,
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

    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

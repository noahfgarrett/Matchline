/**
 * Shared fixtures for the project-store tests.
 *
 * Dragon is an invented site (see `@matchline/model-schema`'s Dragon fixture):
 * every tag, building and file name here is made up, because real project data
 * never enters this repo.
 *
 * Nothing here reads the wall clock. `steppingClock` hands out timestamps one
 * second apart from a fixed start, so two runs of the same test write the same
 * rows -- which is the property the determinism test asserts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** A clock that advances one second per call from 2026-01-15T09:30:00Z. */
export function steppingClock(startIso = '2026-01-15T09:30:00.000Z', stepMs = 1000) {
  let tick = 0;
  return () => {
    const value = new Date(Date.parse(startIso) + tick * stepMs);
    tick += 1;
    return value;
  };
}

/** A clock frozen at one instant. */
export function frozenClock(iso = '2026-01-15T09:30:00.000Z') {
  return () => new Date(iso);
}

/** Makes a temp directory and returns it plus a cleanup function. */
export function tempDirectory(label) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-project-store-${label}-`));
  return {
    directory,
    file: (name) => join(directory, name),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** A valid Dragon Site Profile. */
export function dragonProfile(overrides = {}) {
  return {
    profileId: 'dragon',
    name: 'Dragon',
    version: 1,
    propertyMappings: {
      equipmentTag: { category: 'Item', name: 'Name' },
      description: { category: 'Item', name: 'Description' },
      building: { category: 'Revit Type', name: 'Building' },
    },
    assetFilters: {
      requireTagProperty: true,
      collapseComponents: false,
      includedClasses: ['Equipment'],
      excludedClasses: ['Insulation'],
    },
    tagAnatomy: {
      separators: ['-'],
      ignoredSuffixes: ['-SPARE'],
      segments: {
        role: { kind: 'alphaPrefix', token: 0 },
        system: { kind: 'digitSuffix', token: 0 },
        unit: { kind: 'token', token: 1 },
        instance: { kind: 'charRange', token: 2, from: 0, to: 2 },
      },
      familyKeyTemplate: '{system}-{token:1}-{token:2}',
    },
    systemResolver: {
      keyChain: [
        { kind: 'tag-segment', segment: 'system' },
        { kind: 'mel-lookup', joinBy: 'equipmentTag', returnField: 'systemKey' },
      ],
      descriptionChain: [
        { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
      ],
      normalization: [
        { kind: 'trim' },
        { kind: 'padStart', length: 3, fill: '0' },
        { kind: 'alias', from: 'UPN-001', to: '001' },
      ],
      conflictPolicy: 'review',
    },
    ...overrides,
  };
}

const DRAGON_PROVENANCE = {
  sourceFile: 'Dragon-Coordination.nwd',
  sourceRef: { kind: 'model-object', objectId: '17' },
  propertyOrColumn: 'Item > Name',
  rule: 'flow-family',
  fallbackRung: 4,
};

/**
 * A small resolved snapshot with a Map whose insertion order is deliberately
 * not sorted, so a round trip can prove it comes back sorted.
 */
export function dragonSnapshot() {
  const winningClaim = {
    subjectAssetId: 'MAH001-10-01',
    targetAssetId: 'MCC-D1-01',
    kind: 'structural-parent',
    relationshipType: 'POWERS',
    source: 'FLOW',
    rule: 'easypower-feed',
    evidenceTier: 3,
    provenance: DRAGON_PROVENANCE,
    ladderSource: 'flow-family',
  };

  const nodes = new Map();
  nodes.set('MCC-D1-01', {
    assetId: 'MCC-D1-01',
    parent: { parentAssetId: null, ladderSource: null, status: 'root' },
    dependencies: [],
    levelPath: [{ levelId: 'building', value: 'D1' }],
    losingClaims: [],
  });
  nodes.set('MAH001-10-01', {
    assetId: 'MAH001-10-01',
    parent: {
      parentAssetId: 'MCC-D1-01',
      ladderSource: 'flow-family',
      status: 'resolved',
      winningClaim,
      demotedFrom: { parentAssetId: 'MCC-D2-01', boundaryLevelId: 'building' },
    },
    dependencies: [
      {
        parentAssetId: 'PLC-D1-01',
        relationshipType: 'CONTROLS',
        provenance: DRAGON_PROVENANCE,
      },
    ],
    levelPath: [
      { levelId: 'building', value: 'D1' },
      { levelId: 'system', value: '001' },
    ],
    losingClaims: [{ ...winningClaim, ladderSource: 'model-tree', relationshipType: 'WIRED_TO' }],
  });

  return {
    nodes,
    reviewItems: [
      {
        kind: 'ambiguous-parent',
        assetId: 'TIT001-10-01',
        ladderSource: 'family-role',
        candidateParentIds: ['VFD001-10-01', 'VFD001-10-02'],
      },
      { kind: 'duplicate-model-tag', canonicalTag: 'MAH001-10-01', objectIds: [17, 42] },
      {
        kind: 'system-conflict',
        assetId: 'MAH001-10-01',
        claims: [
          {
            subjectAssetId: 'MAH001-10-01',
            attribute: 'systemKey',
            proposedValue: '001',
            source: 'MODEL',
            rule: 'tag-segment',
            evidenceTier: 4,
            provenance: DRAGON_PROVENANCE,
          },
        ],
      },
    ],
    stats: {
      nodeCount: 2,
      rootCount: 1,
      demotedToDependencyCount: 1,
      unresolvedCount: 0,
      cycleCount: 0,
      ambiguousCount: 1,
    },
  };
}

/** A sha256-shaped digest built from a seed, so fixtures stay readable. */
export function digest(seed) {
  return seed.padEnd(64, '0').slice(0, 64).toLowerCase().replace(/[^0-9a-f]/g, '0');
}

const DUMPED_TABLES = [
  'meta',
  'sources',
  'profile',
  'learned',
  'overrides',
  'compiles',
  'snapshots',
  'decisions',
  'migrations',
];

/**
 * Every row of every table as sorted JSON text.
 *
 * Two SQLite files with the same history are not byte-identical -- page
 * layout, freelists and the rowid counter all differ -- so determinism is
 * asserted on contents instead.
 */
export function dumpTables(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const dump = {};
    for (const table of DUMPED_TABLES) {
      dump[table] = db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => JSON.stringify(row, Object.keys(row).sort()))
        .sort();
    }
    return dump;
  } finally {
    db.close();
  }
}

/** Runs raw SQL against a project file, for corrupting it on purpose. */
export function rawExec(path, sql) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
